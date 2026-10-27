/**
 * R6-9: what a close really did, in words. A close can succeed without selling anything now: it may adopt an earlier sell that landed
 * unconfirmed (and leave tokens in a PARTIALLY_CLOSED row), or find the wallet empty and book an ASSUMED loss of the cost basis. Those
 * used to read "Closed 100%" / "Position closed with PnL: -X SOL". Used by the Plug & Play panel and the aggregator's close message.
 */
export interface CloseResultLike {
  success: boolean;
  /** realized PnL of this call, in SOL */
  pnlSol: number;
  status?: string;
  error?: string;
  outcome?: 'ADOPTED_EARLIER_SELL' | 'ADOPTED_EARLIER_SELL_FILL_UNREAD' | 'ASSUMED_LOSS_EMPTY_WALLET';
}

const sol = (v: number) => `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(6)} SOL`;

export function closeOutcomeText(r: CloseResultLike, sellPct: number, name = 'the position'): { text: string; tone: 'info' | 'warning' | 'error' } {
  if (!r.success) return { text: `Close failed: ${r.error ?? 'refused'}. ${name} is still open.`, tone: 'error' };
  const left = r.status === 'PARTIALLY_CLOSED' ? ` Tokens are still held (PARTIALLY_CLOSED): close again to sell the rest.` : '';
  if (r.outcome === 'ASSUMED_LOSS_EMPTY_WALLET') {
    return { text: `Nothing was sold: the wallet held none of ${name}. The row was closed and booked as an ASSUMED loss of its cost basis (${sol(r.pnlSol)}); no sell was found. Check the wallet.`, tone: 'warning' };
  }
  if (r.outcome === 'ADOPTED_EARLIER_SELL') {
    return { text: `No new sell was sent: an earlier sell of ${name} that landed unconfirmed was adopted, realized ${sol(r.pnlSol)}.${left || ' The position is now closed.'}`, tone: 'warning' };
  }
  if (r.outcome === 'ADOPTED_EARLIER_SELL_FILL_UNREAD') {
    return { text: `No new sell was sent: an earlier sell of ${name} landed but its fill could not be read, so its PnL was not recorded.${left || ' The position is now closed.'}`, tone: 'warning' };
  }
  if (r.status === 'PARTIALLY_CLOSED') return { text: `Sold ${sellPct}% of ${name}, realized ${sol(r.pnlSol)}.${left}`, tone: 'info' };
  return { text: `Closed ${sellPct}% of ${name}, realized ${sol(r.pnlSol)}.`, tone: 'info' };
}
