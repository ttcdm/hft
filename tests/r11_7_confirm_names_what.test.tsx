import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, FakeServer } from './helpers/domApp';
import { autoSnipeController } from '../server/auto/controller';

/**
 * R11-7: the PANIC and KILL AUTO confirms named no count, token or mode, while the per-position sell confirms did. PANIC now lists the
 * open positions this screen read (count, token, each one's mode) and the trading mode; KILL AUTO names the auto mode and how many open
 * positions the auto journal counts, and says hand-opened positions are not sold.
 */
const now = Date.now();
const row = (symbol: string, mode: string, status = 'OPEN') => ({
  id: `r117-${symbol}`, mint: Keypair.generate().publicKey.toBase58(), symbol, tokenDecimals: 6, tokenQuantityRaw: '1000000', costBasisLamports: 1_000_000,
  currentValueSol: 0.001, status, executionMode: mode, entryTimestamp: now, lastMarkTimestamp: now,
});
const dialogBody = () => document.querySelector('[role="alertdialog"] #confirm-body')?.textContent ?? '';

describe('R11-7: PANIC and KILL AUTO confirms name what they sell', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    server.routes['/api/auth/session'] = () => ({ json: { success: true } });
    server.routes['/api/workstation/positions'] = () => ({ json: { success: true, positions: [row('AAA', 'PAPER'), row('BBB', 'LIVE', 'PARTIALLY_CLOSED'), row('OLD', 'PAPER', 'CLOSED')] } });
    server.routes['/api/auto/status'] = () => ({ json: { success: true, ...autoSnipeController.getStatus(), mode: 'PAPER', stats: { ...autoSnipeController.getJournalStats(), open: 2, mode: 'PAPER' }, decisions: [] } });
  });
  afterEach(async () => { await removeDom(); });

  it('PANIC names the count, each token and its mode', async () => {
    await renderApp();
    await click(document.getElementById('btn-nav-plug-and-play'));
    await flush(10);
    await click(document.querySelector('[data-testid="pnp-panic"]'));
    const body = dialogBody();
    expect(body).toMatch(/Sells 2 open positions: \$AAA \(PAPER\), \$BBB \(LIVE\)/);
    expect(body).not.toMatch(/OLD/);
    expect(body).toMatch(/Trading mode: /);
    await click(document.querySelector('[data-testid="confirm-cancel"]'));
  });

  it('PANIC with the list unreadable says it cannot count', async () => {
    server.routes['/api/workstation/positions'] = () => ({ status: 500, json: { error: 'boom' } });
    await renderApp();
    await click(document.getElementById('btn-nav-plug-and-play'));
    await flush(10);
    await click(document.querySelector('[data-testid="pnp-panic"]'));
    expect(dialogBody()).toMatch(/could not be read/);
    await click(document.querySelector('[data-testid="confirm-cancel"]'));
  });

});
