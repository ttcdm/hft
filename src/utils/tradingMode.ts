import { useEffect, useState } from 'react';
import { authFetch } from '../services/engineClient';
import { onAuthenticated } from './authEvents';

/** The server's own answer to "what would a click do right now" (from /api/diagnostics/system). */
export interface SystemAuditLite {
  mode?: string;
  isLiveArmed?: boolean;
  allowedCluster?: string;
  /** S185: APEX_READ_ONLY=true on the server */
  readOnly?: boolean;
  rpcEndpoint?: string;
  /** UI report fix 7: the server's kill switch */
  killSwitchActive?: boolean;
}

export interface TradingModeInfo {
  /** false until the server has answered, or when its last answer is too old to trust */
  known: boolean;
  stale: boolean;
  /** true when a click would send a real transaction */
  live: boolean;
  label: 'PAPER' | 'LIVE ARMED' | 'LIVE (NOT ARMED)' | 'MODE UNKNOWN';
  cluster: string | null;
  /** S185: the server cannot sign or send; the banner says so on every screen */
  readOnly: boolean;
  rpcHost: string | null;
  ageMs: number | null;
  /** UI report fix 7: true when the server's kill switch is on (every order is refused); null when unknown or stale */
  killSwitch: boolean | null;
  /** R12-11: why the mode is unknown although the server answered (its reply could not be read); absent otherwise */
  problem?: string;
}

/**
 * R12-11: a reply whose mode fields are there but of the wrong type (null, a number) is unreadable, never PAPER: `mode: null,
 * isLiveArmed: null` used to read as PAPER in the top bar. A field the server leaves out keeps its old meaning (not armed).
 */
function auditProblem(audit: unknown): string | null {
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) return 'the server reply is unreadable (no systemAudit object)';
  const a = audit as Record<string, unknown>;
  const bad = [
    'mode' in a && typeof a.mode !== 'string' ? 'mode' : null,
    'isLiveArmed' in a && typeof a.isLiveArmed !== 'boolean' ? 'isLiveArmed' : null,
    'killSwitchActive' in a && typeof a.killSwitchActive !== 'boolean' ? 'killSwitchActive' : null,
  ].filter((x): x is string => x !== null);
  return bad.length ? `the server reply is unreadable (${bad.join(', ')} not readable)` : null;
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
    return { known: false, stale: false, live: false, label: 'MODE UNKNOWN', cluster: null, readOnly: false, rpcHost: null, ageMs: null, killSwitch: null };
  }
  const ageMs = Math.max(0, now - fetchedAt);
  const problem = auditProblem(audit);
  if (problem) return { known: false, stale: false, live: false, label: 'MODE UNKNOWN', cluster: null, readOnly: false, rpcHost: null, ageMs, killSwitch: null, problem };
  const stale = ageMs > MODE_STALE_MS;
  const armed = audit.isLiveArmed === true;
  const mode = String(audit.mode ?? '').toUpperCase();
  const label: TradingModeInfo['label'] = stale ? 'MODE UNKNOWN' : armed ? 'LIVE ARMED' : mode === 'LIVE' ? 'LIVE (NOT ARMED)' : 'PAPER';
  const killSwitch = stale || typeof audit.killSwitchActive !== 'boolean' ? null : audit.killSwitchActive;
  return { known: !stale, stale, live: armed && !stale, label, cluster: audit.allowedCluster ?? null, readOnly: audit.readOnly === true, rpcHost: hostOf(audit.rpcEndpoint), ageMs, killSwitch };
}

// One poller shared by every component that shows the mode.
let latest: { audit: SystemAuditLite; at: number } | null = null;
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let offAuth: (() => void) | null = null;

async function poll(): Promise<void> {
  try {
    const r = await authFetch('/api/diagnostics/system');
    if (!r.ok) return;
    const j = await r.json();
    if (j && typeof j === 'object' && 'systemAudit' in j) {
      latest = { audit: j.systemAudit, at: Date.now() };
      subscribers.forEach((fn) => fn());
    }
  } catch { /* keep the last answer; it goes stale on its own */ }
}

/**
 * Subscribe to the shared poller. Every subscriber is notified on every tick, including a tick whose poll failed: that is what lets all of
 * them see the answer go stale together (S18: only the first subscriber's callback used to be called on a failed poll, so the banner said
 * MODE UNKNOWN while a modal button still said "(LIVE ARMED)").
 */
