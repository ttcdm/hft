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
import { riskEngine } from '../server/risk/riskEngine';
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
const uid = () => Math.random().toString(36).slice(2);

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
    // The constructor starts initializeConnection() unawaited; its wallet-balance sync (the mock RPC answers 0.07 SOL) used to land at a
    // timing-dependent moment inside a test and overwrite the balance the test had set. Capture that run and let it finish first.
    const realInit = (ExecutionCoordinator.prototype as any).initializeConnection;
    let initDone: Promise<unknown> = Promise.resolve();
    vi.spyOn(ExecutionCoordinator.prototype as any, 'initializeConnection').mockImplementation(function (this: any) {
      initDone = Promise.resolve(realInit.call(this));
      return initDone;
    });
    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
    await initDone;
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

    // N4: while that buy is unresolved, buying the same mint again is refused and nothing more is sent
    (riskEngine as any).lastTradeFailureTimestamp = 0; // the failure cooldown would otherwise answer first
    const calls = submit.mock.calls.length;
    const again = await coordinator.executeTrade({
      signalTimestamp: Date.now(), mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'N2', name: 'N2', amountSol: 0.005,
      source: 'AUTO_SNIPER', provenance: 'REAL_ONCHAIN', eligibilityReport: createPassingEligibilityReport(VALID_PUMP_MINT_1.toBase58()),
    } as any);
    expect(again.success).toBe(false);
    expect(again.error).toMatch(/UNRESOLVED_BUY/);
    expect(submit.mock.calls.length).toBe(calls);
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

  it('N3: a partial sell whose wallet balance dropped by less than the sold amount is not adopted as a full sale; the rest stays tracked', async () => {
    (TradeReconciler.reconcileSellTransaction as any).mockResolvedValue({ success: false, reconciliationState: 'RECONCILIATION_REQUIRED', error: 'fill unreadable' });
    await coordinator.closePosition(posId, 50, 'TAKE_PROFIT_1'); // asked to sell 500,000,000 of 1,000,000,000
    // The wallet only lost 200,000,000 (the sell was smaller than asked, or only part of it landed).
    (coordinator as any).connection.getTokenAccountBalance = vi.fn(async () => ({ value: { amount: '800000000' } }));
    const again = await coordinator.closePosition(posId, 50, 'TAKE_PROFIT_1');
    expect(again.success).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1); // adopted from the wallet, not sold a second time
    const row = workstationDb.loadPositions().find((p) => p.id === posId)!;
    expect(row.status).toBe('PARTIALLY_CLOSED'); // not CLOSED
    expect(row.tokenQuantityRaw).toBe('800000000'); // the wallet decides what is left, not the 500,000,000 that was asked for
    expect(row.costBasisLamports).toBe(80_000_000); // basis scaled to what is still held
  });

  describe('Q13: a 100% sell sells what the wallet holds', () => {
    const rowOf = () => workstationDb.loadPositions().find((p) => p.id === posId)!;
    const balance = (amount: string) => { (coordinator as any).connection.getTokenAccountBalance = vi.fn(async () => ({ value: { amount } })); };

    it('the row says 1,000,000,000 but the wallet holds 600,000,000: the sell is for 600,000,000, the basis is scaled and the position closes', async () => {
      balance('600000000');
      const res = await coordinator.closePosition(posId, 100, 'STOP_LOSS');
      expect(res.success, res.error).toBe(true);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(String(quoteSpy.mock.calls[0][0].amountTokens ?? quoteSpy.mock.calls[0][0].tokenAmountRaw ?? '')).toBe('600000000');
      expect(rowOf().status).toBe('CLOSED');
      expect(coordinator.getOperatorAlerts().some((a) => a.code === 'POSITION_BALANCE_CLAMPED')).toBe(true);
    });

    it('an empty wallet closes the row without sending anything', async () => {
      balance('0');
      const res = await coordinator.closePosition(posId, 100, 'STOP_LOSS');
      expect(res.success).toBe(true);
      expect(submit).not.toHaveBeenCalled();
      const row = rowOf();
      expect(row.status).toBe('CLOSED');
      expect(row.exitReason).toMatch(/^RECONCILED_ZERO_BALANCE/);
      expect(coordinator.getOperatorAlerts().some((a) => a.code === 'POSITION_BALANCE_MISSING')).toBe(true);
    });

    it('an unreadable balance sells what the row says, as before', async () => {
      (coordinator as any).connection.getTokenAccountBalance = vi.fn(async () => { throw new Error('429 too many requests'); });
      const res = await coordinator.closePosition(posId, 100, 'STOP_LOSS');
      expect(res.success, res.error).toBe(true);
      expect(String(quoteSpy.mock.calls[0][0].amountTokens ?? quoteSpy.mock.calls[0][0].tokenAmountRaw ?? '')).toBe('1000000000');
    });

    it('a wallet holding more than the row (dust, an airdrop) does not change a 100% sell', async () => {
      balance('1500000000');
      const res = await coordinator.closePosition(posId, 100, 'STOP_LOSS');
      expect(res.success, res.error).toBe(true);
      expect(String(quoteSpy.mock.calls[0][0].amountTokens ?? quoteSpy.mock.calls[0][0].tokenAmountRaw ?? '')).toBe('1000000000');
    });
  });

  describe('N20: the PENDING row is written before anything is sent', () => {
    const params = (sigByte: number, orderId: string) => ({
      tx: { signatures: [new Uint8Array(64).fill(sigByte)] } as any, orderId, correlationId: 'c-' + orderId, side: 'BUY' as const,
      mint: VALID_PUMP_MINT_1.toBase58(), mintPubkey: VALID_PUMP_MINT_1, owner: Keypair.generate().publicKey,
      tokenProgram: Keypair.generate().publicKey, preSnapshot: { walletSolLamports: 1, tokenBalanceRaw: '0', tokenDecimals: 6, timestamp: 1 }, jitoTipLamports: 0,
    });
    const rowFor = (orderId: string) => workstationDb.loadTransactions(orderId);

    it('a row exists while the send is still in flight (a crash here leaves something for recovery to find)', async () => {
      submit.mockRestore();
      let release!: (v: any) => void;
      const inner = vi.spyOn(coordinator as any, 'submitAndConfirmInner').mockImplementation(() => new Promise((r) => { release = r; }));
      const p = coordinator.submitAndConfirmWithRetry(params(7, 'ord-n20-a'));
      const rows = rowFor('ord-n20-a');
      expect(rows).toHaveLength(1);
      expect(rows[0].reconciliationState).toBe('PENDING');
      release({ success: true, signature: rows[0].signature, transport: 'SOLANA_RPC', lifecycleState: 'CONFIRMED' });
      await p;
      expect(inner).toHaveBeenCalledTimes(1);
    });

    it('a send that definitely did not go out is marked REVERTED, not left PENDING to block readiness', async () => {
      submit.mockRestore();
      vi.spyOn(coordinator as any, 'submitAndConfirmInner').mockResolvedValue({ success: false, signature: '', transport: 'SOLANA_RPC', error: 'rejected', lifecycleState: 'SUBMIT_FAILED' });
      await coordinator.submitAndConfirmWithRetry(params(8, 'ord-n20-b'));
      expect(rowFor('ord-n20-b').map((t) => t.reconciliationState)).toEqual(['REVERTED']);
    });

    it('an unconfirmed send stays PENDING so recovery keeps watching it', async () => {
      submit.mockRestore();
      vi.spyOn(coordinator as any, 'submitAndConfirmInner').mockResolvedValue({ success: false, signature: 'x', transport: 'SOLANA_RPC', error: 'timeout', lifecycleState: 'REVERTED', unconfirmed: true });
      await coordinator.submitAndConfirmWithRetry(params(9, 'ord-n20-c'));
      expect(rowFor('ord-n20-c').map((t) => t.reconciliationState)).toEqual(['PENDING']);
    });
  });

  it('N14: panic liquidation is never blocked by the dust-economics check, a take-profit partial still is', async () => {
    const id = mkPosition();
    const row = workstationDb.loadPositions().find((p) => p.id === id)!;
    workstationDb.savePosition({ ...row, currentValueSol: 0.0000001, currentPriceSol: 1e-13 } as any);
    const tp = await coordinator.closePosition(id, 50, 'TAKE_PROFIT_1');
    expect(tp.error).toBe('DUST_POSITION_EXIT_UNECONOMICAL');
    const panic = await coordinator.closePosition(id, 100, 'EMERGENCY_PANIC_LIQUIDATION');
    expect(panic.error).not.toBe('DUST_POSITION_EXIT_UNECONOMICAL');
  });

  it('N17: at the alert cap a cleared alert is dropped before an uncleared one; failure counters of closed positions are pruned', async () => {
    const raise = (coordinator as any).raiseOperatorAlert.bind(coordinator);
    raise('KEEP_ME', 'first, uncleared');
    for (let i = 0; i < 49; i++) raise('FILL', `n${i}`, `pos-${i}`);
    (coordinator as any).clearOperatorAlert('FILL', 'pos-3');
    raise('NEW', 'one past the cap');
    const codes = coordinator.getOperatorAlerts().map((a) => a.code);
    expect(codes).toContain('KEEP_ME');
    expect(codes).toContain('NEW');
    expect(coordinator.getOperatorAlerts().some((a) => a.positionId === 'pos-3')).toBe(false);

    (coordinator as any).exitFailures.set('gone-position', { count: 3, nextAttemptAt: 0, lastError: 'x' });
    await coordinator.evaluateAndProcessExits();
    expect((coordinator as any).exitFailures.has('gone-position')).toBe(false);
  });

  it('N12: spendable does not subtract rent already outside the wallet, and the risk engine gets the balance net of in-flight only (the reserve is applied once)', async () => {
    (coordinator as any).realWalletBalanceSol = 0.2;
    (coordinator as any).inFlightReservedSol = 0.01;
    // a LIVE position is open (its token-account rent is NOT part of the 0.2 SOL balance)
    expect(workstationDb.loadPositions('LIVE', 'ACTIVE').length).toBeGreaterThan(0);
    expect(coordinator.getSpendableBankrollSol()).toBeCloseTo(0.2 - 0.015 - 0.01, 6);

    for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) {
      workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0, currentValueSol: 0, currentPriceSol: p.entryPriceSol, realizedPnLSol: 0 } as any);
    }
    vi.spyOn(workstationDb, 'getDailyTotalPnLSol').mockReturnValue(0);
    const evaluate = vi.spyOn(riskEngine, 'evaluateOrder');
    (coordinator as any).executionMode = 'LIVE';
    (coordinator as any).isLiveTradingArmed = true;
    (coordinator as any).inFlightReservedSol = 0;
    submit.mockResolvedValue({ success: false, signature: '', transport: 'SOLANA_RPC', error: 'x', lifecycleState: 'SUBMIT_FAILED' });
    (riskEngine as any).lastTradeFailureTimestamp = 0;
    await coordinator.executeTrade({
      signalTimestamp: Date.now(), mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'N12', name: 'N12', amountSol: 0.005,
      source: 'AUTO_SNIPER', provenance: 'REAL_ONCHAIN', eligibilityReport: createPassingEligibilityReport(VALID_PUMP_MINT_1.toBase58()),
    } as any);
    expect(evaluate).toHaveBeenCalled();
    expect(evaluate.mock.calls[0][0].walletSpendableSol).toBeCloseTo(0.2, 6); // balance - in-flight (0), no reserve and no rent taken off yet
  });

  it('N11: a landed buy whose position the database refuses is still a success for the caller, stays open for recovery, and alerts', async () => {
    for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) {
      workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0, currentValueSol: 0, currentPriceSol: p.entryPriceSol, realizedPnLSol: 0 } as any);
    }
    vi.spyOn(workstationDb, 'getDailyTotalPnLSol').mockReturnValue(0);
    (riskEngine as any).lastTradeFailureTimestamp = 0;
    (coordinator as any).realWalletBalanceSol = 1;
    (coordinator as any).executionMode = 'LIVE';
    (coordinator as any).isLiveTradingArmed = true;
    vi.spyOn(workstationDb, 'hasUnresolvedLiveBuy').mockReturnValue(false); // the N2 case above leaves an unresolved buy of this mint
    const sig = `n11_${uid()}`;
    submit.mockResolvedValue({ success: true, signature: sig, transport: 'SOLANA_RPC', slot: 9, lifecycleState: 'CONFIRMED' });
    vi.spyOn(TradeReconciler, 'reconcileBuyTransaction').mockResolvedValue({
      success: true, reconciliationState: 'RECONCILED', actualSolSpentLamports: 5_000_000, actualTokensReceivedRaw: '1000000', tokenDecimals: 6,
      tokensReceivedHuman: 1, actualNetworkFeeLamports: 5000, actualJitoTipLamports: 0, effectiveFillPriceSol: 0.005, allInFillPriceSol: 0.005, slot: 9,
    } as any);
    const recovery = vi.spyOn(coordinator as any, 'scheduleOrphanRecovery').mockImplementation(() => undefined);
    const realSave = workstationDb.savePosition.bind(workstationDb);
    vi.spyOn(workstationDb, 'savePosition').mockImplementation((pos: any) => {
      if (pos.id === sig) throw new Error('SQLITE_FULL: database or disk is full');
      return realSave(pos);
    });
    const res = await coordinator.executeTrade({
      signalTimestamp: Date.now(), mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'N11', name: 'N11', amountSol: 0.005,
      source: 'AUTO_SNIPER', provenance: 'REAL_ONCHAIN', eligibilityReport: createPassingEligibilityReport(VALID_PUMP_MINT_1.toBase58()),
    } as any);
    expect(res.success, res.error).toBe(true);
    expect(res.lifecycleState).toBe('CONFIRMED');
    expect(coordinator.getOperatorAlerts().some((a) => a.code === 'POSITION_NOT_PERSISTED')).toBe(true);
    expect(recovery).toHaveBeenCalled();
    expect(workstationDb.loadTransactions().find((t) => t.signature === sig)?.reconciliationState).toBe('RECONCILIATION_REQUIRED');
  });

  it('N13: while a buy is in flight the reservation covers the slippage headroom and the new token account, not just the nominal order', async () => {
    for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) {
      workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0, currentValueSol: 0, currentPriceSol: p.entryPriceSol, realizedPnLSol: 0 } as any);
    }
    vi.spyOn(workstationDb, 'getDailyTotalPnLSol').mockReturnValue(0);
    vi.spyOn(workstationDb, 'hasUnresolvedLiveBuy').mockReturnValue(false);
    (riskEngine as any).lastTradeFailureTimestamp = 0;
    (riskEngine as any).mintLastTradedMap.clear(); // the N11 case above bought this mint
    (coordinator as any).realWalletBalanceSol = 1;
    (coordinator as any).executionMode = 'LIVE';
    (coordinator as any).isLiveTradingArmed = true;
    let reservedDuringSend = 0;
    submit.mockImplementation(async () => {
      reservedDuringSend = (coordinator as any).inFlightReservedSol;
      return { success: false, signature: '', transport: 'SOLANA_RPC', error: 'stop here', lifecycleState: 'SUBMIT_FAILED' };
    });
    const r13 = await coordinator.executeTrade({
      signalTimestamp: Date.now(), mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'N13', name: 'N13', amountSol: 0.005,
      source: 'AUTO_SNIPER', provenance: 'REAL_ONCHAIN', eligibilityReport: createPassingEligibilityReport(VALID_PUMP_MINT_1.toBase58()),
    } as any);
    expect(submit, r13.error).toHaveBeenCalled();
    expect(reservedDuringSend).toBeGreaterThan(0.005 + 0.002); // order + at least the token-account rent
    expect((coordinator as any).inFlightReservedSol).toBe(0); // released afterwards
  });
});
