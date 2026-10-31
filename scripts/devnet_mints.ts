/**
 * Picking a devnet pump.fun mint the app's own eligibility filter accepts, for the devnet harness (S226). Harness only: nothing here is
 * imported by the server, and the app's filter is never changed.
 *
 * - `recentCreateMints` reads the pump program's recent transactions and returns the mints named in CreateEvent / TradeEvent log lines.
 * - A candidate is probed (curve readable, not migrated, creator and top-10 holding read) and classified CLEAR, OVER (a known share is over
 *   a limit), UNKNOWN (holder data could not be read: a 429 on the public RPC) or UNUSABLE.
 * - `orderCandidates` puts every CLEAR mint first. Only when none is CLEAR may it offer OVER mints (lowest creator share first), and only if
 *   the caller allows a waiver. UNKNOWN is never waived: not knowing is not the same as being over a limit.
 * - `waiveHolderChecks` turns a failed report into a harness-only passing one, but only when the creator and top-10 checks are the ONLY
 *   failures, and it says in each check's reason that it was waived and why.
 */
import { PublicKey, type Connection } from '@solana/web3.js';
import type { TokenEligibilityReport } from '../server/core/types';
import { TOKEN_2022_PROGRAM_ID } from '../server/solana/programs';

/** Anchor CreateEvent / TradeEvent discriminators (the same values the feed listener checks). */
export const CREATE_EVENT_DISC = Buffer.from('1b72a94ddeeb6376', 'hex');
export const TRADE_EVENT_DISC = Buffer.from('bddb7fd34ee661ee', 'hex');

/** The mint a pump `Program data:` log line names, or null. CreateEvent: three length-prefixed strings, then the mint. TradeEvent: the mint first. */
export function mintFromProgramDataLog(line: string): string | null {
  if (!line.startsWith('Program data: ')) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(line.slice('Program data: '.length).trim(), 'base64');
  } catch {
    return null;
  }
  if (buf.length < 8 + 32) return null;
  const disc = buf.subarray(0, 8);
  try {
    if (disc.equals(TRADE_EVENT_DISC)) return new PublicKey(buf.subarray(8, 40)).toBase58();
    if (disc.equals(CREATE_EVENT_DISC)) {
      let off = 8;
      for (let i = 0; i < 3; i++) {
        if (off + 4 > buf.length) return null;
        off += 4 + buf.readUInt32LE(off);
      }
      if (off + 32 > buf.length) return null;
      return new PublicKey(buf.subarray(off, off + 32)).toBase58();
    }
  } catch {
    return null;
  }
  return null;
}

export { scrubUrls } from './redact';

/** Distinct mints from the pump program's most recent transactions, newest first. Never throws: an RPC error ends the scan with what was found. */
export async function recentCreateMints(
  conn: Pick<Connection, 'getSignaturesForAddress' | 'getTransaction'>,
  programId: PublicKey,
  opts: { maxSignatures?: number; max?: number; pauseMs?: number } = {}
): Promise<string[]> {
  const { maxSignatures = 60, max = 30, pauseMs = 120 } = opts;
  const found: string[] = [];
  try {
    const sigs = await conn.getSignaturesForAddress(programId, { limit: maxSignatures }, 'confirmed');
    for (const s of sigs) {
      if (s.err) continue;
      try {
        const tx = await conn.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        for (const line of tx?.meta?.logMessages ?? []) {
          const m = mintFromProgramDataLog(line);
          if (m && !found.includes(m)) found.push(m);
        }
      } catch {
        // one transaction that cannot be read is skipped
      }
      if (found.length >= max) break;
      if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    }
  } catch {
    // no signatures: the caller falls back to the listed mints
  }
  return found;
}

export type MintClass = 'CLEAR' | 'OVER' | 'UNKNOWN' | 'UNUSABLE';

export interface MintProbe {
  mint: string;
  /** the curve was read and has not migrated */
  usable: boolean;
  creatorPct: number | null;
  top10Pct: number | null;
  note?: string;
}

export interface HolderLimits {
  maxCreatorPct: number;
  maxTop10Pct: number;
}

export function classifyProbe(p: MintProbe, limits: HolderLimits): MintClass {
  if (!p.usable) return 'UNUSABLE';
  if (p.creatorPct === null || p.top10Pct === null) return 'UNKNOWN';
  // the filter passes a share equal to the limit (<=)
  return p.creatorPct <= limits.maxCreatorPct && p.top10Pct <= limits.maxTop10Pct ? 'CLEAR' : 'OVER';
}

