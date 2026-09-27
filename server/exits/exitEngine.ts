export type ExitReason =
  | 'STOP_LOSS'
  | 'TRAILING_STOP'
  | 'TAKE_PROFIT_1'
  | 'TAKE_PROFIT_2'
  | 'STALE_POSITION'
  | 'HOLD';

export interface ExitEvaluationInput {
  positionId?: string;
  entryPriceSol: number;
  currentPriceSol: number;
  highWaterMarkSol?: number;
  trailingStopSol?: number;
  exitStage?: number;
  entryTimestamp: number;
  currentTimestamp?: number;
}

export interface ExitDecision {
  shouldExit: boolean;
  sellPercentage: number;
  reason: ExitReason;
  newHighWaterMarkSol: number;
  newTrailingStopSol: number;
  newExitStage: number;
  profitPct: number;
  holdTimeMs: number;
}

export class ExitEngine {
  public static readonly HARD_STOP_LOSS_PCT = -20.0;
  public static readonly TRAILING_STOP_TRIGGER_PCT = 15.0;
  public static readonly TRAILING_STOP_RATCHET_RATIO = 0.85; // 15% below HWM
  public static readonly STAGE_2_TRAILING_RATIO = 0.90;      // 10% below HWM for remaining 34%
  public static readonly TP1_TRIGGER_PCT = 30.0;
  public static readonly TP1_SELL_PCT = 33;
  public static readonly TP2_TRIGGER_PCT = 60.0;
  public static readonly TP2_SELL_PCT = 33;
  public static readonly STALE_POSITION_HOLD_MS = 1_800_000; // 30 minutes
  public static readonly STALE_POSITION_PROFIT_THRESHOLD_PCT = 5.0;

  /**
   * Evaluates exit conditions for an active position based on:
   * 1. Profit percentage: ((currentPrice - entryPrice) / entryPrice) * 100
   * 2. High-Water Mark: max(highWaterMarkSol, currentPriceSol)
   * 3. Monotonic trailing stop: ratchets to HWM * 0.85 once profit >= +15%
   * 4. 3-stage take-profit ladder:
   *    - Stage 0 -> 1: sell 33% @ +30%
   *    - Stage 1 -> 2: sell 33% @ +60%
   *    - Stage 2: remaining 34% trails with HWM * 0.90
   * 5. Stale position exit: sell 100% after 30 min if profit < 5%
   * 6. Hard stop loss: sell 100% if profit <= -20%
   */
  public evaluate(input: ExitEvaluationInput): ExitDecision {
    const currentTimestamp = input.currentTimestamp ?? Date.now();
    const holdTimeMs = Math.max(0, currentTimestamp - input.entryTimestamp);

    const entryPriceSol = input.entryPriceSol > 0 ? input.entryPriceSol : 0.000001;
    const profitPct = Number((((input.currentPriceSol - entryPriceSol) / entryPriceSol) * 100).toFixed(4));

    // High-Water Mark calculation: strictly non-decreasing
    const prevHwm = (input.highWaterMarkSol !== undefined && input.highWaterMarkSol > 0)
      ? input.highWaterMarkSol
      : Math.max(entryPriceSol, input.currentPriceSol);
    const newHwm = Math.max(prevHwm, input.currentPriceSol);

    const prevTrailingStop = input.trailingStopSol ?? 0;
    const stage = input.exitStage ?? 0;

    // Calculate candidate trailing stop
    let candidateStop = 0;
    if (stage >= 2) {
      // Stage 2: Remaining 34% trails with a 10% stop below HWM (candidateStop = newHwm * 0.90)
      candidateStop = newHwm * ExitEngine.STAGE_2_TRAILING_RATIO;
    } else if (profitPct >= ExitEngine.TRAILING_STOP_TRIGGER_PCT) {
      // Ratchets to newHwm * 0.85 once profit >= +15%
      candidateStop = newHwm * ExitEngine.TRAILING_STOP_RATCHET_RATIO;
    }

    // Monotonicity guarantee: trailing stop price can NEVER decrease
    let newTrailingStop = Math.max(prevTrailingStop, candidateStop);

    // 1. Hard Stop Loss: profit <= -20%
    if (profitPct <= ExitEngine.HARD_STOP_LOSS_PCT) {
      return {
        shouldExit: true,
        sellPercentage: 100,
        reason: 'STOP_LOSS',
        newHighWaterMarkSol: newHwm,
        newTrailingStopSol: newTrailingStop,
        newExitStage: stage,
        profitPct,
        holdTimeMs,
      };
    }

    // 2. Trailing Stop Breach: currentPriceSol <= newTrailingStop && newTrailingStop > 0
    if (newTrailingStop > 0 && input.currentPriceSol <= newTrailingStop) {
      return {
        shouldExit: true,
        sellPercentage: 100,
        reason: 'TRAILING_STOP',
        newHighWaterMarkSol: newHwm,
        newTrailingStopSol: newTrailingStop,
        newExitStage: stage,
        profitPct,
        holdTimeMs,
      };
    }

    // 3. Take Profit Ladder
    if (stage === 0 && profitPct >= ExitEngine.TP1_TRIGGER_PCT) {
      // Stage 0 -> Stage 1: sell 33%, exitStage = 1
      return {
        shouldExit: true,
        sellPercentage: ExitEngine.TP1_SELL_PCT,
        reason: 'TAKE_PROFIT_1',
        newHighWaterMarkSol: newHwm,
        newTrailingStopSol: newTrailingStop,
        newExitStage: 1,
        profitPct,
        holdTimeMs,
      };
    }

    if (stage === 1 && profitPct >= ExitEngine.TP2_TRIGGER_PCT) {
      // Stage 1 -> Stage 2: sell 33%, exitStage = 2; trailing stop ratchets to 10% below HWM
      const stage2Stop = newHwm * ExitEngine.STAGE_2_TRAILING_RATIO;
      newTrailingStop = Math.max(newTrailingStop, stage2Stop);
      return {
        shouldExit: true,
        sellPercentage: ExitEngine.TP2_SELL_PCT,
        reason: 'TAKE_PROFIT_2',
        newHighWaterMarkSol: newHwm,
        newTrailingStopSol: newTrailingStop,
        newExitStage: 2,
        profitPct,
        holdTimeMs,
      };
    }

    // 4. Stale Position Exit: hold time >= 30 minutes and profit < 5%
    if (holdTimeMs >= ExitEngine.STALE_POSITION_HOLD_MS && profitPct < ExitEngine.STALE_POSITION_PROFIT_THRESHOLD_PCT) {
      return {
        shouldExit: true,
        sellPercentage: 100,
        reason: 'STALE_POSITION',
        newHighWaterMarkSol: newHwm,
        newTrailingStopSol: newTrailingStop,
        newExitStage: stage,
        profitPct,
        holdTimeMs,
      };
    }

    // 5. Normal Hold
    return {
      shouldExit: false,
      sellPercentage: 0,
      reason: 'HOLD',
      newHighWaterMarkSol: newHwm,
      newTrailingStopSol: newTrailingStop,
      newExitStage: stage,
      profitPct,
      holdTimeMs,
    };
  }

  public static evaluate(input: ExitEvaluationInput): ExitDecision {
    return new ExitEngine().evaluate(input);
  }
}

export const exitEngine = new ExitEngine();
