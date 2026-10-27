import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, FakeServer } from './helpers/domApp';
import { workstationDb } from '../server/db/database';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { executionCoordinator } from '../server/execution/coordinator';

/**
 * R9-5: Close (Plug & Play), Take 50% and Dump 100% (Sniper holdings) sold on one click, and Take 50% reported "POSITION CLOSED" for a
 * partial sale. Each now asks first with what it sells, and a partial says the position is still open.
 */
const now = Date.now();
const id = `r95-${now}`;
const seed = () => workstationDb.savePosition({
  id, mint: Keypair.generate().publicKey.toBase58(), symbol: 'RNF', name: 'R9-5', tokenDecimals: 6, tokenQuantityRaw: '2000000000',
  entryPriceSol: 1e-6, currentPriceSol: 1e-6, currentValueSol: 0.002, unrealizedPnLSol: 0, costBasisLamports: 2_000_000, realizedPnLSol: 0, status: 'OPEN',
  venue: 'PUMP_BONDING_CURVE', executionMode: 'PAPER', entryTxSignature: `sig-${id}`, entryTimestamp: now, lastMarkTimestamp: now, recordUpdatedAt: now, updatedAt: now,
} as any);

describe('R9-5: one-click sells ask first; a partial is not "POSITION CLOSED"', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    seed();
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    // the bodies the real routes answer (server.ts), from the real aggregator and coordinator
    server.routes['/api/auth/session'] = () => ({ json: { success: true } });
    server.routes['/api/memecoins/positions'] = () => ({ json: { status: 'OK', positions: memecoinAggregator.getPositions() } });
    server.routes['/api/workstation/positions'] = () => ({ json: { success: true, positions: executionCoordinator.getPositions() } });
    server.routes['/api/memecoins/close'] = (b) => ({ json: { status: 'OK', result: { success: true, realizedPnl: 0, message: `Sold ${b.sellPct}% of the position` } } });
    server.routes['/api/wallet/close-position'] = () => ({ json: { success: true, data: { realizedPnLSol: 0, status: 'CLOSED' } } });
  });
  afterEach(async () => {
    await removeDom();
    const p = workstationDb.loadPositions().find((x) => x.id === id); if (p) workstationDb.savePosition({ ...p, status: 'CLOSED' } as any);
  });

  const posts = (url: string) => server.calls.filter((c) => c.url === url && c.method === 'POST');
  // R10-11: the sell confirm is the in-page dialog, not window.confirm
  const dialogText = () => document.querySelector('[role="alertdialog"] #confirm-body')?.textContent ?? '';
  const answer = (yes: boolean) => click(document.querySelector(`[data-testid="${yes ? 'confirm-ok' : 'confirm-cancel'}"]`));

  it('Sniper Take 50%: asks with the quantity; refused sends nothing; accepted says "still open"', async () => {
    await renderApp();
    await click(document.getElementById('btn-nav-telegram-tracker'));
    const tab = [...document.querySelectorAll('button')].find((b) => /Autonomous Sniper/.test(b.textContent || ''));
    await click(tab!);
    await flush(10);
    const take = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Take 50%');
    expect(take).toBeTruthy();
    expect(document.querySelector('[data-testid="holding-qty"]')?.textContent).toMatch(/2000 tokens held/);
    await click(take!);
    expect(dialogText()).toMatch(/^SELL 50% of \$RNF\? PAPER \(nothing is sent\): about 1000 of 2000 tokens held/);
    await answer(false);
    expect(posts('/api/memecoins/close')).toEqual([]);
    await click(take!);
    await answer(true);
    await flush();
    expect(posts('/api/memecoins/close').map((c) => c.body.sellPct)).toEqual([50]);
    const toggle = document.querySelector('[data-testid="alerts-toggle"]');
    if (toggle) await click(toggle);
    const dock = document.getElementById('alerts-notification-panel');
    expect(dock?.textContent).toMatch(/SOLD 50% \(position still open\)/);
    expect(dock?.textContent).not.toMatch(/POSITION CLOSED/);
  });

  it('Plug & Play Close asks first', async () => {
    await renderApp();
    await click(document.getElementById('btn-nav-plug-and-play'));
    await flush(10);
    await click([...document.querySelectorAll('button')].find((b) => /^Open Positions/.test((b.textContent || '').trim()))!);
    const close = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Close' && b.className.includes('text-rose-300'));
    expect(close).toBeTruthy();
    await click(close!);
    expect(dialogText()).toMatch(/^SELL 100% of \$RNF\? PAPER \(nothing is sent\): about 2000 of 2000 tokens held/);
    await answer(false);
    expect(posts('/api/wallet/close-position')).toEqual([]);
    await click(close!);
    await answer(true);
    expect(posts('/api/wallet/close-position')).toHaveLength(1);
  });
});
