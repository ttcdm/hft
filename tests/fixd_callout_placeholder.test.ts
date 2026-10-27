import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { pumpFunService } from '../server/pumpfunService';
import { executionCoordinator } from '../server/execution/coordinator';
import { solPriceService } from '../server/market/solPriceService';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { newPumpPool } from './fixtures/auto';

/**
 * A144 (round 1 #13, + R2-25, R6-13): a `pool-callout-*` placeholder (built from a hot callout when the curve cannot be read, PAPER only)
 * was not refused under noSyntheticPool, and it filled unknown holder, liquidity and authority fields with passing defaults (15% top-10,
 * 0.8% dev, $15,000 liquidity, mint and freeze "revoked", SAFE). Feed pools were labelled SAFE too. The real aggregator; the hot-callout
 * list and the curve read are the boundary.
 */
describe('A144: callout placeholder pools are refused under noSyntheticPool and carry UNKNOWN, not passing, values', () => {
  beforeEach(() => {
    solPriceService.setPrice(150, 'TEST_FIXTURE');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('PAPER');
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(null as any); // the curve cannot be read
  });
  afterEach(() => { vi.restoreAllMocks(); memecoinAggregator.setConfluenceGating(true); });

  const callout = (mint: string) => ({ id: `c-${mint.slice(0, 6)}`, token: { mint, symbol: 'CO', name: 'Callout', currentPriceUsd: 0.00005, currentMarketCapUsd: 50_000, bondingCurveProgress: 40, complete: false } });

  it('noSyntheticPool refuses a callout placeholder, and nothing reaches the coordinator', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    vi.spyOn(pumpFunService, 'getHotCallouts').mockReturnValue([callout(mint)] as any);
    const trade = vi.spyOn(executionCoordinator, 'executeTrade');
    const r = await memecoinAggregator.executeSnipe({ contractAddress: mint, amountUsd: 1, noSyntheticPool: true, signalTimestamp: Date.now() });
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/MARKET_DATA_UNAVAILABLE/);
    expect(trade).not.toHaveBeenCalled();
  });

  it('without noSyntheticPool the placeholder carries UNKNOWN fields: unknown freeze authority is refused by the freeze gate', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    vi.spyOn(pumpFunService, 'getHotCallouts').mockReturnValue([callout(mint)] as any);
    memecoinAggregator.setConfluenceGating(false);
    const trade = vi.spyOn(executionCoordinator, 'executeTrade');
    const r = await memecoinAggregator.executeSnipe({ contractAddress: mint, amountUsd: 1, signalTimestamp: Date.now() });
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/Freeze authority/);
    expect(trade).not.toHaveBeenCalled();
    const pool = memecoinAggregator.getPools().find((p) => p.contractAddress === mint)!;
    expect(pool.id.startsWith('pool-callout-')).toBe(true);
    expect(pool.top10HoldersPct).toBe(-1);
    expect(pool.devHoldingPct).toBe(-1);
    expect(pool.liquidityUsd).toBe(0);
    expect(pool.isMintRevoked).toBe(false);
    expect(pool.authoritiesVerified).toBe(false);
    expect(pool.rugcheckScore).toBe('UNKNOWN');
  });

  it('R6-13: a pool made from a feed create event is not labelled SAFE', () => {
    expect(newPumpPool('NONE').pool.rugcheckScore).toBe('UNKNOWN');
  });
});
