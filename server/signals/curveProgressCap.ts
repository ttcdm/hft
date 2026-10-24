import { curveProgressOf } from '../market/poolStats';

/**
 * P4.3 (R1-57): the design drops a launch whose bonding curve is more than 60% complete. A late curve is close to migration (the exit then runs on
 * the PumpSwap path, or the buy fails once `complete` flips), and liquidity, the one confluence factor that grows with fill, favours it.
 *
 * Progress is pump.fun's own bar: the share of the curve's 793.1M tokens already sold (`curveProgressOf`, the figure the board shows). It is NOT real
 * SOL over 85: at 60% of the tokens sold a curve holds about 24 SOL of real reserves (about 28% of 85 SOL). One formula serves all three checks:
 *   - the watch window releases a watched launch DEAD with CURVE_TOO_FAR as soon as its measured progress is above the cap;
 *   - the auto controller drops a HOT or READY release whose measured progress is above it now (stage `curve`);
 *   - the coordinator checks it again on its own fresh curve read, for every caller (auto, callout, manual), PAPER, SHADOW and LIVE alike.
 * An unknown progress (no trade measured yet, curve not readable) never blocks here; the coordinator's fresh read is the authoritative one.
 */
export const MAX_CURVE_PROGRESS_PCT_DEFAULT = 60;

/** APEX_MAX_CURVE_PROGRESS_PCT when it is a number above 0 and at most 100, else 60. Read at each check, so a test or an operator restart picks it up. */
export function maxCurveProgressPct(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.APEX_MAX_CURVE_PROGRESS_PCT ?? '').trim();
  if (raw === '') return MAX_CURVE_PROGRESS_PCT_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : MAX_CURVE_PROGRESS_PCT_DEFAULT;
}

/** The startup warning for an invalid APEX_MAX_CURVE_PROGRESS_PCT, or null. */
export function maxCurveProgressProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.APEX_MAX_CURVE_PROGRESS_PCT ?? '').trim();
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 100 ? null : `APEX_MAX_CURVE_PROGRESS_PCT=${raw} is ignored (a number above 0 and at most 100); using ${MAX_CURVE_PROGRESS_PCT_DEFAULT}.`;
}

const toBig = (v: unknown): bigint | null => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (v && typeof (v as { toString?: unknown }).toString === 'function' && /^\d+$/.test(String(v))) return BigInt(String(v)); // a BN
  return null;
};

/** Progress (0..100) of an on-chain curve state as the coordinator reads it (reserves in lamports / raw token units). Null when the state carries no readable reserves. */
export function curveProgressPctOfState(state: { realSolReserves?: unknown; realTokenReserves?: unknown }): number | null {
  const tok = toBig(state.realTokenReserves);
  // S266 (review 2026-10-24, finding 8): progress is the token share only. With the token reserves unreadable this used to fall back to
  // SOL/85 (about 28% at a real 60%), a figure that looked measured but was wrong. Now it is unknown (null). The cap still lets an unknown
  // progress through, as before; refusing a LIVE buy on it (curveProgressUnreadable) is not wired in yet, since test fixtures carry states
  // with SOL reserves only and the change needs them updated first.
  if (tok === null) return null;
  const sol = toBig(state.realSolReserves);
  return curveProgressOf({ realSolReserves: sol === null ? 0 : Number(sol) / 1e9, realTokenReserves: tok });
}

/** S266: a bonding-curve state whose SOL reserves read but whose token reserves do not: its progress cannot be known. */
export function curveProgressUnreadable(state: { realSolReserves?: unknown; realTokenReserves?: unknown }): boolean {
  return toBig(state.realTokenReserves) === null && toBig(state.realSolReserves) !== null;
}

/** True when a known progress is above the cap in force. */
export function isCurveTooFar(progressPct: number | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof progressPct === 'number' && Number.isFinite(progressPct) && progressPct > maxCurveProgressPct(env);
}

/** `<code>: 72.4% of the curve sold, above the 60% cap (APEX_MAX_CURVE_PROGRESS_PCT)`. */
export function curveTooFarReason(code: 'CURVE_TOO_FAR' | 'CURVE_PROGRESS_TOO_HIGH', progressPct: number, env: NodeJS.ProcessEnv = process.env): string {
  return `${code}: ${progressPct.toFixed(1)}% of the curve sold, above the ${maxCurveProgressPct(env)}% cap (APEX_MAX_CURVE_PROGRESS_PCT)`;
}
