import { ExecutionMode } from '../core/types';
import { workstationDb } from '../db/database';
import { Logger } from '../middleware/enterprise';

export interface CapitalSizingInputs {
  walletBalanceSol: number;
  reserveBalanceSol?: number;
  inFlightOrdersSol?: number;
  winProbability?: number;
  p?: number;
  winLossRatio?: number;
  b?: number;
  avgWinSol?: number;
  avgLossSol?: number;
  historicalTradeCount?: number;
  N?: number;
  tradeCount?: number;
  maxCapitalPctCeiling?: number;
  fractionMultiplier?: number;
}

export type CapitalSizingRejectionReason =
  | 'INSUFFICIENT_SPENDABLE_BANKROLL'
  | 'NEGATIVE_OR_ZERO_EXPECTANCY';

export interface CapitalSizingResult {
  approved: boolean;
  orderSizeSol: number;
  spendableBankrollSol: number;
  rawKelly: number;
  shrinkageFactor: number;
  shrunkKelly: number;
  appliedFraction: number;
  isHardCapped: boolean;
  rejectionReason?: CapitalSizingRejectionReason | string;
}

export interface HistoricalTradeStats {
  tradeCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgWinSol: number;
  avgLossSol: number;
  winLossRatio: number;
}

export class CapitalSizer {
  public static readonly DEFAULT_RESERVE_SOL = 0.015;
  public static readonly DEFAULT_MAX_CAPITAL_PCT_CEILING = 0.10;
  public static readonly DEFAULT_FRACTION_MULTIPLIER = 0.25;
  public static readonly SHRINKAGE_PRIOR_WEIGHT = 25;

  /**
   * Calculates spendable bankroll:
   * spendable = Math.max(0, walletBalanceSol - (reserveBalanceSol ?? 0.015) - (inFlightOrdersSol ?? 0))
   */
  public static calculateSpendableBankroll(
    walletBalanceSol: number,
    reserveBalanceSol: number = CapitalSizer.DEFAULT_RESERVE_SOL,
    inFlightOrdersSol: number = 0
  ): number {
    return Math.max(0, walletBalanceSol - reserveBalanceSol - inFlightOrdersSol);
  }

  /**
   * Raw Kelly formula:
   * q = 1 - p. If b <= 0, rawKelly = 0. Else rawKelly = (p * b - q) / b
   */
  public static calculateRawKelly(p: number, b: number): number {
    if (b <= 0) return 0;
    const q = 1 - p;
    return (p * b - q) / b;
  }

  /**
   * Bayesian sample-size shrinkage factor:
   * S = N / (N + 25)
   */
  public static calculateShrinkage(N: number): number {
    if (N <= 0) return 0;
    return N / (N + CapitalSizer.SHRINKAGE_PRIOR_WEIGHT);
  }

  /**
   * Queries closed positions from SQLite to derive historical performance stats.
   * If insufficient trade history exists, provides a conservative prior.
   */
  public static getHistoricalTradeStats(mode?: ExecutionMode): HistoricalTradeStats {
    try {
      const closed = workstationDb.loadPositions(mode, 'CLOSED');
      if (closed.length === 0) {
        return {
          tradeCount: 0,
          winCount: 0,
          lossCount: 0,
          winRate: 0.5,
          avgWinSol: 0.002,
          avgLossSol: 0.002,
          winLossRatio: 1.0,
        };
      }

      let winCount = 0;
      let lossCount = 0;
      let totalWinSol = 0;
      let totalLossSol = 0;

      for (const pos of closed) {
        const pnl = pos.realizedPnLSol ?? 0;
        if (pnl > 0) {
          winCount++;
          totalWinSol += pnl;
        } else if (pnl < 0) {
          lossCount++;
          totalLossSol += Math.abs(pnl);
        }
      }

      const tradeCount = closed.length;
      const winRate = tradeCount > 0 ? winCount / tradeCount : 0.5;
      const avgWinSol = winCount > 0 ? totalWinSol / winCount : 0.002;
      const avgLossSol = lossCount > 0 ? totalLossSol / lossCount : 0.002;
      const winLossRatio = avgLossSol > 0 ? avgWinSol / avgLossSol : 1.0;

      return {
        tradeCount,
        winCount,
        lossCount,
        winRate,
        avgWinSol,
        avgLossSol,
        winLossRatio,
      };
    } catch (err: any) {
      Logger.warn(`Failed to derive historical trade stats: ${err.message}`);
      return {
        tradeCount: 0,
        winCount: 0,
        lossCount: 0,
        winRate: 0.5,
        avgWinSol: 0.002,
        avgLossSol: 0.002,
        winLossRatio: 1.0,
      };
    }
  }

