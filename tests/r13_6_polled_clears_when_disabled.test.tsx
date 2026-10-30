import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installDom, removeDom, installFakeServer, renderApp, flush, FakeServer } from './helpers/domApp';

/**
 * R13-6: usePolled returned early when disabled and never cleared its data, so a CRITICAL server alert stayed frozen in the dock after
 * the operator session ended (logout or a 401), with no age marker and no way to acknowledge it.
 */
describe('R13-6: server alerts leave the dock when the operator session ends', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    server.routes['/api/auth/session'] = () => ({ json: { success: true } });
    server.routes['/api/system/checks'] = () => ({
      json: { checkedAt: Date.now(), cluster: 'devnet', mode: 'PAPER', checks: [], operatorAlerts: [{ code: 'EXIT_FAILING', message: 'exit failed 3 times', positionId: 'p1', raisedAt: 1, lastSeenAt: 1, level: 'CRITICAL', acknowledgeable: false }] },
    });
  });
  afterEach(async () => { await removeDom(); });
  const dockText = () => document.getElementById('alerts-notification-panel')?.textContent ?? '';

  it('a 401 (token refused) clears the alerts read under the old session', async () => {
    await renderApp();
    await flush();
    expect(dockText()).toMatch(/EXIT_FAILING/);
    server.deny = (p) => p === '/api/system/checks';
    await new Promise((r) => setTimeout(r, 5300));
    await flush();
    expect(dockText()).not.toMatch(/EXIT_FAILING/);
  }, 15000);
});
