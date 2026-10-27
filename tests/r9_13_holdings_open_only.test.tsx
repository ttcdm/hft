import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, FakeServer } from './helpers/domApp';
import { workstationDb } from '../server/db/database';
import { memecoinAggregator } from '../server/memecoinAggregator';

/** R9-13: the Sniper holdings card listed CLOSED positions as "N Open", with live Take/Dump buttons, next to "0 Active". */
const now = Date.now();
const ids = [`r913-open-${now}`, `r913-closed-${now}`];
const seed = (id: string, status: 'OPEN' | 'CLOSED') => workstationDb.savePosition({
  id, mint: Keypair.generate().publicKey.toBase58(), symbol: status === 'OPEN' ? 'OPN' : 'CLS', name: id, tokenDecimals: 6, tokenQuantityRaw: status === 'OPEN' ? '1000000000' : '0',
  entryPriceSol: 1e-6, currentPriceSol: 1e-6, currentValueSol: 0.001, unrealizedPnLSol: 0, costBasisLamports: status === 'OPEN' ? 1_000_000 : 0, realizedPnLSol: 0, status,
  venue: 'PUMP_BONDING_CURVE', executionMode: 'PAPER', entryTxSignature: `sig-${id}`, entryTimestamp: now, lastMarkTimestamp: now, recordUpdatedAt: now, updatedAt: now,
} as any);

describe('R9-13: the holdings card lists open positions only', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    seed(ids[0], 'OPEN');
    seed(ids[1], 'CLOSED');
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    server.routes['/api/auth/session'] = () => ({ json: { success: true } });
    server.routes['/api/memecoins/positions'] = () => ({ json: { status: 'OK', positions: memecoinAggregator.getPositions() } });
  });
  afterEach(async () => {
    await removeDom();
    const p = workstationDb.loadPositions().find((x) => x.id === ids[0]); if (p) workstationDb.savePosition({ ...p, status: 'CLOSED' } as any);
  });

  it('a closed row is not counted as open and has no sell buttons', async () => {
    expect(memecoinAggregator.getPositions().some((p) => p.id === ids[1] && p.status === 'CLOSED')).toBe(true); // the feed does send it
    await renderApp();
    await click(document.getElementById('btn-nav-telegram-tracker'));
    await click([...document.querySelectorAll('button')].find((b) => /Autonomous Sniper/.test(b.textContent || ''))!);
    await flush(10);
    const open = memecoinAggregator.getPositions().filter((p) => p.status === 'OPEN').length;
    expect(document.body.textContent).toContain(`${open} Open`);
    const rows = [...document.querySelectorAll('tr')].filter((r) => /Take 50%/.test(r.textContent || ''));
    expect(rows.length).toBe(open);
    expect(rows.some((r) => /CLS/.test(r.textContent || ''))).toBe(false);
    expect(rows.some((r) => /OPN/.test(r.textContent || ''))).toBe(true);
  });
});
