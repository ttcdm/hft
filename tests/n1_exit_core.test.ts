import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
  ExecutionCoordinator,
  SELL_SLIPPAGE_LADDER_BPS,
  EXIT_RETRY_BASE_MS,
  EXIT_RETRY_MAX_MS,
  EXIT_FAILURE_ALERT_AFTER,
} from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { TradeReconciler } from '../server/execution/reconciliation';
import { txBuilder } from '../server/solana/transactionBuilder';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { MockJitoEngine } from './e2e/helpers/mockJito';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState, createPassingEligibilityReport } from './e2e/helpers/simulatedStates';

/**
 * P4 (critique #4): a failing stop-loss must not bleed fees. Real coordinator and SQLite; the RPC, builder and reconciler are stubbed at their edges.
 * Wallet keys are freshly generated throwaway values.
 */
describe('N1-N3: exit-loop single flight, unconfirmed sends, uncertain sells', () => {
  let coordinator: ExecutionCoordinator;
  let mockRpc: MockSolanaRpc;
  let mockJito: MockJitoEngine;
  let simulate: ReturnType<typeof vi.fn>;
  let submit: ReturnType<typeof vi.spyOn>;
  let quoteSpy: ReturnType<typeof vi.spyOn>;
  let posId: string;

  const mkPosition = (mode: 'LIVE' | 'PAPER' = 'LIVE') => {
    const id = `n1_${mode}_${Math.random().toString(36).slice(2)}`;
    workstationDb.savePosition({
      id, mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'P4', name: 'P4 Coin', tokenDecimals: 6,
      tokenQuantityRaw: '1000000000', entryPriceSol: 0.0001, currentPriceSol: 0.00005, currentValueSol: 0.05,
      costBasisLamports: 100_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE',
      executionMode: mode, entryTxSignature: `sig_${id}`, entryTimestamp: Date.now(), lastMarkTimestamp: Date.now(),
      recordUpdatedAt: Date.now(), updatedAt: Date.now(),
    } as any);
    return id;
  };

  beforeEach(async () => {
    const kp = Keypair.generate();
    mockRpc = new MockSolanaRpc();
    mockJito = new MockJitoEngine();
    await mockJito.start();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(kp.publicKey);
    vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => tx);
    PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() };
    PumpCurveService.cachedFeeConfig = { feeBps: 100 };
    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
    simulate = vi.fn(async () => ({ context: { slot: 1 }, value: { err: null, logs: [] } }));
    (coordinator as any).connection.simulateTransaction = simulate;
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE' } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
    // The sell math cross-check against the SDK is covered elsewhere; here only the slippage argument matters.
    quoteSpy = vi.spyOn(PumpCurveService, 'calculateSellQuote').mockReturnValue({ expectedJitoTipLamports: 1000, minOutputLamports: 1 } as any);
    vi.spyOn(txBuilder, 'buildSellTransaction').mockResolvedValue({} as any);
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '1000000000', tokenDecimals: 6, timestamp: Date.now() });
    submit = vi.spyOn(coordinator as any, 'submitAndConfirmWithRetry').mockResolvedValue({ success: true, signature: 'sellsig', transport: 'SOLANA_RPC', slot: 5, lifecycleState: 'CONFIRMED' });
    vi.spyOn(TradeReconciler, 'reconcileSellTransaction').mockResolvedValue({
      success: true, reconciliationState: 'RECONCILED', actualTokensSoldRaw: '1000000000', tokensSoldHuman: 1000, tokenDecimals: 6,
      actualGrossSolProceedsLamports: 50_000_000, actualNetSolProceedsLamports: 49_000_000, actualNetworkFeeLamports: 5000,
      actualJitoTipLamports: 0, actualRealizedPnLSol: -0.05, remainingTokensRaw: '0', isFullyClosed: true, slot: 6,
    } as any);
    vi.spyOn(coordinator, 'canExecuteLive').mockReturnValue({ allowed: true, reasons: [], readiness: { ready: true } as any } as any);
    posId = mkPosition();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    coordinator.cleanup();
    await mockJito.stop();
    mockRpc.clear();
  });

  it('N1: overlapping exit passes share one run, so a slow sell is not started twice', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const marks = vi.spyOn(coordinator as any, 'updatePositionMarkPrices').mockImplementation(async () => { await gate; });
    const a = coordinator.evaluateAndProcessExits();
    const b = coordinator.evaluateAndProcessExits();
    release();
    await Promise.all([a, b]);
    expect(marks).toHaveBeenCalledTimes(1);
    await coordinator.evaluateAndProcessExits(); // the slot is free again afterwards
    expect(marks).toHaveBeenCalledTimes(2);
  });

  it('N1: a position closed while a pass was running is not written back as open', async () => {
    vi.spyOn(coordinator as any, 'updatePositionMarkPrices').mockImplementation(async () => {
      const row = workstationDb.loadPositions().find((p) => p.id === posId)!;
      workstationDb.savePosition({ ...row, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0 } as any);
    });
    await coordinator.evaluateAndProcessExits();
    const after = workstationDb.loadPositions().find((p) => p.id === posId)!;
    expect(after.status).toBe('CLOSED');
    expect(after.tokenQuantityRaw).toBe('0');
  });

  it('N2: a buy that was sent but never confirmed is RECONCILIATION_REQUIRED, not REVERTED', async () => {
    submit.mockResolvedValue({ success: false, signature: 'unconf_sig', transport: 'SOLANA_RPC', error: 'did not confirm in 15000ms', lifecycleState: 'REVERTED', unconfirmed: true });
    const recovery = vi.spyOn(coordinator as any, 'scheduleOrphanRecovery').mockImplementation(() => undefined);
    (coordinator as any).realWalletBalanceSol = 1;
    // earlier tests in this file leave open positions in the shared test DB; their unrealized loss would trip the daily-loss gate
    for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) {
      workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0, currentValueSol: 0, currentPriceSol: p.entryPriceSol, realizedPnLSol: 0 } as any);
    }
    vi.spyOn(workstationDb, 'getDailyTotalPnLSol').mockReturnValue(0); // the N1/N3 cases above leave losses in the shared day total
    (coordinator as any).executionMode = 'LIVE';
    (coordinator as any).isLiveTradingArmed = true;
    const res = await coordinator.executeTrade({
      signalTimestamp: Date.now(), mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'N2', name: 'N2', amountSol: 0.005,
      source: 'AUTO_SNIPER', provenance: 'REAL_ONCHAIN', eligibilityReport: createPassingEligibilityReport(VALID_PUMP_MINT_1.toBase58()),
    } as any);
    expect(res.error).toMatch(/UNCONFIRMED/);
    expect(res.txSignature).toBe('unconf_sig');
    expect(res.lifecycleState).toBe('RECONCILIATION_REQUIRED');
    expect(res.error).toMatch(/UNCONFIRMED/);
    expect(recovery).toHaveBeenCalled();
    const tx = workstationDb.loadTransactions().find((t) => t.signature === 'unconf_sig');
    expect(tx?.reconciliationState).toBe('RECONCILIATION_REQUIRED');
  });

  it('N3: a sell that landed but whose fill is unreadable is not sold again; the wallet decides', async () => {
    (TradeReconciler.reconcileSellTransaction as any).mockResolvedValue({ success: false, reconciliationState: 'RECONCILIATION_REQUIRED', error: 'fill unreadable' });
    const first = await coordinator.closePosition(posId, 100, 'STOP_LOSS');
    expect(first.success).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);

    // The wallet is still full and the window is open: no second sell goes out.
    (coordinator as any).connection.getTokenAccountBalance = vi.fn(async () => ({ value: { amount: '1000000000' } }));
    const second = await coordinator.closePosition(posId, 100, 'STOP_LOSS');
    expect(second.error).toMatch(/SELL_PENDING_VERIFICATION/);
    expect(submit).toHaveBeenCalledTimes(1);

    // The wallet now holds nothing: the first sell landed, the position is closed without a second sell.
    (coordinator as any).connection.getTokenAccountBalance = vi.fn(async () => ({ value: { amount: '0' } }));
    const third = await coordinator.closePosition(posId, 100, 'STOP_LOSS');
    expect(third.success).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(workstationDb.loadPositions().find((p) => p.id === posId)!.status).toBe('CLOSED');
  });

  it('N3: a partial sell that landed leaves the wallet balance as the remaining quantity', async () => {
    (TradeReconciler.reconcileSellTransaction as any).mockResolvedValue({ success: false, reconciliationState: 'RECONCILIATION_REQUIRED', error: 'fill unreadable' });
    await coordinator.closePosition(posId, 50, 'TAKE_PROFIT_1');
    (coordinator as any).connection.getTokenAccountBalance = vi.fn(async () => ({ value: { amount: '500000000' } }));
    const again = await coordinator.closePosition(posId, 50, 'TAKE_PROFIT_1');
    expect(again.success).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
    const row = workstationDb.loadPositions().find((p) => p.id === posId)!;
    expect(row.status).toBe('PARTIALLY_CLOSED');
    expect(row.tokenQuantityRaw).toBe('500000000');
  });
});
