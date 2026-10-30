import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { TradeReconciler } from '../server/execution/reconciliation';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1 } from './e2e/helpers/simulatedStates';

/**
 * Round 14 (R14-1, R14-3, R14-13): how startup reconciliation (step 4) books a SELL that landed before a restart. Real coordinator and
 * SQLite; only the RPC answers and the fill reader at the RPC boundary (recoverInterruptedTransaction) are scripted.
 */
describe('R14: startup reconciliation books a landed SELL once, from the row, onto the right position', () => {
  let coordinator: ExecutionCoordinator;
  let mockRpc: MockSolanaRpc;
  let conn: any;
  let wallet: Keypair;
  const mint = VALID_PUMP_MINT_1.toBase58();
  const uid = () => Math.random().toString(36).slice(2);
  const SELL_SLOT = 500;
  const confirmed = { context: { slot: SELL_SLOT + 10 }, value: [{ slot: SELL_SLOT, confirmations: null, err: null, confirmationStatus: 'finalized' }] };

  const livePosition = (id: string, extra: Record<string, unknown> = {}) => {
    workstationDb.savePosition({
      id, mint, symbol: 'R14', name: 'R14', tokenDecimals: 6, tokenQuantityRaw: '1000', entryPriceSol: 1e-4, currentPriceSol: 1e-4,
      currentValueSol: 0.1, costBasisLamports: 100_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE',
      executionMode: 'LIVE', entryTxSignature: `sig_${id}`, entrySlot: 100, entryTimestamp: Date.now() - 10 * 60_000, lastMarkTimestamp: Date.now(),
      walletPubkey: wallet.publicKey.toBase58(), ...extra,
    } as any);
  };
  const sellRow = (sig: string, extra: Record<string, unknown> = {}) =>
    workstationDb.saveTransaction({ signature: sig, orderId: `o_${uid()}`, correlationId: 'c', mint, direction: 'SELL', submissionTransport: 'SOLANA_RPC', submissionTime: Date.now() - 5 * 60_000, reconciliationState: 'PENDING', networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE', exitReason: 'TAKE_PROFIT_1', ...extra } as any);
  const stateOf = (sig: string) => workstationDb.loadTransactions().find((t) => t.signature === sig)?.reconciliationState;
  const rowOf = (id: string) => workstationDb.loadPositions().find((p) => p.id === id)!;
  const clearLedger = () => {
    for (const p of workstationDb.loadPositions()) if (p.status !== 'CLOSED') workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0 } as any);
    for (const t of workstationDb.loadTransactions()) if (['PENDING', 'RECONCILIATION_REQUIRED'].includes(t.reconciliationState)) workstationDb.saveTransaction({ ...t, reconciliationState: 'REVERTED' });
  };
  /** The fill reader's answer for a landed sell, as recoverInterruptedTransaction reads it for the wallet. */
  const landedSell = (o: { sold: string; before: string; after: string; received: number }) =>
    vi.spyOn(TradeReconciler, 'recoverInterruptedTransaction').mockResolvedValue({
      recovered: true, type: 'SELL', mint, tokenDecimals: 6, tokensSoldRaw: o.sold, tokenBeforeRaw: o.before, tokenAfterRaw: o.after,
      remainingTokensRaw: o.after, solReceivedLamports: o.received, blockTime: Date.now() - 4 * 60_000, slot: SELL_SLOT,
    } as any);

  beforeEach(async () => {
    mockRpc = new MockSolanaRpc();
    wallet = Keypair.generate();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(wallet.publicKey);
    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
    coordinator.orphanRecoveryDelaysMs = [];
    conn = (coordinator as any).connection;
    conn.getBalance = vi.fn(async () => 1_000_000_000);
    conn.getParsedTokenAccountsByOwner = vi.fn(async () => ({ context: { slot: 1 }, value: [] }));
    conn.getSignatureStatuses = vi.fn(async () => ({ context: { slot: 1 }, value: [null] }));
    (coordinator as any).rpcHealth = 'HEALTHY';
    await vi.waitFor(() => expect(coordinator.getReconciliationStatus()).not.toBeNull()); // the boot pass a directly built coordinator starts
    await (coordinator as any).reconcileInFlight?.catch(() => undefined);
    vi.spyOn(coordinator as any, 'scheduleReconcileRetry').mockImplementation(() => undefined);
    clearLedger();
    (coordinator as any).pendingSells.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    coordinator.cleanup();
    mockRpc.clear();
    clearLedger();
  });

  it('R14-1: a landed partial booked by step 4 is no longer a pending sell, so the next exit does not book it again', async () => {
    const id = `r141_${uid()}`;
    livePosition(id);
    const sig = `r141sell_${uid()}`;
    sellRow(sig);
    (coordinator as any).seedPendingSellsFromLedger(); // what start() does on a restart, before the reconciliation pass
    expect((coordinator as any).pendingSells.get(id)?.signature).toBe(sig);

    conn.getSignatureStatuses = vi.fn(async () => confirmed);
    conn.getTransaction = vi.fn(async () => ({ slot: SELL_SLOT, blockTime: Math.floor(Date.now() / 1000) - 240, meta: { err: null, fee: 5000 } }));
    conn.getTokenAccountBalance = vi.fn(async () => ({ context: { slot: SELL_SLOT + 10 }, value: { amount: '670' } }));
    landedSell({ sold: '330', before: '1000', after: '670', received: 40_000_000 });
    await coordinator.startupReconciliation();

    expect(stateOf(sig)).toBe('RECONCILED');
    const booked = rowOf(id);
    expect(booked.tokenQuantityRaw).toBe('670');
    expect((coordinator as any).pendingSells.has(id)).toBe(false);
  });

  it('R14-3: a landed partial is sized against the row, not the wallet balance before it (the wallet holds extra tokens)', async () => {
    const id = `r143_${uid()}`;
    livePosition(id); // the row holds 1000 for 0.1 SOL
    const sig = `r143sell_${uid()}`;
    sellRow(sig);
    conn.getSignatureStatuses = vi.fn(async () => confirmed);
    conn.getTransaction = vi.fn(async () => ({ slot: SELL_SLOT, blockTime: Math.floor(Date.now() / 1000) - 240, meta: { err: null, fee: 5000 } }));
    conn.getTokenAccountBalance = vi.fn(async () => ({ context: { slot: SELL_SLOT + 10 }, value: { amount: '1000' } }));
    // the wallet held 1500 (500 sent in from outside); the sell sold 500, half of the row
    landedSell({ sold: '500', before: '1500', after: '1000', received: 60_000_000 });
    await coordinator.startupReconciliation();
    const row = rowOf(id);
    expect(stateOf(sig)).toBe('RECONCILED');
    expect(row.status).toBe('PARTIALLY_CLOSED');
    expect(row.tokenQuantityRaw).toBe('500'); // the row's 1000 less the 500 sold; the wallet's extra 500 stays untracked
    expect(row.costBasisLamports).toBe(50_000_000); // half of the basis went with half of the row
    expect(row.realizedPnLSol).toBeCloseTo(0.01, 9); // 0.06 SOL received for 0.05 SOL of basis
  });

  it('R14-3: a landed sell of at least the whole row closes it, even with tokens left in the wallet', async () => {
    const id = `r143b_${uid()}`;
    livePosition(id);
    const sig = `r143bsell_${uid()}`;
    sellRow(sig, { exitReason: 'STOP_LOSS' });
    conn.getSignatureStatuses = vi.fn(async () => confirmed);
    conn.getTransaction = vi.fn(async () => ({ slot: SELL_SLOT, blockTime: Math.floor(Date.now() / 1000) - 240, meta: { err: null, fee: 5000 } }));
    conn.getTokenAccountBalance = vi.fn(async () => ({ context: { slot: SELL_SLOT + 10 }, value: { amount: '500' } }));
    landedSell({ sold: '1000', before: '1500', after: '500', received: 70_000_000 });
    await coordinator.startupReconciliation();
    const row = rowOf(id);
    expect(row.status).toBe('CLOSED');
    expect(row.tokenQuantityRaw).toBe('0');
    expect(row.costBasisLamports).toBe(0);
    expect(row.realizedPnLSol).toBeCloseTo(-0.03, 9);
  });

  it('R14-1: a pending sell that step 4 finds reverted on chain is dropped too', async () => {
    const id = `r141r_${uid()}`;
    livePosition(id);
    const sig = `r141rev_${uid()}`;
    sellRow(sig);
    (coordinator as any).seedPendingSellsFromLedger();
    expect((coordinator as any).pendingSells.get(id)?.signature).toBe(sig);
    conn.getSignatureStatuses = vi.fn(async () => ({ context: { slot: 1 }, value: [{ slot: SELL_SLOT, confirmations: null, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'finalized' }] }));
    conn.getTokenAccountBalance = vi.fn(async () => ({ context: { slot: SELL_SLOT + 10 }, value: { amount: '1000' } }));
    await coordinator.startupReconciliation();
    expect(stateOf(sig)).toBe('REVERTED');
    expect((coordinator as any).pendingSells.has(id)).toBe(false);
  });
});
