/**
 * The token eligibility gate. Pure: it takes what is known about one token (authorities, creator and top-10 holder shares, Token-2022
 * extensions, liquidity in USD, whether it has migrated) and returns a report with one result per rule. It reads no chain and no
 * network; the caller gathers the data.
 *
 * Rules, in order: freeze authority revoked, mint authority revoked, creator share under `MAX_CREATOR_HOLDING_PCT`, top-10 share under
 * `MAX_TOP10_HOLDERS_PCT`, Token-2022 policy, liquidity above `minLiquidityUsd()` (`MIN_LIQUIDITY_USD`, honoured off mainnet only), and
 * not graduated. Each rule is PASS, FAIL or UNKNOWN.
 *
 * What it must never do: pass an UNKNOWN in LIVE. `evaluate(token, 'LIVE')` fails every rule whose status is UNKNOWN; only PAPER lets an
 * UNKNOWN through, and the report then records it so the fill can be marked unverified. A change here that makes UNKNOWN pass in LIVE is a
 * safety regression. R12-10: the two holder rules (creator cap and top-10) also fail an UNKNOWN in PAPER when the holder facts were asked of
 * the chain (`holderFactsAsked`: the curve was read, so the holder read was made and failed or timed out), so PAPER does not fill a real
 * token LIVE would refuse for lack of holder data. A PAPER buy whose curve could not be read at all is filled on the flat model and
 * recorded unverified, as before.
 *
 * Called by: `ExecutionCoordinator` (`evaluatePaperBuy` and the LIVE path of `executeTrade`). The watch window and the auto
 * controller do not call it; they rely on the coordinator's verdict.
 */
import { MAX_TOP10_HOLDERS_PCT, MAX_CREATOR_HOLDING_PCT, minLiquidityUsd } from '../solana/executionConfig';
import { TokenEligibilityReport, EligibilityCheckResult, TriState, ExecutionMode } from '../core/types';

/** What a token account says about an authority: still held, given up, or not read. */
export type AuthorityStatus = 'ACTIVE' | 'REVOKED' | 'UNKNOWN';

/** The facts one evaluation needs. Most fields are optional and tri-state on purpose: absent or null means "not verified", which is UNKNOWN, never a pass. */
export interface TokenRawData {
  mint: string;
  symbol: string;
  name: string;
  creator?: string;
  isMintAuthorityRevoked?: boolean | AuthorityStatus | TriState | null;
  isFreezeAuthorityRevoked?: boolean | AuthorityStatus | TriState | null;
  mintAuthority?: AuthorityStatus | TriState | null;
  freezeAuthority?: AuthorityStatus | TriState | null;
  hasToken2022Extensions?: boolean;
  unsupportedToken2022Extension?: boolean | string | null;
  token2022Safe?: boolean | null;
  devHoldingPct?: number | null;
  top10HoldersPct?: number | null;
  /** R12-10: the holder facts were asked of the chain (the caller read the curve and then the holders). An UNKNOWN holder rule then fails in PAPER too. */
  holderFactsAsked?: boolean;
  liquidityUsd?: number;
  volume5mUsd?: number;
  bondingCurveProgress?: number;
  createdAgoMs?: number;
  priceSol?: number;
  isMigrated?: boolean;
}

/** Folds the specific authority field and the boolean/status fallback into PASS (revoked), FAIL (active) or UNKNOWN. The specific field wins when both are present. */
function resolveAuthorityStatus(
  specificAuth: AuthorityStatus | TriState | null | undefined,
  booleanOrStatus: boolean | AuthorityStatus | TriState | null | undefined
): TriState {
  if (specificAuth !== undefined && specificAuth !== null) {
    if (specificAuth === 'REVOKED' || specificAuth === 'PASS') return 'PASS';
    if (specificAuth === 'ACTIVE' || specificAuth === 'FAIL') return 'FAIL';
    return 'UNKNOWN';
  }
  if (booleanOrStatus !== undefined && booleanOrStatus !== null) {
    if (booleanOrStatus === true || booleanOrStatus === 'REVOKED' || booleanOrStatus === 'PASS') return 'PASS';
    if (booleanOrStatus === false || booleanOrStatus === 'ACTIVE' || booleanOrStatus === 'FAIL') return 'FAIL';
    return 'UNKNOWN';
  }
  return 'UNKNOWN';
}

