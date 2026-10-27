import { fmtSignedSol, fmtSmall } from './numFormat';

/**
 * R10-4: the bot's own exits (take-profit, stop-loss, trailing stop, stale exit) announced nothing; the only change on screen was a
 * Holding count. The app keeps the open positions it last saw; when one is gone or holds fewer tokens, it raises an alert with what was
 * sold, why, and the realized PnL, read from the position row.
 */
export interface WatchedPosition {
  id: string; symbol?: string; mint?: string; status?: string; executionMode?: string;
  tokenQuantityRaw?: string; tokenDecimals?: number; realizedPnLSol?: number; exitReason?: string;
}
export interface ExitAlert { level: 'INFO' | 'WARNING'; title: string; message: string }

const qty = (p: WatchedPosition) => (/^\d+$/.test(String(p.tokenQuantityRaw ?? '')) ? BigInt(p.tokenQuantityRaw as string) : null);
const human = (raw: bigint, dec = 6) => Number(raw) / Math.pow(10, dec);

/**
 * `before`: the open rows of the last read. `openNow`: the open rows now. `rowsNow`: every row now (closed ones included), to read how a
 * position that left the open list ended. Returns one alert per position that was sold since the last read.
 */
export function exitAlerts(before: WatchedPosition[], openNow: WatchedPosition[], rowsNow: WatchedPosition[]): ExitAlert[] {
  const nowById = new Map(rowsNow.map((p) => [p.id, p]));
  const openIds = new Map(openNow.map((p) => [p.id, p]));
  const out: ExitAlert[] = [];
  for (const prev of before) {
    const cur = openIds.get(prev.id) ?? nowById.get(prev.id);
    const name = `${prev.executionMode ? `${prev.executionMode} ` : ''}$${prev.symbol || (prev.mint ?? prev.id).slice(0, 6)}`;
    const q0 = qty(prev);
    if (!cur) {
      out.push({ level: 'WARNING', title: `POSITION GONE: ${name}`, message: `${name} left the open list and its row could not be read. Check Plug & Play.` });
      continue;
    }
    const q1 = openIds.has(prev.id) ? qty(cur) : 0n;
    if (q0 === null || q1 === null || q1 >= q0) continue;
    const soldRaw = q0 - q1;
    const pnl = typeof cur.realizedPnLSol === 'number' && typeof prev.realizedPnLSol === 'number' ? cur.realizedPnLSol - prev.realizedPnLSol : null;
    const closed = !openIds.has(prev.id);
    const why = cur.exitReason ? ` (${cur.exitReason})` : '';
    const pct = q0 > 0n ? Math.round(Number((soldRaw * 10000n) / q0) / 100) : 100;
    out.push({
      level: pnl !== null && pnl < 0 ? 'WARNING' : 'INFO',
      title: closed ? `SOLD ALL: ${name}${why}` : `SOLD ${pct}%: ${name}${why}`,
      message: `Sold ${fmtSmall(human(soldRaw, cur.tokenDecimals ?? prev.tokenDecimals), 0)} tokens${closed ? '; the position is closed' : `; ${fmtSmall(human(q1, cur.tokenDecimals), 0)} left`}. Realized ${pnl === null ? 'PnL not read' : `${fmtSignedSol(pnl, 6)} SOL`}.`,
    });
  }
  return out;
}

/** R10-4: a journal row for a sell shows what it sold, at what price and for what PnL (the payload has them), not only the reason. */
export function journalEventDetail(ev: { eventType?: string; payload?: any }): string | null {
  const p = ev.payload ?? {};
  if (!/SELL/.test(String(ev.eventType ?? ''))) return null;
  const parts: string[] = [];
  if (typeof p.sellPct === 'number') parts.push(`${p.sellPct}%`);
  if (typeof p.tokensSold === 'number') parts.push(`${fmtSmall(p.tokensSold, 0)} tokens`);
  if (typeof p.exitPriceSol === 'number') parts.push(`at ${fmtSmall(p.exitPriceSol, 4)} SOL`);
  if (typeof p.netRealizedPnLSol === 'number') parts.push(`PnL ${fmtSignedSol(p.netRealizedPnLSol, 6)} SOL`);
  if (typeof p.status === 'string') parts.push(p.status);
  return parts.length ? parts.join(' · ') : null;
}
