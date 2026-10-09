import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { pumpFunService, calloutProvenance } from '../server/pumpfunService';
import { executionCoordinator } from '../server/execution/coordinator';
import { PumpFunCaller, PumpFunHotCallout } from '../src/types';

function makeCaller(overrides: Partial<PumpFunCaller>): PumpFunCaller {
  return {
    userId: 'real_feed_caller',
    userUuid: 'u-1',
    primaryWallet: '',
    totalCallouts: 50,
    avgMultiple: 5,
    medianMultiple: 2,
    winRate1_2x: 80,
    winRate1_5x: 60,
    winRate2x: 45,
    avgTimeToPeakMs: 300_000,
    followersCount: 1000,
    totalVolumeDrivenUsd: 1_000_000,
    reputationTier: 'HIGH_MOMENTUM',
    topCallouts: [],
    isAutoSnipeSubscribed: false,
    ...overrides,
  };
}

function makeCallout(caller: PumpFunCaller, mint: string, confluenceCount = 1): PumpFunHotCallout {
  return {
    id: `callout-${mint}`,
    calloutId: `cid-${mint}`,
    caller,
    token: {
      mint,
      symbol: 'A5TEST',
      name: 'A5 Test',
      imageUri: '',
      description: '',
      bondingCurveProgress: 40,
      bondingCurveAddress: '',
      creator: '',
      calloutPriceUsd: 0.0001,
      currentPriceUsd: 0.0001,
      marketCapAtCalloutUsd: 10000,
      currentMarketCapUsd: 10000,
      athPriceSol: 0.0001,
      peakMultiple: 1,
      currentMultiple: 1,
      complete: false,
      volume5mUsd: 1000,
      buys5m: 10,
      sells5m: 5,
      top10HoldersPct: 20,
      devHoldingPct: 1,
      isMintRevoked: true,
      isFreezeRevoked: true,
      rugcheckScore: 'SAFE',
      createdTimestamp: Date.now() - 10_000,
      timeAgoStr: '10s ago',
    },
    calloutTimestamp: Date.now() - 5_000,
    calloutNote: 'a5 test',
    confluenceCount,
    hftAction: 'INSTANT_SNIPE',
    decayWindowSecondsRemaining: 60,
    status: 'ACTIVE',
  };
}

describe('A5: fake callers cannot drive auto-snipe', () => {
  beforeEach(() => {
    (pumpFunService as any).snipedMints.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('starts with no callers when DEMO_MODE is not true', () => {
    expect(process.env.DEMO_MODE).not.toBe('true');
    expect(pumpFunService.getLeaderboard()).toEqual([]);
  });

  it('never fires a snipe when AUTO_SNIPE_ENABLED is unset, even for a strong caller', async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', '');
    const snipeSpy = vi.spyOn(memecoinAggregator, 'executeSnipe');
    const callout = makeCallout(makeCaller({ isAutoSnipeSubscribed: true }), 'A5MintDisabled1111111111111111111111111111');
    (pumpFunService as any).hotCallouts = [callout];

    await (pumpFunService as any).evaluateAutoSnipeTriggers();

    expect(snipeSpy).not.toHaveBeenCalled();
    expect(callout.status).toBe('ACTIVE');
  });

  it('does not treat a caller subscription as a standalone trigger', async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    const snipeSpy = vi.spyOn(memecoinAggregator, 'executeSnipe');
    const weakSubscribed = makeCaller({
      isAutoSnipeSubscribed: true,
      winRate2x: 5,
      avgMultiple: 1,
    });
    const callout = makeCallout(weakSubscribed, 'A5MintSubscribed111111111111111111111111111', 1);
    (pumpFunService as any).hotCallouts = [callout];

    await (pumpFunService as any).evaluateAutoSnipeTriggers();

    expect(snipeSpy).not.toHaveBeenCalled();
    expect(callout.status).toBe('ACTIVE');
  });

  it('labels a demo caller SYNTHETIC_TEST and a real-feed caller REAL_SOCIAL', () => {
    const demo = makeCallout(makeCaller({ userId: 'sol_cabal_insider' }), 'A5MintDemo11111111111111111111111111111111');
    const real = makeCallout(makeCaller({ userId: 'real_feed_caller' }), 'A5MintReal11111111111111111111111111111111');
    expect(calloutProvenance(demo)).toBe('SYNTHETIC_TEST');
    expect(calloutProvenance(real)).toBe('REAL_SOCIAL');
  });

  it('lets the synthetic-pool check win over an explicit REAL_ONCHAIN provenance', async () => {
    // An unknown mint in PAPER mode resolves to a fabricated pool-simulated-* pool.
    const tradeSpy = vi
      .spyOn(executionCoordinator, 'executeTrade')
      .mockResolvedValue({ success: false, error: 'stubbed for A5 provenance check' } as any);

    await memecoinAggregator.executeSnipe({
      contractAddress: 'A5UnknownMint1111111111111111111111111111111',
      amountUsd: 5,
      provenance: 'REAL_ONCHAIN',
    });

    expect(tradeSpy).toHaveBeenCalledTimes(1);
    expect(tradeSpy.mock.calls[0][0].provenance).toBe('SYNTHETIC_TEST');
  });
});
