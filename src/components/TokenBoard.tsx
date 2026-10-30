import React, { useEffect, useState } from 'react';
import { authFetch } from '../services/engineClient';
import { onAuthenticated } from '../utils/authEvents';
import { ageText } from '../utils/freshness';
import { fmtSignedSol, signTone } from '../utils/numFormat';
import { dollarSymbol, displayName } from '../utils/displayName';

/** H1: the home page. Launches / Watching / Holding, all from GET /api/board. Unknown values render "—", never a number. */
export interface BoardData {
  generatedAt: number;
  watchCapacity?: { active: number; max: number; refusedFull: number; lastRefusedMint: string | null };
  executionMode: string;
  wallet: {
    balanceSol: number | null; reserveSol: number; rentLockedSol: number | null; spendableSol: number | null; solUsd: number | null;
    /** R6-7 / R6-8: ages of the SOL/USD reading and the cached wallet balance. Absent on an older server. */
    solUsdAgeMs?: number | null; solUsdStale?: boolean; balanceAgeMs?: number | null; balanceLastReadFailed?: boolean;
  };
  launches: Array<{
    mint: string; symbol: string; name: string; priceSol: number | null; priceUsd: number | null; curveProgressPct: number | null;
    top10HoldersPct: number | null; creatorHoldingPct: number | null; mintRevoked: boolean | null; freezeRevoked: boolean | null; createdAgo: string | null;
  }>;
  watching: Array<{
    mint: string; state: 'WATCHING' | 'HOT' | 'READY' | 'DEAD'; reason: string | null;
    metrics: {
      elapsedMs: number; cumulativeNetInflowSol: number; uniqueBuyers: number; rawUniqueBuyers: number; funderCoverage: number;
      buySellRatio: number | null; largestBuyerShare: number | null; creatorSold: boolean; passingSignals: number; tradeCount: number;
      netInflowPer10s: number[];
    };
  }>;
  holding: Array<{
    id: string; mint: string; symbol: string; mode: string; entryPriceSol: number | null; markPriceSol: number | null; markAgeMs: number | null; markStale?: boolean;
    costSol: number | null; pnlSol: number | null; nextExit: { kind: string; priceSol: number } | null;
  }>;
}

const DASH = '—';
export const fmt = (n: number | null | undefined, digits = 4, suffix = ''): string =>
  n === null || n === undefined || !Number.isFinite(n) ? DASH : `${n.toFixed(digits)}${suffix}`;
const fmtPrice = (n: number | null | undefined) => (n === null || n === undefined || !(n > 0) ? DASH : n < 0.001 ? n.toExponential(3) : n.toFixed(6));
const short = (m: string) => `${m.slice(0, 4)}…${m.slice(-4)}`;
const cell = 'px-3 py-2 text-right font-mono tabular-nums';
const headLeft = 'px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-semibold';
const head = 'px-3 py-2 text-right text-[10px] uppercase tracking-wider text-slate-500 font-semibold';
// R11-11: at 390 px the section's overflow-hidden cut the AGE and NEXT EXIT columns off; each table now scrolls sideways in its own box
const tableBox = 'overflow-x-auto';
const tableCls = 'w-full text-xs whitespace-nowrap';

/** R11-11: rows were mouse-only (<tr onClick>). The token cell is a real button: Tab reaches it, Enter and Space press it. */
function RowSelect({ mint, label, onSelect, selected, children }: { mint: string; label: string; onSelect?: (mint: string) => void; selected?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" data-testid="board-row-select" aria-label={`Show the curve for ${label}`} aria-pressed={!!selected}
      onClick={(e) => { e.stopPropagation(); onSelect?.(mint); }}
      className="text-left rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
      {children}
    </button>
  );
}

