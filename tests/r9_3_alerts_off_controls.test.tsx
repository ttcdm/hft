import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, FakeServer } from './helpers/domApp';
import { autoSnipeController } from '../server/auto/controller';

/**
 * R9-3: the alert stack was `position: fixed` in the bottom-right corner, over KILL AUTO, and a CRITICAL (the kill-switch toast, or a
 * server alert that cannot be dismissed) never left. happy-dom does no layout, so the test checks what decides overlap: the stack is in
 * the page flow, after the panels (so the end of the page is never under it), and it can be minimized whatever it holds.
 */
describe('R9-3: alerts never hold the emergency controls under them', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    server.routes['/api/auto/status'] = () => ({ json: { success: true, ...autoSnipeController.getStatus(), stats: autoSnipeController.getJournalStats(), decisions: [] } });
    server.routes['/api/auth/session'] = () => ({ json: { success: true } });
    server.routes['/api/system/checks'] = () => ({ json: { checks: [], operatorAlerts: [{ code: 'EXIT_FAILING', message: 'exit failing', raisedAt: Date.now(), lastSeenAt: Date.now(), level: 'CRITICAL' }] } });
  });
  afterEach(async () => { await removeDom(); });

  it('a sticky server CRITICAL and the kill-switch toast: the stack is not fixed, comes after KILL AUTO, and minimizes', async () => {
    await renderApp();
    await click(document.getElementById('btn-emergency-kill-switch'));
    await flush(10);
    const dock = document.getElementById('alerts-notification-panel');
    expect(dock).not.toBeNull();
    expect(dock!.className).not.toMatch(/\bfixed\b/);
    expect(dock!.className).toMatch(/\bsticky\b/);
    const kill = document.querySelector('[data-testid="auto-kill"]');
    expect(kill).not.toBeNull();
    // the dock follows the panels in document order, so at the end of the page it sits below them, not on them
    expect(kill!.compareDocumentPosition(dock!) & 4 /* DOCUMENT_POSITION_FOLLOWING */).toBeTruthy();
    expect(dock!.textContent).toMatch(/KILL SWITCH ENGAGED|EXIT_FAILING|exit failing/i);
    await click(document.querySelector('[data-testid="alerts-minimize"]'));
    expect(document.querySelector('[data-testid="alert-sticky"]')).toBeNull();
    expect(dock!.textContent).not.toMatch(/exit failing/);
    expect(dock!.textContent).toMatch(/Active Risk Alerts \(2, 2 critical\)/);
  });
});
