import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator, executionCoordinator } from '../server/execution/coordinator';
import { emergencyStop, PANIC_CLOSE_REASON } from '../server/execution/emergencyStop';
import { localSigner } from '../server/solana/signer';
import { riskEngine } from '../server/risk/riskEngine';
import { workstationDb } from '../server/db/database';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { TradeReconciler } from '../server/execution/reconciliation';
import { txBuilder } from '../server/solana/transactionBuilder';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState, createPassingEligibilityReport } from './e2e/helpers/simulatedStates';
import { settleLeftoverLiveBuys } from './helpers/leftoverBuys';
import { resetAuto } from './fixtures/auto';

/**
 * Late buy (Mike, 2026-10-26, decision 5: "auto sell it"): a LIVE buy already past the risk gate when the operator hits panic or the kill
 * switch, and that lands after the stop, is sold at once, through the normal sell path (closePosition at 100%, the panic's protective reason,
 * so neither the kill switch nor a halt holds it). Before this change the coin was simply held: the kill switch only stops buys not yet past
 * the gate, and the panic only sells what it finds open during its own run (a buy still unsettled after its wait is reported BUY_IN_FLIGHT).
 * Real ExecutionCoordinator and SQLite; the RPC, builders and reconcilers are stubbed at their edges, as in g_money_path_fixes. Throwaway keys.
 */
const uid = () => Math.random().toString(36).slice(2);
const row = (id: string) => workstationDb.loadPositions().find((p) => p.id === id);
const journal = (type: string) => workstationDb.getEvents(500).filter((j: any) => j.eventType === type);

function clearLedger() {
  for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0 } as any);
  for (const t of workstationDb.loadTransactions()) if (['PENDING', 'RECONCILIATION_REQUIRED'].includes(t.reconciliationState)) workstationDb.saveTransaction({ ...t, reconciliationState: 'REVERTED' });
}

const RECONCILED_BUY = {
  success: true, reconciliationState: 'RECONCILED', actualSolSpentLamports: 5_000_000, actualTokensReceivedRaw: '1000000000', tokenDecimals: 6,
  tokensReceivedHuman: 1000, actualNetworkFeeLamports: 5000, actualJitoTipLamports: 0, effectiveFillPriceSol: 0.000005, slot: 7,
};

