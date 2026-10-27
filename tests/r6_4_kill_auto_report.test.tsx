import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Keypair } from '@solana/web3.js';
import { workstationDb } from '../server/db/database';
import { executionCoordinator } from '../server/execution/coordinator';
import { autoSnipeController } from '../server/auto/controller';
import { killReportFor, AutoPanelView, type AutoStatusData } from '../src/components/AutoPanel';

/** R6-4 (haiku-attack 2026-10-26): KILL AUTO "sell what it bought" answered success:true and the panel showed nothing when sells failed. */
const now = Date.now();
const seedAutoBought = (id: string) => {
  const mint = Keypair.generate().publicKey.toBase58();
  workstationDb.savePosition({
    id, mint, symbol: id.slice(0, 6).toUpperCase(), name: id, tokenDecimals: 6, tokenQuantityRaw: '1000000000', entryPriceSol: 1e-7, currentPriceSol: 1e-7, currentValueSol: 0.0001,
    costBasisLamports: 100_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE', executionMode: 'PAPER', entryTxSignature: `PAPER:${id}`,
    entryTimestamp: now, lastMarkTimestamp: now, recordUpdatedAt: now, updatedAt: now,
  } as any);
  workstationDb.logDecision({ autoMode: 'PAPER', mint, symbol: id, stage: 'buy', outcome: 'BOUGHT', reason: 'r6-4 test', positionId: id });
};
afterEach(() => vi.restoreAllMocks());

describe('R6-4: a kill that leaves positions open says so', () => {
  it('kill returns attempted and every refused or thrown close; one throw does not stop the other sells', async () => {
    seedAutoBought('r64ok'); seedAutoBought('r64refused'); seedAutoBought('r64throws');
    vi.spyOn(executionCoordinator, 'closePosition').mockImplementation((async (id: string) => {
      if (id === 'r64refused') return { success: false, pnlSol: 0, error: 'RPC down' };
      if (id === 'r64throws') throw new Error('boom');
      return { success: true, pnlSol: 0 };
    }) as any);
    const r = await autoSnipeController.kill({ exitAll: true, reason: 'r6-4' });
    const mine = r.failed.filter((f) => f.positionId.startsWith('r64'));
    expect(r.mode).toBe('OFF');
    expect(r.attempted).toBeGreaterThanOrEqual(3);
    expect(mine.map((f) => [f.positionId, f.error]).sort()).toEqual([['r64refused', 'RPC down'], ['r64throws', 'boom']]);
    expect(r.closed).toBeGreaterThanOrEqual(1);
  });

  it('the panel names what was not sold, and a clean kill reads as done', () => {
    const bad = killReportFor({ success: false, partial: true, attempted: 3, closed: 1, failed: [{ symbol: 'AAA', error: 'RPC down' }, { symbol: 'BBB', error: 'boom' }] })!;
    expect(bad.ok).toBe(false);
    expect(bad.text).toMatch(/only 1 of 3 position\(s\) were sold; 2 refused or failed and are STILL OPEN: AAA \(RPC down\); BBB \(boom\)/);
    expect(killReportFor({ success: true, attempted: 2, closed: 2, failed: [] })).toEqual({ ok: true, text: 'Auto is OFF. Sold 2 of 2 position(s) it bought.' });
    expect(killReportFor({ success: true, attempted: 0, closed: 0, failed: [] })!.ok).toBe(true);
    // a reply from a server that does not count attempts is not read as a success
    expect(killReportFor({ success: true, closed: 0 })).toBeNull();
    const status = { mode: 'OFF', killed: true, killReason: 'x', downgradeReason: null, haltReason: null, triggers: [], slippageBreaches: 0, session: null,
      budgets: { maxBuys: 5, maxSpendSol: 0.02, maxLossFraction: 0.15, maxDurationMs: 1 }, stats: { seen: 0, rejectedByStage: {}, wouldBuy: 0, bought: 0, open: 0, closed: 0, netPnlSol: 0, feesPaidSol: 0, winRate: null } } as AutoStatusData;
    expect(renderToStaticMarkup(<AutoPanelView status={status} killReport={bad} />)).toContain('STILL OPEN');
  });
});

describe('R6-4: the KILL AUTO report reads the { closed, refused, failed, stillOpen } shape too', () => {
  it('a refused sell, a failed sell or a position still open is not success', () => {
    const r = killReportFor({ success: true, mode: 'OFF', closed: 1, refused: [{ positionId: 'p1', mint: 'AAAAAAAAAAAA', error: 'CLUSTER_GUARD' }], failed: [], stillOpen: 1 })!;
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/1 refused or failed and are STILL OPEN: AAAAAA\.\.\. \(CLUSTER_GUARD\)\. 1 auto position\(s\) are still open/);
    const open = killReportFor({ success: true, mode: 'OFF', closed: 0, refused: [], failed: [], stillOpen: 2 })!;
    expect(open.ok).toBe(false);
    expect(open.text).toMatch(/2 auto position\(s\) are still open/);
    expect(killReportFor({ success: true, mode: 'OFF', closed: 2, refused: [], failed: [], stillOpen: 0 })).toEqual({ ok: true, text: 'Auto is OFF. Sold 2 position(s) it bought; none is still open.' });
    expect(killReportFor({ success: true, mode: 'OFF', closed: 0, refused: [], failed: [], stillOpen: 0 })!.text).toBe('Auto is OFF. It had no open position to sell.');
  });
});
