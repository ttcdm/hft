import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, FakeServer } from './helpers/domApp';
import { workstationDb } from '../server/db/database';
import { executionCoordinator } from '../server/execution/coordinator';
import { PaperExecutionEngine } from '../server/execution/paperEngine';

/** R10-4: the bot's own exits (TP1, a stop-out) raised no toast or alert; only the Holding count changed. */
const now = Date.now();
const id = `r104-${now}`;
const seed = () => workstationDb.savePosition({
  id, mint: Keypair.generate().publicKey.toBase58(), symbol: 'FIXD', name: id, tokenDecimals: 6, tokenQuantityRaw: '2000000000',
  entryPriceSol: 1e-6, currentPriceSol: 1e-6, currentValueSol: 0.002, unrealizedPnLSol: 0, costBasisLamports: 2_000_000, realizedPnLSol: 0, status: 'OPEN',
  venue: 'PUMP_BONDING_CURVE', executionMode: 'PAPER', entryTxSignature: `sig-${id}`, entryTimestamp: now, lastMarkTimestamp: now, recordUpdatedAt: now, updatedAt: now, jitoTipLamports: 0,
} as any);

describe('R10-4: an exit the bot makes by itself raises an alert', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    seed();
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    server.routes['/api/auth/session'] = () => ({ json: { success: true } });
    // GET /api/workstation/positions (server.ts) from the real coordinator, honouring ?status=
    server.routes['/api/workstation/positions'] = (_b, _i, url) => {
      const status = new URL(url, 'http://x').searchParams.get('status') || undefined;
      return { json: { success: true, positions: executionCoordinator.getPositions(undefined, status as any) } };
    };
  });
  afterEach(async () => {
    await removeDom();
    const p = workstationDb.loadPositions().find((x) => x.id === id); if (p) workstationDb.savePosition({ ...p, status: 'CLOSED' } as any);
  });
  const dock = () => document.getElementById('alerts-notification-panel')?.textContent ?? '';
  const showAll = async () => { const t = document.querySelector('[data-testid="alerts-toggle"]'); if (t && /Show all/.test(t.textContent || '')) await click(t); };

  it('a take-profit partial and then the close each show what was sold, why, and the PnL', async () => {
    await renderApp();
    await flush(5);
    expect(dock()).not.toMatch(/FIXD/);
    // the exit engine's paper sell, as it runs it
    expect(new PaperExecutionEngine().executePaperSell(id, 1.4e-6, 50, 'TAKE_PROFIT_1').success).toBe(true);
    await new Promise((r) => setTimeout(r, 5300));
    await flush();
    await showAll();
    expect(dock()).toMatch(/SOLD 50%: PAPER \$FIXD \(TAKE_PROFIT_1\)/);
    expect(dock()).toMatch(/Sold 1000 tokens; 1000 left\. Realized \+0\.000\d+ SOL/);
    expect(new PaperExecutionEngine().executePaperSell(id, 0.5e-6, 100, 'STOP_LOSS').success).toBe(true);
    await new Promise((r) => setTimeout(r, 5300));
    await flush();
    await showAll();
    expect(dock()).toMatch(/SOLD ALL: PAPER \$FIXD \(STOP_LOSS\)/);
    expect(dock()).toMatch(/the position is closed\. Realized -0\.000\d+ SOL/);
  }, 20000);
});

describe('R10-4: a journal sell row shows quantity, price and PnL', () => {
  it('reads them from the PAPER_SELL_FILLED payload the paper engine writes', async () => {
    const { journalEventDetail } = await import('../src/utils/exitWatch');
    seed();
    expect(new PaperExecutionEngine().executePaperSell(id, 1.4e-6, 50, 'TAKE_PROFIT_1').success).toBe(true);
    const ev = workstationDb.getEvents(20).find((e: any) => e.eventType === 'PAPER_SELL_FILLED' && e.payload?.positionId === id)!;
    expect(journalEventDetail(ev)).toMatch(/^50% · 1000 tokens · at 0\.0000013\d* SOL · PnL [+-]0\.000\d+ SOL · PARTIALLY_CLOSED$/);
    const p = workstationDb.loadPositions().find((x) => x.id === id); if (p) workstationDb.savePosition({ ...p, status: 'CLOSED' } as any);
  });
});
