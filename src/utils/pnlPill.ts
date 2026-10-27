/** Q35: the header pill. Signed dollar amounts from what /api/wallet/state really returns; null (no SOL price yet) is a dash. */
export interface PillState {
  realizedUsd: number | null;
  unrealizedUsd: number | null;
  openCount: number;
  /** R6-2: real LIVE positions still open while the server is not in LIVE (after a disarm); absent when there are none. */
  live?: { openCount: number; unrealizedUsd: number | null; realizedUsd: number | null } | null;
}

/** R10-6: a sign only when the shown cents are not zero; "$0.00" for zero (it used to read "+$0.00"). */
export const signedUsd = (v: number | null | undefined): string => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const t = Math.abs(v).toFixed(2);
  return t === '0.00' ? '$0.00' : `${v < 0 ? '-' : '+'}$${t}`;
};

/** R10-6: each figure in the pill gets its own colour; the realized loss no longer paints the open figure red. */
export function usdTone(v: number | null | undefined): 'up' | 'down' | 'flat' | 'unknown' {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'unknown';
  const t = Math.abs(v).toFixed(2);
  return t === '0.00' ? 'flat' : v > 0 ? 'up' : 'down';
}

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
