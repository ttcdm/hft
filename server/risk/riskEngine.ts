import { solPriceService } from '../market/solPriceService';
import {
  PreTradeRiskLimits,
  RiskReasonCode,
  CircuitBreakerState,
  ExecutionMode,
} from '../core/types';
import { workstationDb } from '../db/database';
import { Logger } from '../middleware/enterprise';
import { executionConfig } from '../solana/executionConfig';

export interface RiskEvaluationRequest {
  mint: string;
  orderSizeSol: number;
  expectedPriceSol: number;
  slippageBps: number;
  /** Quote price impact. When provided it is checked against limits.maxPriceImpactBps. */
  estimatedPriceImpactBps?: number;
  estimatedFeeLamports: number;
  jitoTipLamports: number;
  expectedEdgeSol?: number;
  signalTimestamp: number;
  marketDataTimestamp: number;
  currentOpenPositionsCount: number;
  currentTotalExposureSol: number;
  walletSpendableSol: number;
  executionMode: ExecutionMode;
}

export interface RiskEvaluationResult {
  approved: boolean;
  reasonCode: RiskReasonCode;
  message: string;
  details: Record<string, any>;
}

/** N-61 (3C): the loss gate looks back this far, not to UTC midnight, so a new calendar day does not reset the budget. */
export const DAILY_LOSS_WINDOW_MS = 24 * 60 * 60_000;

/**
 * N-62 (3C): share of every open position and of the new order assumed lost when gate 10 asks "could this buy break the floor?".
 * 1 = a rug to zero. The 20% hard stop is a target, not a bound: a curve can gap through it or a sell can fail to land.
 */
export const WORST_CASE_LOSS_FRACTION = 1;

/** Q56: a SOL price older than this no longer converts the USD floor at full trust (see effectiveMaxDailyLossSol). */
export const DAILY_LOSS_PRICE_MAX_AGE_MS = 60 * 60_000;

/** R3-3 (R7-6): `app_settings` key holding the daily-loss latch per mode, `{ LIVE?: { at, message }, PAPER?: { at, message } }`. */
export const DAILY_LOSS_LATCH_SETTING = 'risk.dailyLossLatch';

export class HardenedRiskEngine {
  private limits: PreTradeRiskLimits;
  /**
   * R3-3: true for the process-wide engine (the `riskEngine` singleton): it restores the daily-loss latch at construction and saves every
   * change. Engines a test or script builds on its own keep their state in memory, so they never latch (or unlatch) the next real boot.
   */
  private readonly persistent: boolean;

  private circuitBreakerState: CircuitBreakerState = 'CLOSED';
  private killSwitchActive = false;
  private lastTradeFailureTimestamp = 0;
  private mintLastTradedMap: Map<string, number> = new Map();
  private consecutiveRpcFailures = 0;
  private readonly maxConsecutiveRpcFailures = 3;

  constructor(opts: { persistent?: boolean } = {}) {
    this.persistent = opts.persistent === true;
    const cfg = executionConfig.getConfig();
    this.limits = {
      maxPositionSol: cfg.maxPositionSizeSol,
      maxAggregateExposureSol: cfg.maxPositionSizeSol * 3,
      // C3: the SOL value of the USD floor follows the live SOL price (see effectiveMaxDailyLossSol). This field is only the upper
      // bound of the no-price fallback, the aggregate exposure cap; it is not a safe default on its own (N-65).
      maxDailyLossSol: cfg.maxPositionSizeSol * 3,
      maxSimultaneousPositions: 3,
      maxSlippageBps: cfg.maxSlippageBps,
      maxPriceImpactBps: 600,
      maxExecutionCostLamports: Math.round(cfg.maxJitoTipSol * 1e9 + 50000),
      maxJitoTipLamports: Math.round(cfg.maxJitoTipSol * 1e9),
      maxFeePctOfPosition: 20.0,
      minWalletReserveSol: 0.015,
      maxDataAgeMs: 5000,
      maxSignalAgeMs: 8000,
      cooldownAfterFailedTradeMs: 15000,
      cooldownPerMintMs: 30000,
    };
    if (this.persistent) this.restoreDailyLossLatch();
  }

