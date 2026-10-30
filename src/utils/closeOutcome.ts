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
  /** The server's ClosePositionResult.outcome: set when nothing was sold now. An adopted sell with status PARTIALLY_CLOSED was a partial. */
  outcome?: 'ADOPTED_EARLIER_SELL' | 'ADOPTED_EARLIER_SELL_FILL_UNREAD' | 'ASSUMED_LOSS_EMPTY_WALLET';
  /** Raw token units still held after an adopted partial sell. */
  remainingTokensRaw?: string;
  /** The server's ClosePositionResult.notSent: the close was refused before any sell was sent. */
  notSent?: boolean;
}

/**
 * R11-5: errors the coordinator returns before it sends anything (closePositionImpl's early returns and isNonAttemptExitError). The row
 * is still open after these. "Position not found" is not here: it means the row is no longer open.
 */
const REFUSED_BEFORE_SEND = /^(TRADING_HALTED|EXIT_IN_PROGRESS|DUST_POSITION_EXIT_UNECONOMICAL|SELL_PENDING_VERIFICATION|UNKNOWN_TRADING_VENUE|Trading venue for mint|Signer is not configured|Calculated sell quantity is zero|CLUSTER_GUARD|INVALID_SELL_PCT|BALANCE_UNTRUSTED|RPC_RATE_LIMITED|RPC_AUTH_REJECTED)/;

/** R11-5: what a failed close says about the position, true in each case (it used to say "is still open" after every failure). */
function failedCloseText(r: CloseResultLike, name: string): string {
  const err = r.error ?? 'refused';
  if (/^Position not found/.test(err)) {
    return `Close not done: ${name} is no longer open (it was closed or sold elsewhere, or never existed). Nothing was sold by this request.`;
  }
  if (r.notSent || REFUSED_BEFORE_SEND.test(err)) return `Close failed: ${err}. Nothing was sent; ${name} is still open.`;
  return `Close failed: ${err}. A sell may have been sent: ${name} may still be open, or partly sold. Check the positions list before closing again.`;
}

const sol = (v: number) => `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(6)} SOL`;

export function closeOutcomeText(r: CloseResultLike, sellPct: number, name = 'the position'): { text: string; tone: 'info' | 'warning' | 'error' } {
  if (!r.success) return { text: failedCloseText(r, name), tone: /^Position not found/.test(r.error ?? '') ? 'warning' : 'error' };
  const rawLeft = typeof r.remainingTokensRaw === 'string' && /^\d+$/.test(r.remainingTokensRaw) ? r.remainingTokensRaw : null;
  const left = r.status === 'PARTIALLY_CLOSED'
    ? ` Tokens are still held (PARTIALLY_CLOSED${rawLeft ? `, ${rawLeft} raw token units left` : ''}): close again to sell the rest.`
    : '';
  if (r.outcome === 'ADOPTED_EARLIER_SELL' && r.status === 'PARTIALLY_CLOSED') {
    return { text: `No new sell was sent: an earlier PARTIAL sell of ${name} that landed unconfirmed was adopted, realized ${sol(r.pnlSol)}.${left}`, tone: 'warning' };
  }
  if (r.outcome === 'ASSUMED_LOSS_EMPTY_WALLET') {
    return { text: `Nothing was sold: the wallet held none of ${name}. The row was closed and booked as an ASSUMED loss of its cost basis (${sol(r.pnlSol)}); no sell was found. Check the wallet.`, tone: 'warning' };
  }
  if (r.outcome === 'ADOPTED_EARLIER_SELL') {
    return { text: `No new sell was sent: an earlier sell of ${name} that landed unconfirmed was adopted, realized ${sol(r.pnlSol)}.${left || ' The position is now closed.'}`, tone: 'warning' };
  }
  if (r.outcome === 'ADOPTED_EARLIER_SELL_FILL_UNREAD') {
    return { text: `No new sell was sent: an earlier sell of ${name} landed but its fill could not be read: the sold share of its cost basis is booked as an ASSUMED loss (${sol(r.pnlSol)}) until reconciliation reads the fill.${left || ' The position is now closed.'}`, tone: 'warning' };
  }
  if (r.status === 'PARTIALLY_CLOSED') return { text: `Sold ${sellPct}% of ${name}, realized ${sol(r.pnlSol)}.${left}`, tone: 'info' };
  return { text: `Closed ${sellPct}% of ${name}, realized ${sol(r.pnlSol)}.`, tone: 'info' };
}
