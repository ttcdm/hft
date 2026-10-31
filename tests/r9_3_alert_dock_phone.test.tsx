import './helpers/domGlobals';
import { describe, it, expect, afterEach } from 'vitest';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, FakeServer } from './helpers/domApp';
import { autoSnipeController } from '../server/auto/controller';

/**
 * R9-3 at phone width (round 11): at 390x700 the sticky alert dock still covered KILL AUTO once it was scrolled into the dock's band: one
 * CRITICAL card plus the bar take a large share of a phone screen. happy-dom does no layout, so the test checks what sets the band: at
 * phone width the dock opens as its one-line bar (which names the most severe alert), and the cards show only when asked for.
 */
describe('R9-3 (390 px): the alert dock opens as a one-line bar on a phone', () => {
  let server: FakeServer;
  const setup = (width: number) => {
    installDom(width);
    server = { calls: [], routes: {}, killSwitchActive: true };
    installFakeServer(server);
    server.routes['/api/auth/session'] = () => ({ json: { success: true } });
    server.routes['/api/system/checks'] = () => ({ json: { checks: [], operatorAlerts: [] } });
    server.routes['/api/auto/status'] = () => ({ json: { success: true, ...autoSnipeController.getStatus(), stats: autoSnipeController.getJournalStats(), decisions: [] } });
  };
  afterEach(async () => { await removeDom(); });

  it('390 px: only the bar, naming the CRITICAL; "Show" opens the card', async () => {
    setup(390);
    await renderApp();
    await flush(5);
    const dock = document.getElementById('alerts-notification-panel')!;
    expect(dock).not.toBeNull();
    expect(document.querySelector('[data-testid="alert-sticky"]')).toBeNull();
    expect(document.querySelector('[data-testid="alerts-top-title"]')?.textContent).toMatch(/KILL SWITCH ENGAGED/);
    expect(document.querySelector('[data-testid="auto-kill"]')).not.toBeNull();
    await click(document.querySelector('[data-testid="alerts-minimize"]'));
    expect(document.querySelector('[data-testid="alert-sticky"]')).not.toBeNull();
  });

  it('1440 px: the card shows at once, as before', async () => {
    setup(1440);
    await renderApp();
    await flush(5);
    expect(document.querySelector('[data-testid="alert-sticky"]')).not.toBeNull();
  });
});
