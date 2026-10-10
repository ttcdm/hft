import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';

// Node has no window: give the client module the small browser surface it touches.
const store = new Map<string, string>();
const events: string[] = [];
beforeEach(() => {
  store.clear(); events.length = 0;
  (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  (globalThis as any).window = { location: { protocol: 'http:', host: '127.0.0.1:1' }, dispatchEvent: (e: any) => void events.push(e.type) };
  (globalThis as any).WebSocket = class { static OPEN = 1; readyState = 0; constructor() { /* never connects */ } close() {} };
  (globalThis as any).CustomEvent = class { type: string; constructor(t: string) { this.type = t; } };
});
afterEach(() => { vi.restoreAllMocks(); delete (globalThis as any).window; delete (globalThis as any).localStorage; });

describe('Q42: a 401 does not make every poller re-open the token prompt', () => {
  it('fires the prompt event once, answers later calls locally without the network, and recovers when a token is set', async () => {
    const mod = await import('../src/services/engineClient');
    const f = vi.fn(async () => new Response('{}', { status: 401 }));
    (globalThis as any).fetch = f;
    await mod.authFetch('/api/a');
    await mod.authFetch('/api/b');
    await mod.authFetch('/api/c');
    expect(f).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e === 'apex:auth-required')).toHaveLength(1);
    expect(mod.isAuthRequired()).toBe(true);
    const local = await mod.authFetch('/api/d');
    expect(local.status).toBe(401);
    await mod.authFetch('/api/auth/status');
    expect(f).toHaveBeenCalledTimes(2); // /api/auth still reaches the server
    mod.setOperatorSessionToken('tok');
    expect(mod.isAuthRequired()).toBe(false);
  });
});

describe('Q36: WebSocket commands carry the operator token, and a refusal reaches the operator', () => {
  it('sends sessionToken with the action, and reports a REST refusal', async () => {
    const mod = await import('../src/services/engineClient');
    mod.setOperatorSessionToken('tok');
    const sent: string[] = [];
    (mod.engineClient as any).ws = { readyState: 1, send: (m: string) => sent.push(m) };
    mod.engineClient.sendAction('START');
    expect(JSON.parse(sent[0]).sessionToken).toBe('tok');
    (mod.engineClient as any).ws = null;
    (globalThis as any).fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 403 }));
    const errs: string[] = [];
    const off = mod.engineClient.onActionError((m) => errs.push(m.error));
    mod.engineClient.sendAction('STOP');
    await new Promise((r) => setTimeout(r, 20));
    expect(errs[0]).toContain('nope');
    mod.engineClient.sendAction('SNIPE_MEMECOIN', {});
    expect(errs[1]).toContain('no REST fallback');
    off();
  });
});