  /**
   * Primary order sizing method implementing:
   * 1. Spendable bankroll deduction
   * 2. Raw Kelly expectancy
   * 3. Bayesian sample shrinkage (N / (N + 25))
   * 4. Quarter-Kelly scaling (f_shrunk = rawKelly * S * 0.25)
   * 5. Hard 10% ceiling enforcement
   */
  public calculateOrderSize(inputs: CapitalSizingInputs): CapitalSizingResult {
    const reserve = inputs.reserveBalanceSol ?? CapitalSizer.DEFAULT_RESERVE_SOL;
    const inFlight = inputs.inFlightOrdersSol ?? 0;
    const spendable = CapitalSizer.calculateSpendableBankroll(inputs.walletBalanceSol, reserve, inFlight);

    if (spendable <= 0) {
      return {
        approved: false,
        orderSizeSol: 0,
        spendableBankrollSol: 0,
        rawKelly: 0,
        shrinkageFactor: 0,
        shrunkKelly: 0,
        appliedFraction: 0,
        isHardCapped: false,
        rejectionReason: 'INSUFFICIENT_SPENDABLE_BANKROLL',
      };
    }

    const p = inputs.winProbability ?? inputs.p ?? 0;
    let b = inputs.winLossRatio ?? inputs.b ?? 0;
    if (b <= 0 && inputs.avgWinSol !== undefined && inputs.avgLossSol !== undefined) {
      b = inputs.avgLossSol > 0 ? inputs.avgWinSol / inputs.avgLossSol : 0;
    }

    const rawKelly = CapitalSizer.calculateRawKelly(p, b);

    if (rawKelly <= 0) {
      return {
        approved: false,
        orderSizeSol: 0,
        spendableBankrollSol: spendable,
        rawKelly: Math.max(0, rawKelly),
        shrinkageFactor: 0,
        shrunkKelly: 0,
        appliedFraction: 0,
        isHardCapped: false,
        rejectionReason: 'NEGATIVE_OR_ZERO_EXPECTANCY',
      };
    }

    const N = Math.max(0, inputs.historicalTradeCount ?? inputs.N ?? inputs.tradeCount ?? 0);
    const S = CapitalSizer.calculateShrinkage(N);

    const fractionMultiplier = inputs.fractionMultiplier ?? CapitalSizer.DEFAULT_FRACTION_MULTIPLIER;
    const f_shrunk = Math.max(0, rawKelly * S * fractionMultiplier);

    const maxCeiling = inputs.maxCapitalPctCeiling ?? CapitalSizer.DEFAULT_MAX_CAPITAL_PCT_CEILING;
    const cappedFraction = Math.min(f_shrunk, maxCeiling);
    const isHardCapped = f_shrunk > maxCeiling;

    const orderSizeSol = Number((spendable * cappedFraction).toFixed(6));

    if (orderSizeSol <= 0) {
      return {
        approved: false,
        orderSizeSol: 0,
        spendableBankrollSol: spendable,
        rawKelly,
        shrinkageFactor: S,
        shrunkKelly: f_shrunk,
        appliedFraction: cappedFraction,
        isHardCapped,
        rejectionReason: 'INSUFFICIENT_SPENDABLE_BANKROLL',
      };
    }

    return {
      approved: true,
      orderSizeSol,
      spendableBankrollSol: spendable,
      rawKelly,
      shrinkageFactor: S,
      shrunkKelly: f_shrunk,
      appliedFraction: cappedFraction,
      isHardCapped,
    };
  }

  public static calculateOrderSize(inputs: CapitalSizingInputs): CapitalSizingResult {
    return new CapitalSizer().calculateOrderSize(inputs);
  }
}

export const capitalSizer = new CapitalSizer();
