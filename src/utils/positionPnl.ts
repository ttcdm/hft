/**
 * What the positions table shows in its PnL column. A CLOSED row has no cost basis left, so it shows the realized PnL in
 * SOL instead of a meaningless +0.0%. A PARTIALLY_CLOSED row shows the open part's % and what the sold part realized.
 */
export interface PnlRow {
  status?: string;
  unrealizedPnLPct?: number;
  realizedPnLSol?: number;
}

export function positionPnlCell(pos: PnlRow): { text: string; positive: boolean } {
  const sol = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(6)} SOL`;
  const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  const realized = pos.realizedPnLSol ?? 0;
  const unrealized = pos.unrealizedPnLPct ?? 0;
  if (pos.status === 'CLOSED') return { text: `${sol(realized)} realized`, positive: realized >= 0 };
  if (pos.status === 'PARTIALLY_CLOSED') {
    return { text: `${pct(unrealized)} open · ${sol(realized)} realized`, positive: unrealized >= 0 && realized >= 0 };
  }
  return { text: pct(unrealized), positive: unrealized >= 0 };
}
