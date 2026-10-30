import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, FakeServer } from './helpers/domApp';

/**
 * R12-2: when the KILL SWITCH POST timed out after the server had engaged the switch, a CRITICAL "Assume trading is NOT halted; retry"
 * alert stayed for good, though the next poll showed RESUME: an operator who "retried" pressed RESUME. The button also showed no pending
 * state while its request was out.
 */
describe('R12-2: a lost kill-switch reply is settled by the next good read', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    server.routes['/api/auth/session'] = () => ({ json: { success: true } });
  });
  afterEach(async () => { await removeDom(); });
  const dockText = () => document.getElementById('alerts-notification-panel')?.textContent ?? '';
  const btn = () => document.getElementById('btn-emergency-kill-switch')!;

  it('engaged on the server, reply lost: the NOT CONFIRMED alert leaves once the state is read, and the header says RESUME', async () => {
    server.routes['/api/execution/kill-switch'] = (body) => {
      server.killSwitchActive = body?.activate === true; // the server applied it ...
      throw new TypeError('NetworkError when attempting to fetch resource.'); // ... and the reply was lost
    };
    await renderApp();
    await click(btn());
    await flush(10);
    expect(server.killSwitchActive).toBe(true);
    await new Promise((r) => setTimeout(r, 5300)); // at the latest, the next poll
    await flush();
    expect(btn().textContent).toMatch(/RESUME/);
    const all = document.querySelector('[data-testid="alerts-toggle"]');
    if (all && /Show all/.test(all.textContent || '')) await click(all);
    expect(dockText()).not.toMatch(/NOT CONFIRMED/);
    expect(dockText()).not.toMatch(/Assume trading is NOT halted/);
    expect(dockText()).toMatch(/KILL SWITCH ENGAGED/);
  }, 15000);

  it('the button shows a pending state while its request is out', async () => {
    let release: (() => void) | null = null;
    const answer = (globalThis as any).fetch;
    const f = vi.fn((input: any, init?: RequestInit) => {
      if (String(input).includes('/api/execution/kill-switch')) return new Promise<Response>((res) => { release = () => res(answer(input, init)); });
      return answer(input, init);
    });
    vi.stubGlobal('fetch', f);
    (window as any).fetch = f;
    await renderApp();
    await click(btn());
    expect(btn().getAttribute('aria-busy')).toBe('true');
    expect(btn().textContent).toMatch(/sending/i);
    release!();
    await flush(10);
    expect(btn().getAttribute('aria-busy')).not.toBe('true');
    expect(btn().textContent).toMatch(/RESUME/);
  });
});