export interface Candidate {
  mint: string;
  kind: 'CLEAR' | 'OVER';
  creatorPct: number;
  top10Pct: number;
}

/** CLEAR mints first (in the order probed). OVER mints follow only if `allowWaiver`, lowest creator share first. UNKNOWN and UNUSABLE never appear. */
export function orderCandidates(probes: MintProbe[], limits: HolderLimits, allowWaiver: boolean): Candidate[] {
  const out: Candidate[] = [];
  for (const p of probes) if (classifyProbe(p, limits) === 'CLEAR') out.push({ mint: p.mint, kind: 'CLEAR', creatorPct: p.creatorPct!, top10Pct: p.top10Pct! });
  if (allowWaiver) {
    const over = probes
      .filter((p) => classifyProbe(p, limits) === 'OVER')
      .sort((a, b) => a.creatorPct! - b.creatorPct! || a.top10Pct! - b.top10Pct!);
    for (const p of over) out.push({ mint: p.mint, kind: 'OVER', creatorPct: p.creatorPct!, top10Pct: p.top10Pct! });
  }
  return out;
}

const WAIVABLE = new Set(['MAX_CREATOR_EXPOSURE', 'TOP_10_CONCENTRATION']);

/**
 * A copy of a LIVE eligibility report in which a FAILED creator or top-10 check is marked passed, with the reason rewritten to say it was
 * waived by the devnet harness and what the observed value and limit were. Returns null when any other check failed or either holder check
 * is UNKNOWN (never waived). Passing checks and the observed values are left as they were.
 */
export function waiveHolderChecks(report: TokenEligibilityReport, now: number = Date.now()): { report: TokenEligibilityReport; waived: string[] } | null {
  const failed = report.checks.filter((c) => !c.passed);
  if (failed.some((c) => !WAIVABLE.has(c.ruleId) || c.status === 'UNKNOWN')) return null;
  if (report.checks.some((c) => WAIVABLE.has(c.ruleId) && c.status === 'UNKNOWN')) return null;
  const waived: string[] = [];
  const checks = report.checks.map((c) => {
    if (c.passed || !WAIVABLE.has(c.ruleId)) return c;
    waived.push(`${c.ruleId} ${c.observedValue} (limit ${c.threshold})`);
    return { ...c, passed: true, status: 'PASS' as const, reason: `WAIVED by the devnet harness only: observed ${c.observedValue}, limit ${c.threshold}. ${c.reason}` };
  });
  return { report: { ...report, checks, failedCount: checks.filter((c) => !c.passed).length, isEligible: checks.every((c) => c.passed), evaluatedAt: now }, waived };
}

/**
 * The facts the coordinator gives the eligibility filter for a LIVE buy, from the same market state and holder distribution. A copy of
 * `ExecutionCoordinator.eligibilityInputFromMarket` (private); a test compares the two so they cannot drift apart.
 */
export function harnessEligibilityInput(
  req: { mint: string; symbol: string; name: string },
  marketState: any,
  holderDist: { devHoldingPct: number; top10HoldersPct: number } | null,
  liquidityUsd: number | undefined
) {
  return {
    mint: req.mint,
    symbol: req.symbol,
    name: req.name,
    creator: marketState.creator.toBase58(),
    priceSol:
      Number(marketState.virtualSolReserves) /
      Number(marketState.virtualTokenReserves) /
      (1e9 / Math.pow(10, marketState.tokenDecimals)),
    liquidityUsd,
    bondingCurveProgress: Number(Math.min(100, (Number(marketState.realSolReserves) / (85 * 1e9)) * 100).toFixed(1)),
    isMigrated: marketState.complete,
    isMintAuthorityRevoked: marketState.isMintAuthorityRevoked,
    isFreezeAuthorityRevoked: marketState.isFreezeAuthorityRevoked,
    hasToken2022Extensions: marketState.baseTokenProgram?.equals(TOKEN_2022_PROGRAM_ID) ?? false,
    token2022Safe: marketState.token2022Report ? marketState.token2022Report.isSafe : undefined,
    unsupportedToken2022Extension:
      marketState.token2022Report && !marketState.token2022Report.isSafe
        ? marketState.token2022Report.unsupportedExtensionNames.join(',') || true
        : undefined,
    devHoldingPct: holderDist ? holderDist.devHoldingPct : null,
    top10HoldersPct: holderDist ? holderDist.top10HoldersPct : null,
    holderFactsAsked: true, // R12-10, as the coordinator
  };
}
