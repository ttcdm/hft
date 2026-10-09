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

export class HardenedRiskEngine {
  private limits: PreTradeRiskLimits;

  private circuitBreakerState: CircuitBreakerState = 'CLOSED';
  private killSwitchActive = false;
  private lastTradeFailureTimestamp = 0;
  private mintLastTradedMap: Map<string, number> = new Map();
  private consecutiveRpcFailures = 0;
  private readonly maxConsecutiveRpcFailures = 3;

  constructor() {
    const cfg = executionConfig.getConfig();
    this.limits = {
      maxPositionSol: cfg.maxPositionSizeSol,
      maxAggregateExposureSol: cfg.maxPositionSizeSol * 3,
      // C3: the SOL value of the USD daily-loss cap follows the live SOL price (see effectiveMaxDailyLossSol).
      // Until a price is known this is the aggregate exposure cap, which is the most that can be at risk.
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
  }

  public getLimits(): PreTradeRiskLimits {
    return { ...this.limits };
  }

  /** True once an operator or test sets maxDailyLossSol explicitly; then the live-price derivation is not applied. */
  private dailyLossLimitPinned = false;

  /** Daily loss stop in SOL: pinned value if set explicitly, else maxDailyLossUsd / live SOL price, else the safe default. */
  public effectiveMaxDailyLossSol(): number {
    if (this.dailyLossLimitPinned) return this.limits.maxDailyLossSol;
    const px = solPriceService.lastKnownPrice();
    return px ? executionConfig.getConfig().maxDailyLossUsd / px : this.limits.maxDailyLossSol;
  }

  public updateLimits(partial: Partial<PreTradeRiskLimits>) {
    if (partial.maxDailyLossSol !== undefined) this.dailyLossLimitPinned = true;
    this.limits = { ...this.limits, ...partial };
    Logger.info('Risk engine limits updated', this.limits);
  }

  public recordRpcFailure(): boolean {
    this.consecutiveRpcFailures++;
    if (this.consecutiveRpcFailures >= this.maxConsecutiveRpcFailures) {
      this.setCircuitBreaker('OPEN');
      this.setKillSwitch(true);
      Logger.error(
        `CIRCUIT BREAKER AUTO-TRIPPED: ${this.consecutiveRpcFailures} consecutive RPC failures detected. Emergency halt activated.`
      );
      return true;
    }
    return false;
  }

  public recordRpcSuccess() {
    this.consecutiveRpcFailures = 0;
  }

  public getRpcFailureCount(): number {
    return this.consecutiveRpcFailures;
  }

  public setKillSwitch(active: boolean) {
    this.killSwitchActive = active;
    Logger.warn(`Risk Engine Kill Switch state changed: ${active ? 'TRIPPED (SHUTDOWN)' : 'RESET'}`);
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

  public getDailyTotalPnLSol(mode: ExecutionMode = 'LIVE'): number {
    return workstationDb.getDailyTotalPnLSol(mode);
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

    // 10. Daily Total Loss Limit (B20: Closed PnL + Open Unrealized PnL - Fees)
    const dailyTotalPnL = this.getDailyTotalPnLSol(req.executionMode);
    const maxDailyLossSol = this.effectiveMaxDailyLossSol();
    if (dailyTotalPnL <= -maxDailyLossSol) {
      return logAndReturn(
        false,
        'DAILY_LOSS_LIMIT',
        `Daily total loss ${Math.abs(dailyTotalPnL).toFixed(4)} SOL reached daily stop limit ${maxDailyLossSol} SOL`
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

export const riskEngine = new HardenedRiskEngine();

/** Max share of an order that may go to round-trip execution cost before the entry is refused. */
export const MAX_ROUND_TRIP_COST_FRACTION = 0.2;

/**
 * Round-trip cost in lamports: buy tip + one expected sell tip + 2 x (base 5,000 + priority fee) + pump fees on both sides.
 * The sell-side pump fee is taken equal to the buy-side fee (same bps on a notional of about the order size).
 */
export function estimateRoundTripCostLamports(p: {
  buyTipLamports: number;
  sellTipLamports: number;
  priorityFeeLamports: number;
  buyProtocolFeeLamports: number;
  buyCreatorFeeLamports: number;
}): number {
  const baseFees = 2 * (5_000 + p.priorityFeeLamports);
  const pumpFees = 2 * (p.buyProtocolFeeLamports + p.buyCreatorFeeLamports);
  return p.buyTipLamports + p.sellTipLamports + baseFees + pumpFees;
}
