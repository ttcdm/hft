import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ConfluenceEngine } from '../server/signals/confluenceEngine';
import { PumpFunService } from '../server/pumpfunService';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { MINT_A, pumpCoin, jsonResponse } from './fixtures/socialFeeds';

const strong = {
  priceChange5mPct: 40, liquidityUsd: 60_000, top10HoldersPct: 10, bondingCurveProgress: 80,
  buys5m: 80, sells5m: 20, devHoldingPct: 0, hasVerifiedSocialCall: false, socialCallCount: 0,
};

describe('B3: missing metrics are null and score zero, never a default', () => {
  afterEach(() => vi.restoreAllMocks());

  it('real ConfluenceEngine: null metrics score lower than real passing metrics', () => {
    const real = ConfluenceEngine.calculate(strong);
    const missing = ConfluenceEngine.calculate({
      ...strong, priceChange5mPct: null, liquidityUsd: null, top10HoldersPct: null, buys5m: null, sells5m: null, devHoldingPct: null,
    });
    expect(missing.compositeScore).toBeLessThan(real.compositeScore);
    expect(missing.momentumScore).toBe(0);
    expect(missing.liquidityScore).toBe(0);
    expect(missing.holderDistributionScore).toBe(0); // null must not coerce to 0 and pass "<= 15"
    expect(missing.buySellImbalanceScore).toBe(0);
    expect(missing.creatorRiskScore).toBe(0);
    expect(missing.explanation).toContain('missing data');
  });

  it('NaN and undefined are also treated as missing', () => {
    const r = ConfluenceEngine.calculate({ ...strong, top10HoldersPct: NaN, buys5m: undefined as any, devHoldingPct: undefined as any });
    expect(r.holderDistributionScore).toBe(0);
    expect(r.buySellImbalanceScore).toBe(0);
    expect(r.creatorRiskScore).toBe(0);
  });

  it('a pool with unknown (-1) holder data earns no distribution or dev-risk points', () => {
    const pool: any = { contractAddress: MINT_A, priceChange5mPct: 0, liquidityUsd: 0, top10HoldersPct: -1, devHoldingPct: -1, bondingCurveProgress: 0, buys5m: 0, sells5m: 0, volume5mUsd: 0 };
    const r = memecoinAggregator.evaluateTokenConfluence(pool);
    expect(r.breakdown.holderDistributionScore).toBe(0);
    expect(r.breakdown.creatorRiskScore).toBe(0);
  });

  it('a feed coin with no DexScreener pair gets null volume/buys/sells and no invented peak, addresses or note', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const svc = new PumpFunService();
    await vi.waitFor(() => expect((svc as any).isPolling).toBe(false));
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) =>
      String(input).includes('frontend-api-v3.pump.fun')
        ? jsonResponse([pumpCoin({ bonding_curve: undefined, creator: undefined, market_cap: undefined, usd_market_cap: undefined })])
        : jsonResponse([]));
    await svc.syncRealWorldData({ evaluateTriggers: false });
    const c = svc.getHotCallouts()[0];
    expect(c.token.volume5mUsd).toBeNull();
    expect(c.token.buys5m).toBeNull();
    expect(c.token.sells5m).toBeNull();
    expect(c.token.peakMultiple).toBe(c.token.currentMultiple);
    expect(c.token.bondingCurveAddress).toBe('');
    expect(c.token.creator).toBe('');
    expect(c.token.bondingCurveProgress).toBe(0);
    expect(c.calloutNote).not.toMatch(/0\.8%|freeze revoked/);
    const conf = svc.evaluateCalloutConfluence(c);
    expect(conf.socialSignalScore).toBe(0);
    expect(conf.buySellImbalanceScore).toBe(0);
    expect(conf.compositeScore).toBeLessThan(70);
  });

  it('none of the fabricated constants remain in pumpfunService.ts', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'server/pumpfunService.ts'), 'utf8');
    for (const needle of ['64 + index', '12400', '* 1.35', 'CN35wYHm', 'AHuDJooR', 'Dev holding is 0.8%', '|| 45', '0.000085 + (index', 'hasVerifiedSocialCall: true']) {
      expect(src, needle).not.toContain(needle);
    }
  });
});
