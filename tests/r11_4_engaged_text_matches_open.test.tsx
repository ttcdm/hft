import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installDom, removeDom, installFakeServer, renderApp, flush, FakeServer } from './helpers/domApp';

/**
 * R11-4: "KILL SWITCH ENGAGED ... Open positions are NOT sold: close them from the Plug & Play panel" was fixed text: it showed with
 * nothing open, and right after PANIC had sold everything.
 */
describe('R11-4: the ENGAGED alert says what is open', () => {
  let server: FakeServer;
  let open: any[] = [];
  beforeEach(() => {
    installDom();
    open = [];
    server = { calls: [], routes: {}, killSwitchActive: true };
    installFakeServer(server);
    server.routes['/api/auth/session'] = () => ({ json: { success: true } });
    server.routes['/api/workstation/positions'] = () => ({ json: { success: true, count: open.length, positions: open } });
  });
  afterEach(async () => { await removeDom(); });
  const dockText = () => document.getElementById('alerts-notification-panel')?.textContent ?? '';

  it('nothing open: it says so, and does not tell the operator to close positions', async () => {
    await renderApp();
    await flush(10);
    expect(dockText()).toMatch(/KILL SWITCH ENGAGED/);
    expect(dockText()).toMatch(/No position is open/);
    expect(dockText()).not.toMatch(/Open positions are NOT sold/);
  });

  it('one open: it names the count', async () => {
    open = [{ id: 'p1', mint: 'M1', symbol: 'AAA', status: 'OPEN', tokenQuantityRaw: '100' }];
    await renderApp();
    await flush(10);
    expect(dockText()).toMatch(/1 open position is NOT sold/);
  });
});
