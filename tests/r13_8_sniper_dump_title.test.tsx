import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, FakeServer } from './helpers/domApp';
import { workstationDb } from '../server/db/database';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { executionCoordinator } from '../server/execution/coordinator';
import { closeOutcomeTitle } from '../src/utils/closeOutcome';

/**
 * R13-8: the Sniper "Dump 100%" titled every result "CLOSE DONE" (INFO), also when the close only adopted an earlier partial sell with
 * tokens left, or found the wallet empty and sold nothing. The title now comes from the R6-9 outcome, as the Plug & Play text does.
 * The /api/memecoins/close body is the real aggregator's reply over a stubbed coordinator close.
 */
const now = Date.now();
const id = `r138-${now}`;

describe('R13-8: Dump 100% titles its result from what the close did', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    workstationDb.savePosition({
      id, mint: Keypair.generate().publicKey.toBase58(), symbol: 'DMP', name: 'R13-8', tokenDecimals: 6, tokenQuantityRaw: '2000000000',
      entryPriceSol: 1e-6, currentPriceSol: 1e-6, currentValueSol: 0.002, unrealizedPnLSol: 0, costBasisLamports: 2_000_000, realizedPnLSol: 0, status: 'OPEN',
      venue: 'PUMP_BONDING_CURVE', executionMode: 'PAPER', entryTxSignature: `sig-${id}`, entryTimestamp: now, lastMarkTimestamp: now, recordUpdatedAt: now, updatedAt: now,
    } as any);
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    server.routes['/api/auth/session'] = () => ({ json: { success: true } });
    server.routes['/api/memecoins/positions'] = () => ({ json: { status: 'OK', positions: memecoinAggregator.getPositions() } });
    server.routes['/api/workstation/positions'] = () => ({ json: { success: true, positions: executionCoordinator.getPositions() } });
  });
  afterEach(async () => {
    await removeDom();
    const p = workstationDb.loadPositions().find((x) => x.id === id); if (p) workstationDb.savePosition({ ...p, status: 'CLOSED' } as any);
  });

  const dumpWith = async (coordinatorReply: any): Promise<string> => {
    const { vi } = await import('vitest');
    vi.spyOn(executionCoordinator, 'closePosition').mockResolvedValue(coordinatorReply);
    let body: any = null;
    server.routes['/api/memecoins/close'] = () => ({ json: body });
    const real = memecoinAggregator.closePosition.bind(memecoinAggregator);
    body = { status: 'OK', result: await real(id, 100) };
    await renderApp();
    await click(document.getElementById('btn-nav-telegram-tracker'));
    await click([...document.querySelectorAll('button')].find((b) => /Autonomous Sniper/.test(b.textContent || ''))!);
    await flush(10);
    await click([...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Dump 100%')!);
    await click(document.querySelector('[data-testid="confirm-ok"]'));
    await flush();
    const toggle = document.querySelector('[data-testid="alerts-toggle"]');
    if (toggle) await click(toggle);
    return document.getElementById('alerts-notification-panel')?.textContent ?? '';
  };

  it('an assumed loss on an empty wallet is not CLOSE DONE', async () => {
    const dock = await dumpWith({ success: true, pnlSol: -0.002, status: 'CLOSED', solMoved: 0, outcome: 'ASSUMED_LOSS_EMPTY_WALLET' });
    expect(dock).toMatch(/NOTHING SOLD/);
    expect(dock).not.toMatch(/CLOSE DONE/);
  });

  it('an adopted partial with tokens left says the position is still open', async () => {
    const dock = await dumpWith({ success: true, pnlSol: 0.0001, status: 'PARTIALLY_CLOSED', solMoved: 0, outcome: 'ADOPTED_EARLIER_SELL', remainingTokensRaw: '1000' });
    expect(dock).toMatch(/still open/);
    expect(dock).not.toMatch(/CLOSE DONE/);
  });

  it('the title rules, for every outcome', () => {
    expect(closeOutcomeTitle({ success: true, status: 'CLOSED' }, 100)).toEqual({ title: 'CLOSE DONE', severity: 'INFO' });
    expect(closeOutcomeTitle({ success: true, status: 'PARTIALLY_CLOSED' }, 50).title).toBe('SOLD 50% (position still open)');
    expect(closeOutcomeTitle({ success: true, status: 'PARTIALLY_CLOSED' }, 100).title).toMatch(/still open/);
    expect(closeOutcomeTitle({ success: true, status: 'CLOSED', outcome: 'ADOPTED_EARLIER_SELL' }, 100)).toEqual({ title: 'NO NEW SELL: earlier sell adopted', severity: 'WARNING' });
    expect(closeOutcomeTitle({ success: true, status: 'CLOSED', outcome: 'ADOPTED_EARLIER_SELL_FILL_UNREAD' }, 100).severity).toBe('WARNING');
  });
});