export function WalletStrip({ wallet, mode }: { wallet: BoardData['wallet']; mode: string }) {
  const item = (label: string, value: string, testId: string, age?: { text: string; warn: boolean }) => (
    <div className="flex flex-col" data-testid={testId}>
      <span className="text-[10px] uppercase tracking-wider text-slate-500">{label}</span>
      <span className="font-mono text-sm text-slate-100">{value}</span>
      {age && <span data-testid={`${testId}-age`} className={`font-mono text-[10px] ${age.warn ? 'text-amber-300' : 'text-slate-500'}`}>{age.text}</span>}
    </div>
  );
  // R6-8: the balance is a cached read (boot, after a trade, an RPC switch, the DEVNET_LIVE wallet audit), not a live figure
  const balanceAge = wallet.balanceAgeMs === undefined && wallet.balanceLastReadFailed === undefined ? undefined
    : wallet.balanceLastReadFailed ? { text: 'last read FAILED', warn: true }
    : { text: wallet.balanceAgeMs === null || wallet.balanceAgeMs === undefined ? 'never read' : `read ${ageText(wallet.balanceAgeMs)}`, warn: wallet.balanceAgeMs === null || (wallet.balanceAgeMs ?? 0) > 60_000 };
  const usdAge = wallet.solUsdAgeMs === undefined ? undefined : { text: `${ageText(wallet.solUsdAgeMs)}${wallet.solUsdStale ? ' (STALE)' : ''}`, warn: !!wallet.solUsdStale };
  return (
    <div className="col-span-12 flex flex-wrap items-center gap-x-8 gap-y-2 px-4 py-3 rounded-lg border border-slate-800 bg-[#0B0F17]" data-testid="wallet-strip">
      <span className="text-xs font-bold text-slate-300">SOL WALLET</span>
      {item('Balance', `${fmt(wallet.balanceSol, 4)} SOL`, 'w-balance', balanceAge)}
      {item('Reserve', `${fmt(wallet.reserveSol, 3)} SOL`, 'w-reserve')}
      {item('Rent locked', wallet.rentLockedSol === null ? DASH : `${fmt(wallet.rentLockedSol, 4)} SOL`, 'w-rent')}
      {item('Spendable', `${fmt(wallet.spendableSol, 4)} SOL`, 'w-spendable')}
      {item('SOL/USD', wallet.solUsd === null ? DASH : `$${wallet.solUsd.toFixed(2)}`, 'w-usd', usdAge)}
      <span className={`ml-auto px-2 py-0.5 rounded text-[11px] font-bold ${mode === 'LIVE' ? 'bg-red-900/60 text-red-200' : 'bg-slate-800 text-slate-300'}`}>{mode}</span>
    </div>
  );
}

const STATE_STYLE: Record<string, string> = {
  HOT: 'bg-orange-900/50 text-orange-300', READY: 'bg-emerald-900/50 text-emerald-300', DEAD: 'bg-slate-800 text-slate-500', WATCHING: 'bg-cyan-900/40 text-cyan-300',
};

export const BOARD_STALE_MS = 10_000;

