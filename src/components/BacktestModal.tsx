import React, { useState } from 'react';
import { useEscapeToClose } from '../utils/useEscapeToClose';
import { X, TrendingUp } from 'lucide-react';
import { usePolled } from '../utils/usePolled';
import { parseThreshold, thresholdWarning } from '../utils/confluenceThreshold';

export interface ReplayedLaunchRow {
  mint: string; symbol: string; trades: number; verdict: string; verdictReason: string; releasedAfterMs: number | null; score: number | null;
  entered: boolean; noEntryReason: string | null; outcome: 'NO_ENTRY' | 'CLOSED' | 'OPEN_AT_END'; entryPriceSol: number | null;
  exits: Array<{ reason: string; sellPct: number; priceSol: number; afterMs: number }>; holdMs: number | null; netPnlSol: number | null; openValueSol: number | null;
  /** 5A: OPEN_AT_END marked at the last price (partial sells included, exit cost charged). Absent on an older server. */
  openNetPnlSol?: number | null;
}
export interface ReplayReportData {
  rules: string[]; notReplayed: string[]; assumptions: Record<string, number>;
  /** 5A: the gaps by the direction they move the result. Absent on an older server. */
  notReplayedByDirection?: { optimistic: string[]; pessimistic: string[]; unknown: string[] };
  summary: {
    launches: number; released: Record<string, number>; entries: number; closed: number; openAtEnd: number; wins: number; losses: number; winRate: number | null; netPnlSol: number | null; avgHoldMs: number | null; exitReasons: Record<string, number>;
    /** 5A: the open-at-end positions marked at the last price, kept out of netPnlSol. Absent on an older server. */
    openMarkNetPnlSol?: number | null;
    /** 5C: the same figures by how each recording ended. Absent on an older server. */
    byRecording?: Record<'COMPLETE' | 'TRUNCATED' | 'GRADUATED' | 'UNRESOLVED', { launches: number; entries: number; closed: number; openAtEnd: number; netPnlSol: number | null; openMarkNetPnlSol: number | null }>;
  };
  launches: ReplayedLaunchRow[];
  /** S190. Absent on an older server. */
  peakAnalysis?: PeakAnalysisData;
}
export interface PeakAnalysisData {
  basis: string; launches: number;
  coverage: { atLeast30Min: number; atLeast60Min: number; atLeast180Min: number };
  buckets: Array<{ label: string; launches: number; medianPeakMultiple: number | null; peakAtLeast2x: number; peakAtLeast5x: number }>;
  late: { peakAfter30MinAtLeast2x: number; ofLaunchesWithAtLeast60MinData: number; peakAfter60MinAtLeast2x: number; ofLaunchesWithAtLeast180MinData: number };
  caveats: string[];
}

