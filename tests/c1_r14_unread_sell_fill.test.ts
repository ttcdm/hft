import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { TradeReconciler } from '../server/execution/reconciliation';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT } from './e2e/helpers/simulatedStates';
import { settleLeftoverLiveBuys } from './helpers/leftoverBuys';

/**
 * R1 #4 / R5-28 (and the synthesiser's chain 2): a landed sell adopted while its fill cannot be read used to close (or shrink) the position
 * at zero basis with no loss booked, so the daily-loss gate never saw the cost. Now the sold share of the basis is booked as an assumed loss
 * at once, and reconciliation adds the proceeds when the fill becomes readable, exactly once. Real coordinator and SQLite; the RPC and the
 * fill readers are scripted at their boundary. Keys are fresh throwaway values.
 */
describe('R1 #4 / R5-28: an adopted sell whose fill cannot be read', () => {
  let coordinator: ExecutionCoordinator;
  let mockRpc: MockSolanaRpc;
  let conn: any;
  let wallet: Keypair;
  const mint = VALID_PUMP_MINT_1.toBase58();
  const uid = () => Math.random().toString(36).slice(2);
  const row = (id: string) => workstationDb.loadPositions().find((p) => p.id === id)!;
  const txState = (sig: string) => workstationDb.loadTransactions().find((t) => t.signature === sig);

  const seed = () => {
    const id = `r14_${uid()}`;
    workstationDb.savePosition({
      id, mint, symbol: 'R14', name: 'R14', tokenDecimals: 6, tokenQuantityRaw: '1000', entryPriceSol: 1e-4, currentPriceSol: 1e-4,
      currentValueSol: 0.1, costBasisLamports: 100_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE',
      executionMode: 'LIVE', entryTxSignature: `sig_${id}`, entryTimestamp: Date.now(), lastMarkTimestamp: Date.now(),
      walletPubkey: wallet.publicKey.toBase58(),
    } as any);
    const sig = `r14sell_${uid()}`;
    workstationDb.saveTransaction({ signature: sig, orderId: `ord-exit-${uid()}`, correlationId: 'c', mint, direction: 'SELL', submissionTransport: 'SOLANA_RPC', submissionTime: Date.now() - 30_000, reconciliationState: 'PENDING', networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE', exitReason: 'STOP_LOSS' } as any);
    (coordinator as any).pendingSells.set(id, { signature: sig, ts: Date.now() - 30_000 });
    return { id, sig };
  };
  const clearLedger = () => {
    for (const p of workstationDb.loadPositions()) if (p.status !== 'CLOSED') workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0 } as any);
    for (const t of workstationDb.loadTransactions()) if (['PENDING', 'RECONCILIATION_REQUIRED'].includes(t.reconciliationState)) workstationDb.saveTransaction({ ...t, reconciliationState: 'REVERTED' });
    settleLeftoverLiveBuys();
  };

  beforeEach(async () => {
    mockRpc = new MockSolanaRpc();
    wallet = Keypair.generate();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(wallet.publicKey);
    PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() } as any;
    PumpCurveService.cachedFeeConfig = { feeBps: 100 } as any;
    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
    coordinator.orphanRecoveryDelaysMs = [];
    conn = (coordinator as any).connection;
    conn.getBalance = vi.fn(async () => 1_000_000_000);
    conn.getParsedTokenAccountsByOwner = vi.fn(async () => ({ context: { slot: 1 }, value: [] }));
    (coordinator as any).rpcHealth = 'HEALTHY';
    await vi.waitFor(() => expect(coordinator.getReconciliationStatus()).not.toBeNull());
    await (coordinator as any).reconcileInFlight?.catch(() => undefined);
    vi.spyOn(coordinator as any, 'scheduleReconcileRetry').mockImplementation(() => undefined);
    vi.spyOn(coordinator, 'canExecuteLive').mockReturnValue({ allowed: true, reasons: [], readiness: { ready: true } as any } as any);
    vi.spyOn(TradeReconciler, 'reconcileSellTransaction').mockResolvedValue({ success: false, error: 'fill not readable' } as any);
    clearLedger();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    coordinator.cleanup();
    mockRpc.clear();
    clearLedger();
  });

  it('a full sell: the position closes with its basis booked as an assumed loss (daily figure included), and the SELL row is kept for reconcile', async () => {
    const { id, sig } = seed();
    conn.getTokenAccountBalance = vi.fn(async () => ({ context: { slot: 10 }, value: { amount: '0' } }));
    const dayBefore = workstationDb.getDailyRealizedPnLSol('LIVE');
    const res = await coordinator.closePosition(id, 100, 'STOP_LOSS');
    expect(res.success).toBe(true);
    expect(res.pnlSol).toBeCloseTo(-0.1, 9);
    expect(row(id).status).toBe('CLOSED');
    expect(row(id).realizedPnLSol).toBeCloseTo(-0.1, 9);
    expect(workstationDb.getDailyRealizedPnLSol('LIVE')).toBeCloseTo(dayBefore - 0.1, 9);
    expect(txState(sig)?.reconciliationState).toBe('RECONCILIATION_REQUIRED');

    // reconciliation reads the fill later: 0.13 SOL of net proceeds. Realized becomes +0.03, booked once.
    conn.getSignatureStatuses = vi.fn(async () => ({ context: { slot: 1 }, value: [{ slot: 9, confirmations: null, err: null, confirmationStatus: 'finalized' }] }));
    conn.getTransaction = vi.fn(async () => ({ slot: 9, blockTime: 1, meta: { err: null, fee: 5000 } }));
    vi.spyOn(TradeReconciler, 'recoverInterruptedTransaction').mockResolvedValue({ recovered: true, type: 'SELL', mint, remainingTokensRaw: '0', tokensSoldRaw: '1000', tokenBeforeRaw: '1000', solReceivedLamports: 130_000_000, slot: 9, blockTime: 1 } as any);
    await coordinator.startupReconciliation({ fresh: true });
    expect(row(id).realizedPnLSol).toBeCloseTo(0.03, 6);
    expect(txState(sig)?.reconciliationState).toBe('RECONCILED');
    expect(workstationDb.getDailyRealizedPnLSol('LIVE')).toBeCloseTo(dayBefore + 0.03, 6);
    await coordinator.startupReconciliation({ fresh: true });
    expect(row(id).realizedPnLSol).toBeCloseTo(0.03, 6); // not booked twice
  });

  it('R5-28: a partial sell books only the sold share of the basis and keeps the rest on the open remainder', async () => {
    const { id, sig } = seed();
    conn.getTokenAccountBalance = vi.fn(async () => ({ context: { slot: 10 }, value: { amount: '600' } }));
    const res = await coordinator.closePosition(id, 100, 'STOP_LOSS');
    expect(res.success).toBe(true);
    const r = row(id);
    expect(r.status).toBe('PARTIALLY_CLOSED');
    expect(r.tokenQuantityRaw).toBe('600');
    expect(r.costBasisLamports).toBe(60_000_000);
    expect(r.realizedPnLSol).toBeCloseTo(-0.04, 9);
    expect(txState(sig)?.reconciliationState).toBe('RECONCILIATION_REQUIRED');
  });
});
