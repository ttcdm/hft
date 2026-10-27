/**
 * R6-7 / R6-8: how old a figure is, as text. Every price, mark and balance on screen says its age, and says STALE past its limit, so a
 * frozen number is not read as live. null age means it was never read.
 */
export function ageText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'never read';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
}

/** A polled figure is stale when its last fetch failed or its last good answer is older than `limitMs`. */
export function isStale(lastGoodAt: number | null, lastFetchFailed: boolean, now: number, limitMs: number): boolean {
  return lastFetchFailed || lastGoodAt === null || now - lastGoodAt > limitMs;
}

/** The header PnL pill counts as stale after this long without a good /api/wallet/state answer (it polls every 3.5 s). */
export const PILL_STALE_MS = 10_000;

/** The coordinator's MARK_STALE_MS (server/execution/coordinator.ts): a mark older than this is stale there too. */
export const MARK_STALE_MS = 15_000;
export const markIsStale = (lastMarkTimestamp: number | null | undefined, now: number): boolean => !lastMarkTimestamp || now - lastMarkTimestamp > MARK_STALE_MS;