describe('a LIVE buy that lands after a panic or kill is sold at once', () => {
  let coordinator: ExecutionCoordinator;
  let mockRpc: MockSolanaRpc;
  let submit: ReturnType<typeof vi.spyOn>;
  let reconcileSell: ReturnType<typeof vi.spyOn>;
  /** what the buy's send does while it is in flight (the moment the operator stops) */
  let duringBuy: () => Promise<void>;
  let buyResult: () => any;

  const sellCalls = () => submit.mock.calls.filter((c: any[]) => c[0].side === 'SELL');
  const buy = (m: string) => coordinator.executeTrade({
    signalTimestamp: Date.now(), mint: m, symbol: 'LATE', name: 'Late', amountSol: 0.005, source: 'MANUAL', provenance: 'MANUAL_OPERATOR',
    eligibilityReport: createPassingEligibilityReport(m),
  } as any);
  const stop = (reason: string) => (coordinator as any).noteEmergencyStop?.(reason);
  const alert = (code: string) => coordinator.getOperatorAlerts().find((a) => a.code === code);

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
    // the exit pass would stop-loss the test position on the simulated curve's price; only the late-buy sell may sell here
    clearInterval((coordinator as any).autoTpSlInterval);
    (coordinator as any).connection.simulateTransaction = vi.fn(async () => ({ context: { slot: 1 }, value: { err: null, logs: [] } }));
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE' } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
    vi.spyOn(PumpCurveService, 'calculateSellQuote').mockReturnValue({ expectedJitoTipLamports: 1000, minOutputLamports: 1 } as any);
    vi.spyOn(txBuilder, 'buildSellTransaction').mockResolvedValue({} as any);
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '1000000000', tokenDecimals: 6, timestamp: Date.now() });
    vi.spyOn(TradeReconciler, 'reconcileBuyTransaction').mockResolvedValue(RECONCILED_BUY as any);
    duringBuy = async () => undefined;
    buyResult = () => ({ success: true, signature: `late_buy_${uid()}`, transport: 'SOLANA_RPC', slot: 7, lifecycleState: 'CONFIRMED' });
    submit = vi.spyOn(coordinator as any, 'submitAndConfirmWithRetry').mockImplementation(async (p: any) => {
      if (p.side === 'BUY') { await duringBuy(); return buyResult(); }
      return { success: true, signature: `late_sell_${uid()}`, transport: 'SOLANA_RPC', slot: 9, lifecycleState: 'CONFIRMED' };
    });
    reconcileSell = vi.spyOn(TradeReconciler, 'reconcileSellTransaction').mockResolvedValue({
      success: true, reconciliationState: 'RECONCILED', actualTokensSoldRaw: '1000000000', tokensSoldHuman: 1000, tokenDecimals: 6,
      actualGrossSolProceedsLamports: 4_900_000, actualNetSolProceedsLamports: 4_800_000, actualNetworkFeeLamports: 5000,
      actualJitoTipLamports: 0, actualRealizedPnLSol: -0.0002, remainingTokensRaw: '0', isFullyClosed: true, slot: 9,
    } as any);
    vi.spyOn(coordinator, 'canExecuteLive').mockReturnValue({ allowed: true, reasons: [], readiness: { ready: true } as any } as any);
    vi.spyOn(coordinator as any, 'liveBuyReadinessProblems').mockReturnValue([]);
    vi.spyOn(coordinator as any, 'scheduleOrphanRecovery').mockImplementation(() => undefined);
    vi.spyOn(workstationDb, 'getDailyTotalPnLSol').mockReturnValue(0);
    (coordinator as any).realWalletBalanceSol = 1;
    (coordinator as any).executionMode = 'LIVE';
    (coordinator as any).isLiveTradingArmed = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    riskEngine.setKillSwitch(false);
    (riskEngine as any).lastTradeFailureTimestamp = 0; // an UNCONFIRMED buy starts the 15 s global cooldown
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    coordinator.cleanup();
    mockRpc.clear();
    clearLedger();
  });

  it('kill switch tripped while the buy is in flight: the buy lands, then is sold at 100% through closePosition', async () => {
    const m = Keypair.generate().publicKey.toBase58();
    const close = vi.spyOn(coordinator, 'closePosition');
    duringBuy = async () => { stop('operator kill switch'); riskEngine.setKillSwitch(true, 'late-buy test'); };

    const res = await buy(m);

    expect(res.success, res.error).toBe(true);
    expect(res.lifecycleState).toBe('CONFIRMED');
    await vi.waitFor(() => expect(row(res.positionId!)?.status).toBe('CLOSED'), { timeout: 3_000 }); // before: stayed OPEN, held
    expect(close).toHaveBeenCalledWith(res.positionId, 100, PANIC_CLOSE_REASON);
    expect(sellCalls()).toHaveLength(1);
    expect(riskEngine.isKillSwitchActive()).toBe(true); // the kill switch blocks buys, not this exit
    expect(journal('LATE_BUY_EXIT').some((j: any) => j.payload.positionId === res.positionId)).toBe(true);
    expect(alert('LATE_BUY_SOLD')?.message).toMatch(/LATE/);
  });

  it('panic: a buy still unsettled when the panic ends (BUY_IN_FLIGHT) is sold when it lands', async () => {
    const m = Keypair.generate().publicKey.toBase58();
    let panicOver!: () => void;
    const ended = new Promise<void>((r) => { panicOver = r; });
    duringBuy = async () => { stop('panic liquidate'); riskEngine.setKillSwitch(true, 'late-buy test'); await ended; };

    const pending = buy(m);
    await vi.waitFor(() => expect(submit).toHaveBeenCalled());
    // the panic has read the positions and found nothing open: the buy has not landed yet
    expect(workstationDb.loadPositions('LIVE', 'ACTIVE').filter((p) => p.mint === m)).toEqual([]);
    panicOver();
    const res = await pending;

    expect(res.success, res.error).toBe(true);
    await vi.waitFor(() => expect(row(res.positionId!)?.status).toBe('CLOSED'), { timeout: 3_000 });
    expect(sellCalls()).toHaveLength(1);
  });

  it('a panic close that meets the late sell gets EXIT_IN_PROGRESS (the panic then waits for it): one SELL is sent, not two', async () => {
    let releaseSell!: () => void;
    const sellHeld = new Promise<void>((r) => { releaseSell = r; });
    submit.mockImplementation(async (p: any) => {
      if (p.side === 'BUY') { stop('panic liquidate'); return buyResult(); }
      await sellHeld;
      return { success: true, signature: `late_sell_${uid()}`, transport: 'SOLANA_RPC', slot: 9, lifecycleState: 'CONFIRMED' };
    });

    const res = await buy(Keypair.generate().publicKey.toBase58());
    await vi.waitFor(() => expect(sellCalls()).toHaveLength(1));
    const panicClose = await coordinator.closePosition(res.positionId!, 100, PANIC_CLOSE_REASON);
    expect(panicClose.error).toMatch(/^EXIT_IN_PROGRESS/);
    releaseSell();

    await vi.waitFor(() => expect(row(res.positionId!)?.status).toBe('CLOSED'), { timeout: 3_000 });
    expect(sellCalls()).toHaveLength(1);
    expect(coordinator.getOperatorAlerts().some((a) => a.code === 'LATE_BUY_SOLD')).toBe(true);
  });

  it('a stop that happened before the buy passed the gate does not sell it (the operator bought after the reset)', async () => {
    stop('earlier kill, since reset');
    const m = Keypair.generate().publicKey.toBase58();

    const res = await buy(m);

    expect(res.success, res.error).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(row(res.positionId!)?.status).toBe('OPEN');
    expect(sellCalls()).toHaveLength(0);
  });

  it('no stop: the buy lands and stays open', async () => {
    const res = await buy(Keypair.generate().publicKey.toBase58());
    expect(res.success, res.error).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(row(res.positionId!)?.status).toBe('OPEN');
    expect(sellCalls()).toHaveLength(0);
  });

  it('the sell fails: the position stays open with a LATE_BUY_NOT_SOLD alert, and the buy still reports CONFIRMED', async () => {
    reconcileSell.mockResolvedValue({ success: false, reconciliationState: 'REVERTED', error: 'sell reverted (test)' } as any);
    submit.mockImplementation(async (p: any) => {
      if (p.side === 'BUY') { stop('operator kill switch'); return buyResult(); }
      return { success: false, signature: `late_sell_${uid()}`, transport: 'SOLANA_RPC', lifecycleState: 'REVERTED', error: 'custom program error: 0x1772' };
    });

    const res = await buy(Keypair.generate().publicKey.toBase58());

    expect(res.success, res.error).toBe(true);
    await vi.waitFor(() => expect(alert('LATE_BUY_NOT_SOLD')).toBeDefined(), { timeout: 3_000 });
    expect(alert('LATE_BUY_NOT_SOLD')!.message).toMatch(/still open/);
    expect(row(res.positionId!)?.status).toBe('OPEN');
    expect(alert('LATE_BUY_SOLD')).toBeUndefined();
  });

  it('an UNCONFIRMED buy sent before the stop and adopted by orphan recovery after it is sold too', async () => {
    const m = Keypair.generate().publicKey.toBase58();
    const sig = `late_unconf_${uid()}`;
    buyResult = () => ({ success: false, signature: sig, transport: 'SOLANA_RPC', error: 'did not confirm in 15000ms', lifecycleState: 'REVERTED', unconfirmed: true });
    duringBuy = async () => { stop('operator kill switch'); };
    const res = await buy(m);
    expect(res.lifecycleState).toBe('RECONCILIATION_REQUIRED');
    vi.spyOn(TradeReconciler, 'recoverInterruptedTransaction').mockResolvedValue({
      recovered: true, type: 'BUY', mint: m, tokenQuantityRaw: '1000000000', tokenDecimals: 6, solSpentLamports: 5_000_000, slot: 8,
    } as any);

    const rec = await coordinator.recoverOrphanedBuys();

    expect(rec.recovered).toEqual([sig]);
    await vi.waitFor(() => expect(row(sig)?.status).toBe('CLOSED'), { timeout: 3_000 });
    expect(sellCalls()).toHaveLength(1);
  });

  it('an UNCONFIRMED buy adopted later with no stop in between stays open', async () => {
    const m = Keypair.generate().publicKey.toBase58();
    const sig = `late_unconf_${uid()}`;
    buyResult = () => ({ success: false, signature: sig, transport: 'SOLANA_RPC', error: 'did not confirm in 15000ms', lifecycleState: 'REVERTED', unconfirmed: true });
    await buy(m);
    vi.spyOn(TradeReconciler, 'recoverInterruptedTransaction').mockResolvedValue({
      recovered: true, type: 'BUY', mint: m, tokenQuantityRaw: '1000000000', tokenDecimals: 6, solSpentLamports: 5_000_000, slot: 8,
    } as any);

    await coordinator.recoverOrphanedBuys();

    await new Promise((r) => setTimeout(r, 100));
    expect(row(sig)?.status).toBe('OPEN');
    expect(sellCalls()).toHaveLength(0);
  });
});

describe('emergencyStop marks the stop before anything else', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await resetAuto();
    riskEngine.setKillSwitch(false);
    executionCoordinator.armLiveTrading(false);
  });

  it.each([true, false])('exitAll %s: noteEmergencyStop runs before the kill switch goes on', async (exitAll) => {
    const order: string[] = [];
    const note = vi.fn((_reason: string) => { order.push('note'); });
    (executionCoordinator as any).noteEmergencyStop = note;
    const kill = vi.spyOn(riskEngine, 'setKillSwitch').mockImplementation(() => { order.push('kill'); });
    try {
      await emergencyStop({ exitAll, reason: 'late-buy wiring' });
    } finally {
      delete (executionCoordinator as any).noteEmergencyStop;
      kill.mockRestore();
    }
    expect(note).toHaveBeenCalledWith('late-buy wiring');
    expect(order.slice(0, 2)).toEqual(['note', 'kill']);
  });
});
