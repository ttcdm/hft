import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator, exitClaimOwnerAlive, newExitClaimOwner } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { HardenedRiskEngine, type RiskEvaluationRequest } from '../server/risk/riskEngine';
import { executionConfig } from '../server/solana/executionConfig';
import { workstationDb } from '../server/db/database';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { TradeReconciler } from '../server/execution/reconciliation';
import { txBuilder } from '../server/solana/transactionBuilder';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState, createPassingEligibilityReport } from './e2e/helpers/simulatedStates';
import { settleLeftoverLiveBuys } from './helpers/leftoverBuys';

/**
 * G (money-path test gaps A1, A2, A3, A4, B2, D3, C5): each case fails on the code before its fix. Real ExecutionCoordinator and SQLite; the RPC,
 * builder and reconciler are stubbed at their edges, as in n1_exit_core and n5_startup_reconcile. Wallet keys are throwaway values.
 */
const uid = () => Math.random().toString(36).slice(2);
const mint = VALID_PUMP_MINT_1.toBase58();
const row = (id: string) => workstationDb.loadPositions().find((p) => p.id === id)!;
const tx = (sig: string) => workstationDb.loadTransactions().find((t) => t.signature === sig)!;

function seedLive(over: Record<string, unknown> = {}): string {
  const id = `g_${uid()}`;
  workstationDb.savePosition({
    id, mint, symbol: 'G', name: 'G Coin', tokenDecimals: 6, tokenQuantityRaw: '1000000000', entryPriceSol: 0.0001, currentPriceSol: 0.00005,
    currentValueSol: 0.05, costBasisLamports: 100_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE', executionMode: 'LIVE',
    entryTxSignature: `sig_${id}`, entryTimestamp: Date.now(), lastMarkTimestamp: Date.now(), recordUpdatedAt: Date.now(), updatedAt: Date.now(),
    ...over,
  } as any);
  return id;
}

function clearLedger() {
  for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0 } as any);
  for (const t of workstationDb.loadTransactions()) if (['PENDING', 'RECONCILIATION_REQUIRED'].includes(t.reconciliationState)) workstationDb.saveTransaction({ ...t, reconciliationState: 'REVERTED' });
}

