import { ConfluenceBreakdown } from '../core/types';
import { CONFLUENCE_DEFAULT_THRESHOLD, getConfluenceThreshold } from './confluenceThreshold';
import {
  CurveVelocityMetrics,
  CurveVelocityEvaluator,
  curveVelocityEvaluator,
} from './curveVelocityEvaluator';
import {
  CreatorRiskReport,
  CreatorRiskScorer,
  creatorRiskScorer,
  CREATOR_LOOKUP_FAILED_FLAG,
} from './creatorRiskScorer';

/** The built-in default. The threshold in force is getConfluenceThreshold() (S187: operator-editable, env CONFLUENCE_MIN_SCORE). */
export const MIN_CONFLUENCE_SCORE = CONFLUENCE_DEFAULT_THRESHOLD;

/**
 * Checks whether the composite confluence score meets the buy threshold in force (default 70; `min` overrides it for a what-if replay).
 */
export function isConfluencePassed(score: number, min: number = getConfluenceThreshold()): boolean {
  return typeof score === 'number' && !isNaN(score) && score >= min;
}

/** A metric is "known" only when it is a finite number. null/undefined/NaN mean missing and earn no points (B3). */
const known = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

export interface ConfluenceFactorsInput {
  // null / undefined = the data source did not provide it. Missing data scores 0 for that factor, never a default.
  priceChange5mPct: number | null;
  liquidityUsd: number | null;
  top10HoldersPct: number | null;
  bondingCurveProgress: number | null;
  buys5m: number | null;
  sells5m: number | null;
  devHoldingPct: number | null;
  hasVerifiedSocialCall: boolean;
  socialCallCount: number;

  // On-chain Alpha Signals Integration (B14)
  mint?: string;
  creatorAddress?: string;
  curveVelocityMetrics?: CurveVelocityMetrics;
  /** 5C: null = the caller knows there is no report (the replay), so the live creator cache is not read; the creator then scores as live without a report */
  creatorRiskReport?: CreatorRiskReport | null;
  slotAcceleration?: number;
  volume10sSol?: number;
  volume30sSol?: number;
  buyVolume10sSol?: number;
  creatorWalletAgeSeconds?: number;
  creatorSignatureCount?: number;
  isCreatorBurner?: boolean;
}

export class ConfluenceEngine {
  public static get MIN_PASSING_SCORE(): number {
    return getConfluenceThreshold();
  }

  public static isConfluencePassed(score: number): boolean {
    return isConfluencePassed(score);
  }

