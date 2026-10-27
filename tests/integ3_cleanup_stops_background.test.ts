import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator, INSTANCE_LOCK_LOST, executionCoordinator } from '../server/execution/coordinator';
import { emergencyStop, PANIC_PENDING_SELL_WAIT_MS, PANIC_PENDING_SELL_POLL_MS, PANIC_BUY_SETTLE_WAIT_MS } from '../server/execution/emergencyStop';
import { autoSnipeController } from '../server/auto/controller';
import { riskEngine } from '../server/risk/riskEngine';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { txBuilder } from '../server/solana/transactionBuilder';
import { TradeReconciler } from '../server/execution/reconciliation';
import { acquireLock, releaseAllLocks, signerLockPath, dbLockPath } from '../server/system/instanceLock';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';

/**
 * Devnet (f): the harness stops trading (coordinator.cleanup()), releases its instance locks and hands them to a child process. After
 * cleanup nothing in this process may sign or take a lock back: a background pass still in flight at cleanup must not re-arm its retry
 * timer, and no sign may happen (the fake signer takes the signer lock on each signature, as LocalKeypairSigner.signTransaction does).
 * Real coordinator, SQLite and lock module; the chain reads and the transaction build are the stubbed boundary.
 */
const uid = () => Math.random().toString(36).slice(2);
let coordinator: ExecutionCoordinator | null = null;
let mockRpc: MockSolanaRpc | null = null;

function startWithFakeSigner() {
  const kp = Keypair.generate();
  mockRpc = new MockSolanaRpc();
  const pub = kp.publicKey.toBase58();
  const sign = vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => { acquireLock(signerLockPath(pub), { walletPubkey: pub }); return tx; });
  vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
  vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(kp.publicKey);
  coordinator = new ExecutionCoordinator(mockRpc.createConnection()); // a non-singleton starts at once: it takes the locks
  const signerLock = signerLockPath(pub);
  expect(fs.existsSync(signerLock)).toBe(true);
  return { c: coordinator, sign, signerLock };
}

/** What the harness does before it spawns the crash child. */
function stopAndRelease(c: ExecutionCoordinator, signerLock: string) {
  c.cleanup();
  releaseAllLocks();
  expect(fs.existsSync(signerLock)).toBe(false);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  coordinator?.cleanup();
  mockRpc?.clear();
  releaseAllLocks();
  coordinator = null;
  PumpCurveService.cachedGlobal = null;
  PumpCurveService.cachedFeeConfig = null;
});

