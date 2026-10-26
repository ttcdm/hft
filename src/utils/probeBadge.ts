/** Q10a: the status pill of a connectivity probe, from what the probe returned. A probe that was not run, or failed, is never shown as OK. */
export interface ProbeResult {
  reachable?: boolean;
  status?: number | null;
  error?: string;
  health?: string | null;
}

export function probeBadge(t: ProbeResult | undefined | null, okLabel: string): { text: string; ok: boolean } {
  if (!t) return { text: 'NOT PROBED', ok: false };
  if (t.reachable) {
    const detail = t.status ? `HTTP ${t.status}` : t.health && t.health !== 'ok' ? String(t.health) : null;
    return { text: detail ? `${okLabel} • ${detail}` : okLabel, ok: true };
  }
  const why = t.error ? String(t.error).slice(0, 48) : t.status ? `HTTP ${t.status}` : 'no response';
  return { text: `UNREACHABLE • ${why}`, ok: false };
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

/** UI-1: the toast after a connectivity audit counts the services that answered, not the keys in the reply. */
export function connectivityAuditSummary(res: { connections?: Record<string, { service?: string; testResult?: ProbeResult } | undefined> } | null | undefined): {
  level: 'INFO' | 'WARNING';
  title: string;
  message: string;
} {
  const entries = Object.entries(res?.connections || {});
  const down = entries.filter(([, c]) => !c?.testResult?.reachable).map(([k, c]) => c?.service?.split(' (')[0] || k);
  const up = entries.length - down.length;
  if (entries.length === 0) return { level: 'WARNING', title: 'CONNECTIVITY AUDIT: NO RESULTS', message: 'The server returned no probe results.' };
  if (down.length === 0) return { level: 'INFO', title: 'CONNECTIVITY AUDIT COMPLETE', message: `All ${entries.length} external services answered.` };
  return {
    level: 'WARNING',
    title: 'CONNECTIVITY AUDIT COMPLETE',
    message: `${up} of ${entries.length} external services answered. Unreachable: ${down.join(', ')}.`,
  };
}
