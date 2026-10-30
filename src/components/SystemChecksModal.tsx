import React from 'react';
import { useEscapeToClose } from '../utils/useEscapeToClose';
import { X, RefreshCw } from 'lucide-react';
import { usePolled } from '../utils/usePolled';
import { DialogFrame } from './DialogFrame';

export interface SystemCheckRow { id: string; label: string; status: 'OK' | 'WARN' | 'FAIL' | 'UNKNOWN'; value: string; detail: string }
export interface SystemChecksData { checkedAt: number; cluster: string; mode: string; checks: SystemCheckRow[] }

const TONE: Record<SystemCheckRow['status'], string> = {
  OK: 'bg-emerald-500/20 text-emerald-300', WARN: 'bg-amber-500/20 text-amber-300', FAIL: 'bg-red-500/25 text-red-300', UNKNOWN: 'bg-slate-700/60 text-slate-300',
};

const ageText = (ms: number) => `${Math.max(0, Math.round(ms / 1000))}s`;

/**
 * Pure view: renders what the server returned (or the reason it did not). R11-1: when the latest read failed (`error`), the rows of the
 * last good read are not current, so each one says UNKNOWN, greyed, with what it said and how old that is. Never a stale OK.
 */
export function SystemChecksView({ data: raw, error: readError, at, now = Date.now() }: { data: SystemChecksData | null; error?: string | null; at?: number | null; now?: number }) {
  // R12-11: a reply without a checks list cannot be shown as checks; say so instead of rendering nothing or throwing
  const shapeOk = !raw || Array.isArray(raw.checks);
  const data = shapeOk ? raw : null;
  const error = readError ?? (shapeOk ? null : 'Reply unreadable: it has no list of checks.');
  const unknown = !!error;
  const age = at != null ? ageText(now - at) : null;
  return (
    <div data-testid="system-checks" className="font-mono text-xs">
      {error && <p className="text-red-400 mb-2" data-testid="system-checks-error">{error}{data ? ` Every row is UNKNOWN until a read succeeds${age ? `; the values shown are from ${age} ago` : ''}.` : ''}</p>}
      {!data && !error && <p className="text-slate-500">Reading the server…</p>}
      {data && (
        <>
          <p className="text-slate-400 mb-2" data-testid="system-checks-head">
            cluster <strong className="text-slate-200">{data.cluster}</strong> · mode <strong className="text-slate-200">{data.mode}</strong> · read {new Date(data.checkedAt).toLocaleTimeString()}
          </p>
          <ul className={`divide-y divide-[#1E293B] border border-[#1E293B] rounded-lg ${unknown ? 'opacity-60' : ''}`}>
            {data.checks.map((c) => {
              // R12-11: a row whose status is missing or not one of the four is UNKNOWN, and a null value says so
              const status: SystemCheckRow['status'] = unknown || !(c?.status in TONE) ? 'UNKNOWN' : c.status;
              return (
                <li key={c.id} data-testid={`check-${c.id}`} className="p-2.5 flex items-start gap-3">
                  <span data-testid="check-status" className={`shrink-0 w-16 text-center text-[10px] font-bold rounded px-1 py-0.5 ${TONE[status]}`}>{status}</span>
                  <div className="min-w-0">
                    <div className="text-slate-200"><span className="text-slate-400">{c.label ?? c.id}:</span> {c.value ?? '(unreadable)'}</div>
                    {unknown && <div className="text-[10px] text-amber-300/90" data-testid="check-last-read">not current: last read {age ? `${age} ago` : 'earlier'}: {c.status}</div>}
                    <div className="text-[10px] text-slate-500 break-words">{c.detail}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

export const SystemChecksModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const { data, error, at } = usePolled<SystemChecksData>('/api/system/checks', 5000, isOpen);
  useEscapeToClose(isOpen, onClose);
  if (!isOpen) return null;
  return (
    <DialogFrame label="System checks" className="fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4 z-50 font-mono">
      <div className="bg-[#0D131F] border border-[#1E293B] rounded-xl p-5 max-w-2xl w-full shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2"><RefreshCw className="w-4 h-4 text-cyan-400" /> System checks</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
        <p className="text-[10px] text-slate-500 mb-3">Live results from the running server, refreshed every 5 s. A check that cannot be read says UNKNOWN, never OK.</p>
        <SystemChecksView data={data} error={error} at={at} />
      </div>
    </DialogFrame>
  );
};
