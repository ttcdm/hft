import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installDom, removeDom, installFakeServer, renderApp, flush, FakeServer } from './helpers/domApp';

/**
 * R12-1: the header's kill-state poll had no timeout and no age check, so with /api/diagnostics/system hung the header kept showing its
 * old state for good (the switch was engaged from another tab and this one still showed the off "KILL SWITCH" after 25 s).
 */
describe('R12-1: a hung kill-state read turns the header UNKNOWN', () => {
  let server: FakeServer;
  let hang = false;
  beforeEach(() => {
    installDom();
    hang = false;
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    const answer = (globalThis as any).fetch;
    // a hung request behaves like the browser's: it never settles, unless its signal aborts it
    const f = vi.fn((input: any, init?: RequestInit) => {
      const url = String(typeof input === 'string' ? input : input.url);
      if (hang && url.includes('/api/diagnostics/system')) {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
        });
      }
      return answer(input, init);
    });
    vi.stubGlobal('fetch', f);
    (window as any).fetch = f;
  });
  afterEach(async () => { await removeDom(); });

  it('the header leaves its last known state within about 10 s of the last good read', async () => {
    await renderApp();
    const btn = () => document.getElementById('btn-emergency-kill-switch')!;
    expect(btn().textContent).not.toMatch(/UNKNOWN/);
    expect(btn().textContent).toMatch(/KILL/);
    hang = true;
    server.killSwitchActive = true; // engaged from another tab; this tab cannot read it
    await new Promise((r) => setTimeout(r, 11_000));
    await flush();
    expect(btn().textContent).toMatch(/UNKNOWN/);
  }, 20_000);
});