  public getLimits(): PreTradeRiskLimits {
    return { ...this.limits };
  }

  /** True once an operator or test sets maxDailyLossSol explicitly; then the live-price derivation is not applied. */
  private dailyLossLimitPinned = false;

  /**
   * Net daily PnL floor in SOL: the pinned value if one was set explicitly, else MAX_DAILY_LOSS_USD / SOL price read within the last
   * hour. N-65 (3C): with an older price, or none, it is min(3 x maxPositionSol, MAX_DAILY_LOSS_USD / last known price), so a stale
   * price can only tighten the floor, never loosen it to 3 full positions.
   */
  public effectiveMaxDailyLossSol(): number {
    if (this.dailyLossLimitPinned) return this.limits.maxDailyLossSol;
    const usdCap = executionConfig.getConfig().maxDailyLossUsd;
    const reading = solPriceService.getPrice();
    if (reading.usd !== null && (reading.ageMs ?? Infinity) <= DAILY_LOSS_PRICE_MAX_AGE_MS) return usdCap / reading.usd;
    const exposureCap = this.limits.maxDailyLossSol;
    return reading.usd !== null ? Math.min(exposureCap, usdCap / reading.usd) : exposureCap;
  }

  public updateLimits(partial: Partial<PreTradeRiskLimits>) {
    if (partial.maxDailyLossSol !== undefined) this.dailyLossLimitPinned = true;
    // N-65: the unpinned fallback is 3 x the position cap; keep it in step when the position cap changes.
    const fallback = !this.dailyLossLimitPinned && partial.maxPositionSol !== undefined ? { maxDailyLossSol: partial.maxPositionSol * 3 } : {};
    this.limits = { ...this.limits, ...partial, ...fallback };
    Logger.info('Risk engine limits updated', this.limits);
  }

  /**
   * N-61 (3C): once the floor is reached, buys in that mode stay refused until an operator clears the latch, even after the losses
   * leave the 24 h window. R3-3: the process-wide engine saves it (DAILY_LOSS_LATCH_SETTING, plus a journal row) and restores it at boot,
   * so a restart does not release it either.
   */
  private dailyLossLatch = new Map<ExecutionMode, { at: number; message: string }>();
  private warnedCapBelowOrder = false;

  public getDailyLossLatch(mode: ExecutionMode): { at: number; message: string } | null {
    return this.dailyLossLatch.get(mode) ?? null;
  }

  /**
   * Operator clear (POST /api/auto/resume with clearDailyLossLatch), for ONE mode (R5-15: a PAPER clear must never release a LIVE latch).
   * Gate 10 still refuses while the window itself is below the floor. Returns false when the clear could not be saved (it holds in memory).
   */
  public clearDailyLossLatch(mode: ExecutionMode): boolean {
    if (!this.dailyLossLatch.has(mode)) return true;
    Logger.warn(`Daily loss latch cleared by operator for ${mode}`);
    this.dailyLossLatch.delete(mode);
    if (!this.persistent) return true;
    workstationDb.logJournal('DAILY_LOSS_LATCH_CLEARED', 'daily-loss', mode, {});
    return this.saveDailyLossLatch();
  }

  private setDailyLossLatch(mode: ExecutionMode, latch: { at: number; message: string }): void {
    this.dailyLossLatch.set(mode, latch);
    if (!this.persistent) return;
    workstationDb.logJournal('DAILY_LOSS_LATCHED', 'daily-loss', mode, latch);
    if (!this.saveDailyLossLatch()) Logger.error(`Daily loss latch for ${mode} could not be saved; it holds until this process restarts`);
  }

  private saveDailyLossLatch(): boolean {
    return workstationDb.setSetting(DAILY_LOSS_LATCH_SETTING, Object.fromEntries(this.dailyLossLatch));
  }

