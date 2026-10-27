import React from 'react';
import { useEscapeToClose } from '../utils/useEscapeToClose';
import { X, Timer } from 'lucide-react';
import { usePolled } from '../utils/usePolled';
import { DialogFrame } from './DialogFrame';

export interface LatencyRowData { label: string; n: number; p50Ms: number | null; p95Ms: number | null; maxMs: number | null }
export interface LatencyData {
  sendToConfirm: LatencyRowData[]; signalToSend: LatencyRowData[]; notes: string[];
  counts: { transactions: number; confirmed: number; unconfirmed: number; reverted: number; signals: number; signalsWithSend: number };
}
const ms = (v: number | null) => (v === null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);

function Table({ title, rows, empty, testId }: { title: string; rows: LatencyRowData[]; empty: string; testId: string }) {
  return (
    <section className="mb-4" data-testid={testId}>
      <h4 className="text-[11px] font-bold text-slate-300 mb-1">{title}</h4>
      {rows.length === 0 ? <p className="text-slate-500">{empty}</p> : (
        <table className="w-full text-left">
          <thead><tr className="text-slate-500 text-[10px]"><th className="py-1">path</th><th>n</th><th>p50</th><th>p95</th><th>max</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.label} className="border-t border-[#1E293B]"><td className="py-1 text-slate-300">{r.label}</td><td>{r.n}</td><td>{ms(r.p50Ms)}</td><td>{ms(r.p95Ms)}</td><td>{ms(r.maxMs)}</td></tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}

export function ExecutionLatencyView({ data, error }: { data: LatencyData | null; error?: string | null }) {
  return (
    <div className="font-mono text-xs" data-testid="latency-view">
      {error && <p className="text-red-400 mb-2">{error}</p>}
      {!data && !error && <p className="text-slate-500">Reading the journal…</p>}
      {data && (
        <>
          <p className="text-slate-400 mb-3" data-testid="latency-counts">
            {data.counts.transactions} transaction(s) in the journal: {data.counts.confirmed} confirmed, {data.counts.reverted} reverted, {data.counts.unconfirmed} without a confirmation time.
          </p>
          <Table testId="latency-confirm" title="Send → confirm (transport / mode / side)" rows={data.sendToConfirm} empty="No confirmed transaction yet: nothing to measure." />
          <Table testId="latency-signal" title="Candidate reached the trader → first buy sent (transport / mode)" rows={data.signalToSend} empty="No candidate has been followed by a buy yet: nothing to measure." />
          {data.notes.map((n) => <p key={n} className="text-[10px] text-amber-300/80 mb-1">{n}</p>)}
        </>
      )}
    </div>
  );
}

export const ExecutionLatencyModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const { data, error } = usePolled<LatencyData>('/api/system/latency', 10000, isOpen);
  useEscapeToClose(isOpen, onClose);
  if (!isOpen) return null;
  return (
    <DialogFrame label="Execution latency" className="fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4 z-50 font-mono">
      <div className="bg-[#0D131F] border border-[#1E293B] rounded-xl p-5 max-w-2xl w-full shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2"><Timer className="w-4 h-4 text-cyan-400" /> Execution latency</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
        <p className="text-[10px] text-slate-500 mb-3">Measured from this app's own journal (transaction submission and confirmation times, candidate arrival times). No co-location or network latency is assumed.</p>
        <ExecutionLatencyView data={data} error={error} />
      </div>
    </DialogFrame>
  );
};