/** S190: when does the best price come? Measured on the recorded launches, no strategy behind it. */
export function PeakAnalysisView({ a }: { a: PeakAnalysisData }) {
  const x = (v: number | null) => (v === null ? '—' : `${v.toFixed(2)}x`);
  return (
    <div className="mb-3 p-2 rounded border border-[#1E293B] bg-[#090D16]" data-testid="peak-analysis">
      <h4 className="text-[11px] font-bold text-slate-300 mb-1">When does the peak come? (time from the 2-minute release to the highest recorded price)</h4>
      <p className="text-slate-500 mb-1">{a.launches} launch(es) with a release and later trades. Data reaches 30+ min after the release for {a.coverage.atLeast30Min}, 60+ min for {a.coverage.atLeast60Min}, 180+ min for {a.coverage.atLeast180Min}.</p>
      <table className="w-full text-left mb-1" data-testid="peak-buckets">
        <thead><tr className="text-slate-500 text-[10px]"><th className="py-1">peak came</th><th>launches</th><th>median peak vs release</th><th>peak 2x+</th><th>peak 5x+</th></tr></thead>
        <tbody>{a.buckets.map((b) => <tr key={b.label} className="border-t border-[#1E293B]"><td className="py-1">{b.label}</td><td>{b.launches}</td><td>{x(b.medianPeakMultiple)}</td><td>{b.peakAtLeast2x}</td><td>{b.peakAtLeast5x}</td></tr>)}</tbody>
      </table>
      <p className="text-slate-300" data-testid="peak-late">Late spikes: {a.late.peakAfter30MinAtLeast2x} launch(es) peaked 2x+ more than 30 min after the release (of {a.late.ofLaunchesWithAtLeast60MinData} with 60+ min of data); {a.late.peakAfter60MinAtLeast2x} more than 60 min after (of {a.late.ofLaunchesWithAtLeast180MinData} with 180+ min of data).</p>
      {a.coverage.atLeast60Min === 0 && <p className="text-amber-300/90 mt-1" data-testid="peak-no-coverage">No launch has 60+ minutes of recorded data yet, so late spikes cannot be seen. The recorder keeps up to the configured window per launch; data recorded with the old 30-minute window cannot show them.</p>}
      <ul className="list-disc pl-4 text-slate-500 mt-1">{a.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
    </div>
  );
}
export interface ReplayResponse {
  recorded: { launches: number; events: number; oldestTs: number | null; newestTs: number | null };
  report: ReplayReportData | null;
  message: string | null;
  /** S188: how many launches this replay covers and the most it will cover. Absent on an older server. */
  replayedLaunches?: number;
  replayCap?: number;
}

/** The summary covers every replayed launch; the per-launch table shows the newest rows only, so a 3,000-launch replay does not render 3,000 rows. */
export const TABLE_ROWS_SHOWN = 300;

const sol = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(5)} SOL`);
const dur = (ms: number | null) => (ms === null ? '—' : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 60_000).toFixed(1)} min`);

/**
 * S187: the what-if box. Replays the recorded launches at another confluence threshold; the shortcut buttons run 70, 50 and 40.
 * Nothing here changes the live threshold (that is the Auto panel); this only changes what the replay below uses.
 */