  /** R3-3: bring back the latches saved by the last run. A malformed entry is skipped with a warning; nothing is latched from nothing. */
  private restoreDailyLossLatch(): void {
    const saved = workstationDb.getSetting<Record<string, unknown>>(DAILY_LOSS_LATCH_SETTING);
    if (!saved || typeof saved !== 'object') return;
    for (const mode of ['LIVE', 'PAPER'] as ExecutionMode[]) {
      const v = saved[mode] as { at?: unknown; message?: unknown } | undefined;
      if (!v) continue;
      if (typeof v.at === 'number' && Number.isFinite(v.at)) {
        this.dailyLossLatch.set(mode, { at: v.at, message: typeof v.message === 'string' ? v.message : 'latched before the restart' });
        Logger.warn(`Daily loss latch for ${mode} restored from before the restart (latched at ${new Date(v.at).toISOString()})`);
      } else {
        // Fail closed: an entry we cannot read still says a latch was set, so keep it latched from now.
        this.dailyLossLatch.set(mode, { at: Date.now(), message: 'a latch saved before the restart could not be read' });
        Logger.warn(`Daily loss latch for ${mode}: saved entry unreadable; latched until an operator clears it`);
      }
    }
  }

  private dailyWindowStartMs(): number {
    return Date.now() - DAILY_LOSS_WINDOW_MS;
  }

  /** When the oldest loss in the window leaves it, as text for refusal messages. */
  private windowReleaseNote(mode: ExecutionMode): string {
    const oldest = workstationDb.getOldestRealizedLossTs(mode, this.dailyWindowStartMs());
    if (oldest === null) return 'no realized loss is left in the 24 h window';
    return `the oldest loss in the 24 h window leaves it at ${new Date(oldest + DAILY_LOSS_WINDOW_MS).toISOString()}`;
  }

  /** The last wallet-balance read the coordinator reported (recordRpcSuccess / recordRpcFailure); null before the first one. */
  private lastBalanceRead: { ok: boolean; at: number } | null = null;

  public recordRpcFailure(): boolean {
    this.consecutiveRpcFailures++;
    this.lastBalanceRead = { ok: false, at: Date.now() };
    if (this.consecutiveRpcFailures >= this.maxConsecutiveRpcFailures) {
      this.setCircuitBreaker('OPEN');
      this.setKillSwitch(true, `circuit breaker: ${this.consecutiveRpcFailures} wallet balance reads failed in a row`);
      Logger.error(
        `CIRCUIT BREAKER AUTO-TRIPPED: ${this.consecutiveRpcFailures} consecutive RPC failures detected. Emergency halt activated.`
      );
      return true;
    }
    return false;
  }

  public recordRpcSuccess() {
    this.consecutiveRpcFailures = 0;
    this.lastBalanceRead = { ok: true, at: Date.now() };
  }

  public getLastBalanceRead(): { ok: boolean; at: number } | null {
    return this.lastBalanceRead ? { ...this.lastBalanceRead } : null;
  }

  /**
   * The operator's way to close an open breaker (Mike's choice: a manual reset, never an automatic one). It closes only when the
   * latest wallet-balance read succeeded, so a reset while the RPC is still failing leaves it OPEN and says why. Called by the
   * kill-switch reset (POST /api/execution/kill-switch {activate:false}). Before this, nothing ever closed the breaker short of a restart.
   */
  public resetCircuitBreaker(): { state: CircuitBreakerState; closed: boolean; reason: string } {
    if (this.circuitBreakerState === 'CLOSED') return { state: 'CLOSED', closed: true, reason: 'the circuit breaker was not open' };
    const last = this.lastBalanceRead;
    if (!last || !last.ok) {
      const reason = !last
        ? 'no wallet balance read has been made since it opened'
        : `the latest wallet balance read failed (${this.consecutiveRpcFailures} in a row); it closes on a reset after a read succeeds`;
      return { state: this.circuitBreakerState, closed: false, reason };
    }
    this.setCircuitBreaker('CLOSED');
    return { state: 'CLOSED', closed: true, reason: `closed: the latest wallet balance read succeeded ${Math.round((Date.now() - last.at) / 1000)}s ago` };
  }

