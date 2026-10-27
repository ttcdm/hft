/** Q35: the header pill. Signed dollar amounts from what /api/wallet/state really returns; null (no SOL price yet) is a dash. */
export interface PillState {
  realizedUsd: number | null;
  unrealizedUsd: number | null;
  openCount: number;
  /** R6-2: real LIVE positions still open while the server is not in LIVE (after a disarm); absent when there are none. */
  live?: { openCount: number; unrealizedUsd: number | null; realizedUsd: number | null } | null;
}

export const signedUsd = (v: number | null | undefined): string =>
  typeof v === 'number' && Number.isFinite(v) ? `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}` : '—';

export function readPillState(data: any): PillState | null {
  if (!data || typeof data !== 'object') return null;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    realizedUsd: num(data.totalRealizedPnLUsd),
    unrealizedUsd: num(data.totalUnrealizedPnLUsd),
    openCount: num(data.activePositionsCount) ?? 0,
    ...(data.liveOpen && typeof data.liveOpen === 'object' && (num(data.liveOpen.count) ?? 0) > 0
      ? { live: { openCount: num(data.liveOpen.count) as number, unrealizedUsd: num(data.liveOpen.unrealizedPnLUsd), realizedUsd: num(data.liveOpen.realizedTodayUsd) } }
      : {}),
  };
}

export function pillTone(p: PillState | null): 'up' | 'down' | 'flat' | 'unknown' {
  if (!p || (p.realizedUsd === null && p.unrealizedUsd === null)) return 'unknown';
  const total = (p.realizedUsd ?? 0) + (p.unrealizedUsd ?? 0);
  return total > 0 ? 'up' : total < 0 ? 'down' : 'flat';
}
