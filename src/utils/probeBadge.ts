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
