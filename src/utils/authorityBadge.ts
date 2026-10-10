/** Q10c: mint / freeze authority badges from the value the server reported. Unknown is shown as unknown, never as revoked. */
export function authorityBadge(kind: 'Mint' | 'Freeze', revoked: boolean | null | undefined): { text: string; tone: 'ok' | 'bad' | 'unknown' } {
  if (revoked === true) return { text: `${kind} Revoked`, tone: 'ok' };
  if (revoked === false) return { text: `${kind} NOT revoked`, tone: 'bad' };
  return { text: `${kind}: unknown`, tone: 'unknown' };
}

export const authorityTone: Record<'ok' | 'bad' | 'unknown', string> = {
  ok: 'text-emerald-400',
  bad: 'text-rose-400',
  unknown: 'text-slate-500',
};

/** A holder percentage the server gave, or a dash for unknown (the server sends -1 / null when it does not know). */
export function holderPct(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? `${Number(v.toFixed(1))}%` : '—';
}