  public getRpcFailureCount(): number {
    return this.consecutiveRpcFailures;
  }

  /**
   * The flag itself stays in memory (off after a restart: LIVE starts disarmed and auto's OFF is persisted, so no buy follows a restart
   * without an operator). The module singleton journals each change, so the next boot can tell the operator the switch was on.
   */
  public setKillSwitch(active: boolean, reason = 'no reason given') {
    const changed = this.killSwitchActive !== active;
    this.killSwitchActive = active;
    Logger.warn(`Risk Engine Kill Switch state changed: ${active ? 'TRIPPED (SHUTDOWN)' : 'RESET'}`);
    if (changed && this === riskEngine) workstationDb.logJournal(active ? 'KILL_SWITCH_TRIPPED' : 'KILL_SWITCH_RESET', 'kill-switch', 'PAPER', { reason });
  }

  public isKillSwitchActive(): boolean {
    return this.killSwitchActive;
  }

  public getCircuitBreakerState(): CircuitBreakerState {
    return this.circuitBreakerState;
  }

  public setCircuitBreaker(state: CircuitBreakerState) {
    this.circuitBreakerState = state;
    Logger.warn(`Circuit breaker transition -> ${state}`);
  }

  public recordTradeFailure() {
    this.lastTradeFailureTimestamp = Date.now();
  }

  public recordTradeSuccess(mint: string) {
    this.mintLastTradedMap.set(mint, Date.now());
  }

  /** Net PnL over the last 24 h (N-61, 3C): realized, plus open unrealized, minus unbooked fees. */
  public getDailyTotalPnLSol(mode: ExecutionMode = 'LIVE'): number {
    return workstationDb.getDailyTotalPnLSol(mode, this.dailyWindowStartMs());
  }

  public getDailyLossSol(mode: ExecutionMode = 'PAPER'): number {
    const dailyPnL = this.getDailyTotalPnLSol(mode);
    return Math.max(0, -dailyPnL);
  }

