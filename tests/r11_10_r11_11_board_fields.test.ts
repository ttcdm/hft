import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildBoard } from '../server/board';
import { setConfluenceThreshold, resetConfluenceThreshold } from '../server/signals/confluenceThreshold';
import { onChainPoolStats } from '../server/market/poolStats';
import { newPumpPool } from './fixtures/auto';
import { replay, wallet } from './fixtures/watch';
import { memecoinAggregator } from '../server/memecoinAggregator';

/**
 * R11-10 / R11-11 (server half, in board.ts): the board's released verdicts carried only the reason text, frozen with the threshold
 * at release, and their age froze at "over 121s (released)"; a launch's price and curve carried no age. Real watch window, real pool
 * stats, real confluence threshold.
 */
describe('R11-10 / R11-11: the board carries the live gate, the release age and the price age', () => {
  afterEach(() => { resetConfluenceThreshold(); vi.useRealTimers(); });

  it('a READY row has its score, the live threshold, the READY gate result and its release age', () => {
    const { mint } = newPumpPool('READY_WEAK');
    expect(setConfluenceThreshold(40).ok).toBe(true);
    const row: any = buildBoard().watching.find((w) => w.mint === mint);
    expect(row.state).toBe('READY');
    expect(row.reason).toMatch(/threshold 70/); // the reason is as it was released...
    expect(row.threshold).toBe(40); // ...the threshold the gate uses now is sent beside it
    expect(row.readyGate).toMatchObject({ pass: false });
    expect(row.readyGate.reason).toMatch(/READY_TOO_WEAK/);
    expect(typeof row.releasedAgeMs).toBe('number');
    expect(row.signalLimitMs).toBeGreaterThan(0);
  });

  it('a released launch age counts from its release, not frozen at the window length', () => {
    const { mint } = newPumpPool('HOT');
    const t0 = Date.now();
    const a = buildBoard(t0 + 5_000).launches.find((l) => l.mint === mint)!;
    const b = buildBoard(t0 + 65_000).launches.find((l) => l.mint === mint)!;
    expect(a.createdAgo).toMatch(/^released \d+s ago$/);
    expect(b.createdAgo).not.toBe(a.createdAgo);
    expect(b.createdAgo).not.toMatch(/over \d+s/);
  });

  it('a launch carries the age of the last trade its price is from; none seen is null', () => {
    const traded = newPumpPool('NONE').mint;
    const quiet = newPumpPool('NONE').mint;
    const t0 = Date.now();
    for (const { trade, at } of replay(traded, t0, [[0, wallet(), 'buy', 0.2], [3, wallet(), 'buy', 0.1]])) memecoinAggregator.applyTradeToPool(trade, at);
    const last = onChainPoolStats.lastTradeAt(traded)!;
    expect(last).toBe(t0 + 3000);
    const b = buildBoard(last + 30_000);
    expect((b.launches.find((l) => l.mint === traded) as any).priceAgeMs).toBe(30_000);
    expect((b.launches.find((l) => l.mint === quiet) as any).priceAgeMs).toBeNull();
  });
});
