import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installDom, removeDom, installFakeServer, renderApp, click, typeInto, flush, FakeServer } from './helpers/domApp';

/**
 * R9-10: the Plug & Play snipe sent a hard-coded confluenceScore:100, while the auto panel says the threshold applies to manual snipes
 * too. The server (batch D) now refuses a client-sent score, so the UI must not send one at all.
 */
describe('R9-10: the Plug & Play snipe sends no confluence score', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    server.routes['/api/wallet/snipe'] = () => ({ status: 400, json: { success: false, error: 'refused in test' } });
  });
  afterEach(async () => { await removeDom(); });

  it('the POST /api/wallet/snipe body has no confluenceScore', async () => {
    await renderApp();
    await click(document.getElementById('btn-nav-plug-and-play'));
    await flush();
    await typeInto(document.querySelector('input[placeholder^="Enter Pump.fun"]'), 'So11111111111111111111111111111111111111112');
    const btn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('class')?.includes('bg-amber-600') && /SNIPE/i.test(b.textContent || ''));
    expect(btn).toBeTruthy();
    await click(btn!);
    await flush();
    const snipe = server.calls.find((c) => c.url === '/api/wallet/snipe');
    expect(snipe).toBeTruthy();
    expect(snipe!.body).not.toHaveProperty('confluenceScore');
    expect(snipe!.body.mint).toBe('So11111111111111111111111111111111111111112');
  });
});
