import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { curveVelocityEvaluator } from '../server/signals/curveVelocityEvaluator';
import { creatorRiskScorer } from '../server/signals/creatorRiskScorer';
import { setConfluenceThreshold, resetConfluenceThreshold } from '../server/signals/confluenceThreshold';

const weakPool = {
  id: 'pool-s187-1', platform: 'PUMP_FUN', chain: 'SOLANA', symbol: 'WEAK', name: 'Weak Token',
  contractAddress: 'WeakMint11111111111111111111111111111111111', priceUsd: 0.00001, priceNative: 0.0000001, marketCapUsd: 10000, liquidityUsd: 2000,
  bondingCurveProgress: 10, isMigrated: false, volume5mUsd: 100, volume1hUsd: 500, volume24hUsd: 1000, priceChange5mPct: -15.0, priceChange1hPct: -25.0,
  buys5m: 2, sells5m: 20, top10HoldersPct: 65.0, devHoldingPct: 3.0, isMintRevoked: true, isFreezeRevoked: true, isLpBurned: false, rugcheckScore: 'SAFE' as const,
  createdAgo: '5m ago', trendingRank: 0,
};

beforeEach(() => { curveVelocityEvaluator.clear(); creatorRiskScorer.clearCache(); memecoinAggregator.setConfluenceGating(false); (memecoinAggregator as any).pools.unshift(weakPool); });
afterEach(() => { resetConfluenceThreshold(); (memecoinAggregator as any).pools = (memecoinAggregator as any).pools.filter((p: any) => p.id !== weakPool.id); });

describe('S187 the execution gate (manual snipes too) reads the shared threshold and names it in every rejection', () => {
  it('one point above the pool\'s score is refused with that threshold in the reason; at the score the confluence gate lets it through', async () => {
    const score = memecoinAggregator.evaluateTokenConfluence(weakPool as any).score;
    expect(score).toBeLessThan(70);
    setConfluenceThreshold(score + 1);
    const refused = await memecoinAggregator.executeSnipe({ contractAddress: weakPool.contractAddress, amountUsd: 5, enforceConfluence: true });
    expect(refused.success).toBe(false);
    expect(refused.message).toContain(`failed minimum threshold of ${score + 1}`);
    setConfluenceThreshold(score);
    const passed = await memecoinAggregator.executeSnipe({ contractAddress: weakPool.contractAddress, amountUsd: 5, enforceConfluence: true });
    expect(passed.message).not.toMatch(/Confluence score/); // other gates may still refuse; the confluence gate does not
  });
  it('an explicit per-call minimum still wins over the shared one', async () => {
    const score = memecoinAggregator.evaluateTokenConfluence(weakPool as any).score;
    setConfluenceThreshold(0);
    const r = await memecoinAggregator.executeSnipe({ contractAddress: weakPool.contractAddress, amountUsd: 5, enforceConfluence: true, minConfluenceScore: score + 5 });
    expect(r.message).toContain(`failed minimum threshold of ${score + 5}`);
  });
});
