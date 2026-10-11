import React from 'react';
import { X, TrendingUp } from 'lucide-react';
import { usePolled } from '../utils/usePolled';

export interface ReplayedLaunchRow {
  mint: string; symbol: string; trades: number; verdict: string; verdictReason: string; releasedAfterMs: number | null; score: number | null;
  entered: boolean; noEntryReason: string | null; outcome: 'NO_ENTRY' | 'CLOSED' | 'OPEN_AT_END'; entryPriceSol: number | null;
  exits: Array<{ reason: string; sellPct: number; priceSol: number; afterMs: number }>; holdMs: number | null; netPnlSol: number | null; openValueSol: number | null;
}
export interface ReplayReportData {
  rules: string[]; notReplayed: string[]; assumptions: Record<string, number>;
  summary: { launches: number; released: Record<string, number>; entries: number; closed: number; openAtEnd: number; wins: number; losses: number; winRate: number | null; netPnlSol: number | null; avgHoldMs: number | null; exitReasons: Record<string, number> };
  launches: ReplayedLaunchRow[];
}
export interface ReplayResponse {
  recorded: { launches: number; events: number; oldestTs: number | null; newestTs: number | null };
  report: ReplayReportData | null;
  message: string | null;
}

const sol = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(5)} SOL`);
const dur = (ms: number | null) => (ms === null ? '—' : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 60_000).toFixed(1)} min`);

/**
 * Backtest = a replay of recorded launches through the auto trader's own rules. With nothing recorded it says so and shows no result:
 * there is no generator behind this screen.
 */
export function ReplayBacktestView({ data, error }: { data: ReplayResponse | null; error?: string | null }) {
  return (
    <div className="font-mono text-xs" data-testid="replay-backtest">
      {error && <p className="text-red-400 mb-2">{error}</p>}
      {!data && !error && <p className="text-slate-500">Reading the recording…</p>}
      {data && !data.report && (
        <div data-testid="replay-empty" className="p-3 rounded-lg border border-[#1E293B] bg-[#090D16] text-slate-300">
          <p className="font-bold mb-1">No recorded launches, so there is no backtest result.</p>
          <p className="text-slate-500">{data.message ?? 'The recorder saves the launches the watch window scores while the app runs against a pump.fun feed. Leave it running, then open this screen again.'}</p>
        </div>
      )}
      {data?.report && (() => {
        const r = data.report;
        const s = r.summary;
        return (
          <>
            <p className="text-slate-400 mb-3" data-testid="replay-recorded">
              {data.recorded.launches} launch(es), {data.recorded.events} recorded events, from {data.recorded.oldestTs ? new Date(data.recorded.oldestTs).toLocaleString() : '—'} to {data.recorded.newestTs ? new Date(data.recorded.newestTs).toLocaleString() : '—'}.
            </p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 mb-3" data-testid="replay-summary">
              <span className="text-slate-500">Verdicts</span><span className="text-right">{Object.entries(s.released).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}</span>
              <span className="text-slate-500">Entered</span><span className="text-right">{s.entries}</span>
              <span className="text-slate-500">Closed / still open at end</span><span className="text-right">{s.closed} / {s.openAtEnd}</span>
              <span className="text-slate-500">Win rate (closed)</span><span className="text-right">{s.winRate === null ? '—' : `${(s.winRate * 100).toFixed(0)}% (${s.wins} of ${s.closed})`}</span>
              <span className="text-slate-500">Net PnL after fees (closed)</span><span className="text-right">{sol(s.netPnlSol)}</span>
              <span className="text-slate-500">Average hold</span><span className="text-right">{dur(s.avgHoldMs)}</span>
              <span className="text-slate-500">Exits by reason</span><span className="text-right">{Object.entries(s.exitReasons).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}</span>
            </div>
            {s.closed < 30 && <p className="text-amber-300/90 mb-3" data-testid="replay-small-n">Only {s.closed} closed trade(s): too few to say anything about expectancy.</p>}
            <table className="w-full text-left mb-3" data-testid="replay-table">
              <thead><tr className="text-slate-500 text-[10px]"><th className="py-1">token</th><th>verdict</th><th>score</th><th>result</th><th>net</th></tr></thead>
              <tbody>
                {r.launches.map((l) => (
                  <tr key={l.mint} className="border-t border-[#1E293B] align-top">
                    <td className="py-1 text-slate-300">${l.symbol}<div className="text-[10px] text-slate-500" title={l.mint}>{l.mint.slice(0, 6)}…{l.mint.slice(-4)} · {l.trades} trades</div></td>
                    <td title={l.verdictReason}>{l.verdict}{l.releasedAfterMs !== null ? ` @${Math.round(l.releasedAfterMs / 1000)}s` : ''}</td>
                    <td>{l.score ?? '—'}</td>
                    <td>{l.entered ? `${l.outcome === 'OPEN_AT_END' ? 'open at end' : 'closed'}: ${l.exits.map((e) => e.reason).join(', ') || 'no exit yet'}` : (l.noEntryReason ?? '—')}</td>
                    <td className={l.netPnlSol === null ? '' : l.netPnlSol >= 0 ? 'text-emerald-400' : 'text-red-400'}>{sol(l.netPnlSol)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h4 className="text-[11px] font-bold text-slate-300 mb-1">Rules replayed</h4>
            <ul className="mb-2 text-slate-400 list-disc pl-4" data-testid="replay-rules">{r.rules.map((x) => <li key={x}>{x}</li>)}</ul>
            <h4 className="text-[11px] font-bold text-amber-300 mb-1">Not replayed (the result is optimistic by this much)</h4>
            <ul className="mb-2 text-slate-400 list-disc pl-4" data-testid="replay-not-replayed">{r.notReplayed.map((x) => <li key={x}>{x}</li>)}</ul>
            <p className="text-[10px] text-slate-500" data-testid="replay-assumptions">
              Assumed: order {r.assumptions.orderSol} SOL, buy lands {Math.round(r.assumptions.entryDelayMs)} ms after the release at the next recorded price, {r.assumptions.feePct}% fee each side, network fee {r.assumptions.networkFeeSol} SOL and tip {r.assumptions.tipSol} SOL per transaction.
            </p>
          </>
        );
      })()}
    </div>
  );
}

interface BacktestModalProps { isOpen: boolean; onClose: () => void }

export const BacktestModal: React.FC<BacktestModalProps> = ({ isOpen, onClose }) => {
  const { data, error } = usePolled<ReplayResponse>('/api/backtest/replay', 30000, isOpen);
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4 z-50 font-mono">
      <div className="bg-[#0D131F] border border-[#1E293B] rounded-xl p-5 max-w-3xl w-full shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2"><TrendingUp className="w-4 h-4 text-emerald-400" /> Backtest: replay of recorded launches</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
        <p className="text-[10px] text-slate-500 mb-3">Runs the auto trader's own watch window, confluence gate and exit engine over launches this app recorded. Past launches only: it says nothing about the next one.</p>
        <ReplayBacktestView data={data} error={error} />
      </div>
    </div>
  );
};
