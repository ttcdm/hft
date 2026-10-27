import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator, EXIT_LOOP_ALERT_AFTER, MARK_STALE_MS } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';

/**
 * The exit loop: R4-6 (a pass that throws is caught, alerts after N in a row, and refuses LIVE buys while failing), R5-10 / R7-10 (a
 * decided exit is sent before the stale-mark reads, which run concurrently), R4-3 (mark ages on the monotonic clock). Real
 * ExecutionCoordinator exit pass and SQLite; the mark reads (updatePositionMarkPrices, refreshStaleMark) and closePosition are the edges.
 */
describe('C2: exit loop', () => {
  let coordinator: ExecutionCoordinator;
  let rpc: MockSolanaRpc;
  const made: string[] = [];

  const seedLive = (over: Record<string, unknown> = {}) => {
    const id = `c2x_${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    workstationDb.savePosition({
      id, mint: Keypair.generate().publicKey.toBase58(), symbol: 'C2X', name: 'C2 exit', tokenDecimals: 6, tokenQuantityRaw: '1000000000',
      entryPriceSol: 0.0001, currentPriceSol: 0.0001, currentValueSol: 0.1, costBasisLamports: 100_000_000, realizedPnLSol: 0, status: 'OPEN',
      venue: 'PUMP_BONDING_CURVE', executionMode: 'LIVE', entryTxSignature: `sig_${id}`, entryTimestamp: now, lastMarkTimestamp: now,
      recordUpdatedAt: now, updatedAt: now, ...over,
    } as any);
    made.push(id);
    return id;
  };

  beforeEach(() => {
    for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0' } as any);
    rpc = new MockSolanaRpc();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(Keypair.generate().publicKey);
    vi.spyOn(ExecutionCoordinator.prototype as any, 'initializeConnection').mockResolvedValue(undefined);
    coordinator = new ExecutionCoordinator(rpc.createConnection());
    (coordinator as any).firstReconciliationDone = true;
    vi.spyOn(coordinator as any, 'updatePositionMarkPrices').mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    coordinator.cleanup();
    rpc.clear();
    for (const id of made.splice(0)) {
      const p = workstationDb.loadPositions().find((x) => x.id === id);
      if (p) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0' } as any);
    }
  });

  describe('R4-6: a failing exit pass', () => {
    it('is caught, raises EXIT_LOOP_FAILING after N passes in a row, refuses LIVE buys, and clears when a pass completes', async () => {
      vi.spyOn(ExecutionCoordinator.prototype as any, 'liveBuyReadinessProblems').mockRestore(); // the suite setup stubs it green (tests/setup/devnetGuard.ts)
      const load = vi.spyOn(workstationDb, 'loadPositions').mockImplementation(() => { throw new Error('SQLITE_IOERR: disk I/O error'); });
      for (let i = 0; i < EXIT_LOOP_ALERT_AFTER; i++) await expect(coordinator.evaluateAndProcessExits()).resolves.toBeUndefined();
      load.mockRestore();
      expect(coordinator.getOperatorAlerts().some((a) => a.code === 'EXIT_LOOP_FAILING')).toBe(true);
      expect(coordinator.isExitLoopFailing()).toBe(true);
      expect((coordinator as any).liveBuyReadinessProblems().join(' ')).toMatch(/exit loop is failing/);
      expect(coordinator.getLiveReadiness().reasons.join(' ')).toMatch(/exit loop is failing/i);
      await coordinator.evaluateAndProcessExits();
      expect(coordinator.isExitLoopFailing()).toBe(false);
      expect(coordinator.getOperatorAlerts().some((a) => a.code === 'EXIT_LOOP_FAILING')).toBe(false);
    });

    it('one failed pass alone raises nothing', async () => {
      const load = vi.spyOn(workstationDb, 'loadPositions').mockImplementationOnce(() => { throw new Error('SQLITE_BUSY'); });
      await coordinator.evaluateAndProcessExits();
      load.mockRestore();
      expect(coordinator.getOperatorAlerts().some((a) => a.code === 'EXIT_LOOP_FAILING')).toBe(false);
    });
  });

  describe('R5-10 / R7-10: stale-mark reads do not hold a decided exit', () => {
    it('a stop-loss decided on a fresh mark is sent while the stale reads are still running, and those run concurrently', async () => {
      const stop = seedLive({ currentPriceSol: 0.00005 }); // -50%, fresh mark
      seedLive({ lastMarkTimestamp: Date.now() - 60_000 });
      seedLive({ lastMarkTimestamp: Date.now() - 60_000 });
      let open!: () => void;
      const gate = new Promise<void>((r) => { open = r; });
      const refresh = vi.spyOn(coordinator as any, 'refreshStaleMark').mockImplementation(async () => { await gate; return false; });
      const close = vi.spyOn(coordinator, 'closePosition').mockResolvedValue({ success: true, pnlSol: -0.05 });
      const pass = coordinator.evaluateAndProcessExits();
      await new Promise((r) => setTimeout(r, 20));
      expect(close).toHaveBeenCalledWith(stop, 100, 'STOP_LOSS'); // before any stale read returned
      expect(refresh).toHaveBeenCalledTimes(2); // both reads started, not one after the other
      open();
      await pass;
    });
  });

  describe('R4-3: a wall clock set back does not hide a dead mark feed', () => {
    it('a mark this process applied ages on the monotonic clock: the exit pass reads it again directly', async () => {
      const id = seedLive();
      const pos = workstationDb.loadPositions().find((p) => p.id === id)!;
      (coordinator as any).applyMarkPrice(pos, 0.0001, 'ON_CHAIN_BONDING_CURVE', Date.now());
      const realNow = Date.now.bind(Date);
      const realPerf = performance.now.bind(performance);
      vi.spyOn(Date, 'now').mockImplementation(() => realNow() - 3_600_000); // set back one hour
      vi.spyOn(performance, 'now').mockImplementation(() => realPerf() + MARK_STALE_MS + 5_000); // while 20 s really passed
      const refresh = vi.spyOn(coordinator as any, 'refreshStaleMark').mockResolvedValue(false);
      await coordinator.evaluateAndProcessExits();
      expect(refresh.mock.calls.some((c: any[]) => c[0].id === id)).toBe(true);
    });

    it('the mark-feed clock (feed ages and readiness) is monotonic too', () => {
      coordinator.recordPositionMarkEvent();
      const realNow = Date.now.bind(Date);
      const realPerf = performance.now.bind(performance);
      vi.spyOn(Date, 'now').mockImplementation(() => realNow() - 3_600_000);
      vi.spyOn(performance, 'now').mockImplementation(() => realPerf() + 130_000);
      expect(coordinator.getFeedAges().positionMarkAgeMs).toBeGreaterThanOrEqual(130_000);
      expect(coordinator.getLiveReadiness().components.markFeed.healthy).toBe(false);
    });
  });
});