describe('G: the sell path (take-profit stage, stale claims, no signer, buys in flight)', () => {
  let coordinator: ExecutionCoordinator;
  let mockRpc: MockSolanaRpc;
  let submit: ReturnType<typeof vi.spyOn>;
  let reconcileSell: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    settleLeftoverLiveBuys();
    clearLedger();
    const kp = Keypair.generate();
    mockRpc = new MockSolanaRpc();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(kp.publicKey);
    vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (t: any) => t);
    PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() };
    PumpCurveService.cachedFeeConfig = { feeBps: 100 };
    const realInit = (ExecutionCoordinator.prototype as any).initializeConnection;
    let initDone: Promise<unknown> = Promise.resolve();
    vi.spyOn(ExecutionCoordinator.prototype as any, 'initializeConnection').mockImplementation(function (this: any) {
      initDone = Promise.resolve(realInit.call(this));
      return initDone;
    });
    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
    await initDone;
    (coordinator as any).connection.simulateTransaction = vi.fn(async () => ({ context: { slot: 1 }, value: { err: null, logs: [] } }));
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE' } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
    vi.spyOn(PumpCurveService, 'calculateSellQuote').mockReturnValue({ expectedJitoTipLamports: 1000, minOutputLamports: 1 } as any);
    vi.spyOn(txBuilder, 'buildSellTransaction').mockResolvedValue({} as any);
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '1000000000', tokenDecimals: 6, timestamp: Date.now() });
    submit = vi.spyOn(coordinator as any, 'submitAndConfirmWithRetry').mockResolvedValue({ success: true, signature: `sell_${uid()}`, transport: 'SOLANA_RPC', slot: 5, lifecycleState: 'CONFIRMED' });
    reconcileSell = vi.spyOn(TradeReconciler, 'reconcileSellTransaction').mockResolvedValue({
      success: true, reconciliationState: 'RECONCILED', actualTokensSoldRaw: '1000000000', tokensSoldHuman: 1000, tokenDecimals: 6,
      actualGrossSolProceedsLamports: 50_000_000, actualNetSolProceedsLamports: 49_000_000, actualNetworkFeeLamports: 5000,
      actualJitoTipLamports: 0, actualRealizedPnLSol: -0.05, remainingTokensRaw: '0', isFullyClosed: true, slot: 6,
    } as any);
    vi.spyOn(coordinator, 'canExecuteLive').mockReturnValue({ allowed: true, reasons: [], readiness: { ready: true } as any } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    coordinator.cleanup();
    mockRpc.clear();
    clearLedger();
  });

  it('A1: a take-profit 1 fill books exitStage 1 in the same write, and its SELL row carries the reason', async () => {
    reconcileSell.mockResolvedValue({
      success: true, reconciliationState: 'RECONCILED', actualTokensSoldRaw: '330000000', tokensSoldHuman: 330, tokenDecimals: 6,
      actualGrossSolProceedsLamports: 20_000_000, actualNetSolProceedsLamports: 19_000_000, actualNetworkFeeLamports: 5000,
      actualJitoTipLamports: 0, actualRealizedPnLSol: 0.002, remainingTokensRaw: '670000000', isFullyClosed: false, slot: 6,
    } as any);
    const id = seedLive({ currentPriceSol: 0.0002, currentValueSol: 0.2 });
    const res = await coordinator.closePosition(id, 33, 'TAKE_PROFIT_1');
    expect(res.success, res.error).toBe(true);
    expect(row(id).status).toBe('PARTIALLY_CLOSED');
    expect(row(id).exitStage).toBe(1); // before the fix only the exit pass wrote it, in a second write after this call returned
    expect(submit.mock.calls[0][0]).toMatchObject({ side: 'SELL', exitReason: 'TAKE_PROFIT_1' });
  });

  it('A1: the SELL row stores its exit reason (the column a restart reads)', () => {
    const sig = `a1row_${uid()}`;
    workstationDb.saveTransaction({ signature: sig, orderId: `o_${uid()}`, correlationId: 'c', mint, direction: 'SELL', submissionTransport: 'SOLANA_RPC', submissionTime: Date.now(), reconciliationState: 'PENDING', networkFeeLamports: 0, jitoTipLamports: 0, executionMode: 'LIVE', exitReason: 'TAKE_PROFIT_1' } as any);
    workstationDb.saveTransaction({ ...tx(sig), reconciliationState: 'RECONCILED', exitReason: undefined }); // a later write without it keeps it
    expect(tx(sig).exitReason).toBe('TAKE_PROFIT_1');
  });

  it.each([
    ['the older <pid>:<nonce> form', () => `${process.pid}:${crypto.randomUUID()}`],
    ['another run id', () => `${process.pid}:${crypto.randomUUID()}:${crypto.randomUUID()}`],
  ])('A4: a fresh claim left by an earlier run with the same pid (%s; PID 1 in a container) does not hold the stop-loss off', async (_name, leftover) => {
    const id = seedLive();
    const owner = leftover();
    expect(workstationDb.claimExit(id, owner, Date.now(), 0, () => true)).toBe(true); // taken just now, so not stale by age
    expect(exitClaimOwnerAlive(owner)).toBe(false);
    const res = await coordinator.closePosition(id, 100, 'STOP_LOSS');
    expect(res.error).toBeUndefined(); // was EXIT_IN_PROGRESS for up to EXIT_CLAIM_STALE_MS
    expect(res.success).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('A4: this run\'s own claim still counts as alive, so two coordinators in one process never sell the same position at once', async () => {
    expect(exitClaimOwnerAlive(newExitClaimOwner())).toBe(true);
    const id = seedLive();
    expect(workstationDb.claimExit(id, newExitClaimOwner(), Date.now(), 0, () => true)).toBe(true);
    const res = await coordinator.closePosition(id, 100, 'STOP_LOSS');
    expect(res.error).toMatch(/EXIT_IN_PROGRESS/);
    expect(submit).not.toHaveBeenCalled();
  });

  it('B2/D1: a LIVE exit with no signer sends nothing but raises EXIT_NO_SIGNER; a later fill clears it', async () => {
    const id = seedLive();
    const status = vi.spyOn(localSigner, 'getStatus').mockReturnValue('NOT_CONFIGURED' as any);
    const res = await coordinator.closePosition(id, 100, 'STOP_LOSS');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^Signer is not configured/);
    expect(submit).not.toHaveBeenCalled();
    const alert = coordinator.getOperatorAlerts().find((a) => a.code === 'EXIT_NO_SIGNER' && a.positionId === id && !a.cleared);
    expect(alert?.message).toMatch(/NOT_CONFIGURED/);

    status.mockReturnValue('READY');
    expect((await coordinator.closePosition(id, 100, 'STOP_LOSS')).success).toBe(true);
    expect(coordinator.getOperatorAlerts().some((a) => a.code === 'EXIT_NO_SIGNER' && a.positionId === id && !a.cleared)).toBe(false);
  });

  it('B2: a PAPER exit never raises the no-signer alert', async () => {
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('NOT_CONFIGURED' as any);
    const id = seedLive({ executionMode: 'PAPER' });
    await coordinator.closePosition(id, 100, 'STOP_LOSS');
    expect(coordinator.getOperatorAlerts().some((a) => a.code === 'EXIT_NO_SIGNER')).toBe(false);
  });

  it('D3: a LIVE buy from any route is visible to waitForBuysInFlight from its reservation until it settles', async () => {
    let seenInFlight: string[] = [];
    submit.mockImplementation(async () => {
      seenInFlight = await coordinator.waitForBuysInFlight(0);
      return { success: false, signature: 'unconf_sig', transport: 'SOLANA_RPC', error: 'did not confirm in 15000ms', lifecycleState: 'REVERTED', unconfirmed: true };
    });
    vi.spyOn(coordinator as any, 'scheduleOrphanRecovery').mockImplementation(() => undefined);
    vi.spyOn(workstationDb, 'getDailyTotalPnLSol').mockReturnValue(0);
    (coordinator as any).realWalletBalanceSol = 1;
    (coordinator as any).executionMode = 'LIVE';
    (coordinator as any).isLiveTradingArmed = true;
    const d3Mint = Keypair.generate().publicKey.toBase58(); // 3F: the sell cases above close `mint` at a loss, so it is not bought again
    await coordinator.executeTrade({
      signalTimestamp: Date.now(), mint: d3Mint, symbol: 'D3', name: 'D3', amountSol: 0.005, source: 'MANUAL', provenance: 'MANUAL_OPERATOR',
      eligibilityReport: createPassingEligibilityReport(d3Mint),
    } as any);
    expect(submit).toHaveBeenCalled();
    expect(seenInFlight).toEqual([d3Mint]);
    expect(await coordinator.waitForBuysInFlight(0)).toEqual([]);
  });
});