export function ReplayThresholdBox({ value, onChange, inForce }: { value: string; onChange: (v: string) => void; inForce?: number }) {
  const p = parseThreshold(value);
  const warn = p.ok ? thresholdWarning(p.value) : null;
  return (
    <div className="mb-3 p-2 rounded border border-[#1E293B] bg-[#090D16]" data-testid="replay-threshold">
      <div className="text-slate-400 mb-1">What if the confluence buy threshold were… {inForce !== undefined && <span className="text-slate-600">(live: {inForce})</span>}</div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <input data-testid="replay-threshold-slider" type="range" min={0} max={100} step={1} value={p.ok ? p.value : 0} onChange={(e) => onChange(e.target.value)} className="flex-1 min-w-[8rem]" aria-label="Replay threshold" />
        <input data-testid="replay-threshold-box" type="number" min={0} max={100} step={1} value={value} onChange={(e) => onChange(e.target.value)} className="w-14 px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-[11px]" />
        {[70, 50, 40].map((n) => <button key={n} data-testid={`replay-threshold-${n}`} onClick={() => onChange(String(n))} className="px-2 py-0.5 rounded border border-slate-600 text-slate-300 hover:text-white">{n}</button>)}
      </div>
      {!p.ok && <p className="text-rose-400 mt-1" data-testid="replay-threshold-problem">{p.reason}</p>}
      {warn && <p className="text-amber-300 mt-1" data-testid="replay-threshold-warning">{warn}</p>}
    </div>
  );
}

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
            {data.replayCap !== undefined && data.replayedLaunches !== undefined && data.recorded.launches > data.replayedLaunches && (
              <p className="text-amber-300/90 mb-3" data-testid="replay-capped">Replaying the newest {data.replayedLaunches} of {data.recorded.launches} recorded launches (the replay is capped at {data.replayCap}); the older ones are kept but not replayed.</p>
            )}
            {r.peakAnalysis && <PeakAnalysisView a={r.peakAnalysis} />}
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 mb-3" data-testid="replay-summary">
              <span className="text-slate-500">Verdicts</span><span className="text-right">{Object.entries(s.released).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}</span>
              <span className="text-slate-500">Entered</span><span className="text-right">{s.entries}</span>
              <span className="text-slate-500">Closed / still open at end</span><span className="text-right">{s.closed} / {s.openAtEnd}</span>
              <span className="text-slate-500">Win rate (closed)</span><span className="text-right">{s.winRate === null ? '—' : `${(s.winRate * 100).toFixed(0)}% (${s.wins} of ${s.closed})`}</span>
              <span className="text-slate-500">Net PnL after fees (closed, realized)</span><span className="text-right">{sol(s.netPnlSol)}</span>
              {s.openMarkNetPnlSol !== undefined && <><span className="text-slate-500">Still open at end, marked at the last price (not in the net above)</span><span className="text-right" data-testid="replay-open-mark">{sol(s.openMarkNetPnlSol)}{s.openAtEnd ? ` over ${s.openAtEnd}` : ''}</span></>}
              <span className="text-slate-500">Average hold</span><span className="text-right">{dur(s.avgHoldMs)}</span>
              <span className="text-slate-500">Exits by reason</span><span className="text-right">{Object.entries(s.exitReasons).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}</span>
            </div>
            {s.byRecording && (
              <p className="text-slate-400 mb-3" data-testid="replay-by-recording">
                Recordings: {s.byRecording.COMPLETE.launches} recorded for the whole window, {s.byRecording.TRUNCATED.launches} cut by the trade cap, {s.byRecording.GRADUATED.launches} graduated, {s.byRecording.UNRESOLVED.launches} unresolved (no END row: still recording, stopped with the app, or recorded before END rows).
                {(['TRUNCATED', 'GRADUATED', 'UNRESOLVED'] as const).filter((k) => s.byRecording![k].entries > 0).map((k) => ` ${k}: ${s.byRecording![k].entries} entered, net ${sol(s.byRecording![k].netPnlSol)} closed, ${sol(s.byRecording![k].openMarkNetPnlSol)} open mark.`).join('')}
              </p>
            )}
            {s.closed < 30 && <p className="text-amber-300/90 mb-3" data-testid="replay-small-n">Only {s.closed} closed trade(s): too few to say anything about expectancy.</p>}
            {r.launches.length > TABLE_ROWS_SHOWN && <p className="text-slate-500 mb-1" data-testid="replay-table-capped">Table: the newest {TABLE_ROWS_SHOWN} of {r.launches.length} replayed launches (the summary above counts all of them).</p>}
            <table className="w-full text-left mb-3" data-testid="replay-table">
              <thead><tr className="text-slate-500 text-[10px]"><th className="py-1">token</th><th>verdict</th><th>score</th><th>result</th><th>net</th></tr></thead>
              <tbody>
                {r.launches.slice(-TABLE_ROWS_SHOWN).reverse().map((l) => (
                  <tr key={l.mint} className="border-t border-[#1E293B] align-top">
                    <td className="py-1 text-slate-300">${l.symbol}<div className="text-[10px] text-slate-500" title={l.mint}>{l.mint.slice(0, 6)}…{l.mint.slice(-4)} · {l.trades} trades</div></td>
                    <td title={l.verdictReason}>{l.verdict}{l.releasedAfterMs !== null ? ` @${Math.round(l.releasedAfterMs / 1000)}s` : ''}</td>
                    <td>{l.score ?? '—'}</td>
                    <td>{l.entered ? `${l.outcome === 'OPEN_AT_END' ? 'open at end' : 'closed'}: ${l.exits.map((e) => e.reason).join(', ') || 'no exit yet'}` : (l.noEntryReason ?? '—')}</td>
                    {l.outcome === 'OPEN_AT_END' && l.openNetPnlSol !== undefined && l.openNetPnlSol !== null
                      ? <td className="text-slate-400" title="marked at the last recorded price, not realized">{sol(l.openNetPnlSol)} (mark)</td>
                      : <td className={l.netPnlSol === null ? '' : l.netPnlSol >= 0 ? 'text-emerald-400' : 'text-red-400'}>{sol(l.netPnlSol)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
            <h4 className="text-[11px] font-bold text-slate-300 mb-1">Rules replayed</h4>
            <ul className="mb-2 text-slate-400 list-disc pl-4" data-testid="replay-rules">{r.rules.map((x) => <li key={x}>{x}</li>)}</ul>
            {r.notReplayedByDirection ? (
              <div data-testid="replay-not-replayed">
                <h4 className="text-[11px] font-bold text-amber-300 mb-1">Not replayed, makes the result look better than live</h4>
                <ul className="mb-2 text-slate-400 list-disc pl-4">{r.notReplayedByDirection.optimistic.map((x) => <li key={x}>{x}</li>)}</ul>
                <h4 className="text-[11px] font-bold text-slate-300 mb-1">Not replayed, makes it look worse</h4>
                <ul className="mb-2 text-slate-400 list-disc pl-4">{r.notReplayedByDirection.pessimistic.map((x) => <li key={x}>{x}</li>)}</ul>
                <h4 className="text-[11px] font-bold text-slate-300 mb-1">Not replayed, direction unknown</h4>
                <ul className="mb-2 text-slate-400 list-disc pl-4">{r.notReplayedByDirection.unknown.map((x) => <li key={x}>{x}</li>)}</ul>
              </div>
            ) : (
              <>
                <h4 className="text-[11px] font-bold text-amber-300 mb-1">Not replayed</h4>
                <ul className="mb-2 text-slate-400 list-disc pl-4" data-testid="replay-not-replayed">{r.notReplayed.map((x) => <li key={x}>{x}</li>)}</ul>
              </>
            )}
            <p className="text-[10px] text-slate-500" data-testid="replay-assumptions">
              {r.assumptions.exitDelayMs !== undefined
                ? <>Assumed: order {r.assumptions.orderSol} SOL; the buy lands {Math.round(r.assumptions.entryDelayMs)} ms after the release and each sell {Math.round(r.assumptions.exitDelayMs)} ms after its decision, at the curve state then; {r.assumptions.feePct}% pump.fun fee on the buy and on every sell; per transaction: network fee {r.assumptions.networkFeeSol} SOL, priority fee {r.assumptions.priorityBuySol} SOL (buy) / {r.assumptions.prioritySellSol} SOL (sell), tip {r.assumptions.tipSol} SOL.</>
                : <>Assumed: order {r.assumptions.orderSol} SOL, buy lands {Math.round(r.assumptions.entryDelayMs)} ms after the release, {r.assumptions.feePct}% fee, network fee {r.assumptions.networkFeeSol} SOL and tip {r.assumptions.tipSol} SOL (an older server: see its own notes for what it charges).</>}
            </p>
          </>
        );
      })()}
    </div>
  );
}

