import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installDom, removeDom, installFakeServer, renderApp, FakeServer } from './helpers/domApp';
import { signedUsd } from '../src/utils/pnlPill';

/** R10-6: "today -$0.30 · open +$0.00" painted the open part red (one colour from the sum), and zero got a "+". */
describe('R10-6: each pill figure has its own colour, and zero has no sign', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    server.routes['/api/wallet/state'] = () => ({ json: { success: true, data: { totalRealizedPnLUsd: -0.3, totalUnrealizedPnLUsd: 0, activePositionsCount: 1 } } });
  });
  afterEach(async () => { await removeDom(); });

  it('realized red, open neutral "$0.00"', async () => {
    await renderApp();
    const r = document.querySelector('[data-testid="pill-realized"]')!;
    const o = document.querySelector('[data-testid="pill-open"]')!;
    expect(r.textContent).toBe('-$0.30');
    expect(r.className).toMatch(/text-rose-300/);
    expect(o.textContent).toBe('$0.00');
    expect(o.className).not.toMatch(/rose|emerald/);
    expect(document.getElementById('btn-auto-profit-ticker')!.className).not.toMatch(/rose|emerald/);
  });

  it('a value that rounds to zero cents has no sign', () => {
    expect(signedUsd(0.004)).toBe('$0.00');
    expect(signedUsd(-0.004)).toBe('$0.00');
    expect(signedUsd(0.01)).toBe('+$0.01');
  });
});
