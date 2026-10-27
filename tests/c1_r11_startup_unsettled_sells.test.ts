import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { TradeReconciler } from '../server/execution/reconciliation';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1 } from './e2e/helpers/simulatedStates';

/**
 * R1 #1, R5-3, R7-18: startup reconciliation never closes a position as an assumed loss while one of its sells is unsettled, retries SELL
 * rows left RECONCILIATION_REQUIRED, leaves a confirmed row alone on a boot with no signer, and never expires a transaction that has a
 * status. Real coordinator and SQLite; only the RPC answers (and the fill reader at the RPC boundary) are scripted.
 */
describe('R1 #1 / R5-3 / R7-18: startup reconciliation and unsettled sells', () => {
  let coordinator: ExecutionCoordinator;
  let mockRpc: MockSolanaRpc;
  let conn: any;
  let wallet: Keypair;
  const mint = VALID_PUMP_MINT_1.toBase58();
  const uid = () => Math.random().toString(36).slice(2);
  const confirmed = { context: { slot: 1 }, value: [{ slot: 5, confirmations: null, err: null, confirmationStatus: 'finalized' }] };

  const livePosition = (id: string) => {
    workstationDb.savePosition({
      id, mint, symbol: 'R11', name: 'R11', tokenDecimals: 6, tokenQuantityRaw: '1000', entryPriceSol: 1e-4, currentPriceSol: 1e-4,
      currentValueSol: 0.1, costBasisLamports: 100_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE',
      executionMode: 'LIVE', entryTxSignature: `sig_${id}`, entryTimestamp: Date.now(), lastMarkTimestamp: Date.now(),
      walletPubkey: wallet.publicKey.toBase58(),
    } as any);
  };
  const sellRow = (sig: string, state: 'PENDING' | 'RECONCILIATION_REQUIRED', extra: Record<string, unknown> = {}) =>
    workstationDb.saveTransaction({ signature: sig, orderId: `o_${uid()}`, correlationId: 'c', mint, direction: 'SELL', submissionTransport: 'SOLANA_RPC', submissionTime: Date.now() - 5 * 60_000, reconciliationState: state, networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE', ...extra } as any);
  const stateOf = (sig: string) => workstationDb.loadTransactions().find((t) => t.signature === sig)?.reconciliationState;
  const clearLedger = () => {
    for (const p of workstationDb.loadPositions()) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0 } as any);
    for (const t of workstationDb.loadTransactions()) if (['PENDING', 'RECONCILIATION_REQUIRED'].includes(t.reconciliationState)) workstationDb.saveTransaction({ ...t, reconciliationState: 'REVERTED' });
  };

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
    conn.getTokenAccountBalance = vi.fn(async () => ({ value: { amount: '1000' } }));
    (coordinator as any).rpcHealth = 'HEALTHY';
    await vi.waitFor(() => expect(coordinator.getReconciliationStatus()).not.toBeNull()); // the boot pass a directly built coordinator starts
    await (coordinator as any).reconcileInFlight?.catch(() => undefined);
    vi.spyOn(coordinator as any, 'scheduleReconcileRetry').mockImplementation(() => undefined);
    clearLedger();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    coordinator.cleanup();
    mockRpc.clear();
    clearLedger();
  });

  it('R1 #1: a SELL left RECONCILIATION_REQUIRED keeps its zero-balance position open and books no assumed loss', async () => {
    const id = `r11_${uid()}`;
    livePosition(id);
    const sig = `r11sell_${uid()}`;
    sellRow(sig, 'RECONCILIATION_REQUIRED');
    conn.getSignatureStatuses = vi.fn(async () => confirmed);
    conn.getTransaction = vi.fn(async () => null); // still unreadable on this pass
    conn.getTokenAccountBalance = vi.fn(async () => ({ value: { amount: '0' } })); // the sell landed, so the wallet holds nothing
    const journal = vi.spyOn(workstationDb, 'logJournal');
    const res = await coordinator.startupReconciliation();
    const row = workstationDb.loadPositions().find((p) => p.id === id)!;
    expect(row.status).toBe('OPEN');
    expect(row.costBasisLamports).toBe(100_000_000);
    expect(journal.mock.calls.some((c) => c[0] === 'REALIZED_ASSUMED_LOSS')).toBe(false);
    expect(res.status).toBe('RECONCILIATION_MISMATCH');
  });

  it('R1 #1: a SELL left RECONCILIATION_REQUIRED is tried again, and applied with its PnL once its fill can be read', async () => {
    const id = `r11b_${uid()}`;
    livePosition(id);
    const sig = `r11bsell_${uid()}`;
    sellRow(sig, 'RECONCILIATION_REQUIRED');
    conn.getSignatureStatuses = vi.fn(async () => confirmed);
    conn.getTransaction = vi.fn(async () => ({ slot: 5, blockTime: 1, meta: { err: null, fee: 5000 } }));
    conn.getTokenAccountBalance = vi.fn(async () => ({ value: { amount: '0' } }));
    vi.spyOn(TradeReconciler, 'recoverInterruptedTransaction').mockResolvedValue({ recovered: true, type: 'SELL', mint, remainingTokensRaw: '0', tokensSoldRaw: '1000', tokenBeforeRaw: '1000', solReceivedLamports: 130_000_000, blockTime: 1, slot: 5 } as any);
    await coordinator.startupReconciliation();
    const row = workstationDb.loadPositions().find((p) => p.id === id)!;
    expect(row.status).toBe('CLOSED');
    expect(row.realizedPnLSol).toBeCloseTo(0.03, 9);
    expect(row.exitTxSignature).toBe(sig);
    expect(stateOf(sig)).toBe('RECONCILED');
  });

  it('R5-3: a confirmed row read on a boot with no signer stays as it was (not RECONCILIATION_REQUIRED)', async () => {
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('NOT_CONFIGURED');
    const sig = `r53_${uid()}`;
    sellRow(sig, 'PENDING');
    conn.getSignatureStatuses = vi.fn(async () => confirmed);
    conn.getTransaction = vi.fn(async () => ({ slot: 5, blockTime: 1, meta: { err: null, fee: 5000 } }));
    await coordinator.startupReconciliation();
    expect(stateOf(sig)).toBe('PENDING');
  });

  it('R7-18: a processed (landed, not yet confirmed) sell past its blockhash height is not TIMED_OUT', async () => {
    const sig = `r718a_${uid()}`;
    sellRow(sig, 'PENDING', { lastValidBlockHeight: 100 });
    conn.getSignatureStatuses = vi.fn(async () => ({ context: { slot: 1 }, value: [{ slot: 5, confirmations: 0, err: null, confirmationStatus: 'processed' }] }));
    conn.getBlockHeight = vi.fn(async () => 500);
    await coordinator.startupReconciliation();
    expect(stateOf(sig)).toBe('PENDING');
  });

  it('R7-18: "no status" is read again after the block height says expired; a sell seen on that read is not TIMED_OUT', async () => {
    const sig = `r718b_${uid()}`;
    sellRow(sig, 'PENDING', { lastValidBlockHeight: 100 });
    let calls = 0;
    conn.getSignatureStatuses = vi.fn(async () => (++calls === 1
      ? { context: { slot: 1 }, value: [null] } // the first read, before the height
      : { context: { slot: 1 }, value: [{ slot: 5, confirmations: 0, err: null, confirmationStatus: 'processed' }] })); // it landed meanwhile
    conn.getBlockHeight = vi.fn(async () => 500);
    await coordinator.startupReconciliation();
    expect(stateOf(sig)).toBe('PENDING');

    const gone = `r718c_${uid()}`; // and one that is still unseen after the height read is TIMED_OUT, as before
    sellRow(gone, 'PENDING', { lastValidBlockHeight: 100 });
    workstationDb.saveTransaction({ ...workstationDb.loadTransactions().find((t) => t.signature === sig)!, reconciliationState: 'REVERTED' });
    conn.getSignatureStatuses = vi.fn(async () => ({ context: { slot: 1 }, value: [null] }));
    await coordinator.startupReconciliation({ fresh: true });
    expect(stateOf(gone)).toBe('TIMED_OUT');
  });
});
