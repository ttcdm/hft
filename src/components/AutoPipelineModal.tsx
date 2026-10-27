import { SHADOW_TEST_NOTE } from './AutoPanel';
import React from 'react';
import { useEscapeToClose } from '../utils/useEscapeToClose';
import { X, Cpu } from 'lucide-react';
import { usePolled } from '../utils/usePolled';
import type { AutoStatusData } from './AutoPanel';
import { DialogFrame } from './DialogFrame';

export interface WatchSnapshotData {
  watching: Array<{ metrics: { mint: string; elapsedMs: number; tradeCount: number; uniqueBuyers: number; buyVolumeSol: number; passingSignals?: number } }>;
  released: Array<{ state: string; reason: string }>;
  capacity: { active: number; max: number; refusedFull: number };
}

export function AutoPipelineView({ auto, watch, error }: { auto: AutoStatusData | null; watch: WatchSnapshotData | null; error?: string | null }) {
  const stages = Object.entries(auto?.stats.rejectedByStage ?? {}).sort((a, b) => b[1] - a[1]);
  const verdicts = (watch?.released ?? []).reduce<Record<string, number>>((m, r) => { m[r.state] = (m[r.state] ?? 0) + 1; return m; }, {});
  return (
    <div className="font-mono text-xs" data-testid="auto-pipeline">
      {error && <p className="text-red-400 mb-2">{error}</p>}
      {!auto && !error && <p className="text-slate-500">Reading the server…</p>}
      {auto && (
        <>
          <p className="mb-2 text-slate-300" data-testid="pipeline-mode">
            Auto mode <strong>{auto.mode}</strong>{auto.killed ? ' (killed)' : ''}{auto.haltReason ? ` · ALL TRADING HALTED: ${auto.haltReason}` : ''}
            {auto.envEnabled === false ? ' · server env: AUTO_SNIPE_ENABLED is not true' : ''}
          </p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 mb-3" data-testid="pipeline-stats">
            <span className="text-slate-500">Candidates seen</span><span className="text-right">{auto.stats.seen}</span>
            <span className="text-slate-500" data-testid="shadow-would-buy" title={SHADOW_TEST_NOTE}>Would buy (SHADOW, looser test)</span><span className="text-right">{auto.stats.wouldBuy}</span>
            <span className="text-slate-500">Bought</span><span className="text-right">{auto.stats.bought}</span>
            <span className="text-slate-500">Open / closed</span><span className="text-right">{auto.stats.open} / {auto.stats.closed}</span>
          </div>
          <h4 className="text-[11px] font-bold text-slate-300 mb-1">Dropped / rejected by stage</h4>
          <p className="mb-3 text-slate-400" data-testid="pipeline-stages">{stages.length === 0 ? 'none yet' : stages.map(([k, v]) => `${k} ${v}`).join(' · ')}</p>
        </>
      )}
      {watch && (
        <>
          <h4 className="text-[11px] font-bold text-slate-300 mb-1">Watch window</h4>
          <p className="mb-1 text-slate-400" data-testid="pipeline-watch">
            watching {watch.capacity.active} of {watch.capacity.max} · refused when full {watch.capacity.refusedFull} · verdicts (last {watch.released.length}): {Object.keys(verdicts).length === 0 ? 'none' : Object.entries(verdicts).map(([k, v]) => `${k} ${v}`).join(' · ')}
          </p>
          {watch.watching.slice(0, 8).map((w) => (
            <p key={w.metrics.mint} className="text-[10px] text-slate-500">{w.metrics.mint.slice(0, 6)}…{w.metrics.mint.slice(-4)} · {Math.round(w.metrics.elapsedMs / 1000)} s · {w.metrics.tradeCount} trades · {w.metrics.uniqueBuyers} buyers · {w.metrics.buyVolumeSol.toFixed(2)} SOL bought</p>
          ))}
        </>
      )}
    </div>
  );
}

export const AutoPipelineModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const a = usePolled<AutoStatusData>('/api/auto/status', 4000, isOpen);
  const w = usePolled<WatchSnapshotData>('/api/watch', 4000, isOpen);
  useEscapeToClose(isOpen, onClose);
  if (!isOpen) return null;
  return (
    <DialogFrame label="Auto pipeline" className="fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4 z-50 font-mono">
      <div className="bg-[#0D131F] border border-[#1E293B] rounded-xl p-5 max-w-xl w-full shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2"><Cpu className="w-4 h-4 text-cyan-400" /> Auto pipeline</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
        <AutoPipelineView auto={a.data} watch={w.data} error={a.error || w.error} />
      </div>
    </DialogFrame>
  );
};
