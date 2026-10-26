/** Q10a: the status pill of a connectivity probe, from what the probe returned. A probe that was not run, or failed, is never shown as OK. */
export interface ProbeResult {
  /** 3H: the server did not run this probe (APEX_DISABLE_EXTERNAL_FEEDS=true). Neither reachable nor down. */
  skipped?: boolean;
  reachable?: boolean;
  status?: number | null;
  error?: string;
  health?: string | null;
}

export function probeBadge(t: ProbeResult | undefined | null, okLabel: string): { text: string; ok: boolean; skipped?: boolean } {
  if (!t) return { text: 'NOT PROBED', ok: false };
  if (t.skipped) return { text: 'SKIPPED • external feeds off', ok: false, skipped: true };
  if (t.reachable) {
    const detail = t.status ? `HTTP ${t.status}` : t.health && t.health !== 'ok' ? String(t.health) : null;
    return { text: detail ? `${okLabel} • ${detail}` : okLabel, ok: true };
  }
  const why = t.error ? String(t.error).slice(0, 48) : t.status ? `HTTP ${t.status}` : 'no response';
  return { text: `UNREACHABLE • ${why}`, ok: false };
}

/** 3H: the pill colours for a badge: green when it answered, grey when the probe was skipped, red when it did not answer. */
export function probeBadgeClass(b: { ok: boolean; skipped?: boolean }): string {
  if (b.ok) return 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40';
  if (b.skipped) return 'bg-slate-700/40 text-slate-300 border border-slate-600/50';
  return 'bg-rose-500/20 text-rose-300 border border-rose-500/40';
}

/** A latency the probe measured, or a dash. Never a made-up default. */
export function probeLatency(ms: number | undefined | null): string {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? `${ms}ms` : '—';
}

/** "Solana RPC (host)" -> "host" */
export function hostOfService(service: string | undefined): string {
  const m = service?.match(/\(([^)]+)\)/);
  return m ? m[1] : 'unknown';
}

/**
 * UI-1: the toast after a connectivity audit counts the services that answered, not the keys in the reply. 3H: a probe the server skipped
 * (external feeds off) is counted as skipped, not as down, and the title says how many did not answer (it used to read "COMPLETE" either way).
 */
export function connectivityAuditSummary(res: { connections?: Record<string, { service?: string; testResult?: ProbeResult } | undefined> } | null | undefined): {
  level: 'INFO' | 'WARNING';
  title: string;
  message: string;
} {
  const entries = Object.entries(res?.connections || {});
  const name = (k: string, c: { service?: string } | undefined) => c?.service?.split(' (')[0] || k;
  const skipped = entries.filter(([, c]) => c?.testResult?.skipped).map(([k, c]) => name(k, c));
  const probed = entries.filter(([, c]) => !c?.testResult?.skipped);
  const down = probed.filter(([, c]) => !c?.testResult?.reachable).map(([k, c]) => name(k, c));
  const up = probed.length - down.length;
  if (entries.length === 0) return { level: 'WARNING', title: 'CONNECTIVITY AUDIT: NO RESULTS', message: 'The server returned no probe results.' };
  const skippedNote = skipped.length ? ` Skipped (external feeds off): ${skipped.join(', ')}.` : '';
  if (down.length === 0) {
    return { level: 'INFO', title: 'CONNECTIVITY AUDIT: ALL ANSWERED', message: `All ${probed.length} external services answered.${skippedNote}` };
  }
  return {
    level: 'WARNING',
    title: `CONNECTIVITY AUDIT: ${down.length} OF ${probed.length} UNREACHABLE`,
    message: `${up} of ${probed.length} external services answered. Unreachable: ${down.join(', ')}.${skippedNote}`,
  };
}
