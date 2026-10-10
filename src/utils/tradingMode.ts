import { useEffect, useState } from 'react';
import { authFetch } from '../services/engineClient';

/** The server's own answer to "what would a click do right now" (from /api/diagnostics/system). */
export interface SystemAuditLite {
  mode?: string;
  isLiveArmed?: boolean;
  allowedCluster?: string;
  rpcEndpoint?: string;
}

export interface TradingModeInfo {
  /** false until the server has answered, or when its last answer is too old to trust */
  known: boolean;
  stale: boolean;
  /** true when a click would send a real transaction */
  live: boolean;
  label: 'PAPER' | 'LIVE ARMED' | 'LIVE (NOT ARMED)' | 'MODE UNKNOWN';
  cluster: string | null;
  rpcHost: string | null;
  ageMs: number | null;
}

export const MODE_STALE_MS = 15_000;

const hostOf = (url?: string): string | null => {
  if (!url) return null;
  try { return new URL(url).host; } catch { return null; }
};

/**
 * Q10b / Q41: what mode the operator is in, said once and the same everywhere. Until the server answers (or after it stops answering)
 * the label is MODE UNKNOWN, never "PAPER (SAFE)": a screen that guesses PAPER while LIVE is armed is the dangerous failure.
 */
export function describeTradingMode(audit: SystemAuditLite | null | undefined, fetchedAt: number | null, now = Date.now()): TradingModeInfo {
  if (!audit || fetchedAt === null) {
    return { known: false, stale: false, live: false, label: 'MODE UNKNOWN', cluster: null, rpcHost: null, ageMs: null };
  }
  const ageMs = Math.max(0, now - fetchedAt);
  const stale = ageMs > MODE_STALE_MS;
  const armed = audit.isLiveArmed === true;
  const mode = String(audit.mode ?? '').toUpperCase();
  const label: TradingModeInfo['label'] = stale ? 'MODE UNKNOWN' : armed ? 'LIVE ARMED' : mode === 'LIVE' ? 'LIVE (NOT ARMED)' : 'PAPER';
  return { known: !stale, stale, live: armed && !stale, label, cluster: audit.allowedCluster ?? null, rpcHost: hostOf(audit.rpcEndpoint), ageMs };
}

// One poller shared by every component that shows the mode.
let latest: { audit: SystemAuditLite; at: number } | null = null;
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

async function poll(): Promise<void> {
  try {
    const r = await authFetch('/api/diagnostics/system');
    if (!r.ok) return;
    const j = await r.json();
    if (j?.systemAudit) {
      latest = { audit: j.systemAudit, at: Date.now() };
      subscribers.forEach((fn) => fn());
    }
  } catch { /* keep the last answer; it goes stale on its own */ }
}

export function useTradingMode(): TradingModeInfo {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    subscribers.add(fn);
    if (!timer) {
      void poll();
      timer = setInterval(() => { void poll(); fn(); }, 5000);
    }
    return () => {
      subscribers.delete(fn);
      if (subscribers.size === 0 && timer) { clearInterval(timer); timer = null; }
    };
  }, []);
  return describeTradingMode(latest?.audit, latest?.at ?? null);
}

/** The words for a confirm dialog before a one-click trade, or null when the click is paper. */
export function liveClickWarning(m: TradingModeInfo, what: string): string | null {
  if (!m.live) return null;
  return `LIVE is armed${m.cluster ? ` on ${m.cluster}` : ''}. ${what} will send a REAL transaction from the signer wallet. Continue?`;
}
