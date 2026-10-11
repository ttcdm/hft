import { useEffect, useState } from 'react';
import { authFetch } from '../services/engineClient';

export interface Polled<T> { data: T | null; error: string | null; at: number | null }

/** GET `path` now and every `everyMs` while `enabled`. An error keeps the last good data and says what failed; nothing is invented. */
export function usePolled<T>(path: string, everyMs: number, enabled = true): Polled<T> {
  const [state, setState] = useState<Polled<T>>({ data: null, error: null, at: null });
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = async () => {
      try {
        const r = await authFetch(path);
        const j = await r.json().catch(() => null);
        if (!alive) return;
        if (!r.ok) setState((s) => ({ ...s, error: `${j?.error || 'Request refused'} (HTTP ${r.status})` }));
        else setState({ data: j as T, error: null, at: Date.now() });
      } catch (e: any) {
        if (alive) setState((s) => ({ ...s, error: `Could not reach the server (${e?.message || 'network error'})` }));
      }
    };
    load();
    const t = setInterval(load, everyMs);
    return () => { alive = false; clearInterval(t); };
  }, [path, everyMs, enabled]);
  return state;
}
