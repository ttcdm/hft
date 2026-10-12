/**
 * S187: the ONE confluence buy threshold. The watch window's HOT / READY gate and the aggregator's execution gate (manual snipes too)
 * both read it from here, so they cannot diverge. Order of precedence: the operator's value (POST /api/auto/threshold, kept in memory
 * until a restart like the other auto settings), then CONFLUENCE_MIN_SCORE from the environment, then 70.
 * MIN_CONFLUENCE_SCORE and HOT_MIN_SCORE stay exported as the built-in default (70) for code that names it; no gate compares against them.
 */
export const CONFLUENCE_DEFAULT_THRESHOLD = 70;
export const CONFLUENCE_MIN_THRESHOLD = 0;
export const CONFLUENCE_MAX_THRESHOLD = 100;
/** Below this the screen warns plainly: more buys of weaker coins. */
export const CONFLUENCE_WARN_BELOW = 50;

export type ThresholdCheck = { ok: true; value: number } | { ok: false; reason: string };

/** A whole number from 0 to 100. Nothing is clamped: an out-of-range value is refused with its reason. */
export function checkConfluenceThreshold(raw: unknown): ThresholdCheck {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN; // null, booleans and '' are not numbers
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, reason: `REJECTED: THRESHOLD_NOT_A_WHOLE_NUMBER: the confluence threshold must be a whole number from ${CONFLUENCE_MIN_THRESHOLD} to ${CONFLUENCE_MAX_THRESHOLD}.` };
  if (n < CONFLUENCE_MIN_THRESHOLD || n > CONFLUENCE_MAX_THRESHOLD) return { ok: false, reason: `REJECTED: THRESHOLD_OUT_OF_RANGE: ${n} is outside ${CONFLUENCE_MIN_THRESHOLD} to ${CONFLUENCE_MAX_THRESHOLD}.` };
  return { ok: true, value: n };
}

/** CONFLUENCE_MIN_SCORE when it is a valid whole number from 0 to 100, else the built-in 70 (an invalid value is reported by `envProblem`). */
export function envConfluenceThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.CONFLUENCE_MIN_SCORE ?? '').trim();
  if (raw === '') return CONFLUENCE_DEFAULT_THRESHOLD;
  const c = checkConfluenceThreshold(raw);
  return c.ok ? c.value : CONFLUENCE_DEFAULT_THRESHOLD;
}

export function envConfluenceProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.CONFLUENCE_MIN_SCORE ?? '').trim();
  if (raw === '') return null;
  const c = checkConfluenceThreshold(raw);
  return c.ok ? null : `CONFLUENCE_MIN_SCORE=${raw} is ignored (${c.reason}); using ${CONFLUENCE_DEFAULT_THRESHOLD}.`;
}

let operatorValue: number | null = null;

/** The threshold in force right now. */
export function getConfluenceThreshold(): number {
  return operatorValue ?? envConfluenceThreshold();
}

export interface ConfluenceThresholdInfo {
  value: number;
  /** what it falls back to: CONFLUENCE_MIN_SCORE or 70 */
  defaultValue: number;
  source: 'operator' | 'env' | 'default';
  warnBelow: number;
  warning: string | null;
}

export function confluenceWarning(value: number): string | null {
  return value < CONFLUENCE_WARN_BELOW ? `Below ${CONFLUENCE_WARN_BELOW}: more buys of weaker coins. A lower threshold lets more launches through; it does not make them better.` : null;
}

export function confluenceThresholdInfo(): ConfluenceThresholdInfo {
  const def = envConfluenceThreshold();
  const rawEnv = (process.env.CONFLUENCE_MIN_SCORE ?? '').trim();
  const hasEnv = rawEnv !== '' && checkConfluenceThreshold(rawEnv).ok;
  const value = getConfluenceThreshold();
  return { value, defaultValue: def, source: operatorValue !== null ? 'operator' : hasEnv ? 'env' : 'default', warnBelow: CONFLUENCE_WARN_BELOW, warning: confluenceWarning(value) };
}

/** Sets the operator's value. Returns the previous value so the caller can journal the change. */
export function setConfluenceThreshold(raw: unknown): { ok: true; value: number; previous: number } | { ok: false; reason: string } {
  const c = checkConfluenceThreshold(raw);
  if (!c.ok) return c;
  const previous = getConfluenceThreshold();
  operatorValue = c.value;
  return { ok: true, value: c.value, previous };
}

/** Back to CONFLUENCE_MIN_SCORE / 70 (tests, and a restart does the same). */
export function resetConfluenceThreshold(): void {
  operatorValue = null;
}
