import React, { useEffect, useState } from 'react';
import { authFetch } from '../services/engineClient';

/** H1: the home page. Launches / Watching / Holding, all from GET /api/board. Unknown values render "—", never a number. */
export interface BoardData {
  generatedAt: number;
  executionMode: string;
  wallet: { balanceSol: number | null; reserveSol: number; rentLockedSol: number | null; spendableSol: number | null; solUsd: number | null };
  launches: Array<{
    mint: string; symbol: string; name: string; priceSol: number | null; priceUsd: number | null; curveProgressPct: number | null;
    top10HoldersPct: number | null; creatorHoldingPct: number | null; mintRevoked: boolean; freezeRevoked: boolean; createdAgo: string | null;
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
    id: string; mint: string; symbol: string; mode: string; entryPriceSol: number | null; markPriceSol: number | null; markAgeMs: number | null;
    costSol: number | null; pnlSol: number | null; nextExit: { kind: string; priceSol: number } | null;
  }>;
}

const DASH = '—';
export const fmt = (n: number | null | undefined, digits = 4, suffix = ''): string =>
  n === null || n === undefined || !Number.isFinite(n) ? DASH : `${n.toFixed(digits)}${suffix}`;
const fmtPrice = (n: number | null | undefined) => (n === null || n === undefined || !(n > 0) ? DASH : n < 0.001 ? n.toExponential(3) : n.toFixed(6));
const short = (m: string) => `${m.slice(0, 4)}…${m.slice(-4)}`;
const cell = 'px-3 py-2 text-right font-mono tabular-nums';
const head = 'px-3 py-2 text-right text-[10px] uppercase tracking-wider text-slate-500 font-semibold';

export function WalletStrip({ wallet, mode }: { wallet: BoardData['wallet']; mode: string }) {
  const item = (label: string, value: string, testId: string) => (
    <div className="flex flex-col" data-testid={testId}>
      <span className="text-[10px] uppercase tracking-wider text-slate-500">{label}</span>
      <span className="font-mono text-sm text-slate-100">{value}</span>
    </div>
  );
  return (
    <div className="col-span-12 flex flex-wrap items-center gap-x-8 gap-y-2 px-4 py-3 rounded-lg border border-slate-800 bg-[#0B0F17]" data-testid="wallet-strip">
      <span className="text-xs font-bold text-slate-300">SOL WALLET</span>
      {item('Balance', `${fmt(wallet.balanceSol, 4)} SOL`, 'w-balance')}
      {item('Reserve', `${fmt(wallet.reserveSol, 3)} SOL`, 'w-reserve')}
      {item('Rent locked', wallet.rentLockedSol === null ? DASH : `${fmt(wallet.rentLockedSol, 4)} SOL`, 'w-rent')}
      {item('Spendable', `${fmt(wallet.spendableSol, 4)} SOL`, 'w-spendable')}
      {item('SOL/USD', wallet.solUsd === null ? DASH : `$${wallet.solUsd.toFixed(2)}`, 'w-usd')}
      <span className={`ml-auto px-2 py-0.5 rounded text-[11px] font-bold ${mode === 'LIVE' ? 'bg-red-900/60 text-red-200' : 'bg-slate-800 text-slate-300'}`}>{mode}</span>
    </div>
  );
}

const STATE_STYLE: Record<string, string> = {
  HOT: 'bg-orange-900/50 text-orange-300', READY: 'bg-emerald-900/50 text-emerald-300', DEAD: 'bg-slate-800 text-slate-500', WATCHING: 'bg-cyan-900/40 text-cyan-300',
};

