import { useEffect, useState } from 'react';
import { authFetch } from '../services/engineClient';

export interface Polled<T> { data: T | null; error: string | null; at: number | null }

const EMPTY: Polled<never> = { data: null, error: null, at: null };

/**
 * GET `path` now and every `everyMs` while `enabled`. An error keeps the last good data and says what failed; nothing is invented.
 * R13-6: when it is disabled (logged out, a 401, a closed modal) the data is dropped, so nothing read under an old session stays on screen.
 */
export function usePolled<T>(path: string, everyMs: number, enabled = true): Polled<T> {
  const [state, setState] = useState<Polled<T>>(EMPTY);
  useEffect(() => {
    if (!enabled) { setState((s) => (s.data === null && s.error === null && s.at === null ? s : EMPTY)); return; }
    let alive = true;
    const load = async () => {
      try {
        const r = await authFetch(path);
        const j = await r.json().catch(() => null);
        if (!alive) return;
        if (!r.ok) setState((s) => ({ ...s, error: `${j?.error || 'Request refused'} (HTTP ${r.status})` }));
        // R12-11: a 200 whose body is not JSON is an unreadable reply, not "no data yet" (which read as "Reading the server…" forever)
        else if (j === null) setState((s) => ({ ...s, error: `Reply unreadable (HTTP ${r.status}, not JSON)` }));
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
