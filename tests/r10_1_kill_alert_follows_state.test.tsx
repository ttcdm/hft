import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, FakeServer } from './helpers/domApp';

/**
 * R10-1: the CRITICAL "KILL SWITCH ENGAGED" alert never expired and the reset never removed it, so once the 8 s "KILL SWITCH RESET"
 * expired it was the top alert again while the switch was off; in another tab it stayed for good.
 */
describe('R10-1: the kill-switch alert follows the server state', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    server.routes['/api/auth/session'] = () => ({ json: { success: true } });
  });
  afterEach(async () => { await removeDom(); });
  const dockText = () => document.getElementById('alerts-notification-panel')?.textContent ?? '';
  const showAll = async () => { const t = document.querySelector('[data-testid="alerts-toggle"]'); if (t && /Show all/.test(t.textContent || '')) await click(t); };

  it('RESUME in this tab removes ENGAGED, also after the RESET notice expires', async () => {
    await renderApp();
    await click(document.getElementById('btn-emergency-kill-switch'));
    expect(dockText()).toMatch(/KILL SWITCH ENGAGED/);
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => t0 + 3000);
    await click(document.getElementById('btn-emergency-kill-switch')); // RESUME, past the double-press guard
    await click(document.querySelector('[data-testid="confirm-ok"]')); // R10-11: the in-page confirm
    expect(server.killSwitchActive).toBe(false);
    await showAll();
    expect(dockText()).not.toMatch(/KILL SWITCH ENGAGED/);
    (Date.now as any).mockImplementation(() => t0 + 30_000); // the INFO reset notice expires
    await new Promise((r) => setTimeout(r, 1100));
    await flush();
    expect(dockText()).not.toMatch(/KILL SWITCH ENGAGED/);
  });

  it('a reset in another tab (seen by the poll) removes ENGAGED here', async () => {
    server.killSwitchActive = true;
    await renderApp();
    await flush();
    expect(dockText()).toMatch(/KILL SWITCH ENGAGED/);
    server.killSwitchActive = false; // another tab pressed RESUME
    await new Promise((r) => setTimeout(r, 5300));
    await flush();
    expect(dockText()).not.toMatch(/KILL SWITCH ENGAGED/);
  }, 15000);
});
