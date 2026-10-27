import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator, LIVE_BUY_FILLED } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { TradeReconciler } from '../server/execution/reconciliation';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';

/**
 * R2-4, R4-4, R5-5, R7-3 (and R2-14, the synthesiser's chain 3): one model for unresolved LIVE buys. Recovery is single-flight and journals
 * a buy's SOL once; a landed buy left PENDING is recovered like a RECONCILIATION_REQUIRED one; the retries never stop while a buy is
 * unresolved; and readiness is not green meanwhile. Real coordinator and SQLite; the chain read (recoverInterruptedTransaction) is scripted.
 */
describe('C1: unresolved LIVE buys', () => {
  let coordinator: ExecutionCoordinator;
  let mockRpc: MockSolanaRpc;
  let wallet: Keypair;
  const uid = () => Math.random().toString(36).slice(2);

  const buyRow = (sig: string, mint: string, state: 'PENDING' | 'RECONCILIATION_REQUIRED') =>
    workstationDb.saveTransaction({ signature: sig, orderId: `o_${uid()}`, correlationId: 'c', mint, direction: 'BUY', submissionTransport: 'SOLANA_RPC', submissionTime: Date.now() - 60_000, reconciliationState: state, networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE' } as any);
  const landed = (mint: string) => ({ recovered: true, type: 'BUY', mint, tokenQuantityRaw: '5000000', tokenDecimals: 6, solSpentLamports: 20_000_000, curveSpendLamports: 18_000_000, networkFeeLamports: 5000, slot: 9, blockTime: 1 });
  const fillRows = (sig: string) => workstationDb.loadDecisions({ outcome: LIVE_BUY_FILLED, limit: 1000 }).filter((d) => d.positionId === sig);
  const clearLedger = () => {
    for (const p of workstationDb.loadPositions()) if (p.status !== 'CLOSED') workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0 } as any);
    for (const t of workstationDb.loadTransactions()) if (['PENDING', 'RECONCILIATION_REQUIRED'].includes(t.reconciliationState)) workstationDb.saveTransaction({ ...t, reconciliationState: 'REVERTED' });
  };

  beforeEach(async () => {
    mockRpc = new MockSolanaRpc();
    wallet = Keypair.generate();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(wallet.publicKey);
    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
    coordinator.orphanRecoveryDelaysMs = [];
    await vi.waitFor(() => expect(coordinator.getReconciliationStatus()).not.toBeNull());
    await (coordinator as any).reconcileInFlight?.catch(() => undefined);
    vi.spyOn(coordinator as any, 'sellIfLateBuyAdopted').mockImplementation(() => undefined);
    clearLedger();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    coordinator.cleanup();
    mockRpc.clear();
    clearLedger();
  });

  it('R2-4: two recovery passes at once adopt the buy once and journal its SOL once', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const sig = `r24_${uid()}`;
    buyRow(sig, mint, 'RECONCILIATION_REQUIRED');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const read = vi.spyOn(TradeReconciler, 'recoverInterruptedTransaction').mockImplementation(async () => { await gate; return landed(mint) as any; });
    const a = coordinator.recoverOrphanedBuys();
    const b = coordinator.recoverOrphanedBuys();
    release();
    await Promise.all([a, b]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(workstationDb.loadPositions().filter((p) => p.entryTxSignature === sig)).toHaveLength(1);
    expect(fillRows(sig)).toHaveLength(1);
  });

  it('R2-4: the buy journal row is keyed on the signature, so a second writer of the same buy writes nothing', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const sig = `r24j_${uid()}`;
    const pos = { id: sig, mint, symbol: 'J', entryTxSignature: sig, executionMode: 'LIVE' } as any;
    (coordinator as any).journalLiveBuySolDelta(pos, 20_000_000, 'ORPHAN_RECOVERY', 'RECOVERED');
    (coordinator as any).journalLiveBuySolDelta(pos, 20_000_000, 'STARTUP_RECONCILIATION', 'RECOVERED');
    expect(fillRows(sig)).toHaveLength(1);
  });

  it('R4-4 / R5-5: a landed buy left PENDING is recovered into a position; one this process is still sending is left alone', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const sig = `r44_${uid()}`;
    buyRow(sig, mint, 'PENDING');
    const sending = Keypair.generate().publicKey.toBase58();
    const sendingSig = `r44s_${uid()}`;
    buyRow(sendingSig, sending, 'PENDING');
    (coordinator as any).inFlightBuyMints.add(sending);
    const read = vi.spyOn(TradeReconciler, 'recoverInterruptedTransaction').mockImplementation(async (_c, s: string) => landed(s === sig ? mint : sending) as any);
    const r = await coordinator.recoverOrphanedBuys();
    expect(r.recovered).toContain(sig);
    expect(read.mock.calls.map((c) => c[1])).not.toContain(sendingSig);
    expect(workstationDb.loadPositions().find((p) => p.entryTxSignature === sig)?.status).toBe('OPEN');
    expect(workstationDb.loadTransactions().find((t) => t.signature === sig)?.reconciliationState).toBe('RECONCILED');
    expect(workstationDb.loadTransactions().find((t) => t.signature === sendingSig)?.reconciliationState).toBe('PENDING');
    (coordinator as any).inFlightBuyMints.delete(sending);
  });

  it('R7-3: background recovery keeps retrying at the last step for as long as a buy is unresolved, as one chain', async () => {
    vi.useFakeTimers();
    coordinator.orphanRecoveryDelaysMs = [10, 20, 50];
    const pass = vi.spyOn(coordinator, 'recoverOrphanedBuys').mockResolvedValue({ recovered: [], stillOrphaned: ['x'] });
    (coordinator as any).scheduleOrphanRecovery();
    (coordinator as any).scheduleOrphanRecovery(); // a second failed buy: still one chain, restarted
    await vi.advanceTimersByTimeAsync(10 + 20 + 50 * 6);
    expect(pass).toHaveBeenCalledTimes(2 + 6); // the old ladder stopped after 3
    pass.mockResolvedValue({ recovered: ['x'], stillOrphaned: [] });
    await vi.advanceTimersByTimeAsync(50);
    const calls = pass.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(pass.mock.calls.length).toBe(calls); // resolved: the chain stops
  });

  it('R7-3: an unresolved landed buy keeps LIVE readiness from going green and refuses the next LIVE buy', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const sig = `r73_${uid()}`;
    buyRow(sig, mint, 'RECONCILIATION_REQUIRED');
    vi.spyOn(TradeReconciler, 'recoverInterruptedTransaction').mockResolvedValue({ recovered: false, type: 'BUY', error: 'could not reconstruct' } as any);
    vi.spyOn(ExecutionCoordinator.prototype as any, 'liveBuyReadinessProblems').mockRestore(); // the suite setup stubs it green (tests/setup/devnetGuard.ts)
    await coordinator.recoverOrphanedBuys();
    const reasons = coordinator.canExecuteLive().reasons.join(' | ');
    expect(reasons).toMatch(/not resolved and may hold tokens with no stop-loss/);
    expect((coordinator as any).liveBuyReadinessProblems().join(' ')).toMatch(/not resolved/);
    vi.spyOn(TradeReconciler, 'recoverInterruptedTransaction').mockResolvedValue(landed(mint) as any);
    await coordinator.recoverOrphanedBuys();
    expect((coordinator as any).liveBuyReadinessProblems().join(' ')).not.toMatch(/not resolved/);
  });

  it('R5-5: a startup pass that leaves a landed buy unresolved starts the background retries', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    buyRow(`r55_${uid()}`, mint, 'RECONCILIATION_REQUIRED');
    vi.spyOn(TradeReconciler, 'recoverInterruptedTransaction').mockResolvedValue({ recovered: false, type: 'BUY', error: 'could not reconstruct' } as any);
    const sched = vi.spyOn(coordinator as any, 'scheduleOrphanRecovery').mockImplementation(() => undefined);
    (coordinator as any).rpcHealth = 'HEALTHY';
    await coordinator.startupReconciliation({ fresh: true });
    expect(sched).toHaveBeenCalled();
  });

  it('R5-5: a status-read error at startup leaves a PENDING buy as it is, but the pass is a mismatch and background recovery is started', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const sig = `r55e_${uid()}`;
    buyRow(sig, mint, 'PENDING');
    const conn: any = (coordinator as any).connection;
    conn.getSignatureStatuses = vi.fn(async () => { throw new Error('429 Too Many Requests'); });
    conn.getBalance = vi.fn(async () => 1_000_000_000);
    conn.getParsedTokenAccountsByOwner = vi.fn(async () => ({ context: { slot: 1 }, value: [] }));
    vi.spyOn(coordinator as any, 'scheduleReconcileRetry').mockImplementation(() => undefined);
    const sched = vi.spyOn(coordinator as any, 'scheduleOrphanRecovery').mockImplementation(() => undefined);
    (coordinator as any).rpcHealth = 'HEALTHY';
    const res = await coordinator.startupReconciliation({ fresh: true });
    expect(res.status).toBe('RECONCILIATION_MISMATCH');
    expect(res.details).toMatch(/could not be checked/);
    expect(sched).toHaveBeenCalled();
    expect(workstationDb.loadTransactions().find((t) => t.signature === sig)?.reconciliationState).toBe('PENDING');
  });
});
