import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Keypair } from '@solana/web3.js';
import { workstationDb } from '../server/db/database';
import { executionCoordinator } from '../server/execution/coordinator';
import { riskEngine } from '../server/risk/riskEngine';
import { solPriceService } from '../server/market/solPriceService';
import { buildBoard } from '../server/board';
import { buildSystemChecks } from '../server/system/systemChecks';
import { WalletStrip, TokenBoardView } from '../src/components/TokenBoard';
import { PillStaleNote } from '../src/components/Header';
import { ageText, isStale } from '../src/utils/freshness';

/** R6-7 / R6-8 (haiku-attack 2026-10-26): marks, SOL/USD, the wallet balance and the header pill say how old they are. */
const wire = <T,>(o: T): T => JSON.parse(JSON.stringify(o));
afterEach(() => vi.restoreAllMocks());

describe('R6-7/R6-8: ages on the board', () => {
  it('a position whose mark is 40 s old is sent and shown as STALE with its age; the PnL column says it is before exit costs', () => {
    const now = Date.now();
    const id = 'r67-stale';
    workstationDb.savePosition({
      id, mint: Keypair.generate().publicKey.toBase58(), symbol: 'R67', name: 'r67', tokenDecimals: 6, tokenQuantityRaw: '1000000000', entryPriceSol: 1e-7, currentPriceSol: 1.4e-7,
      currentValueSol: 0.00014, costBasisLamports: 100_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE', executionMode: 'PAPER', entryTxSignature: `PAPER:${id}`,
      entryTimestamp: now - 60_000, lastMarkTimestamp: now - 40_000, recordUpdatedAt: now, updatedAt: now,
    } as any);
    try {
      const board = wire(buildBoard(now));
      const row = board.holding.find((h) => h.id === id)!;
      expect(row.markStale).toBe(true);
      const html = renderToStaticMarkup(<TokenBoardView board={board as any} tab="holding" onTab={() => {}} />);
      expect(html).toContain('40s ago (STALE)');
      expect(html).toContain('before exit costs');
    } finally {
      const p = workstationDb.loadPositions().find((x) => x.id === id)!;
      workstationDb.savePosition({ ...p, status: 'CLOSED' } as any);
    }
  });

  it('the wallet strip shows the balance read age and a stale SOL/USD reading as STALE', () => {
    vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol').mockReturnValue(1.25);
    riskEngine.recordRpcSuccess();
    solPriceService.setPrice(150, 'test', Date.now() - 300_000);
    const board = wire(buildBoard());
    expect(board.wallet.balanceAgeMs).not.toBeNull();
    expect(board.wallet.solUsdStale).toBe(true);
    const html = renderToStaticMarkup(<WalletStrip wallet={board.wallet} mode="PAPER" />);
    expect(html).toMatch(/read \ds ago/);
    expect(html).toMatch(/5m ago \(STALE\)/);
  });

  it('a failed balance read says FAILED, not an age', () => {
    vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol').mockReturnValue(null);
    vi.spyOn(riskEngine, 'getLastBalanceRead').mockReturnValue({ ok: false, at: Date.now() });
    const html = renderToStaticMarkup(<WalletStrip wallet={wire(buildBoard()).wallet} mode="PAPER" />);
    expect(html).toContain('last read FAILED');
  });
});

describe('R6-7: the header pill says stale; System checks never says "never ago"', () => {
  it('stale after a failed fetch or an old answer; nothing shown while fresh', () => {
    const now = 1_000_000;
    expect(isStale(now - 1_000, false, now, 10_000)).toBe(false);
    expect(isStale(now - 1_000, true, now, 10_000)).toBe(true);
    expect(isStale(now - 11_000, false, now, 10_000)).toBe(true);
    expect(renderToStaticMarkup(<PillStaleNote at={now - 1_000} failed={false} now={now} />)).toBe('');
    expect(renderToStaticMarkup(<PillStaleNote at={now - 30_000} failed={true} now={now} />)).toContain('STALE 30s ago');
    expect(ageText(null)).toBe('never read');
    expect(ageText(3_600_000 + 120_000)).toBe('1h 2m ago');
  });

  it('with no mark and no feed event the checks print "none yet"', () => {
    const r = buildSystemChecks();
    for (const c of r.checks) expect(c.value, c.id).not.toMatch(/never ago/);
  });
});
