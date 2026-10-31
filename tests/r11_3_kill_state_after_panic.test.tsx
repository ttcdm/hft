import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, FakeServer } from './helpers/domApp';
import { autoSnipeController } from '../server/auto/controller';

/**
 * R11-3: after PANIC turned the kill switch on, the header and the auto panel showed it OFF for 1 to 3 s (until their next poll): the auto
 * panel said "The kill switch itself is OFF now" next to a panic reply that said "Kill switch on".
 */
describe('R11-3: PANIC and KILL replies re-read the kill state at once', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    server.routes['/api/auth/session'] = () => ({ json: { success: true } });
    // auto was killed earlier by a panic and the switch reset since: the panel rightly says the switch is OFF now
    server.routes['/api/auto/status'] = () => ({ json: { success: true, ...autoSnipeController.getStatus(), mode: 'OFF', killed: true, killReason: 'operator panic', stats: autoSnipeController.getJournalStats(), decisions: [] } });
    server.routes['/api/wallet/panic-liquidate'] = () => {
      server.killSwitchActive = true;
      return { json: { success: true, killSwitchActive: true, attempted: 0, succeeded: 0, failed: [] } };
    };
  });
  afterEach(async () => { await removeDom(); });

  it('the header says RESUME and the auto panel stops saying the switch is OFF, well before the next 5 s poll', async () => {
    await renderApp();
    await flush(10);
    expect(document.querySelector('[data-testid="auto-kill-reason"]')?.textContent).toMatch(/kill switch itself is OFF now/);
    await click(document.getElementById('btn-nav-plug-and-play'));
    await click(document.querySelector('[data-testid="pnp-panic"]'));
    const reads = server.calls.filter((c) => c.url === '/api/diagnostics/system').length;
    await click(document.querySelector('[data-testid="confirm-ok"]'));
    await flush(10);
    expect(server.killSwitchActive).toBe(true);
    expect(server.calls.filter((c) => c.url === '/api/diagnostics/system').length).toBeGreaterThan(reads);
    expect(document.getElementById('btn-emergency-kill-switch')!.textContent).toMatch(/RESUME/);
    expect(document.querySelector('[data-testid="auto-kill-reason"]')?.textContent).not.toMatch(/kill switch itself is OFF now/);
  });
});