/** Namespace for the single static rule evaluator. */
export class EligibilityFilter {
  /**
   * Runs every rule and returns the report. `isEligible` is true only when no rule failed. The second argument is the execution mode (or a legacy
   * boolean where true means strict). Strict is `'LIVE'` or `true`: PAPER passes `true` when `PAPER_STRICT_GATES` is on, and then rejects UNKNOWN like LIVE.
 * Anything else is lenient PAPER.
   */
  public static evaluate(token: TokenRawData, isLiveModeOrExecutionMode: ExecutionMode | boolean = false): TokenEligibilityReport {
    const isLiveMode = isLiveModeOrExecutionMode === 'LIVE' || isLiveModeOrExecutionMode === true;
    // R12-10: holder facts that were asked for and not read are refused in every mode (PAPER fills only what LIVE would buy)
    const holderStrict = isLiveMode || token.holderFactsAsked === true;
    const checks: EligibilityCheckResult[] = [];
    const now = Date.now();

    // 1. Freeze Authority (Tri-State: PASS / FAIL / UNKNOWN; in LIVE: critical UNKNOWN -> REJECT)
    const freezeStatus = resolveAuthorityStatus(token.freezeAuthority, token.isFreezeAuthorityRevoked);
    const freezePassed = freezeStatus === 'PASS' ? true : freezeStatus === 'FAIL' ? false : !isLiveMode;
    checks.push({
      ruleId: 'FREEZE_AUTHORITY_REVOKED',
      ruleName: 'Freeze Authority Revoked',
      passed: freezePassed,
      status: freezeStatus,
      observedValue:
        freezeStatus === 'PASS' ? 'Revoked' : freezeStatus === 'FAIL' ? 'Active (Honeypot risk)' : 'Unknown',
      threshold: 'Revoked',
      reason:
        freezeStatus === 'PASS'
          ? 'Freeze authority is disabled. Tokens cannot be frozen in holder wallets.'
          : freezeStatus === 'FAIL'
          ? 'Freeze authority is active. Potential honeypot risk.'
          : isLiveMode
          ? 'Freeze authority status is UNKNOWN. Critical safety unverified; rejected in LIVE mode.'
          : 'Freeze authority status is UNKNOWN (allowed in paper mode).',
      source: 'SOLANA_RPC',
      timestamp: now,
    });

    // 2. Mint Authority (Tri-State: PASS / FAIL / UNKNOWN; in LIVE: critical UNKNOWN -> REJECT)
    const mintStatus = resolveAuthorityStatus(token.mintAuthority, token.isMintAuthorityRevoked);
    const mintPassed = mintStatus === 'PASS' ? true : mintStatus === 'FAIL' ? false : !isLiveMode;
    checks.push({
      ruleId: 'MINT_AUTHORITY_REVOKED',
      ruleName: 'Mint Authority Revoked',
      passed: mintPassed,
      status: mintStatus,
      observedValue:
        mintStatus === 'PASS' ? 'Revoked' : mintStatus === 'FAIL' ? 'Active (Dilution risk)' : 'Unknown',
      threshold: 'Revoked',
      reason:
        mintStatus === 'PASS'
          ? 'Supply is fixed. Dev cannot mint additional tokens.'
          : mintStatus === 'FAIL'
          ? 'Mint authority is active. Unlimited supply dilution risk.'
          : isLiveMode
          ? 'Mint authority status is UNKNOWN. Critical safety unverified; rejected in LIVE mode.'
          : 'Mint authority status is UNKNOWN (allowed in paper mode).',
      source: 'SOLANA_RPC',
      timestamp: now,
    });

    // 3. Creator Holding Exposure (Tri-State: PASS / FAIL / UNKNOWN; in LIVE: critical UNKNOWN -> REJECT)
    const MAX_DEV_PCT = MAX_CREATOR_HOLDING_PCT;
    const hasDevData = token.devHoldingPct !== null && token.devHoldingPct !== undefined;
    const devStatus: TriState = hasDevData
      ? token.devHoldingPct! <= MAX_DEV_PCT
        ? 'PASS'
        : 'FAIL'
      : 'UNKNOWN';
    const devPassed = devStatus === 'PASS' ? true : devStatus === 'FAIL' ? false : !holderStrict;
    checks.push({
      ruleId: 'MAX_CREATOR_EXPOSURE',
      ruleName: 'Creator Holding Concentration',
      passed: devPassed,
      status: devStatus,
      observedValue: hasDevData
        ? `${token.devHoldingPct!.toFixed(1)}%`
        : holderStrict
        ? 'Unknown (Fail-closed)'
        : 'Unverified (Paper)',
      threshold: `< ${MAX_DEV_PCT}%`,
      reason: hasDevData
        ? devStatus === 'PASS'
          ? `Creator holds at most ${token.devHoldingPct!.toFixed(1)}% (its own accounts, its funder cluster and every holder not known to be independent), within safe tolerance.`
          : `Creator may hold excessive supply (${token.devHoldingPct!.toFixed(1)}%: its own accounts, its funder cluster and every holder not known to be independent). High rug risk.`
        : isLiveMode
        ? 'Creator holding percentage is unknown. Fail-closed rejection on live trading.'
        : holderStrict
        ? 'Creator holding percentage could not be read. Fail-closed rejection in PAPER too (PAPER fills only what LIVE would buy).'
        : 'Creator holding unverified in simulated execution.',
      source: 'SOLANA_RPC',
      timestamp: now,
    });

    // 4. Top 10 Holders Concentration (Tri-State: PASS / FAIL / UNKNOWN; in LIVE: critical UNKNOWN -> REJECT)
    const MAX_TOP10_PCT = MAX_TOP10_HOLDERS_PCT;
    const hasTop10Data = token.top10HoldersPct !== null && token.top10HoldersPct !== undefined;
    const top10Status: TriState = hasTop10Data
      ? token.top10HoldersPct! <= MAX_TOP10_PCT
        ? 'PASS'
        : 'FAIL'
      : 'UNKNOWN';
    const top10Passed = top10Status === 'PASS' ? true : top10Status === 'FAIL' ? false : !holderStrict;
    checks.push({
      ruleId: 'TOP_10_CONCENTRATION',
      ruleName: 'Top 10 Holders Concentration',
      passed: top10Passed,
      status: top10Status,
      observedValue: hasTop10Data
        ? `${token.top10HoldersPct!.toFixed(1)}%`
        : holderStrict
        ? 'Unknown (Fail-closed)'
        : 'Unverified (Paper)',
      threshold: `< ${MAX_TOP10_PCT}%`,
      reason: hasTop10Data
        ? top10Status === 'PASS'
          ? `Top 10 hold ${token.top10HoldersPct!.toFixed(1)}%, decentralized distribution.`
          : `Top 10 holders control ${token.top10HoldersPct!.toFixed(1)}% of supply. High cartel dump risk.`
        : isLiveMode
        ? 'Top 10 holder distribution is unknown. Fail-closed rejection on live trading.'
        : holderStrict
        ? 'Top 10 holder distribution could not be read. Fail-closed rejection in PAPER too (PAPER fills only what LIVE would buy).'
        : 'Top 10 holder distribution unverified in simulated execution.',
      source: 'SOLANA_RPC',
      timestamp: now,
    });

    // 5. Token-2022 Policy: Inspect extensions (R0.8: unsupported/unmodeled -> UNSUPPORTED_TOKEN_EXTENSION -> REJECT)
    if (token.hasToken2022Extensions || token.unsupportedToken2022Extension !== undefined || token.token2022Safe !== undefined) {
      const isUnsupported =
        token.unsupportedToken2022Extension === true ||
        (typeof token.unsupportedToken2022Extension === 'string' && token.unsupportedToken2022Extension.length > 0) ||
        token.token2022Safe === false;
      const isExplicitSafe = token.token2022Safe === true && !token.unsupportedToken2022Extension;
      const t22Status: TriState = isUnsupported ? 'FAIL' : isExplicitSafe ? 'PASS' : 'UNKNOWN';
      const t22Passed = t22Status === 'PASS' ? true : t22Status === 'FAIL' ? false : !isLiveMode;

      checks.push({
        ruleId: 'TOKEN_2022_POLICY',
        ruleName: 'Token-2022 Extensions Safety',
        passed: t22Passed,
        status: t22Status,
        observedValue: isUnsupported
          ? typeof token.unsupportedToken2022Extension === 'string'
            ? `UNSUPPORTED_TOKEN_EXTENSION (${token.unsupportedToken2022Extension})`
            : 'UNSUPPORTED_TOKEN_EXTENSION'
          : isExplicitSafe
          ? 'Supported Extensions Only'
          : 'Extensions Unverified',
        threshold: 'Supported Extensions Only',
        reason: isUnsupported
          ? 'UNSUPPORTED_TOKEN_EXTENSION: Token uses unsupported or unmodeled Token-2022 extensions. Fail-closed in LIVE.'
          : isExplicitSafe
          ? 'Token-2022 extensions inspected and verified safe.'
          : isLiveMode
          ? 'UNSUPPORTED_TOKEN_EXTENSION: Token-2022 extensions unverified. Rejected in LIVE mode.'
          : 'Token-2022 extensions unverified (Paper mode).',
        source: 'SOLANA_RPC',
        timestamp: now,
      });
    }

    // 6. Minimum Liquidity Depth
    const MIN_LIQUIDITY_USD = minLiquidityUsd();
    // C5: a missing liquidity figure is UNKNOWN (LIVE rejects it, PAPER lets it through and records it), not "$NaN < min".
    const hasLiq = typeof token.liquidityUsd === 'number' && Number.isFinite(token.liquidityUsd);
    const liq = hasLiq ? (token.liquidityUsd as number) : 0;
    const liqStatus: TriState = !hasLiq ? 'UNKNOWN' : liq >= MIN_LIQUIDITY_USD ? 'PASS' : 'FAIL';
    const liqPassed = liqStatus === 'PASS' ? true : liqStatus === 'FAIL' ? false : !isLiveMode;
    checks.push({
      ruleId: 'MIN_LIQUIDITY_DEPTH',
      ruleName: 'Minimum Liquidity Depth',
      passed: liqPassed,
      status: liqStatus,
      observedValue: hasLiq ? `$${Math.round(liq).toLocaleString()}` : 'Unknown',
      threshold: `> $${MIN_LIQUIDITY_USD}`,
      reason:
        liqStatus === 'PASS'
          ? `Liquidity ($${Math.round(liq)}) supports low slippage execution.`
          : liqStatus === 'FAIL'
          ? `Liquidity ($${Math.round(liq)}) is below minimum safe execution threshold.`
          : isLiveMode
          ? 'Liquidity is unknown. Fail-closed rejection on live trading.'
          : 'Liquidity unverified in simulated execution.',
      source: 'PUMPFUN',
      timestamp: now,
    });

    // 7. Token Migration Status
    if (token.isMigrated) {
      checks.push({
        ruleId: 'BONDING_CURVE_GRADUATED',
        ruleName: 'Bonding Curve State',
        passed: false,
        status: 'FAIL',
        observedValue: 'Graduated / Migrated',
        threshold: 'Active Bonding Curve',
        reason: 'Token has already graduated from Pump.fun bonding curve. Curve trade impossible.',
        source: 'SOLANA_RPC',
        timestamp: now,
      });
    }

    const failedCount = checks.filter((c) => !c.passed).length;

    return {
      mint: token.mint,
      isEligible: failedCount === 0,
      checks,
      failedCount,
      evaluatedAt: now,
    };
  }
}
