import { fmtSmall } from './numFormat';

/**
 * R9-5: Close (Plug & Play), Take 50% and Dump 100% (Sniper holdings) sold on one click, with no quantity, price or confirm, while the
 * buy buttons and PANIC ask first. Each now asks with what it is about to sell. The price is the last mark, not the fill: a sale is at
 * the market.
 */
export interface SellConfirmInput {
  name: string;
  sellPct: number;
  mode?: string;
  /** human token units held now */
  tokensHeld?: number | null;
  /** value of the whole holding at the last mark */
  valueText?: string | null;
}

export function sellConfirmText(p: SellConfirmInput): string {
  const mode = p.mode === 'LIVE' ? 'LIVE (real SOL, sends a transaction)' : p.mode ? `${p.mode} (nothing is sent)` : 'mode unknown';
  const held = typeof p.tokensHeld === 'number' && Number.isFinite(p.tokensHeld) && p.tokensHeld > 0 ? p.tokensHeld : null;
  const qty = held !== null ? `about ${fmtSmall((held * p.sellPct) / 100, 0)} of ${fmtSmall(held, 0)} tokens held` : 'quantity unknown';
  const value = p.valueText ? ` The holding is worth ${p.valueText} at the last mark; the sale fills at the market, not at that price.` : ' The sale fills at the market.';
  const after = p.sellPct >= 100 ? '' : ' The rest stays open.';
  return `SELL ${p.sellPct}% of ${p.name}? ${mode}: ${qty}.${value}${after}`;
}

/** The alert title after a sell: a partial is never "POSITION CLOSED". */
export function sellDoneTitle(sellPct: number): string {
  return sellPct >= 100 ? 'CLOSE DONE' : `SOLD ${sellPct}% (position still open)`;
}
