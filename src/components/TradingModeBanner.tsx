import React from 'react';
import { useTradingMode, readOnlyBannerText } from '../utils/tradingMode';

/** Q10b / Q41: mode, cluster, RPC host and how old that answer is, always visible. */
export const TradingModeBanner: React.FC = () => {
  const m = useTradingMode();
  const tone = m.live
    ? 'bg-rose-950/80 border-rose-500/60 text-rose-200'
    : m.known
      ? 'bg-slate-900/80 border-slate-700 text-slate-300'
      : 'bg-amber-950/70 border-amber-500/50 text-amber-200';
  const ro = readOnlyBannerText(m);
  return (
    <div>
    {ro && !m.stale && (
      <div data-testid="read-only-banner" className="px-4 py-1 text-[11px] font-mono font-bold tracking-wider bg-emerald-950 border-b border-emerald-500/60 text-emerald-200">
        {ro} <span className="font-normal text-emerald-300/80">· no signer loaded, nothing can be signed or sent</span>
      </div>
    )}
    {/* R9-7: with the server not answering, the green strip stayed up as if confirmed; it is now the last known answer, in amber */}
    {ro && m.stale && (
      <div data-testid="read-only-banner" className="px-4 py-1 text-[11px] font-mono font-bold tracking-wider bg-amber-950 border-b border-amber-500/60 text-amber-200">
        LAST KNOWN: {ro} <span className="font-normal text-amber-300/80">· the server has not answered for {Math.round((m.ageMs ?? 0) / 1000)}s, so this is not confirmed now</span>
      </div>
    )}
    <div data-testid="trading-mode-banner" className={`px-4 py-1 text-[11px] font-mono border-b flex flex-wrap items-center gap-x-4 gap-y-0.5 ${tone}`}>
      <span className="font-bold">{m.label}</span>
      <span>cluster: {m.cluster ?? 'unknown'}</span>
      <span>rpc: {m.rpcHost ?? 'unknown'}</span>
      <span>{m.ageMs === null ? 'no answer from the server yet' : m.stale ? `server status is ${Math.round(m.ageMs / 1000)}s old` : `server status ${Math.round(m.ageMs / 1000)}s old`}</span>
    </div>
    </div>
  );
};

/** S185: the same text in the always-docked header, so it stays visible while the page is scrolled and over every view. Renders nothing off read-only. */
export const ReadOnlyPill: React.FC = () => {
  const m = useTradingMode();
  const ro = readOnlyBannerText(m);
  if (!ro) return null;
  if (m.stale) {
    return (
      <span data-testid="read-only-pill" title="The last answer said read-only, but the server has not answered since; not confirmed now." className="px-2 py-0.5 rounded text-[10px] font-mono font-bold whitespace-nowrap bg-amber-950 border border-amber-500/60 text-amber-200">
        {ro}? (stale)
      </span>
    );
  }
  return (
    <span data-testid="read-only-pill" title="This server has no signer. It watches and paper trades only; nothing can be signed or sent." className="px-2 py-0.5 rounded text-[10px] font-mono font-bold whitespace-nowrap bg-emerald-950 border border-emerald-500/60 text-emerald-200">
      {ro}
    </span>
  );
};
