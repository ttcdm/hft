import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, FakeServer } from './helpers/domApp';

/** R12-13: the alert dock had no live region, so CRITICAL alerts (kill switch, stale marks) were never announced to assistive tech. */
describe('R12-13: CRITICAL alerts are announced', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    server.routes['/api/auth/session'] = () => ({ json: { success: true } });
    server.routes['/api/system/checks'] = () => ({ json: { checks: [], operatorAlerts: [] } });
  });
  afterEach(async () => { await removeDom(); });
  const assertive = () => document.querySelector('[role="alert"][aria-live="assertive"]');

  it('an assertive live region is on the page before any alert, and announces the kill switch once it is engaged', async () => {
    await renderApp();
    expect(assertive()).not.toBeNull();
    expect(assertive()!.textContent).toBe('');
    await click(document.getElementById('btn-emergency-kill-switch'));
    await flush(5);
    expect(assertive()!.textContent).toMatch(/KILL SWITCH ENGAGED/);
    // still announced with the dock minimized
    await click(document.querySelector('[data-testid="alerts-minimize"]'));
    expect(assertive()!.textContent).toMatch(/KILL SWITCH ENGAGED/);
  });
});