  // Pre-trade evaluation gate: Evaluates all limits deterministically
  public evaluateOrder(req: RiskEvaluationRequest): RiskEvaluationResult {
    const now = Date.now();
    const id = `risk-${now}-${Math.random().toString(36).substring(2, 7)}`;

    const logAndReturn = (
      approved: boolean,
      reasonCode: RiskReasonCode,
      message: string,
      details: Record<string, any> = {}
    ): RiskEvaluationResult => {
      workstationDb.saveRiskDecision({
        id,
        mint: req.mint,
        approved,
        reasonCode,
        attemptedSizeSol: req.orderSizeSol,
        currentExposureSol: req.currentTotalExposureSol,
        dailyLossSol: workstationDb.getDailyRealizedPnLSol(req.executionMode),
        executionMode: req.executionMode,
      });

      if (!approved) {
        Logger.warn(`Risk REJECT for ${req.mint}: ${reasonCode} - ${message}`, details);
      }
      return { approved, reasonCode, message, details };
    };

    // 1. Kill Switch Check
    if (this.killSwitchActive) {
      return logAndReturn(false, 'KILL_SWITCH_ACTIVE', 'Emergency kill switch is active');
    }

    // 2. Circuit Breaker Check
    if (this.circuitBreakerState === 'OPEN') {
      return logAndReturn(false, 'CIRCUIT_BREAKER_OPEN', 'Circuit breaker is OPEN. Trading halted.');
    }

    // 3. Cooldown after failed trade
    if (now - this.lastTradeFailureTimestamp < this.limits.cooldownAfterFailedTradeMs) {
      const remainingSec = Math.ceil(
        (this.limits.cooldownAfterFailedTradeMs - (now - this.lastTradeFailureTimestamp)) / 1000
      );
      return logAndReturn(
        false,
        'EXECUTION_DISABLED',
        `Cooling down after recent execution failure (${remainingSec}s remaining)`
      );
    }

    // 4. Per-Mint duplicate / cooldown check
    const lastMintTrade = this.mintLastTradedMap.get(req.mint) || 0;
    if (now - lastMintTrade < this.limits.cooldownPerMintMs) {
      return logAndReturn(
        false,
        'DUPLICATE_MINT',
        `Mint ${req.mint} was traded recently. Cooldown active.`
      );
    }

    // 5. Market Data Age Check
    const dataAge = now - req.marketDataTimestamp;
    if (dataAge > this.limits.maxDataAgeMs) {
      return logAndReturn(
        false,
        'STALE_MARKET_DATA',
        `Market data is stale (${dataAge}ms > limit ${this.limits.maxDataAgeMs}ms)`
      );
    }

    // 6. Signal Age Check
    const signalAge = now - req.signalTimestamp;
    if (signalAge > this.limits.maxSignalAgeMs) {
      return logAndReturn(
        false,
        'STALE_SIGNAL',
        `Signal is stale (${signalAge}ms > limit ${this.limits.maxSignalAgeMs}ms)`
      );
    }

    // 6b. R1-8, R1-36: a limit that is not a positive number (MAX_POSITION_SIZE_SOL=abc parses to NaN) makes every comparison below
    // false, which approved any size, any exposure and any daily loss. Fail closed and name the setting.
    const invalidLimits = [
      ['maxPositionSol (MAX_POSITION_SIZE_SOL)', this.limits.maxPositionSol],
      ['maxAggregateExposureSol', this.limits.maxAggregateExposureSol],
      ['maxDailyLossSol', this.effectiveMaxDailyLossSol()],
      ...(this.dailyLossLimitPinned ? [] : [['MAX_DAILY_LOSS_USD', executionConfig.getConfig().maxDailyLossUsd]]),
    ].filter(([, v]) => !(Number.isFinite(v as number) && (v as number) > 0)).map(([name, v]) => `${name}=${String(v)}`);
    if (invalidLimits.length > 0) {
      return logAndReturn(false, 'RISK_LIMIT_INVALID', `Risk limit is not a positive number: ${invalidLimits.join(', ')}; fix the setting and restart`);
    }

    // 7. Max Position Size
    if (req.orderSizeSol > this.limits.maxPositionSol) {
      return logAndReturn(
        false,
        'MAX_POSITION_SIZE',
        `Order size ${req.orderSizeSol} SOL exceeds limit ${this.limits.maxPositionSol} SOL`
      );
    }

    // 8. Max Aggregate Exposure
    const projectedExposure = req.currentTotalExposureSol + req.orderSizeSol;
    if (projectedExposure > this.limits.maxAggregateExposureSol) {
      return logAndReturn(
        false,
        'MAX_EXPOSURE',
        `Projected exposure ${projectedExposure.toFixed(4)} SOL exceeds limit ${this.limits.maxAggregateExposureSol} SOL`
      );
    }

    // 9. Max Simultaneous Positions
    if (req.currentOpenPositionsCount >= this.limits.maxSimultaneousPositions) {
      return logAndReturn(
        false,
        'MAX_EXPOSURE',
        `Already at max simultaneous positions (${req.currentOpenPositionsCount}/${this.limits.maxSimultaneousPositions})`
      );
    }

    // 10. Net daily PnL floor (B20: Closed PnL + Open Unrealized PnL - Fees, over a rolling 24 h; 3C)
    const latch = this.dailyLossLatch.get(req.executionMode);
    if (latch) {
      return logAndReturn(
        false,
        'DAILY_LOSS_LIMIT',
        `Net daily PnL floor latched at ${new Date(latch.at).toISOString()} (${latch.message}); an operator must clear it (POST /api/auto/resume with clearDailyLossLatch); ${this.windowReleaseNote(req.executionMode)}`
      );
    }
    const dailyTotalPnL = this.getDailyTotalPnLSol(req.executionMode);
    const maxDailyLossSol = this.effectiveMaxDailyLossSol();
    if (dailyTotalPnL <= -maxDailyLossSol) {
      const message = `net PnL over the last 24 h ${dailyTotalPnL.toFixed(4)} SOL reached the floor of -${maxDailyLossSol.toFixed(4)} SOL`;
      this.setDailyLossLatch(req.executionMode, { at: now, message });
      return logAndReturn(
        false,
        'DAILY_LOSS_LIMIT',
        `Net daily PnL floor: ${message}; latched until an operator clears it; ${this.windowReleaseNote(req.executionMode)}`
      );
    }
    // 11. Slippage Limit
    if (req.slippageBps > this.limits.maxSlippageBps) {
      return logAndReturn(
        false,
        'SLIPPAGE_TOO_HIGH',
        `Slippage ${req.slippageBps} bps exceeds max limit ${this.limits.maxSlippageBps} bps`
      );
    }

    // 11b. Price Impact Limit (maxPriceImpactBps existed but nothing enforced it)
    if (req.estimatedPriceImpactBps !== undefined && req.estimatedPriceImpactBps > this.limits.maxPriceImpactBps) {
      return logAndReturn(
        false,
        'PRICE_IMPACT_TOO_HIGH',
        `Price impact ${req.estimatedPriceImpactBps} bps exceeds max limit ${this.limits.maxPriceImpactBps} bps`
      );
    }

    // 12. Total Execution Cost Limit (Fee + Jito Tip)
    const totalFeeLamports = req.estimatedFeeLamports + req.jitoTipLamports;
    if (totalFeeLamports > this.limits.maxExecutionCostLamports) {
      return logAndReturn(
        false,
        'FEE_TOO_HIGH',
        `Total execution cost ${(totalFeeLamports / 1e9).toFixed(5)} SOL exceeds limit ${(this.limits.maxExecutionCostLamports / 1e9).toFixed(5)} SOL`
      );
    }

    // 13. Fee as Percentage of Position Value
    const orderLamports = req.orderSizeSol * 1e9;
    const feePct = (totalFeeLamports / orderLamports) * 100;
    if (feePct > this.limits.maxFeePctOfPosition) {
      return logAndReturn(
        false,
        'EXPECTED_EDGE_BELOW_EXECUTION_COST',
        `Execution cost is ${feePct.toFixed(1)}% of trade size (Limit: ${this.limits.maxFeePctOfPosition}%)`
      );
    }

    // 13b. N-62, the second half of gate 10 (after the fee gates, so an oversized fee keeps its own reason): the order and every open
    // position could still go to zero, and that worst case must fit above the floor too. Unrealized PnL is already in dailyTotalPnL, so
    // an open position is charged at its marked value (cost plus unrealized), not at cost plus its loss.
    const openUnrealizedSol = workstationDb.getOpenUnrealizedPnLSol(req.executionMode);
    const orderCostSol = req.orderSizeSol + totalFeeLamports / 1e9;
    const atRiskSol = req.currentTotalExposureSol + openUnrealizedSol + orderCostSol;
    const worstCasePnL = dailyTotalPnL - atRiskSol * WORST_CASE_LOSS_FRACTION;
    if (worstCasePnL < -maxDailyLossSol) {
      const capBelowOrder = orderCostSol * WORST_CASE_LOSS_FRACTION > maxDailyLossSol;
      if (capBelowOrder && !this.warnedCapBelowOrder) {
        this.warnedCapBelowOrder = true;
        Logger.warn(`MAX_DAILY_LOSS_USD (${maxDailyLossSol.toFixed(4)} SOL at the current price) is smaller than one ${req.orderSizeSol} SOL order plus its costs; no buy of that size can pass the net daily PnL floor. Raise MAX_DAILY_LOSS_USD or lower MAX_POSITION_SIZE_SOL.`);
      }
      return logAndReturn(
        false,
        'DAILY_LOSS_LIMIT',
        capBelowOrder
          ? `Net daily PnL floor: MAX_DAILY_LOSS_USD (${maxDailyLossSol.toFixed(4)} SOL) is smaller than this ${orderCostSol.toFixed(4)} SOL order with its costs; raise MAX_DAILY_LOSS_USD or lower the order size`
          : `Net daily PnL floor: if this order and the open positions (${atRiskSol.toFixed(4)} SOL at risk) went to zero, net PnL over 24 h would be ${worstCasePnL.toFixed(4)} SOL, below the floor of -${maxDailyLossSol.toFixed(4)} SOL`,
        { worstCasePnL, atRiskSol, maxDailyLossSol }
      );
    }

    // 14. Wallet Reserve Protection
    const requiredTotalSol = req.orderSizeSol + (totalFeeLamports / 1e9);
    const postBalance = req.walletSpendableSol - requiredTotalSol;
    if (postBalance < this.limits.minWalletReserveSol) {
      return logAndReturn(
        false,
        'INSUFFICIENT_BALANCE',
        `Trade requires ${requiredTotalSol.toFixed(4)} SOL leaving ${postBalance.toFixed(4)} SOL (Minimum reserve: ${this.limits.minWalletReserveSol} SOL)`
      );
    }

    return logAndReturn(true, 'RISK_OK', 'Order approved by all pre-trade risk controls');
  }
}

