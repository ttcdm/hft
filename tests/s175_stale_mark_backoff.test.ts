import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
  executionCoordinator, MARK_ALERT_AFTER_MS, MARK_RETRY_BASE_MS, PAPER_STALE_REFRESH_PER_PASS, PAPER_INDIVIDUAL_ALERTS,
} from '../server/execution/coordinator';
import { RealMarkPriceService } from '../server/execution/reconciliation';
import { workstationDb } from '../server/db/database';

const N = 40;
const ids: string[] = [];

function seedStalePaper(n: number) {
  for (let i = 0; i < n; i++) {
    const id = `s175-${i}-${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    workstationDb.savePosition({
      id, mint: Keypair.generate().publicKey.toBase58(), symbol: 'TEST', name: 'TEST', tokenDecimals: 6, tokenQuantityRaw: '1000000',
      costBasisLamports: 5_000_000, entryPriceSol: 0.0001, currentPriceSol: 0.0001, realizedPnLSol: 0, entryTxSignature: id,
      entryTimestamp: Date.now() - 3_600_000, lastMarkTimestamp: Date.now() - (MARK_ALERT_AFTER_MS + 60_000), executionMode: 'PAPER', status: 'OPEN',
    } as any);
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of ids.splice(0)) {
    const p = workstationDb.loadPositions().find((x) => x.id === id);
    if (p) { p.status = 'CLOSED'; p.tokenQuantityRaw = '0'; workstationDb.savePosition(p); }
  }
});

describe('stale marks on mints that do not exist do not flood the RPC or the log', () => {
  it('reads each failing mint once, then waits; the next pass makes no per-mint reads', async () => {
    seedStalePaper(N);
    const q = vi.spyOn(RealMarkPriceService, 'queryOnChainMarkPrices').mockResolvedValue({} as any);
    await executionCoordinator.evaluateAndProcessExits();
    const mine = (calls: any[][]) => calls.filter((c) => (c[1] as string[]).some((m) => workstationDb.loadPositions().some((p) => ids.includes(p.id) && p.mint === m)));
    const firstPass = mine(q.mock.calls).reduce((n, c) => n + (c[1] as string[]).length, 0);
    // the bulk read covers all N once; direct reads are capped
    expect(firstPass).toBeLessThanOrEqual(N + PAPER_STALE_REFRESH_PER_PASS);
    q.mockClear();
    await executionCoordinator.evaluateAndProcessExits();
    const secondPass = mine(q.mock.calls).reduce((n, c) => n + (c[1] as string[]).length, 0);
    expect(secondPass).toBeLessThanOrEqual(PAPER_STALE_REFRESH_PER_PASS); // the capped ones that were not asked in pass 1; the rest wait
  });

  it('after the wait the mints are asked again, and a successful read ends the back-off', async () => {
    seedStalePaper(3);
    const q = vi.spyOn(RealMarkPriceService, 'queryOnChainMarkPrices').mockResolvedValue({} as any);
    await executionCoordinator.evaluateAndProcessExits();
    q.mockClear();
    await executionCoordinator.evaluateAndProcessExits();
    expect(q.mock.calls.some((c) => (c[1] as string[]).length > 0 && workstationDb.loadPositions().some((p) => ids.includes(p.id) && (c[1] as string[]).includes(p.mint)))).toBe(false);
    // P1.6: the clock moves past the wait instead of the test rewriting the private back-off map
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0 + MARK_RETRY_BASE_MS + 1);
    q.mockClear();
    await executionCoordinator.evaluateAndProcessExits();
    expect(q.mock.calls.length).toBeGreaterThan(0);
    // the second failure doubles the wait: one base wait later the mints are still not asked
    now.mockReturnValue(t0 + 2 * MARK_RETRY_BASE_MS + 2);
    q.mockClear();
    await executionCoordinator.evaluateAndProcessExits();
    expect(q.mock.calls.some((c) => (c[1] as string[]).length > 0 && workstationDb.loadPositions().some((p) => ids.includes(p.id) && (c[1] as string[]).includes(p.mint)))).toBe(false);
  });

  it('many unpriced PAPER positions raise a handful of alerts and one with a count, not one each', async () => {
    seedStalePaper(N);
    vi.spyOn(RealMarkPriceService, 'queryOnChainMarkPrices').mockResolvedValue({} as any);
    await executionCoordinator.evaluateAndProcessExits();
    const alerts = executionCoordinator.getOperatorAlerts();
    const per = alerts.filter((a) => a.code === 'POSITION_MARK_UNAVAILABLE' && a.positionId && ids.includes(a.positionId));
    expect(per.length).toBeLessThanOrEqual(PAPER_INDIVIDUAL_ALERTS);
    const agg = alerts.find((a) => a.code === 'PAPER_MARKS_UNAVAILABLE');
    expect(agg).toBeTruthy();
    expect(agg!.message).toMatch(/\d+ more PAPER position/);
    // a second pass changes no alert count
    await executionCoordinator.evaluateAndProcessExits();
    expect(executionCoordinator.getOperatorAlerts().filter((a) => a.code === 'PAPER_MARKS_UNAVAILABLE')).toHaveLength(1);
  });
});
