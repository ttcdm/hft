import React from 'react';
import { X, RefreshCw } from 'lucide-react';
import { usePolled } from '../utils/usePolled';

export interface SystemCheckRow { id: string; label: string; status: 'OK' | 'WARN' | 'FAIL' | 'UNKNOWN'; value: string; detail: string }
export interface SystemChecksData { checkedAt: number; cluster: string; mode: string; checks: SystemCheckRow[] }

const TONE: Record<SystemCheckRow['status'], string> = {
  OK: 'bg-emerald-500/20 text-emerald-300', WARN: 'bg-amber-500/20 text-amber-300', FAIL: 'bg-red-500/25 text-red-300', UNKNOWN: 'bg-slate-700/60 text-slate-300',
};

/** Pure view: renders what the server returned (or the reason it did not). */
export function SystemChecksView({ data, error }: { data: SystemChecksData | null; error?: string | null }) {
  return (
    <div data-testid="system-checks" className="font-mono text-xs">
      {error && <p className="text-red-400 mb-2" data-testid="system-checks-error">{error}</p>}
      {!data && !error && <p className="text-slate-500">Reading the server…</p>}
      {data && (
        <>
          <p className="text-slate-400 mb-2" data-testid="system-checks-head">
            cluster <strong className="text-slate-200">{data.cluster}</strong> · mode <strong className="text-slate-200">{data.mode}</strong> · read {new Date(data.checkedAt).toLocaleTimeString()}
          </p>
          <ul className="divide-y divide-[#1E293B] border border-[#1E293B] rounded-lg">
            {data.checks.map((c) => (
              <li key={c.id} data-testid={`check-${c.id}`} className="p-2.5 flex items-start gap-3">
                <span className={`shrink-0 w-16 text-center text-[10px] font-bold rounded px-1 py-0.5 ${TONE[c.status]}`}>{c.status}</span>
                <div className="min-w-0">
                  <div className="text-slate-200"><span className="text-slate-400">{c.label}:</span> {c.value}</div>
                  <div className="text-[10px] text-slate-500 break-words">{c.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export const SystemChecksModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const { data, error } = usePolled<SystemChecksData>('/api/system/checks', 5000, isOpen);
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4 z-50 font-mono">
      <div className="bg-[#0D131F] border border-[#1E293B] rounded-xl p-5 max-w-2xl w-full shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2"><RefreshCw className="w-4 h-4 text-cyan-400" /> System checks</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
        <p className="text-[10px] text-slate-500 mb-3">Live results from the running server, refreshed every 5 s. A check that cannot be read says UNKNOWN, never OK.</p>
        <SystemChecksView data={data} error={error} />
      </div>
    </div>
  );
};
