import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installDom, removeDom, installFakeServer, renderApp, flush, FakeServer } from './helpers/domApp';
import { killSwitchStateAlert } from '../src/utils/operatorAlerts';

/**
 * R13-5 (regression from R10-1/R10-2): one failed kill-state read set the state to null, and the ENGAGED alert was drawn only for `true`,
 * so a single 504 made the CRITICAL alert vanish with nothing in its place but the small "(state UNKNOWN)" header label.
 */
describe('R13-5: the kill-switch alert survives a failed state read', () => {
  let server: FakeServer;
  let fail = false;
  beforeEach(() => {
    installDom();
    fail = false;
    server = { calls: [], routes: {}, killSwitchActive: true };
    installFakeServer(server);
    server.routes['/api/auth/session'] = () => ({ json: { success: true } });
    server.routes['/api/diagnostics/system'] = () => (fail ? { status: 504, json: { error: 'Gateway Timeout' } } : undefined);
  });
  afterEach(async () => { await removeDom(); });
  const dockText = () => document.getElementById('alerts-notification-panel')?.textContent ?? '';

  it('a 504 after the switch was seen ON keeps a CRITICAL kill-switch alert, saying the state is not confirmed', async () => {
    await renderApp();
    expect(dockText()).toMatch(/KILL SWITCH ENGAGED/);
    fail = true;
    await new Promise((r) => setTimeout(r, 5300));
    await flush();
    expect(document.getElementById('btn-emergency-kill-switch')!.textContent).toMatch(/UNKNOWN/);
    expect(dockText()).toMatch(/KILL SWITCH ENGAGED/);
    expect(dockText()).toMatch(/not confirmed|cannot be read/i);
    expect(dockText()).toMatch(/1 critical/);
  }, 15000);

  it('state never read, or last seen OFF, and now unreadable: a sticky STATE UNKNOWN alert', () => {
    const [a] = killSwitchStateAlert(null, null, { lastKnown: false, failed: true });
    expect(a.title).toMatch(/KILL SWITCH STATE UNKNOWN/);
    expect(a.sticky).toBe(true);
    expect(killSwitchStateAlert(null, null, { lastKnown: null, failed: false })).toEqual([]); // before the first answer: nothing yet
    expect(killSwitchStateAlert(false, null)).toEqual([]);
  });
});
