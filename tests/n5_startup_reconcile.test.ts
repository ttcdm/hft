import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { TradeReconciler } from '../server/execution/reconciliation';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1 } from './e2e/helpers/simulatedStates';

/** N5/N6/N8/N9: startup reconciliation against awkward ledger states. Real coordinator and SQLite; only the RPC answers are scripted. */
describe('N5-N9: startup reconciliation does not wedge readiness on states that can never resolve', () => {
  let coordinator: ExecutionCoordinator;
  let mockRpc: MockSolanaRpc;
  let conn: any;
  const mint = VALID_PUMP_MINT_1.toBase58();
  const uid = () => Math.random().toString(36).slice(2);

  const livePosition = (id: string, status: 'OPEN' | 'CLOSED' = 'OPEN') => {
    workstationDb.savePosition({
      id, mint, symbol: 'N5', name: 'N5', tokenDecimals: 6, tokenQuantityRaw: status === 'OPEN' ? '1000' : '0', entryPriceSol: 1e-4, currentPriceSol: 1e-4,
      currentValueSol: 0.1, costBasisLamports: status === 'OPEN' ? 100_000_000 : 0, realizedPnLSol: 0, status, venue: 'PUMP_BONDING_CURVE',
      executionMode: 'LIVE', entryTxSignature: `sig_${id}`, entryTimestamp: Date.now(), lastMarkTimestamp: Date.now(),
      recordUpdatedAt: Date.now(), updatedAt: Date.now(),
      walletPubkey: localSigner.getPublicKey().toBase58(), // R4-2: bound to the test signer
    } as any);
  };
  const clearLedger = () => {
    for (const p of workstationDb.loadPositions()) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0 } as any);
    for (const t of workstationDb.loadTransactions()) if (['PENDING', 'RECONCILIATION_REQUIRED'].includes(t.reconciliationState)) workstationDb.saveTransaction({ ...t, reconciliationState: 'REVERTED' });
  };

  beforeEach(() => {
    mockRpc = new MockSolanaRpc();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(Keypair.generate().publicKey);
    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
    conn = (coordinator as any).connection;
    conn.getBalance = vi.fn(async () => 1_000_000_000);
    conn.getParsedTokenAccountsByOwner = vi.fn(async () => ({ context: { slot: 1 }, value: [] }));
    conn.getSignatureStatuses = vi.fn(async () => ({ context: { slot: 1 }, value: [null] }));
    conn.getTokenAccountBalance = vi.fn(async () => ({ value: { amount: '1000' } }));
    (coordinator as any).rpcHealth = 'HEALTHY';
    clearLedger();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    coordinator.cleanup();
    mockRpc.clear();
    clearLedger();
  });

  it('N5: a LIVE position whose token account no longer exists is closed with the reason recorded, and readiness is not held at MISMATCH', async () => {
    const id = `n5_${uid()}`;
    livePosition(id);
    conn.getTokenAccountBalance = vi.fn(async () => { throw new Error('failed to get token account balance: Invalid param: could not find account'); });
    const res = await coordinator.startupReconciliation();
    const row = workstationDb.loadPositions().find((p) => p.id === id)!;
    expect(row.status).toBe('CLOSED');
    expect(row.exitReason).toMatch(/RECONCILED_ZERO_BALANCE/);
    expect(res.status).toBe('EXECUTION_READY');
    expect(coordinator.getOperatorAlerts().some((a) => a.code === 'POSITION_GONE' && a.positionId === id)).toBe(true);
  });

  it('S259 (P2.3, N-28): that close books the cost basis as a realized loss, once, tagged REALIZED_ASSUMED_LOSS', async () => {
    const id = `s259_${uid()}`;
    livePosition(id); // cost basis 0.1 SOL
    conn.getTokenAccountBalance = vi.fn(async () => { throw new Error('failed to get token account balance: Invalid param: could not find account'); });
    const journal = vi.spyOn(workstationDb, 'logJournal');
    const dayBefore = workstationDb.getDailyRealizedPnLSol('LIVE');
    await coordinator.startupReconciliation();
    const row = workstationDb.loadPositions().find((p) => p.id === id)!;
    expect(row.status).toBe('CLOSED');
    expect(row.realizedPnLSol).toBeCloseTo(-0.1, 9);
    expect(row.exitReason).toMatch(/REALIZED_ASSUMED_LOSS/);
    expect(workstationDb.getDailyRealizedPnLSol('LIVE')).toBeCloseTo(dayBefore - 0.1, 9);
    expect(journal.mock.calls.filter((c) => c[0] === 'REALIZED_ASSUMED_LOSS' && (c[3] as any)?.positionId === id)).toHaveLength(1);
    await coordinator.startupReconciliation(); // closed rows are not booked again
    expect(workstationDb.getDailyRealizedPnLSol('LIVE')).toBeCloseTo(dayBefore - 0.1, 9);
  });

  it('N5: an RPC failure while reading the balance is unknown, not zero: the position stays open', async () => {
    const id = `n5_${uid()}`;
    livePosition(id);
    conn.getTokenAccountBalance = vi.fn(async () => { throw new Error('503 service unavailable'); });
    await coordinator.startupReconciliation();
    expect(workstationDb.loadPositions().find((p) => p.id === id)!.status).toBe('OPEN');
  });

  it('N6: a buy that is still not on chain 15 minutes later is TIMED_OUT, a young one stays an orphan', async () => {
    vi.spyOn(TradeReconciler, 'recoverInterruptedTransaction').mockResolvedValue({ recovered: false, error: 'Transaction not found on-chain' } as any);
    const base = { orderId: `o_${uid()}`, correlationId: 'c', mint, direction: 'BUY' as const, submissionTransport: 'SOLANA_RPC' as const, reconciliationState: 'RECONCILIATION_REQUIRED' as const, networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE' as const };
    workstationDb.saveTransaction({ ...base, signature: `old_${uid()}`, submissionTime: Date.now() - 16 * 60_000 } as any);
    workstationDb.saveTransaction({ ...base, signature: `new_${uid()}`, submissionTime: Date.now() - 60_000 } as any);
    const res = await coordinator.recoverOrphanedBuys();
    expect(res.stillOrphaned).toHaveLength(1);
    expect(res.stillOrphaned[0]).toMatch(/^new_/);
    const states = Object.fromEntries(workstationDb.loadTransactions().filter((t) => /^(old|new)_/.test(t.signature)).map((t) => [t.signature.split('_')[0], t.reconciliationState]));
    expect(states).toEqual({ old: 'TIMED_OUT', new: 'RECONCILIATION_REQUIRED' });
  });

  it('N8: a confirmed sell whose position is already closed is reconciled, not held at MISMATCH', async () => {
    const closed = `n8_${uid()}`;
    livePosition(closed, 'CLOSED');
    const sig = `sell_${uid()}`;
    workstationDb.saveTransaction({ signature: sig, orderId: `o_${uid()}`, correlationId: 'c', mint, direction: 'SELL', submissionTransport: 'SOLANA_RPC', submissionTime: Date.now() - 5 * 60_000, reconciliationState: 'PENDING', networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE' } as any);
    conn.getSignatureStatuses = vi.fn(async () => ({ context: { slot: 1 }, value: [{ slot: 5, confirmations: null, err: null, confirmationStatus: 'finalized' }] }));
    conn.getTransaction = vi.fn(async () => ({ slot: 5, blockTime: 1, meta: { err: null, fee: 5000 } }));
    vi.spyOn(TradeReconciler, 'recoverInterruptedTransaction').mockResolvedValue({ recovered: true, type: 'SELL', mint, remainingTokensRaw: '0', tokensSoldRaw: '1000', tokenBeforeRaw: '1000', solReceivedLamports: 1 } as any);
    const res = await coordinator.startupReconciliation();
    expect(workstationDb.loadTransactions().find((t) => t.signature === sig)!.reconciliationState).toBe('RECONCILED');
    expect(res.status).toBe('EXECUTION_READY');
  });

  it('N9: a confirmed signature whose details are unreadable stays PENDING, is reported, and a retry is scheduled', async () => {
    const sig = `n9_${uid()}`;
    workstationDb.saveTransaction({ signature: sig, orderId: `o_${uid()}`, correlationId: 'c', mint, direction: 'BUY', submissionTransport: 'SOLANA_RPC', submissionTime: Date.now() - 5000, reconciliationState: 'PENDING', networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE' } as any);
    conn.getSignatureStatuses = vi.fn(async () => ({ context: { slot: 1 }, value: [{ slot: 5, confirmations: null, err: null, confirmationStatus: 'finalized' }] }));
    conn.getTransaction = vi.fn(async () => null);
    const retry = vi.spyOn(coordinator as any, 'scheduleReconcileRetry').mockImplementation(() => undefined);
    const res = await coordinator.startupReconciliation();
    expect(res.status).toBe('RECONCILIATION_MISMATCH');
    expect(res.details).toMatch(/not readable yet/);
    expect(retry).toHaveBeenCalled();
    expect(workstationDb.loadTransactions().find((t) => t.signature === sig)!.reconciliationState).toBe('PENDING');
  });

  it('S10: a sell still PENDING (its details unreadable) keeps its position open through an empty wallet, and the retry applies it WITH its PnL', async () => {
    const id = `s10_${uid()}`;
    livePosition(id); // cost basis 0.1 SOL, 1000 raw tokens
    const sig = `s10sell_${uid()}`;
    workstationDb.saveTransaction({ signature: sig, orderId: `o_${uid()}`, correlationId: 'c', mint, direction: 'SELL', submissionTransport: 'SOLANA_RPC', submissionTime: Date.now() - 5000, reconciliationState: 'PENDING', networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE' } as any);
    const confirmed = { context: { slot: 1 }, value: [{ slot: 5, confirmations: null, err: null, confirmationStatus: 'finalized' }] };
    conn.getSignatureStatuses = vi.fn(async () => confirmed);
    conn.getTransaction = vi.fn(async () => null); // confirmed, but the details cannot be read yet
    conn.getTokenAccountBalance = vi.fn(async () => ({ value: { amount: '0' } })); // the sell landed, so the wallet holds nothing
    vi.spyOn(coordinator as any, 'scheduleReconcileRetry').mockImplementation(() => undefined);

    const first = await coordinator.startupReconciliation();
    const afterFirst = workstationDb.loadPositions().find((p) => p.id === id)!;
    expect(afterFirst.status).toBe('OPEN'); // was CLOSED by RECONCILED_ZERO_BALANCE with the cost basis zeroed
    expect(afterFirst.costBasisLamports).toBe(100_000_000);
    expect(first.status).toBe('RECONCILIATION_MISMATCH');
    expect(first.details).toMatch(/not settled yet/);
    expect(workstationDb.loadTransactions().find((t) => t.signature === sig)!.reconciliationState).toBe('PENDING');

    // the next pass can read the transaction: the sell is applied with its realized PnL (0.12 SOL received against 0.1 cost)
    // R14-13: it landed after the position's buy (its block time is not before the entry), so it is this position's sell
    conn.getTransaction = vi.fn(async () => ({ slot: 5, blockTime: Math.ceil(Date.now() / 1000), meta: { err: null, fee: 5000 } }));
    vi.spyOn(TradeReconciler, 'recoverInterruptedTransaction').mockResolvedValue({ recovered: true, type: 'SELL', mint, remainingTokensRaw: '0', tokensSoldRaw: '1000', tokenBeforeRaw: '1000', solReceivedLamports: 120_000_000, blockTime: 1, slot: 5 } as any);
    const second = await coordinator.startupReconciliation({ fresh: true });
    const closed = workstationDb.loadPositions().find((p) => p.id === id)!;
    expect(closed.status).toBe('CLOSED');
    expect(closed.realizedPnLSol).toBeCloseTo(0.02, 9); // the PnL the old order lost
    expect(closed.exitTxSignature).toBe(sig);
    expect(second.status).toBe('EXECUTION_READY');
  });

  it('R7 / R7-4: a hung reconciliation is cut off and reported as a mismatch; a new pass starts once the hung one has ended', async () => {
    await coordinator.startupReconciliation(); // let the boot pass the constructor started finish, so the next call starts a new one
    (coordinator as any).reconcileTimeoutMs = 50;
    let endHung!: () => void;
    const hung = vi.spyOn(coordinator as any, 'runStartupReconciliation').mockImplementationOnce(
      () => new Promise((resolve) => { endHung = () => resolve({ status: 'RECONCILIATION_MISMATCH', mismatchesCount: 1, details: 'hung pass ended' }); })
    );
    const first = await coordinator.startupReconciliation();
    expect(first.status).toBe('RECONCILIATION_MISMATCH');
    expect(first.details).toMatch(/did not finish/);
    expect(coordinator.canExecuteLive().reasons.join(' ')).toMatch(/unresolved issues|reconciliation/i);
    const whileHung = await coordinator.startupReconciliation(); // R7-4: no second pass beside the one still running
    expect(hung).toHaveBeenCalledTimes(1);
    expect(whileHung.details).toMatch(/did not finish/);
    endHung();
    await new Promise((r) => setTimeout(r, 0));
    const second = await coordinator.startupReconciliation(); // the hung pass has ended: this one is fresh
    expect(hung).toHaveBeenCalledTimes(2);
    expect(second.details).not.toMatch(/did not finish/);
  });
});
