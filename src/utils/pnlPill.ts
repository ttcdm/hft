/** Q35: the header pill. Signed dollar amounts from what /api/wallet/state really returns; null (no SOL price yet) is a dash. */
export interface PillState {
  realizedUsd: number | null;
  unrealizedUsd: number | null;
  openCount: number;
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
  };
}

export function pillTone(p: PillState | null): 'up' | 'down' | 'flat' | 'unknown' {
  if (!p || (p.realizedUsd === null && p.unrealizedUsd === null)) return 'unknown';
  const total = (p.realizedUsd ?? 0) + (p.unrealizedUsd ?? 0);
  return total > 0 ? 'up' : total < 0 ? 'down' : 'flat';
}