interface BacktestModalProps { isOpen: boolean; onClose: () => void }

export const BacktestModal: React.FC<BacktestModalProps> = ({ isOpen, onClose }) => {
  const [thresholdText, setThresholdText] = useState('');
  // untouched: the threshold in force (no query). A valid number: replay at that value. An invalid one keeps the last good replay.
  const [applied, setApplied] = useState<number | null>(null);
  const onThreshold = (v: string) => {
    setThresholdText(v);
    const p = parseThreshold(v);
    if (p.ok) setApplied(p.value);
  };
  const path = applied === null ? '/api/backtest/replay' : `/api/backtest/replay?minScore=${applied}`;
  const { data, error } = usePolled<ReplayResponse>(path, 30000, isOpen);
  const live = usePolled<{ confluence?: { value: number } }>('/api/auto/status', 10000, isOpen).data?.confluence?.value;
  useEscapeToClose(isOpen, onClose);
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4 z-50 font-mono">
      <div className="bg-[#0D131F] border border-[#1E293B] rounded-xl p-5 max-w-3xl w-full shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2"><TrendingUp className="w-4 h-4 text-emerald-400" /> Backtest: replay of recorded launches</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
        <p className="text-[10px] text-slate-500 mb-3">Runs the auto trader's own watch window, confluence gate and exit engine over launches this app recorded. Past launches only: it says nothing about the next one.</p>
        <ReplayThresholdBox value={thresholdText === '' ? String(live ?? 70) : thresholdText} onChange={onThreshold} inForce={live} />
        <ReplayBacktestView data={data} error={error} />
      </div>
    </div>
  );
};
