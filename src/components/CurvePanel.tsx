import React, { useEffect, useState } from 'react';
import { authFetch } from '../services/engineClient';
import { fmt } from './TokenBoard';

/** H2: bonding-curve depth ladder + trade tape for the selected mint. No order book exists on Pump.fun; empty states are honest. */
export interface CurveData {
  spotPriceSol: number; priceUsd: number | null; curveProgressPct: number; complete: boolean; note: string | null;
  buy: Array<{ upPct: number; solNeeded: number | null; tokensOut: number | null; feesSol: number | null }>;
  sell: Array<{ sellPct: number; solReceived: number | null; impactBps: number | null }> | null;
}
export interface TapeData { source: string; trades: Array<{ signature: string; at: number; side: 'BUY' | 'SELL'; sol: number; tokens: number; walletShort: string; creator: boolean; own: boolean }> }

const k = 'px-2 py-1 text-right font-mono tabular-nums';

export function CurvePanelView({ mint, curve, tape, error }: { mint: string | null; curve: CurveData | null; tape: TapeData | null; error: string | null }) {
  return (
    <section className="rounded-lg border border-slate-800 bg-[#0B0F17] p-3 text-xs" data-testid="curve-panel">
      <h3 className="text-[11px] uppercase tracking-wider text-slate-400 font-bold mb-2">Curve depth {mint ? `· ${mint.slice(0, 4)}…${mint.slice(-4)}` : ''}</h3>
      {!mint && <p className="text-slate-500">Select a token on the board.</p>}
      {mint && error && <p className="text-amber-400">No market data ({error}).</p>}
      {mint && curve && (
        <>
          <div className="flex justify-between mb-2">
            <span>Price <b className="font-mono text-slate-100">{curve.spotPriceSol.toExponential(3)} SOL</b></span>
            <span className="text-slate-400">{curve.priceUsd === null ? '—' : `$${curve.priceUsd.toExponential(3)}`}</span>
          </div>
          <div className="h-1.5 rounded bg-slate-800 overflow-hidden mb-1"><div className="h-full bg-cyan-500" style={{ width: `${Math.min(100, curve.curveProgressPct)}%` }} /></div>
          <p className="text-slate-500 mb-2">{curve.curveProgressPct.toFixed(1)}% to migration</p>
          {curve.note && <p className="text-amber-400 mb-2">{curve.note}</p>}
          <table className="w-full mb-2"><thead><tr className="text-slate-500"><th className="text-left px-2">Buy to move price</th><th className={k}>SOL needed</th><th className={k}>Fees</th></tr></thead>
            <tbody>{curve.buy.map((r) => <tr key={r.upPct} className="border-t border-slate-800/60"><td className="px-2 py-1 text-emerald-400">+{r.upPct}%</td><td className={k}>{fmt(r.solNeeded, 4)}</td><td className={k}>{fmt(r.feesSol, 5)}</td></tr>)}</tbody></table>
          {curve.sell ? (
            <table className="w-full mb-2"><thead><tr className="text-slate-500"><th className="text-left px-2">Sell your position</th><th className={k}>SOL received</th><th className={k}>Impact</th></tr></thead>
              <tbody>{curve.sell.map((r) => <tr key={r.sellPct} className="border-t border-slate-800/60"><td className="px-2 py-1 text-red-400">{r.sellPct}%</td><td className={k}>{fmt(r.solReceived, 4)}</td><td className={k}>{r.impactBps === null ? '—' : `${(r.impactBps / 100).toFixed(2)}%`}</td></tr>)}</tbody></table>
          ) : <p className="text-slate-500 mb-2">No open position in this token, so no sell ladder.</p>}
        </>
      )}
      {mint && (
        <>
          <h4 className="text-[11px] uppercase tracking-wider text-slate-400 font-bold mt-2 mb-1">Trade tape</h4>
          {(!tape || tape.trades.length === 0) && <p className="text-slate-500">No trades seen for this token.</p>}
          {tape && tape.trades.length > 0 && (
            <table className="w-full"><tbody>
              {tape.trades.slice(0, 15).map((t, i) => (
                <tr key={`${t.signature}-${i}`} className={`border-t border-slate-800/60 ${t.own ? 'bg-cyan-950/50' : ''}`}>
                  <td className="px-2 py-1 text-slate-500">{new Date(t.at).toLocaleTimeString()}</td>
                  <td className={`px-2 py-1 font-bold ${t.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>{t.side}</td>
                  <td className={k}>{t.sol.toFixed(4)}</td>
                  <td className={k}>{t.tokens.toFixed(0)}</td>
                  <td className="px-2 py-1 font-mono text-slate-400">{t.walletShort}{t.creator ? ' · creator' : ''}{t.own ? ' · you' : ''}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </>
      )}
    </section>
  );
}

export function CurvePanel({ mint }: { mint: string | null }) {
  const [curve, setCurve] = useState<CurveData | null>(null);
  const [tape, setTape] = useState<TapeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setCurve(null); setTape(null); setError(null);
    if (!mint) return;
    let alive = true;
    const load = async () => {
      try {
        const [c, t] = await Promise.all([authFetch(`/api/market/curve/${mint}`), authFetch(`/api/market/trades/${mint}`)]);
        if (!alive) return;
        if (c.ok) { setCurve(await c.json()); setError(null); } else { setCurve(null); setError(`${c.status} UNAVAILABLE`); }
        if (t.ok) setTape(await t.json());
      } catch { if (alive) setError('offline'); }
    };
    load();
    const id = setInterval(load, 4000);
    return () => { alive = false; clearInterval(id); };
  }, [mint]);
  return <CurvePanelView mint={mint} curve={curve} tape={tape} error={error} />;
}
