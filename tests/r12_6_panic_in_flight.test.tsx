import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, FakeServer } from './helpers/domApp';

/**
 * R12-6: PANIC stayed enabled while its request was out, and a second confirmed PANIC sent during a slow first one answered
 * "Attempted: 0, Succeeded: 0", which overwrote the first one's "Attempted: 1, Succeeded: 1". PANIC is now one request at a time: the
 * button is disabled and says so while one is out, and only that request's reply is shown.
 */
describe('R12-6: PANIC has an in-flight guard', () => {
  let server: FakeServer;
  let release: (() => void) | null = null;
  beforeEach(() => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    server.routes['/api/auth/session'] = () => ({ json: { success: true } });
    server.routes['/api/workstation/positions'] = () => ({ json: { success: true, positions: [] } });
    // the first PANIC is slow: its reply waits until the test releases it
    const realFetch = (window as any).fetch;
    const slow = async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      if (/panic-liquidate/.test(url)) {
        await new Promise<void>((r) => { release = r; });
        server.calls.push({ url: '/api/wallet/panic-liquidate', method: 'POST', body: undefined });
        const n = server.calls.filter((c) => c.url === '/api/wallet/panic-liquidate').length;
        return new Response(JSON.stringify({ success: true, message: n === 1 ? 'Emergency liquidation complete. Attempted: 1, Succeeded: 1' : 'Emergency liquidation complete. Attempted: 0, Succeeded: 0' }), { status: 200 });
      }
      return realFetch(input, init);
    };
    (window as any).fetch = slow;
    (globalThis as any).fetch = slow;
  });
  afterEach(async () => { release?.(); await removeDom(); });

  it('a second press while the first is out sends nothing and the first reply stands', async () => {
    await renderApp();
    await click(document.getElementById('btn-nav-plug-and-play'));
    await flush(10);
    const panic = () => document.querySelector('[data-testid="pnp-panic"]') as HTMLButtonElement;
    await click(panic());
    await click(document.querySelector('[data-testid="confirm-ok"]'));
    await flush(3);
    expect(panic().disabled).toBe(true);
    expect(panic().textContent).toMatch(/PANIC (SENT|IN PROGRESS)/);
    const firstRelease = release!;
    release = null;
    // a second press: no dialog and no request
    await click(panic());
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(release).toBeNull();
    firstRelease();
    await flush(10);
    expect(document.body.textContent).toMatch(/Attempted: 1, Succeeded: 1/);
    expect(document.body.textContent).not.toMatch(/Attempted: 0/);
    expect(panic().disabled).toBe(false);
  });
});