export const riskEngine = new HardenedRiskEngine({ persistent: true });

/** Max share of an order that may go to round-trip execution cost before the entry is refused. */
export const MAX_ROUND_TRIP_COST_FRACTION = 0.2;

/**
 * Rent-exempt lamports per byte of account data, including the 128-byte header. Measured, not assumed: the user_volume_accumulator
 * (137 bytes) that the real pump program creates holds 1,346,200 lamports on the local chain and on devnet (S6b), which is
 * 265 x 5,080. (An earlier 6,960 was the old 3,480 x 2 figure and over-counted by 37%.)
 */
export const RENT_LAMPORTS_PER_BYTE = 5_080;
/**
 * S6: the pump program creates a UserVolumeAccumulator (137 bytes, measured on the local chain with the real program binary) the first time
 * a wallet buys anything on pump.fun, and charges the buyer its rent: (137 + 128) x 5,080 = 1,346,200 lamports (0.00135 SOL), the figure also read off the app wallet's account on devnet. Nothing
 * refunds it. A 0.005 SOL first order therefore starts 27% down before any fee; every later buy by the wallet does not pay it.
 * The token account's rent (Token-2022, 170 bytes: 1,513,840 lamports) is NOT counted: the exit closes the account and refunds it.
 */
export const PUMP_USER_VOLUME_ACCUMULATOR_RENT_LAMPORTS = (137 + 128) * RENT_LAMPORTS_PER_BYTE;

/**
 * Round-trip cost in lamports: buy tip + one expected sell tip + 2 x (base 5,000 + priority fee) + pump fees on both sides.
 * The sell-side pump fee is taken equal to the buy-side fee (same bps on a notional of about the order size).
 * S6: plus any rent that is paid and never refunded (see PUMP_USER_VOLUME_ACCUMULATOR_RENT_LAMPORTS).
 */
export function estimateRoundTripCostLamports(p: {
  buyTipLamports: number;
  sellTipLamports: number;
  priorityFeeLamports: number;
  buyProtocolFeeLamports: number;
  buyCreatorFeeLamports: number;
  /** S6: rent this round trip pays and never gets back (the one-time pump volume accumulator on a wallet's first pump buy). Default 0. */
  nonRefundableRentLamports?: number;
}): number {
  const baseFees = 2 * (5_000 + p.priorityFeeLamports);
  const pumpFees = 2 * (p.buyProtocolFeeLamports + p.buyCreatorFeeLamports);
  return p.buyTipLamports + p.sellTipLamports + baseFees + pumpFees + (p.nonRefundableRentLamports ?? 0);
}
