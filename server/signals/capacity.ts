import { isReadOnly } from '../solana/readOnly';

/** The default number of launches the watch window follows at once (Q6c). */
export const WATCH_DEFAULT_CANDIDATES = 60;
/** What read-only mode starts with: a mainnet feed brings thousands of launches a day and bursts several times the average. */
export const WATCH_READ_ONLY_CANDIDATES = 250;
const WATCH_MIN_ALLOWED = 10;
const WATCH_MAX_ALLOWED = 2_000;

/**
 * S185: the watch window capacity. APEX_WATCH_MAX_CANDIDATES (10 to 2000) sets it; otherwise 60, or 250 in read-only mode. A launch that
 * arrives while the window is full is not watched and is counted (watchWindow.getSnapshot().capacity.refusedFull), never silently lost.
 */
export function watchMaxCandidates(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.APEX_WATCH_MAX_CANDIDATES ?? '').trim();
  if (raw !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= WATCH_MIN_ALLOWED && n <= WATCH_MAX_ALLOWED) return n;
  }
  return isReadOnly(env) ? WATCH_READ_ONLY_CANDIDATES : WATCH_DEFAULT_CANDIDATES;
}

/** The measured-stats table must outlive every watched mint: three times the window, never under the old 300. */
export function poolStatsMaxMints(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(300, watchMaxCandidates(env) * 3);
}