describe('G A1/A2: startup reconciliation', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    vi.restoreAllMocks();
    while (cleanups.length) cleanups.pop()!();
    clearLedger();
  });

  function coordinatorOn(opts: { genesisHash?: string } = {}) {
    const mockRpc = new MockSolanaRpc();
    if (opts.genesisHash) mockRpc.genesisHash = opts.genesisHash;
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(Keypair.generate().publicKey);
    const c = new ExecutionCoordinator(mockRpc.createConnection());
    cleanups.push(() => { c.cleanup(); mockRpc.clear(); });
    const conn = (c as any).connection;
    conn.getBalance = vi.fn(async () => 1_000_000_000);
    conn.getParsedTokenAccountsByOwner = vi.fn(async () => ({ context: { slot: 1 }, value: [] }));
    (c as any).rpcHealth = 'HEALTHY';
    return { c, conn };
  }

  it('A1: a take-profit 1 sell that landed before a crash is recovered with exitStage 1, so TP1 does not fire again', async () => {
    clearLedger();
    const { c, conn } = coordinatorOn();
    await c.startupReconciliation(); // the constructor's own pass, on an empty ledger
    const id = seedLive({ tokenQuantityRaw: '1000', costBasisLamports: 100_000_000 });
    const sig = `a1tp1_${uid()}`;
    workstationDb.saveTransaction({ signature: sig, orderId: `o_${uid()}`, correlationId: 'c', mint, direction: 'SELL', submissionTransport: 'SOLANA_RPC', submissionTime: Date.now() - 5000, reconciliationState: 'PENDING', networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE', exitReason: 'TAKE_PROFIT_1' } as any);
    conn.getSignatureStatuses = vi.fn(async () => ({ context: { slot: 1 }, value: [{ slot: 5, confirmations: null, err: null, confirmationStatus: 'finalized' }] }));
    conn.getTransaction = vi.fn(async () => ({ slot: 5, blockTime: 1, meta: { err: null, fee: 5000 } }));
    conn.getTokenAccountBalance = vi.fn(async () => ({ value: { amount: '670' } }));
    vi.spyOn(TradeReconciler, 'recoverInterruptedTransaction').mockResolvedValue({ recovered: true, type: 'SELL', mint, remainingTokensRaw: '670', tokensSoldRaw: '330', tokenBeforeRaw: '1000', solReceivedLamports: 40_000_000, blockTime: 1, slot: 5 } as any);

    await c.startupReconciliation({ fresh: true });

    const after = row(id);
    expect(after.status).toBe('PARTIALLY_CLOSED');
    expect(after.tokenQuantityRaw).toBe('670');
    expect(after.exitStage).toBe(1); // was 0: the next exit pass sold another 33% as TAKE_PROFIT_1
    expect(after.exitReason).toBe('TAKE_PROFIT_1');
    expect(tx(sig).reconciliationState).not.toBe('PENDING');
  });

  it('A2: on a wrong-cluster RPC, pending sells and orphaned buys are left for a trusted pass instead of being TIMED_OUT', async () => {
    clearLedger();
    const { c } = coordinatorOn({ genesisHash: Keypair.generate().publicKey.toBase58() });
    await vi.waitFor(() => expect(c.getClusterStatus().problem).toMatch(/genesis hash/), { timeout: 5_000 });
    const retry = vi.spyOn(c as any, 'scheduleReconcileRetry').mockImplementation(() => undefined);
    seedLive();
    const sell = `a2sell_${uid()}`;
    const buy = `a2buy_${uid()}`;
    workstationDb.saveTransaction({ signature: sell, orderId: `o_${uid()}`, correlationId: 'c', mint, direction: 'SELL', submissionTransport: 'SOLANA_RPC', submissionTime: Date.now() - 3 * 60_000, reconciliationState: 'PENDING', networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE' } as any);
    workstationDb.saveTransaction({ signature: buy, orderId: `o_${uid()}`, correlationId: 'c', mint: Keypair.generate().publicKey.toBase58(), direction: 'BUY', submissionTransport: 'SOLANA_RPC', submissionTime: Date.now() - 20 * 60_000, reconciliationState: 'RECONCILIATION_REQUIRED', networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE' } as any);
    // what a wrong-cluster RPC says about every real signature
    vi.spyOn(TradeReconciler, 'recoverInterruptedTransaction').mockResolvedValue({ recovered: false, error: 'Transaction not found on-chain' } as any);

    const res = await c.startupReconciliation({ fresh: true });

    expect(res.status).not.toBe('EXECUTION_READY');
    expect(tx(sell).reconciliationState).toBe('PENDING'); // was TIMED_OUT after 120 s
    expect(tx(buy).reconciliationState).toBe('RECONCILIATION_REQUIRED'); // was TIMED_OUT after 15 min
    expect((await c.recoverOrphanedBuys()).stillOrphaned).toContain(buy);
    expect(tx(buy).reconciliationState).toBe('RECONCILIATION_REQUIRED');
    expect(retry).toHaveBeenCalled();
  });
});

describe('G A3: startup step 4 decides a silent PENDING row by its blockhash window, not its age', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    vi.restoreAllMocks();
    while (cleanups.length) cleanups.pop()!();
    clearLedger();
  });

  it.each([
    ['still valid', 1_000, 'PENDING'],
    ['expired', 100, 'TIMED_OUT'],
  ])('a 3-minute-old sell whose blockhash is %s (lastValidBlockHeight %i, chain at 500) ends %s', async (_name, lastValidBlockHeight, expected) => {
    clearLedger();
    const mockRpc = new MockSolanaRpc();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(Keypair.generate().publicKey);
    const c = new ExecutionCoordinator(mockRpc.createConnection());
    cleanups.push(() => { c.cleanup(); mockRpc.clear(); });
    await c.startupReconciliation();
    const conn = (c as any).connection;
    conn.getSignatureStatuses = vi.fn(async () => ({ context: { slot: 1 }, value: [null] }));
    conn.getBlockHeight = vi.fn(async () => 500);
    const retry = vi.spyOn(c as any, 'scheduleReconcileRetry').mockImplementation(() => undefined);
    const sig = `a3_${uid()}`;
    workstationDb.saveTransaction({ signature: sig, orderId: `o_${uid()}`, correlationId: 'c', mint, direction: 'SELL', submissionTransport: 'SOLANA_RPC', submissionTime: Date.now() - 3 * 60_000, reconciliationState: 'PENDING', networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE', lastValidBlockHeight } as any);

    await c.startupReconciliation({ fresh: true });

    expect(tx(sig).reconciliationState).toBe(expected); // a still-valid row was TIMED_OUT at 120 s, though it could still land
    if (expected === 'PENDING') expect(retry).toHaveBeenCalled();
  });
});

describe('G C5: a risk limit that is not a positive number refuses every order', () => {
  const req = (): RiskEvaluationRequest => ({
    mint: 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS', orderSizeSol: 0.02, expectedPriceSol: 0.0001, slippageBps: 500, estimatedFeeLamports: 50_000,
    jitoTipLamports: 1_000_000, expectedEdgeSol: 0.005, signalTimestamp: Date.now(), marketDataTimestamp: Date.now(), currentOpenPositionsCount: 1,
    currentTotalExposureSol: 0.02, walletSpendableSol: 0.1, executionMode: 'PAPER',
  });
  afterEach(() => vi.restoreAllMocks());

  it('the baseline order is approved', () => {
    expect(new HardenedRiskEngine().evaluateOrder(req()).reasonCode).toBe('RISK_OK');
  });

  it.each([
    ['maxPositionSol', { maxPositionSol: NaN }],
    ['maxAggregateExposureSol', { maxAggregateExposureSol: NaN }],
    ['maxDailyLossSol', { maxDailyLossSol: NaN }],
    ['maxPositionSol', { maxPositionSol: 0 }],
  ])('%s = %o (MAX_POSITION_SIZE_SOL=abc parses to NaN)', (name, limits) => {
    const r = new HardenedRiskEngine();
    r.updateLimits(limits as any);
    const res = r.evaluateOrder({ ...req(), orderSizeSol: 1000, currentTotalExposureSol: 1000 }); // any size passed every comparison with NaN
    expect(res.approved).toBe(false);
    expect(res.reasonCode).toBe('RISK_LIMIT_INVALID');
    expect(res.message).toContain(name);
  });

  it('MAX_DAILY_LOSS_USD=abc refuses too', () => {
    const real = executionConfig.getConfig();
    vi.spyOn(executionConfig, 'getConfig').mockReturnValue({ ...real, maxDailyLossUsd: NaN });
    const res = new HardenedRiskEngine().evaluateOrder(req());
    expect(res.reasonCode).toBe('RISK_LIMIT_INVALID');
    expect(res.message).toMatch(/MAX_DAILY_LOSS_USD|maxDailyLossSol/);
  });
});
