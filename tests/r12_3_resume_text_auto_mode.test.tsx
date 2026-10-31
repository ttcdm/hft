import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, FakeServer } from './helpers/domApp';
import { autoSnipeController } from '../server/auto/controller';

/**
 * R12-3 (client half): the RESUME confirm and its reply said "Auto stays OFF" whatever auto's mode was. Auto can be set to SHADOW or PAPER
 * while the kill switch is on, and then resumes buying as soon as the switch is off.
 */
describe('R12-3: RESUME says what auto will do', () => {
  let server: FakeServer;
  let mode = 'PAPER';
  beforeEach(() => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: true };
    installFakeServer(server);
    server.routes['/api/auth/session'] = () => ({ json: { success: true } });
    server.routes['/api/auto/status'] = () => ({ json: { success: true, ...autoSnipeController.getStatus(), mode, stats: autoSnipeController.getJournalStats(), decisions: [] } });
  });
  afterEach(async () => { await removeDom(); });
  const dialogText = () => document.querySelector('[role="alertdialog"]')?.textContent ?? '';
  const dockText = () => document.getElementById('alerts-notification-panel')?.textContent ?? '';

  const resume = async () => {
    await renderApp();
    await flush(10);
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => t0 + 3000); // past the double-press guard
    await click(document.getElementById('btn-emergency-kill-switch'));
    await flush();
  };

  it('auto in PAPER: the confirm and the reply say PAPER buys start again, not "Auto stays OFF"', async () => {
    mode = 'PAPER';
    await resume();
    expect(dialogText()).toMatch(/RESUME TRADING\?/);
    expect(dialogText()).toMatch(/Auto is in PAPER/);
    expect(dialogText()).not.toMatch(/Auto stays OFF/);
    await click(document.querySelector('[data-testid="confirm-ok"]'));
    await flush(10);
    expect(server.killSwitchActive).toBe(false);
    const all = document.querySelector('[data-testid="alerts-toggle"]');
    if (all && /Show all/.test(all.textContent || '')) await click(all);
    expect(dockText()).toMatch(/KILL SWITCH RESET/);
    expect(dockText()).toMatch(/Auto is in PAPER/);
  });

  it('auto OFF: it still says auto stays OFF', async () => {
    mode = 'OFF';
    await resume();
    expect(dialogText()).toMatch(/Auto stays OFF/);
  });
});
