import { ExecutionMode } from '../core/types';

// Authoritative Token Safety & RugCheck Risk Assessor
export type AuthorityStatus = 'ACTIVE' | 'REVOKED' | 'UNKNOWN';

export interface TokenSafetyFactors {
  mint: string;
  isMintRevoked?: boolean | null;
  isFreezeRevoked?: boolean | null;
  mintAuthority?: AuthorityStatus;
  freezeAuthority?: AuthorityStatus;
  hasToken2022Extensions?: boolean | null;
  unsupportedToken2022Extension?: boolean | string | null;
  isLpBurned?: boolean | null;
  devHoldingPct?: number | null;
  top10HoldersPct?: number | null;
  curveProgress?: number | null;
  volume5mUsd?: number | null;
  hasSocials?: boolean | null;
  complete?: boolean | null;
  holderDataSource?: string | null;
}

export interface TokenSafetyAssessment {
  score: 'SAFE' | 'CAUTION' | 'DANGEROUS';
  riskScoreNumber: number; // 0 (safest) to 100 (most dangerous)
  risks: string[];
  passedChecks: string[];
  isEligibleForSniper: boolean;
}

export function evaluateTokenSafety(
  factors: TokenSafetyFactors,
  executionModeOrIsLive: ExecutionMode | boolean = false
): TokenSafetyAssessment {
  const isLiveMode = executionModeOrIsLive === 'LIVE' || executionModeOrIsLive === true;
  const risks: string[] = [];
  const passedChecks: string[] = [];
  let scorePoints = 0;

  // Resolve tri-state freeze authority
  const freezeAuth: AuthorityStatus =
    factors.freezeAuthority ??
    (factors.isFreezeRevoked === true
      ? 'REVOKED'
      : factors.isFreezeRevoked === false
      ? 'ACTIVE'
      : 'UNKNOWN');

  // 1. Freeze Authority Check (Honeypot prevention)
  if (freezeAuth === 'ACTIVE') {
    risks.push('Freeze authority ACTIVE (Critical honeypot risk)');
    scorePoints += 60;
  } else if (freezeAuth === 'REVOKED') {
    passedChecks.push('Freeze authority revoked');
  } else {
    // UNKNOWN
    risks.push('Freeze authority UNKNOWN (Unverified on-chain)');
    scorePoints += isLiveMode ? 60 : 35;
  }

  // Resolve tri-state mint authority
  const mintAuth: AuthorityStatus =
    factors.mintAuthority ??
    (factors.isMintRevoked === true
      ? 'REVOKED'
      : factors.isMintRevoked === false
      ? 'ACTIVE'
      : 'UNKNOWN');

  // 2. Mint Authority Check (Inflation prevention)
  if (mintAuth === 'ACTIVE') {
    risks.push('Mint authority ACTIVE (Unlimited supply dilution risk)');
    scorePoints += 60;
  } else if (mintAuth === 'REVOKED') {
    passedChecks.push('Mint authority revoked');
  } else {
    // UNKNOWN
    risks.push('Mint authority UNKNOWN (Unverified on-chain)');
    scorePoints += isLiveMode ? 60 : 35;
  }

  // 3. Dev holding concentration (Fail-closed if unknown in LIVE)
  if (factors.devHoldingPct == null) {
    risks.push('Developer holding UNKNOWN (Holder distribution unverified)');
    scorePoints += isLiveMode ? 50 : 25;
  } else {
    const devHolding = factors.devHoldingPct;
    if (devHolding > 15) {
      risks.push(`Dev wallet holds excessive supply (${devHolding.toFixed(1)}%)`);
      scorePoints += 40;
    } else if (devHolding > 5) {
      risks.push(`Dev wallet holds elevated supply (${devHolding.toFixed(1)}%)`);
      scorePoints += 20;
    } else {
      passedChecks.push(`Dev holding within limits (${devHolding.toFixed(1)}%)`);
    }
  }

  // 4. Top 10 holders concentration (Fail-closed if unknown in LIVE)
  if (factors.top10HoldersPct == null) {
    risks.push('Top 10 holders concentration UNKNOWN (Cartel risk unverified)');
    scorePoints += isLiveMode ? 50 : 25;
  } else {
    const top10 = factors.top10HoldersPct;
    if (top10 > 50) {
      risks.push(`Top 10 holders control majority of supply (${top10.toFixed(1)}%)`);
      scorePoints += 30;
    } else if (top10 > 35) {
      risks.push(`Top 10 holders moderately concentrated (${top10.toFixed(1)}%)`);
      scorePoints += 15;
    } else {
      passedChecks.push(`Distributed top 10 holders (${top10.toFixed(1)}%)`);
    }
  }

  // 5. Curve progression and liquidity
  const progress = factors.curveProgress ?? 0;
  if (progress < 1 && !factors.complete) {
    risks.push('Immature bonding curve (<1% progress)');
    scorePoints += 10;
  }

  // 6. Social footprint
  if (factors.hasSocials === false && progress < 10) {
    risks.push('No verified social channels or website');
    scorePoints += 10;
  }

  // 7. Token-2022 Policy (Fail-closed on unsupported/unmodeled extensions)
  const isUnsupportedToken2022 =
    factors.unsupportedToken2022Extension === true ||
    (typeof factors.unsupportedToken2022Extension === 'string' && factors.unsupportedToken2022Extension.length > 0);
  if (isUnsupportedToken2022) {
    risks.push(`UNSUPPORTED_TOKEN_EXTENSION: ${factors.unsupportedToken2022Extension}`);
    scorePoints += 70;
  } else if (isLiveMode && factors.hasToken2022Extensions && factors.unsupportedToken2022Extension === undefined) {
    risks.push('UNSUPPORTED_TOKEN_EXTENSION: Token-2022 extensions present but unverified in LIVE');
    scorePoints += 70;
  }

  let finalScore: 'SAFE' | 'CAUTION' | 'DANGEROUS';
  if (
    scorePoints >= 50 ||
    freezeAuth !== 'REVOKED' ||
    mintAuth !== 'REVOKED' ||
    isUnsupportedToken2022 ||
    (isLiveMode && factors.hasToken2022Extensions && factors.unsupportedToken2022Extension === undefined) ||
    (isLiveMode && (factors.devHoldingPct == null || factors.top10HoldersPct == null))
  ) {
    finalScore = 'DANGEROUS';
  } else if (scorePoints >= 20 || risks.length > 0) {
    finalScore = 'CAUTION';
  } else {
    finalScore = 'SAFE';
  }

  return {
    score: finalScore,
    riskScoreNumber: Math.min(100, scorePoints),
    risks,
    passedChecks,
    isEligibleForSniper: finalScore !== 'DANGEROUS',
  };
}
