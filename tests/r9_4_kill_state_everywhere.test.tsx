import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, FakeServer } from './helpers/domApp';
import { riskEngine } from '../server/risk/riskEngine';
import { buildSystemChecks } from '../server/system/systemChecks';

/**
 * R9-4: with the kill switch on, Plug & Play showed a green "CIRCUIT BREAKER NORMAL (ACTIVE)" tile and an enabled ARM LIVE TRADING, and
 * System checks showed "Wallet audit / halt: OK, no halt" right above the red kill-switch row.
 */
describe('R9-4: the kill switch shows on Plug & Play and in System checks', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: true };
    installFakeServer(server);
    server.routes['/api/auth/session'] = () => ({ json: { success: true } });
    server.routes['/api/diagnostics/system'] = () => ({
      json: { success: true, systemAudit: { killSwitchActive: true, executionMode: 'PAPER', isLiveArmed: false, cluster: 'devnet' }, riskControls: { circuitBreakerTripped: false, circuitBreakerState: 'CLOSED' } },
    });
  });
  afterEach(async () => { await removeDom(); riskEngine.setKillSwitch(false, 'test reset'); });

  it('Plug & Play: the tile says KILL SWITCH ON and ARM LIVE TRADING is disabled', async () => {
    await renderApp();
    await click(document.getElementById('btn-nav-plug-and-play'));
    await flush(10);
    const tile = document.querySelector('[data-testid="pnp-breaker-tile"]');
    expect(tile?.textContent).toMatch(/KILL SWITCH ON/);
    expect(tile?.textContent).not.toMatch(/NORMAL/);
    expect((document.querySelector('[data-testid="pnp-arm-live"]') as HTMLButtonElement | null)?.disabled).toBe(true);
  });

  it('System checks: the halt row is not a plain OK while the kill switch is on', () => {
    riskEngine.setKillSwitch(true, 'test');
    const halt = buildSystemChecks().checks.find((c) => c.id === 'halt')!;
    expect(halt.status).not.toBe('OK');
    expect(halt.value).toMatch(/KILL SWITCH is ON/);
  });
});
