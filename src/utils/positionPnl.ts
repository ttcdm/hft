import { fmtSignedSol, signTone } from './numFormat';

/**
 * What the positions table shows in its PnL column. A CLOSED row has no cost basis left, so it shows the realized PnL in
 * SOL instead of a meaningless +0.0%. A PARTIALLY_CLOSED row shows the open part's % and what the sold part realized.
 */
export interface PnlRow {
  status?: string;
  unrealizedPnLPct?: number;
  realizedPnLSol?: number;
}

/**
 * UI report fix 6: `tone` colours the cell. A partial with a gain on the open part and a loss on the sold part is 'mixed' (it used to be
 * red, so "+40.0% open" showed in red), and a value that rounds to zero is 'flat', never red.
 */
export function positionPnlCell(pos: PnlRow): { text: string; positive: boolean; tone: 'up' | 'down' | 'mixed' | 'flat' } {
  const sol = (v: number) => `${fmtSignedSol(v, 6)} SOL`;
  const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  const pctTone = (v: number) => (Math.abs(v) < 0.05 ? 'flat' : v > 0 ? 'up' : 'down');
  const realized = pos.realizedPnLSol ?? 0;
  const unrealized = pos.unrealizedPnLPct ?? 0;
  if (pos.status === 'CLOSED') return { text: `${sol(realized)} realized`, positive: realized >= 0, tone: signTone(realized) };
  if (pos.status === 'PARTIALLY_CLOSED') {
    const a = pctTone(unrealized), b = signTone(realized);
    const tone = a === b || b === 'flat' ? a : a === 'flat' ? b : 'mixed';
    return { text: `${pct(unrealized)} open · ${sol(realized)} realized`, positive: unrealized >= 0 && realized >= 0, tone };
  }
  return { text: pct(unrealized), positive: unrealized >= 0, tone: pctTone(unrealized) };
}