  public static calculate(input: ConfluenceFactorsInput): ConfluenceBreakdown {
    // 1. Momentum Score (0 - 20)
    // Scaled around 0-50% 5m change
    const missing: string[] = [];
    if (!known(input.priceChange5mPct)) missing.push('momentum');
    if (!known(input.liquidityUsd)) missing.push('liquidity');
    if (!known(input.top10HoldersPct)) missing.push('distribution');
    if (!known(input.buys5m) || !known(input.sells5m)) missing.push('orderflow');
    let momentumScore = 0;
    if (known(input.priceChange5mPct) && input.priceChange5mPct > 0) {
      momentumScore = Math.min(20, Math.round((input.priceChange5mPct / 40) * 20));
    }

    // 2. Liquidity Score (0 - 15)
    // Scaled around $10k - $100k depth
    let liquidityScore = 0;
    if (known(input.liquidityUsd) && input.liquidityUsd >= 5000) {
      liquidityScore = Math.min(15, Math.round((input.liquidityUsd / 60000) * 15));
    }

    // 3. Holder Distribution Score (0 - 15)
    // Low top-10 concentration gives max points
    let holderScore = 0;
    if (!known(input.top10HoldersPct)) {
      holderScore = 0;
    } else if (input.top10HoldersPct <= 15) {
      holderScore = 15;
    } else if (input.top10HoldersPct <= 30) {
      holderScore = 10;
    } else if (input.top10HoldersPct <= 45) {
      holderScore = 5;
    }

    // 4. Bonding Curve Velocity (0 - 15)
    // Priority: Real on-chain slot acceleration & trade flow velocity
    let curveScore: number;
    if (input.curveVelocityMetrics) {
      curveScore = input.curveVelocityMetrics.velocityScore;
    } else if (input.slotAcceleration !== undefined || input.volume10sSol !== undefined) {
      curveScore = CurveVelocityEvaluator.evaluateFromParams({
        slotAcceleration: input.slotAcceleration,
        volume10sSol: input.volume10sSol,
        volume30sSol: input.volume30sSol,
        buyVolume10sSol: input.buyVolume10sSol,
      }).velocityScore;
    } else if (input.mint && curveVelocityEvaluator.hasData(input.mint)) {
      curveScore = curveVelocityEvaluator.getMetrics(input.mint).velocityScore;
    } else {
      // C2: no measured velocity means no velocity points. The old fallback awarded up to 15 points from curve
      // progress alone (>= 90% got the maximum), which scored a nearly-finished curve as if it were accelerating.
      curveScore = 0;
      missing.push('velocity');
    }

    // 5. Buy/Sell Imbalance Score (0 - 20)
    // Higher buy ratio (> 75% buys) gives max points
    let imbalanceScore = 0;
    const totalTx = known(input.buys5m) && known(input.sells5m) ? (input.buys5m as number) + (input.sells5m as number) : 0;
    if (totalTx > 10) {
      const buyRatio = (input.buys5m as number) / totalTx;
      imbalanceScore = Math.round(buyRatio * 20);
    }

    // 6. Creator Risk Score (0 - 5)
    // Priority: Real on-chain creator transaction history & burner wallet detection
    let creatorRiskScore = 0;
    const creatorReport = input.creatorRiskReport === null
      ? undefined
      : input.creatorRiskReport ?? (input.creatorAddress ? creatorRiskScorer.getCachedReport(input.creatorAddress) : undefined);
    if (creatorReport) {
      creatorRiskScore = creatorReport.confluenceScore;
      if (creatorReport.riskFlags.includes(CREATOR_LOOKUP_FAILED_FLAG)) missing.push('creator'); // a failed lookup is 0 points of missing data
    } else if (input.isCreatorBurner === true) {
      creatorRiskScore = 0;
    } else if (input.creatorWalletAgeSeconds !== undefined || input.creatorSignatureCount !== undefined) {
      creatorRiskScore = CreatorRiskScorer.evaluateFromParams({
        walletAgeSeconds: input.creatorWalletAgeSeconds,
        signatureCount: input.creatorSignatureCount,
        isBurner: input.isCreatorBurner,
      }).confluenceScore;
    } else if (input.creatorAddress) {
      // P4.1 (R1-53): the creator is known but its report is not (expired, never fetched). Dev holding is no stand-in for it: a burner
      // with no dev buy holds 0% and used to get the full 5 points here once its 0-point report expired.
      missing.push('creator');
    } else {
      // No creator known at all (a feed without it; 5C: the replay passes its recorded creator): fall back to dev holding. 0% dev holding = 5 points
      if (!known(input.devHoldingPct)) {
        missing.push('creator');
      } else if (input.devHoldingPct <= 0.1) {
        creatorRiskScore = 5;
      } else if (input.devHoldingPct <= 2.5) {
        creatorRiskScore = 3;
      } else if (input.devHoldingPct <= 5.0) {
        creatorRiskScore = 1;
      }
    }

    // 7. Social Signal Score (0 - 10)
    // ONLY awarded when real verified social call exists (no synthetic calls)
    let socialScore = 0;
    if (input.hasVerifiedSocialCall) {
      socialScore = Math.min(10, input.socialCallCount * 5);
    }

    const compositeScore = Math.min(
      100,
      momentumScore +
        liquidityScore +
        holderScore +
        curveScore +
        imbalanceScore +
        creatorRiskScore +
        socialScore
    );

    const explanation = `Confluence ${compositeScore}/100: Momentum (${momentumScore}/20), Liquidity (${liquidityScore}/15), Distribution (${holderScore}/15), Curve (${curveScore}/15), OrderFlow (${imbalanceScore}/20), DevRisk (${creatorRiskScore}/5), Social (${socialScore}/10)${missing.length ? ` [missing data, scored 0: ${missing.join(', ')}]` : ''}`;

    return {
      momentumScore,
      liquidityScore,
      holderDistributionScore: holderScore,
      bondingCurveVelocityScore: curveScore,
      buySellImbalanceScore: imbalanceScore,
      creatorRiskScore,
      socialSignalScore: socialScore,
      compositeScore,
      explanation,
    };
  }

  public static evaluate(input: ConfluenceFactorsInput): ConfluenceBreakdown & { passed: boolean } {
    const breakdown = ConfluenceEngine.calculate(input);
    return {
      ...breakdown,
      passed: isConfluencePassed(breakdown.compositeScore),
    };
  }
}