export function subscribeTradingMode(fn: () => void): () => void {
  subscribers.add(fn);
  if (!timer) {
    void poll();
    timer = setInterval(() => { void poll(); subscribers.forEach((f) => f()); }, 5000);
    offAuth = onAuthenticated(() => { void poll(); }); // UI-5: read at once after sign-in
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && timer) { clearInterval(timer); timer = null; offAuth?.(); offAuth = null; }
  };
}

export function useTradingMode(): TradingModeInfo {
  const [, bump] = useState(0);
  useEffect(() => subscribeTradingMode(() => bump((n) => n + 1)), []);
  return describeTradingMode(latest?.audit, latest?.at ?? null);
}

/** The words for a confirm dialog before a one-click trade, or null when the click is paper. */
export function liveClickWarning(m: TradingModeInfo, what: string): string | null {
  if (!m.live) return null;
  return `LIVE is armed${m.cluster ? ` on ${m.cluster}` : ''}. ${what} will send a REAL transaction from the signer wallet. Continue?`;
}

/** S185: the banner text for a read-only server ("MAINNET · READ-ONLY · PAPER"), or null. Names the cluster it really runs on. */
export function readOnlyBannerText(m: Pick<TradingModeInfo, 'readOnly' | 'cluster'>): string | null {
  if (!m.readOnly) return null;
  const c = m.cluster === 'mainnet-beta' || m.cluster === 'mainnet' ? 'MAINNET' : (m.cluster ?? 'UNKNOWN CLUSTER').toUpperCase();
  return `${c} · READ-ONLY · PAPER`;
}

/**
 * Round 1 #11: the Plug & Play mode badge, mode tile and snipe button, from the shared poller (15 s staleness) instead of the modal's own
 * last good /api/diagnostics/system answer, which never aged out and kept saying PAPER TRADING while the banner said MODE UNKNOWN.
 */
export function plugAndPlayModeView(m: TradingModeInfo): { badge: string; tone: 'unknown' | 'live' | 'paper'; mode: string; snipe: string } {
  if (!m.known) return { badge: 'MODE UNKNOWN', tone: 'unknown', mode: 'UNKNOWN', snipe: 'SNIPE (MODE UNKNOWN)' };
  if (m.live) return { badge: 'LIVE BROADCAST ACTIVE', tone: 'live', mode: 'LIVE (ARMED)', snipe: 'LIVE SNIPE' };
  return { badge: 'PAPER TRADING', tone: 'paper', mode: m.label, snipe: 'PAPER SNIPE' };
}

/**
 * UI report fix 7: why a snipe button is greyed out, or null when it may be pressed. With the kill switch on the server refuses every
 * order anyway; the button now says so instead of looking live.
 */
export function snipeBlockedReason(m: Pick<TradingModeInfo, 'killSwitch'>): string | null {
  return m.killSwitch === true ? 'KILL SWITCH ON: the server refuses every order. Reset it from the header first.' : null;
}

/**
 * R9-4: the Plug & Play "Circuit Breaker" tile read the breaker only, so it stayed green "NORMAL (ACTIVE)" under the kill switch. It
 * now leads with the kill switch, and says "unknown" when the kill-switch state is (killSwitch null: no fresh answer).
 */
export function killAndBreakerTile(killSwitch: boolean | null, breaker: 'CLOSED' | 'OPEN' | 'HALF_OPEN' | undefined, haveRisk: boolean): { text: string; tone: string } {
  if (killSwitch === true) return { text: 'KILL SWITCH ON (orders refused)', tone: 'text-rose-400' };
  if (breaker === 'OPEN') return { text: 'BREAKER TRIPPED (orders refused)', tone: 'text-rose-400' };
  if (breaker === 'HALF_OPEN') return { text: 'RECOVERING (HALF-OPEN)', tone: 'text-amber-400' };
  if (killSwitch === null) return { text: 'kill switch unknown (no fresh server answer)', tone: 'text-amber-400' };
  return haveRisk ? { text: 'kill switch off, breaker closed', tone: 'text-emerald-400' } : { text: '—', tone: 'text-slate-400' };
}