export function TokenBoardView({ board, tab, onTab, onSelect, selected, ageMs }: {
  ageMs?: number | null;
  board: BoardData | null; tab: 'launches' | 'watching' | 'holding'; onTab: (t: 'launches' | 'watching' | 'holding') => void;
  onSelect?: (mint: string) => void; selected?: string | null;
}) {
  // R9-6: before the board is read (or while it cannot be), the counts are unknown, not 0
  const tabs: Array<['launches' | 'watching' | 'holding', string, number | string]> = [
    ['launches', 'New launches', board?.launches.length ?? '—'],
    ['watching', 'Watching', board?.watching.length ?? '—'],
    ['holding', 'Holding', board?.holding.length ?? '—'],
  ];
  return (
    <section className="col-span-12 lg:col-span-8 rounded-lg border border-slate-800 bg-[#0B0F17] overflow-hidden" data-testid="token-board">
      <div className="flex border-b border-slate-800 items-center" role="tablist" aria-label="Token board">
        {tabs.map(([key, label, n]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => onTab(key)} data-testid={`tab-${key}`}
            className={`px-4 py-2.5 text-sm font-semibold ${tab === key ? 'text-cyan-300 border-b-2 border-cyan-400' : 'text-slate-400 hover:text-slate-200'}`}>
            {label} <span className="text-xs text-slate-500">({n})</span>
          </button>
        ))}
        {ageMs !== undefined && (
          <span data-testid="board-age" className={`ml-auto px-3 text-[11px] font-mono ${ageMs === null || ageMs > BOARD_STALE_MS ? 'text-amber-300' : 'text-slate-500'}`}>
            {ageMs === null ? 'no board received yet' : `updated ${Math.round(ageMs / 1000)}s ago${ageMs > BOARD_STALE_MS ? ' (STALE)' : ''}`}
            {board?.watchCapacity && board.watchCapacity.refusedFull > 0 ? ` • watch full: ${board.watchCapacity.refusedFull} launches skipped` : ''}
          </span>
        )}
      </div>
      {!board && <div className="p-6 text-sm text-slate-500">Loading… (sign in as operator to read the board)</div>}
      {board && tab === 'launches' && (
        <div className={tableBox}><table className={tableCls}>
          <thead><tr><th className={headLeft}>Token</th><th className={head}>Price (SOL)</th><th className={head}>Curve</th><th className={head} title="Share of the tokens OFF the bonding curve held by the 10 largest holders. The holder gate uses share of total supply, a different figure.">Top10 % (off-curve)</th><th className={head}>Creator %</th><th className={head} title="Time since the launch entered the watch window; — when it is not being watched">Age</th></tr></thead>
          <tbody>
            {board.launches.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-slate-500">No launches seen yet. The board fills from the Pump.fun create-event stream.</td></tr>}
            {board.launches.map((l) => (
              <tr key={l.mint} onClick={() => onSelect?.(l.mint)} className={`border-t border-slate-800/60 cursor-pointer hover:bg-slate-900 ${selected === l.mint ? 'bg-slate-900' : ''}`}>
                <td className="px-3 py-2 text-left"><RowSelect mint={l.mint} label={`${dollarSymbol(l.symbol)} ${short(l.mint)}`} onSelect={onSelect} selected={selected === l.mint}><span className="font-bold text-slate-100" title={displayName(l.name)}>{dollarSymbol(l.symbol)}</span> <span className="text-slate-500 font-mono">{short(l.mint)}</span></RowSelect></td>
                <td className={cell}>{fmtPrice(l.priceSol)}</td>
                <td className={cell}>{fmt(l.curveProgressPct, 1, '%')}</td>
                <td className={cell}>{fmt(l.top10HoldersPct, 1, '%')}</td>
                <td className={cell}>{fmt(l.creatorHoldingPct, 1, '%')}</td>
                <td className={cell}>{l.createdAgo ?? DASH}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {board && tab === 'watching' && (
        <div className={tableBox}><table className={tableCls}>
          <thead><tr><th className={headLeft}>Token</th><th className={head}>State</th><th className={head}>Net inflow</th><th className={head}>Buyers</th><th className={head}>Buy:sell</th><th className={head}>Top buyer</th><th className={head}>Creator sold</th></tr></thead>
          <tbody>
            {board.watching.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-slate-500">Nothing in the watch window.</td></tr>}
            {board.watching.map((w) => (
              <tr key={w.mint} onClick={() => onSelect?.(w.mint)} className="border-t border-slate-800/60 cursor-pointer hover:bg-slate-900" title={w.reason ?? ''}>
                <td className="px-3 py-2 text-left font-mono text-slate-300"><RowSelect mint={w.mint} label={w.mint} onSelect={onSelect} selected={selected === w.mint}>{short(w.mint)}</RowSelect></td>
                <td className={cell}><span className={`px-1.5 py-0.5 rounded font-bold ${STATE_STYLE[w.state]}`}>{w.state}</span></td>
                <td className={cell}>{w.metrics.tradeCount === 0 ? DASH : `${fmt(w.metrics.cumulativeNetInflowSol, 3)} SOL`}</td>
                <td className={cell}>{w.metrics.rawUniqueBuyers === 0 ? DASH : `${w.metrics.uniqueBuyers}${w.metrics.funderCoverage < 1 ? '?' : ''}`}</td>
                <td className={cell}>{fmt(w.metrics.buySellRatio, 2)}</td>
                <td className={cell}>{w.metrics.largestBuyerShare === null ? DASH : `${(w.metrics.largestBuyerShare * 100).toFixed(1)}%`}</td>
                <td className={cell}>{w.metrics.tradeCount === 0 ? DASH : w.metrics.creatorSold ? 'YES' : 'no'}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {board && tab === 'holding' && (
        <div className={tableBox}><table className={tableCls}>
          <thead><tr><th className={headLeft}>Position</th><th className={head}>Entry</th><th className={head}>Mark (age)</th><th className={head} title="At the curve spot price; exit fee, price impact and tip are not taken off">PnL at mark (SOL, before exit costs)</th><th className={head}>Next exit</th></tr></thead>
          <tbody>
            {board.holding.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-slate-500">No open positions.</td></tr>}
            {board.holding.map((h) => (
              <tr key={h.id} onClick={() => onSelect?.(h.mint)} className="border-t border-slate-800/60 cursor-pointer hover:bg-slate-900">
                <td className="px-3 py-2 text-left"><RowSelect mint={h.mint} label={`${dollarSymbol(h.symbol)} (${h.mode})`} onSelect={onSelect} selected={selected === h.mint}><span className="font-bold text-slate-100">{dollarSymbol(h.symbol)}</span> <span className="text-slate-500">{h.mode}</span></RowSelect></td>
                <td className={cell}>{fmtPrice(h.entryPriceSol)}</td>
                <td className={cell}>
                  {fmtPrice(h.markPriceSol)}
                  <span data-testid="mark-age" className={`block text-[10px] ${h.markStale ? 'text-amber-300' : 'text-slate-500'}`}>{ageText(h.markAgeMs)}{h.markStale ? ' (STALE)' : ''}</span>
                </td>
                {/* R10-5: at a stale mark the PnL and the next exit are not current: the PnL is old, and exits wait for a fresh mark */}
                <td data-testid="holding-pnl" className={`${cell} ${h.markStale ? 'text-amber-300' : { up: 'text-emerald-400', down: 'text-red-400', flat: '' }[signTone(h.pnlSol)]}`}>{fmtSignedSol(h.pnlSol, 5)}{h.markStale && <span className="block text-[10px]">at a STALE mark</span>}</td>
                <td data-testid="holding-next-exit" className={cell}>{h.nextExit ? `${h.nextExit.kind.replace(/_/g, ' ')} @ ${fmtPrice(h.nextExit.priceSol)}` : DASH}{h.markStale && <span className="block text-[10px] text-amber-300">waits for a fresh mark</span>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

export function TokenBoard({ onSelect, selected }: { onSelect?: (mint: string) => void; selected?: string | null }) {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [tab, setTab] = useState<'launches' | 'watching' | 'holding'>('launches');
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await authFetch('/api/board');
        if (r.ok && alive) { setBoard(await r.json()); setLastOkAt(Date.now()); }
      } catch { /* offline: keep the last board; its age keeps growing and shows */ }
    };
    load();
    const t = setInterval(load, 3000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const off = onAuthenticated(load); // UI-5
    return () => { alive = false; clearInterval(t); clearInterval(tick); off(); };
  }, []);
  return (
    <>
      {board && <WalletStrip wallet={board.wallet} mode={board.executionMode} />}
      <TokenBoardView board={board} tab={tab} onTab={setTab} onSelect={onSelect} selected={selected} ageMs={lastOkAt === null ? null : Math.max(0, now - lastOkAt)} />
    </>
  );
}