describe('after coordinator.cleanup() nothing signs or re-takes a lock', () => {
  it('an orphan-recovery pass in flight at cleanup does not re-arm its retry chain', async () => {
    const { c, sign, signerLock } = startWithFakeSigner();
    await (c as any).reconcileInFlight?.catch(() => undefined);
    const sig = `cl_${uid()}`;
    workstationDb.saveTransaction({ signature: sig, orderId: `o_${uid()}`, correlationId: 'c', mint: Keypair.generate().publicKey.toBase58(), direction: 'BUY', submissionTransport: 'SOLANA_RPC', submissionTime: Date.now() - 60_000, reconciliationState: 'RECONCILIATION_REQUIRED', networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE' } as any);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const read = vi.spyOn(TradeReconciler, 'recoverInterruptedTransaction').mockImplementation(async () => { await gate; return { recovered: false, type: 'BUY', error: 'could not reconstruct' } as any; });
    vi.useFakeTimers();
    c.orphanRecoveryDelaysMs = [10, 20, 50];
    (c as any).scheduleOrphanRecovery();
    await vi.advanceTimersByTimeAsync(10);
    expect(read).toHaveBeenCalledTimes(1); // the pass is in flight
    stopAndRelease(c, signerLock);
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(1); // no further pass after cleanup
    expect((c as any).orphanRecoveryTimer).toBeNull();
    expect(sign).not.toHaveBeenCalled();
    expect(fs.existsSync(signerLock)).toBe(false);
    workstationDb.saveTransaction({ ...workstationDb.loadTransactions().find((t) => t.signature === sig)!, reconciliationState: 'REVERTED' });
  });

  it('a reconcile retry asked for by a pass that ends after cleanup is not scheduled', async () => {
    const { c, signerLock } = startWithFakeSigner();
    await (c as any).reconcileInFlight?.catch(() => undefined);
    stopAndRelease(c, signerLock);
    const pass = vi.spyOn(c, 'startupReconciliation');
    vi.useFakeTimers();
    (c as any).scheduleReconcileRetry(10);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pass).not.toHaveBeenCalled();
    const db = dbLockPath(workstationDb.getDbPath());
    if (db) expect(fs.existsSync(db)).toBe(false);
  });

  it('a LIVE sell after the locks were released is refused before it is signed; the signer lock is not re-created', async () => {
    const { c, sign, signerLock } = startWithFakeSigner();
    PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() } as any;
    PumpCurveService.cachedFeeConfig = { feeBps: 100 } as any;
    (c as any).connection.simulateTransaction = vi.fn(async () => ({ context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 1 } }));
    vi.spyOn(c.getJitoTransport(), 'getTipFloorLamports').mockResolvedValue(null as any);
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE' } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
    vi.spyOn(PumpCurveService, 'calculateSellQuote').mockReturnValue({ expectedJitoTipLamports: 0, minOutputLamports: 1 } as any);
    vi.spyOn(txBuilder, 'buildSellTransaction').mockResolvedValue({ message: { recentBlockhash: 'AnyBlockhash' } } as any);
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '1000000000', tokenDecimals: 6, timestamp: Date.now() });
    vi.spyOn(c, 'canExecuteLive').mockReturnValue({ allowed: true, reasons: [], readiness: { ready: true } as any } as any);
    const id = `cl_sell_${uid()}`;
    const now = Date.now();
    workstationDb.savePosition({
      id, mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'CL', name: 'CL', tokenDecimals: 6, tokenQuantityRaw: '1000000000', entryPriceSol: 0.0001,
      currentPriceSol: 0.00005, currentValueSol: 0.05, costBasisLamports: 100_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE',
      executionMode: 'LIVE', entryTxSignature: `sig_${id}`, entryTimestamp: now, lastMarkTimestamp: now, recordUpdatedAt: now, updatedAt: now,
    } as any);
    stopAndRelease(c, signerLock);
    const res = await c.closePosition(id, 100, 'STOP_LOSS');
    expect(res.success).toBe(false);
    expect(res.error).toContain(INSTANCE_LOCK_LOST);
    expect(sign).not.toHaveBeenCalled();
    expect(fs.existsSync(signerLock)).toBe(false);
    workstationDb.savePosition({ ...workstationDb.loadPositions().find((p) => p.id === id)!, status: 'CLOSED', tokenQuantityRaw: '0' } as any);
  });

  // Last in the file: it stops the module singleton for good.
  it('the panic stops retrying a pending sell once the coordinator is stopped', async () => {
    const saved = { wait: PANIC_PENDING_SELL_WAIT_MS.value, poll: PANIC_PENDING_SELL_POLL_MS.value, buy: PANIC_BUY_SETTLE_WAIT_MS.value };
    PANIC_PENDING_SELL_WAIT_MS.value = 2_000;
    PANIC_PENDING_SELL_POLL_MS.value = 5;
    PANIC_BUY_SETTLE_WAIT_MS.value = 0;
    try {
      for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0' } as any);
      vi.spyOn(autoSnipeController, 'kill').mockResolvedValue(undefined as any);
      vi.spyOn(autoSnipeController, 'getMode').mockReturnValue('OFF' as any);
      const id = `cl_panic_${uid()}`;
      const now = Date.now();
      workstationDb.savePosition({
        id, mint: Keypair.generate().publicKey.toBase58(), symbol: 'PND', name: 'CL panic', tokenDecimals: 6, tokenQuantityRaw: '1000000000',
        entryPriceSol: 1e-7, currentPriceSol: 1e-7, currentValueSol: 0.0001, costBasisLamports: 100_000, realizedPnLSol: 0, status: 'OPEN',
        venue: 'PUMP_BONDING_CURVE', executionMode: 'LIVE', entryTxSignature: `CLPanic${id}`, entryTimestamp: now, lastMarkTimestamp: now, recordUpdatedAt: now, updatedAt: now,
      } as any);
      let calls = 0;
      vi.spyOn(executionCoordinator, 'closePosition').mockImplementation(async () => {
        calls++;
        if (calls === 1) executionCoordinator.cleanup(); // the harness stops trading while the panic waits on the pending sell
        return { success: false, pnlSol: 0, error: 'SELL_PENDING_VERIFICATION: still pending' };
      });
      const report = await emergencyStop({ exitAll: true, reason: 'cleanup during the panic' });
      expect(calls).toBe(1);
      expect(report.failed.find((f) => f.id === id)?.error).toMatch(/^SELL_PENDING_VERIFICATION: .*the coordinator was stopped/);
      workstationDb.savePosition({ ...workstationDb.loadPositions().find((p) => p.id === id)!, status: 'CLOSED', tokenQuantityRaw: '0' } as any);
    } finally {
      riskEngine.setKillSwitch(false);
      PANIC_PENDING_SELL_WAIT_MS.value = saved.wait;
      PANIC_PENDING_SELL_POLL_MS.value = saved.poll;
      PANIC_BUY_SETTLE_WAIT_MS.value = saved.buy;
    }
  });
});
