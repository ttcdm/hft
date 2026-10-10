import React from 'react';
import { useTradingMode } from '../utils/tradingMode';

/** Q10b / Q41: mode, cluster, RPC host and how old that answer is, always visible. */
export const TradingModeBanner: React.FC = () => {
  const m = useTradingMode();
  const tone = m.live
    ? 'bg-rose-950/80 border-rose-500/60 text-rose-200'
    : m.known
      ? 'bg-slate-900/80 border-slate-700 text-slate-300'
      : 'bg-amber-950/70 border-amber-500/50 text-amber-200';
  return (
    <div data-testid="trading-mode-banner" className={`px-4 py-1 text-[11px] font-mono border-b flex flex-wrap items-center gap-x-4 gap-y-0.5 ${tone}`}>
      <span className="font-bold">{m.label}</span>
      <span>cluster: {m.cluster ?? 'unknown'}</span>
      <span>rpc: {m.rpcHost ?? 'unknown'}</span>
      <span>{m.ageMs === null ? 'no answer from the server yet' : m.stale ? `server status is ${Math.round(m.ageMs / 1000)}s old` : `server status ${Math.round(m.ageMs / 1000)}s old`}</span>
    </div>
  );
};