export function TokenBoardView({ board, tab, onTab, onSelect, selected }: {
  board: BoardData | null; tab: 'launches' | 'watching' | 'holding'; onTab: (t: 'launches' | 'watching' | 'holding') => void;
  onSelect?: (mint: string) => void; selected?: string | null;
}) {
  const tabs: Array<['launches' | 'watching' | 'holding', string, number]> = [
    ['launches', 'New launches', board?.launches.length ?? 0],
    ['watching', 'Watching', board?.watching.length ?? 0],
    ['holding', 'Holding', board?.holding.length ?? 0],
  ];
  return (
    <section className="col-span-12 lg:col-span-8 rounded-lg border border-slate-800 bg-[#0B0F17] overflow-hidden" data-testid="token-board">
      <div className="flex border-b border-slate-800">
        {tabs.map(([key, label, n]) => (
          <button key={key} onClick={() => onTab(key)} data-testid={`tab-${key}`}
            className={`px-4 py-2.5 text-sm font-semibold ${tab === key ? 'text-cyan-300 border-b-2 border-cyan-400' : 'text-slate-400 hover:text-slate-200'}`}>
            {label} <span className="text-xs text-slate-500">({n})</span>
          </button>
        ))}
      </div>
      {!board && <div className="p-6 text-sm text-slate-500">Loading… (sign in as operator to read the board)</div>}
      {board && tab === 'launches' && (
        <table className="w-full text-xs">
          <thead><tr><th className={`${head} text-left`}>Token</th><th className={head}>Price (SOL)</th><th className={head}>Curve</th><th className={head}>Top10 %</th><th className={head}>Creator %</th><th className={head}>Age</th></tr></thead>
          <tbody>
            {board.launches.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-slate-500">No launches seen yet. The board fills from the Pump.fun create-event stream.</td></tr>}
            {board.launches.map((l) => (
              <tr key={l.mint} onClick={() => onSelect?.(l.mint)} className={`border-t border-slate-800/60 cursor-pointer hover:bg-slate-900 ${selected === l.mint ? 'bg-slate-900' : ''}`}>
                <td className="px-3 py-2 text-left"><span className="font-bold text-slate-100">${l.symbol}</span> <span className="text-slate-500 font-mono">{short(l.mint)}</span></td>
                <td className={cell}>{fmtPrice(l.priceSol)}</td>
                <td className={cell}>{fmt(l.curveProgressPct, 1, '%')}</td>
                <td className={cell}>{fmt(l.top10HoldersPct, 1, '%')}</td>
                <td className={cell}>{fmt(l.creatorHoldingPct, 1, '%')}</td>
                <td className={cell}>{l.createdAgo ?? DASH}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {board && tab === 'watching' && (
        <table className="w-full text-xs">
          <thead><tr><th className={`${head} text-left`}>Token</th><th className={head}>State</th><th className={head}>Net inflow</th><th className={head}>Buyers</th><th className={head}>Buy:sell</th><th className={head}>Top buyer</th><th className={head}>Creator sold</th></tr></thead>
          <tbody>
            {board.watching.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-slate-500">Nothing in the watch window.</td></tr>}
            {board.watching.map((w) => (
              <tr key={w.mint} onClick={() => onSelect?.(w.mint)} className="border-t border-slate-800/60 cursor-pointer hover:bg-slate-900" title={w.reason ?? ''}>
                <td className="px-3 py-2 text-left font-mono text-slate-300">{short(w.mint)}</td>
                <td className={cell}><span className={`px-1.5 py-0.5 rounded font-bold ${STATE_STYLE[w.state]}`}>{w.state}</span></td>
                <td className={cell}>{w.metrics.tradeCount === 0 ? DASH : `${fmt(w.metrics.cumulativeNetInflowSol, 3)} SOL`}</td>
                <td className={cell}>{w.metrics.rawUniqueBuyers === 0 ? DASH : `${w.metrics.uniqueBuyers}${w.metrics.funderCoverage < 1 ? '?' : ''}`}</td>
                <td className={cell}>{fmt(w.metrics.buySellRatio, 2)}</td>
                <td className={cell}>{w.metrics.largestBuyerShare === null ? DASH : `${(w.metrics.largestBuyerShare * 100).toFixed(1)}%`}</td>
                <td className={cell}>{w.metrics.tradeCount === 0 ? DASH : w.metrics.creatorSold ? 'YES' : 'no'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {board && tab === 'holding' && (
        <table className="w-full text-xs">
          <thead><tr><th className={`${head} text-left`}>Position</th><th className={head}>Entry</th><th className={head}>Mark</th><th className={head}>PnL (SOL)</th><th className={head}>Next exit</th></tr></thead>
          <tbody>
            {board.holding.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-slate-500">No open positions.</td></tr>}
            {board.holding.map((h) => (
              <tr key={h.id} onClick={() => onSelect?.(h.mint)} className="border-t border-slate-800/60 cursor-pointer hover:bg-slate-900">
                <td className="px-3 py-2 text-left"><span className="font-bold text-slate-100">${h.symbol}</span> <span className="text-slate-500">{h.mode}</span></td>
                <td className={cell}>{fmtPrice(h.entryPriceSol)}</td>
                <td className={cell}>{fmtPrice(h.markPriceSol)}</td>
                <td className={`${cell} ${h.pnlSol === null ? '' : h.pnlSol >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(h.pnlSol, 5)}</td>
                <td className={cell}>{h.nextExit ? `${h.nextExit.kind.replace(/_/g, ' ')} @ ${fmtPrice(h.nextExit.priceSol)}` : DASH}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function TokenBoard({ onSelect, selected }: { onSelect?: (mint: string) => void; selected?: string | null }) {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [tab, setTab] = useState<'launches' | 'watching' | 'holding'>('launches');
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await authFetch('/api/board');
        if (r.ok && alive) setBoard(await r.json());
      } catch { /* offline: keep the last board */ }
    };
    load();
    const t = setInterval(load, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return (
    <>
      {board && <WalletStrip wallet={board.wallet} mode={board.executionMode} />}
      <TokenBoardView board={board} tab={tab} onTab={setTab} onSelect={onSelect} selected={selected} />
    </>
  );
}
