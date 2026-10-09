import { setAutoMode, releaseHotCallouts } from './fixtures/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  CurveVelocityEvaluator,
  curveVelocityEvaluator,
} from '../server/signals/curveVelocityEvaluator';
import {
  CreatorRiskScorer,
  creatorRiskScorer,
  ConfirmedSignatureInfo,
} from '../server/signals/creatorRiskScorer';
import {
  ConfluenceEngine,
  isConfluencePassed,
  MIN_CONFLUENCE_SCORE,
} from '../server/signals/confluenceEngine';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { pumpfunService } from '../server/pumpfunService';
import { executionCoordinator } from '../server/execution/coordinator';
import { PumpFunHotCallout } from '../src/types';

describe('Phase 5 Challenger Stress & Adversarial Suite: Alpha Pipeline (B14)', () => {
  const MINT_PREFIX = 'StressMintAdversarialTest';
  const CREATOR_SEASONED = '7xK9nMQk3mPzV1W8L5tG7yD2jX4vB6nS8cF9eR3tY1uQ';
  // Valid Base58 address (generated via Keypair)
  const VALID_CREATOR_BASE58 = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

  beforeEach(async () => {
    curveVelocityEvaluator.clear();
    creatorRiskScorer.clearCache();
    memecoinAggregator.setConfluenceGating(false);
    (pumpfunService as any).snipedMints = new Set();
    (pumpfunService as any).hotCallouts = [];
    vi.restoreAllMocks();
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    await setAutoMode('PAPER'); // G1: the controller owns auto trading; PAPER sends candidates on to executeSnipe
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // =========================================================================
  // Suite 1: Concurrency Safety Across Multiple Mints & Simultaneous Inputs
  // =========================================================================
  describe('Concurrency Safety: Simultaneous Curve Transitions & Race Resistance', () => {
    it('maintains absolute data isolation under 50 simultaneous concurrent mint transitions', async () => {
      const evaluator = new CurveVelocityEvaluator();
      const mintCount = 50;
      const mints = Array.from({ length: mintCount }, (_, i) => `${MINT_PREFIX}_${i}`);

      // Concurrently fire transitions across all 50 mints with distinct slot and reserve values
      await Promise.all(
        mints.map(async (mint, idx) => {
          const baseSlot = 1000 + idx * 100;
          const baseReserve = 10 + idx;

          // Step 1: Initial transition
          evaluator.recordTransition(mint, baseSlot, baseReserve, 100_000);

          // Simulate micro-delay/async interleaving
          await new Promise((res) => setTimeout(res, Math.floor(Math.random() * 5)));

          // Step 2: Next transition with deliberate acceleration
          // Delta SOL = 2.0, Delta slots = 10 -> accel = 0.2
          evaluator.recordTransition(mint, baseSlot + 10, baseReserve + 2.0, 104_000);
        })
      );

      // Verify that every single mint independently computed slotAcceleration = 0.2 without cross-talk
      for (let i = 0; i < mintCount; i++) {
        const mint = mints[i];
        expect(evaluator.hasData(mint)).toBe(true);
        const metrics = evaluator.getMetrics(mint, 104_000);
        expect(metrics.slotAcceleration).toBe(0.2);
        expect(metrics.transitionCount).toBe(2);
        expect(metrics.lastSlot).toBe(1000 + i * 100 + 10);
      }
    });

    it('handles out-of-order, chaotic slot arrival correctly by maintaining sorted order', async () => {
      const evaluator = new CurveVelocityEvaluator();
      const mint = 'ChaoticSlotOrderMint';

      // Feed slots out of chronological/numerical order
      const chaoticArrivals = [
        { slot: 1050, reserve: 25.0, ts: 150_000 },
        { slot: 1010, reserve: 15.0, ts: 110_000 },
        { slot: 1080, reserve: 30.0, ts: 180_000 },
        { slot: 1000, reserve: 10.0, ts: 100_000 },
        { slot: 1030, reserve: 20.0, ts: 130_000 },
      ];

      for (const item of chaoticArrivals) {
        evaluator.recordTransition(mint, item.slot, item.reserve, item.ts);
      }

      const metrics = evaluator.getMetrics(mint, 180_000);
      // Latest transition should be slot 1080 (reserve 30.0), previous is 1050 (reserve 25.0)
      // Delta SOL = 5.0, Delta slots = 30 -> 5/30 = 0.166667
      expect(metrics.lastSlot).toBe(1080);
      expect(metrics.transitionCount).toBe(5);
      expect(metrics.slotAcceleration).toBeCloseTo(0.166667, 5);
      expect(metrics.windowVelocitySolPerSec).toBeGreaterThan(0);
    });

    it('safely handles duplicate slots (deltaSlots = 0) without NaN or Infinity division', () => {
      const evaluator = new CurveVelocityEvaluator();
      const mint = 'ZeroDeltaSlotMint';

      // Two transitions with identical slot number
      evaluator.recordTransition(mint, 5000, 10.0, 100_000);
      evaluator.recordTransition(mint, 5000, 12.0, 100_050);

      const metrics = evaluator.getMetrics(mint, 100_050);
      expect(Number.isFinite(metrics.slotAcceleration)).toBe(true);
      expect(isNaN(metrics.slotAcceleration)).toBe(false);
      // When deltaSlots <= 0, deltaSol > 0 ? deltaSol : 0 -> 2.0
      expect(metrics.slotAcceleration).toBe(2.0);
    });

    it('maintains read consistency during simultaneous high-throughput reads and writes', async () => {
      const evaluator = new CurveVelocityEvaluator();
      const mint = 'HeavyReadWriteMint';

      let readErrors = 0;
      const iterations = 100;

      // Start continuous background writes
      const writePromise = (async () => {
        for (let i = 0; i < iterations; i++) {
          evaluator.recordTransition(mint, 1000 + i, 10 + i * 0.1, 100_000 + i * 100);
          evaluator.recordTradeFlow(mint, 0.5, true, 100_000 + i * 100);
        }
      })();

      // Start concurrent reads
      const readPromise = (async () => {
        for (let i = 0; i < iterations; i++) {
          try {
            const metrics = evaluator.getMetrics(mint, 100_000 + i * 100);
            if (isNaN(metrics.slotAcceleration) || isNaN(metrics.volume10sSol)) {
              readErrors++;
            }
          } catch {
            readErrors++;
          }
        }
      })();

      await Promise.all([writePromise, readPromise]);
      expect(readErrors).toBe(0);
    });
  });

  // =========================================================================
  // Suite 2: Memory Leak Resistance & Sliding Window Bounded Pruning
  // =========================================================================
  describe('Memory Leak Resistance & Sliding Window Bounded Pruning', () => {
    it('strictly caps transitions array at maxTransitionsPerMint (120) when flooded with 1,000 transitions', () => {
      const evaluator = new CurveVelocityEvaluator();
      const mint = 'FloodedTransitionMint';

      for (let i = 0; i < 1000; i++) {
        evaluator.recordTransition(mint, 1000 + i, 10 + i * 0.05, 100_000 + i * 500);
      }

      const metrics = evaluator.getMetrics(mint, 100_000 + 1000 * 500);
      expect(metrics.transitionCount).toBe(120); // Hard bounded at 120
      expect(metrics.lastSlot).toBe(1999);

      // Verify slot acceleration is computed accurately on the bounded buffer tail
      // Slot 1999 vs Slot 1998: Delta SOL = 0.05, Delta slots = 1 -> 0.05
      expect(metrics.slotAcceleration).toBe(0.05);
    });

    it('strictly caps trade flows array at maxTradeFlowsPerMint (600) when flooded with 2,500 trade flows', () => {
      const evaluator = new CurveVelocityEvaluator();
      const mint = 'FloodedTradeFlowMint';
      const now = 500_000;

      for (let i = 0; i < 2500; i++) {
        // Spread flows across 100 seconds
        evaluator.recordTradeFlow(mint, 0.1, i % 2 === 0, now - (2500 - i) * 40);
      }

      // Check internal trade flows length
      const flows = (evaluator as any).tradeFlowsByMint.get(mint);
      expect(flows).toBeDefined();
      expect(flows.length).toBe(600); // Hard bounded at 600
    });

    it('prunes expired trade flows outside the 10s and 30s sliding windows', () => {
      const evaluator = new CurveVelocityEvaluator();
      const mint = 'ExpiredWindowMint';
      const baseTime = 1_000_000;

      // 1. Trade 40 seconds ago (outside both 10s and 30s windows)
      evaluator.recordTradeFlow(mint, 10.0, true, baseTime - 40_000);

      // 2. Trade 20 seconds ago (inside 30s, outside 10s)
      evaluator.recordTradeFlow(mint, 3.0, true, baseTime - 20_000);

      // 3. Trade 5 seconds ago (inside both 10s and 30s)
      evaluator.recordTradeFlow(mint, 1.5, true, baseTime - 5_000);

      const metricsAtBase = evaluator.getMetrics(mint, baseTime);
      expect(metricsAtBase.volume10sSol).toBe(1.5);
      expect(metricsAtBase.volume30sSol).toBe(4.5); // 1.5 + 3.0 (40s trade excluded)

      // Advance time by another 15 seconds (now baseTime + 15_000)
      // The 20s-ago trade is now 35s ago (expired from 30s window)
      // The 5s-ago trade is now 20s ago (expired from 10s window, but within 30s window)
      const metricsLater = evaluator.getMetrics(mint, baseTime + 15_000);
      expect(metricsLater.volume10sSol).toBe(0);
      expect(metricsLater.volume30sSol).toBe(1.5);

      // Advance time by 35 seconds (now baseTime + 35_000)
      // All previous trades have expired from both windows
      const metricsFinal = evaluator.getMetrics(mint, baseTime + 35_000);
      expect(metricsFinal.volume10sSol).toBe(0);
      expect(metricsFinal.volume30sSol).toBe(0);
    });

    it('CreatorRiskScorer cache honors TTL (120s) and allows explicit clearCache()', async () => {
      const scorer = new CreatorRiskScorer();
      const dummyPubkey = new PublicKey(VALID_CREATOR_BASE58);
      const address = dummyPubkey.toBase58();

      let rpcCallCount = 0;
      const mockRpc = {
        getSignaturesForAddress: vi.fn(async () => {
          rpcCallCount++;
          const nowSec = Math.floor(Date.now() / 1000);
          return [
            { signature: 'sig1', slot: 100, err: null, memo: null, blockTime: nowSec - 100 },
            { signature: 'sig2', slot: 90, err: null, memo: null, blockTime: nowSec - 200_000 },
            { signature: 'sig3', slot: 80, err: null, memo: null, blockTime: nowSec - 500_000 },
          ] as ConfirmedSignatureInfo[];
        }),
      };

      // Call 1: fresh fetch -> RPC called
      const rep1 = await scorer.evaluateCreator(mockRpc, dummyPubkey);
      expect(rpcCallCount).toBe(1);
      expect(rep1.creatorAddress).toBe(address);

      // Call 2: immediately after -> returns cached, RPC NOT called
      const rep2 = await scorer.evaluateCreator(mockRpc, dummyPubkey);
      expect(rpcCallCount).toBe(1);
      expect(rep2).toEqual(rep1);

      // Call 3: bypassCache: true -> forces fresh fetch
      await scorer.evaluateCreator(mockRpc, dummyPubkey, { bypassCache: true });
      expect(rpcCallCount).toBe(2);

      // Call 4: clearCache() -> empties cache completely
      scorer.clearCache();
      await scorer.evaluateCreator(mockRpc, dummyPubkey);
      expect(rpcCallCount).toBe(3);
    });
  });

  // =========================================================================
  // Suite 3: RPC Failure Resilience & Graceful Fallbacks (No Crashes)
  // =========================================================================
  describe('RPC Failure Resilience & Conservative Fallback Behavior', () => {
    it('gracefully handles network timeout (ETIMEDOUT) with conservative fallback report', async () => {
      const scorer = new CreatorRiskScorer();
      const timeoutRpc = {
        getSignaturesForAddress: vi.fn(async () => {
          throw new Error('connect ETIMEDOUT 127.0.0.1:8899');
        }),
      };

      const report = await scorer.evaluateCreator(timeoutRpc, VALID_CREATOR_BASE58);

      // Must NOT throw or crash
      expect(report).toBeDefined();
      expect(report.creatorAddress).toBe(VALID_CREATOR_BASE58);
      expect(report.riskScore).toBe(30);
      expect(report.confluenceScore).toBe(0); // C2: a failed lookup earns no points
      expect(report.isBurner).toBe(true);
      expect(report.riskFlags).toContain('RPC_HISTORY_QUERY_FAILED');
      expect(report.details).toContain('ETIMEDOUT');
    });

    it('gracefully handles HTTP 429 Too Many Requests rate limit error', async () => {
      const scorer = new CreatorRiskScorer();
      const rateLimitedRpc = {
        getSignaturesForAddress: vi.fn(async () => {
          throw new Error('429 Too Many Requests: RPC rate limit exceeded');
        }),
      };

      const report = await scorer.evaluateCreator(rateLimitedRpc, VALID_CREATOR_BASE58);
      expect(report.riskScore).toBe(30);
      expect(report.confluenceScore).toBe(0); // C2: a failed lookup earns no points
      expect(report.isBurner).toBe(true);
      expect(report.riskFlags).toContain('RPC_HISTORY_QUERY_FAILED');
    });

    it('gracefully handles non-Error thrown exceptions (e.g., raw string or object)', async () => {
      const scorer = new CreatorRiskScorer();
      const throwingStringRpc = {
        getSignaturesForAddress: vi.fn(async () => {
          throw 'RPC socket terminated abruptly';
        }),
      };

      const report = await scorer.evaluateCreator(throwingStringRpc, VALID_CREATOR_BASE58);
      expect(report.riskScore).toBe(30);
      expect(report.confluenceScore).toBe(0); // C2: a failed lookup earns no points
      expect(report.isBurner).toBe(true);
      expect(report.details).toContain('RPC socket terminated abruptly');
    });

    it('gracefully handles null / undefined connection objects without throwing', async () => {
      const scorer = new CreatorRiskScorer();
      const reportNull = await scorer.evaluateCreator(null, VALID_CREATOR_BASE58);
      expect(reportNull).toBeDefined();
      // Null connection results in 0 signatures returned -> evaluateSignatures evaluates 0 tx as fresh burner
      expect(reportNull.isBurner).toBe(true);
      expect(reportNull.confluenceScore).toBe(0);

      const reportUndef = await scorer.evaluateCreator(undefined, VALID_CREATOR_BASE58);
      expect(reportUndef).toBeDefined();
      expect(reportUndef.isBurner).toBe(true);
      expect(reportUndef.confluenceScore).toBe(0);
    });

    it('gracefully handles malformed base58 public keys without uncaught exception', async () => {
      const scorer = new CreatorRiskScorer();
      const malformedAddress = 'Invalid!Base58@Address#$%';
      const dummyRpc = { getSignaturesForAddress: vi.fn() };

      const report = await scorer.evaluateCreator(dummyRpc, malformedAddress);
      expect(report.riskScore).toBe(30);
      expect(report.confluenceScore).toBe(0); // C2: a failed lookup earns no points
      expect(report.riskFlags).toContain('RPC_HISTORY_QUERY_FAILED');
    });
  });

  // =========================================================================
  // Suite 4: PumpfunService autoSnipeTriggers & Strict >= 70 Threshold Gate
  // =========================================================================
  describe('PumpFunService: Strict Composite Score >= 70 Enforcement in Auto-Snipe', () => {
    const createBaseCallout = (overrides?: Partial<PumpFunHotCallout>): PumpFunHotCallout => ({
      id: 'stress-callout-1',
      calloutId: 'scid-1',
      caller: {
        userId: 'caller_unsubscribed',
        userUuid: 'usr-unsub',
        primaryWallet: CREATOR_SEASONED,
        avatarUrl: '',
        totalCallouts: 20,
        avgMultiple: 1.5,       // Below minAvgMultiple (2.0)
        medianMultiple: 1.2,
        winRate1_2x: 45,
        winRate1_5x: 30,
        winRate2x: 15,          // Below minCallerWinRate2x (40)
        avgTimeToPeakMs: 400_000,
        followersCount: 500,
        totalVolumeDrivenUsd: 20_000,
        reputationTier: 'EMERGING_CALLER',
        isAutoSnipeSubscribed: false, // NOT subscribed -> MUST rely solely on confluence
        topCallouts: [],
      },
      token: {
        mint: 'TestSnipeToken1111111111111111111111111111111',
        symbol: 'SNIPE_ME',
        name: 'Snipe Me Coin',
        imageUri: '',
        description: '',
        bondingCurveProgress: 75,
        bondingCurveAddress: '',
        creator: CREATOR_SEASONED,
        calloutPriceUsd: 0.0001,
        currentPriceUsd: 0.00012,
        marketCapAtCalloutUsd: 10000,
        currentMarketCapUsd: 12000,
        athPriceSol: 0.0002,
        peakMultiple: 1.2,
        currentMultiple: 1.2, // Within maxEntryMultiple (1.8)
        complete: false,
        volume5mUsd: 15000,
        buys5m: 50,
        sells5m: 10,
        top10HoldersPct: 15.0,
        devHoldingPct: 0.0,
        isMintRevoked: true,
        isFreezeRevoked: true,
        rugcheckScore: 'SAFE',
        createdTimestamp: Date.now() - 30_000,
        timeAgoStr: '30s ago',
      },
      calloutTimestamp: Date.now() - 10_000, // Well within maxElapsedSeconds (45)
      calloutNote: 'Confluence testing callout',
      confluenceCount: 2, // Meets minimum 2 callers
      hftAction: 'INSTANT_SNIPE',
      decayWindowSecondsRemaining: 50,
      status: 'ACTIVE',
      ...overrides,
    });

    it('rejects auto-snipe when composite score is 69 (strictly below 70 threshold)', async () => {
      const callout69 = createBaseCallout({
        token: {
          mint: 'Score69Token111111111111111111111111111111111',
          symbol: 'SCORE69',
          name: 'Score 69 Meme',
          imageUri: '',
          description: '',
          bondingCurveProgress: 70,
          bondingCurveAddress: '',
          creator: CREATOR_SEASONED,
          calloutPriceUsd: 0.0001,
          currentPriceUsd: 0.000128,
          marketCapAtCalloutUsd: 10000,
          currentMarketCapUsd: 12850,
          athPriceSol: 0.0002,
          peakMultiple: 1.285,
          currentMultiple: 1.285,
          complete: false,
          volume5mUsd: 1000,
          buys5m: 20,
          sells5m: 5,
          top10HoldersPct: 14.0,
          devHoldingPct: 0.0,
          isMintRevoked: true,
          isFreezeRevoked: true,
          rugcheckScore: 'SAFE',
          createdTimestamp: Date.now() - 30_000,
          timeAgoStr: '30s ago',
        },
      });

      // Mock evaluateCalloutConfluence to return compositeScore = 69
      vi.spyOn(pumpfunService, 'evaluateCalloutConfluence').mockReturnValue({
        compositeScore: 69,
        momentumScore: 10,
        liquidityScore: 10,
        holderDistributionScore: 15,
        bondingCurveVelocityScore: 12,
        buySellImbalanceScore: 17,
        creatorRiskScore: 5,
        socialSignalScore: 0,
        explanation: 'Score 69 Mock',
      });

      (pumpfunService as any).hotCallouts = [callout69];
      const snipeSpy = vi.spyOn(memecoinAggregator, 'executeSnipe');

      releaseHotCallouts(pumpfunService);
      await (pumpfunService as any).evaluateAutoSnipeTriggers();

      // STRICT CHECK: Snipe MUST NOT execute because 69 < 70
      expect(snipeSpy).toHaveBeenCalledTimes(0);
      expect(callout69.status).toBe('ACTIVE');
    });

    it('triggers auto-snipe when composite score is exactly 70 (boundary condition)', async () => {
      const callout70 = createBaseCallout({
        id: 'callout-boundary-70',
        token: {
          ...createBaseCallout().token,
          mint: 'Score70Token111111111111111111111111111111111',
        },
      });

      // Mock evaluateCalloutConfluence to return compositeScore = 70
      vi.spyOn(pumpfunService, 'evaluateCalloutConfluence').mockReturnValue({
        compositeScore: 70,
        momentumScore: 10,
        liquidityScore: 10,
        holderDistributionScore: 15,
        bondingCurveVelocityScore: 15,
        buySellImbalanceScore: 15,
        creatorRiskScore: 5,
        socialSignalScore: 5,
        explanation: 'Score 70 Boundary Mock',
      });

      const snipeSpy = vi.spyOn(memecoinAggregator, 'executeSnipe').mockResolvedValueOnce({
        success: true,
        message: 'Sniped successfully',
        txHash: '0xmockboundary70',
        confluenceScore: 70,
      });

      (pumpfunService as any).hotCallouts = [callout70];

      releaseHotCallouts(pumpfunService);
      await (pumpfunService as any).evaluateAutoSnipeTriggers();

      // STRICT CHECK: Boundary score 70 MUST trigger snipe
      expect(snipeSpy).toHaveBeenCalledTimes(1);
      expect(snipeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          contractAddress: callout70.token.mint,
          enforceConfluence: true,
        })
      );
      expect(callout70.status).toBe('SNIPED');
    });

    it('triggers auto-snipe when composite score is 71 (strictly above 70 threshold)', async () => {
      const callout71 = createBaseCallout({
        id: 'callout-above-71',
        token: {
          ...createBaseCallout().token,
          mint: 'Score71Token111111111111111111111111111111111',
        },
      });

      vi.spyOn(pumpfunService, 'evaluateCalloutConfluence').mockReturnValue({
        compositeScore: 71,
        momentumScore: 10,
        liquidityScore: 10,
        holderDistributionScore: 15,
        bondingCurveVelocityScore: 15,
        buySellImbalanceScore: 16,
        creatorRiskScore: 5,
        socialSignalScore: 5,
        explanation: 'Score 71 Mock',
      });

      const snipeSpy = vi.spyOn(memecoinAggregator, 'executeSnipe').mockResolvedValueOnce({
        success: true,
        message: 'Sniped successfully',
        txHash: '0xmockabove71',
        confluenceScore: 71,
      });

      (pumpfunService as any).hotCallouts = [callout71];

      releaseHotCallouts(pumpfunService);
      await (pumpfunService as any).evaluateAutoSnipeTriggers();

      expect(snipeSpy).toHaveBeenCalledTimes(1);
      expect(callout71.status).toBe('SNIPED');
    });

    it('rejects auto-snipe when confluenceCount is 1, even if compositeScore is 95', async () => {
      const highSingleCallerCallout = createBaseCallout({
        confluenceCount: 1, // Only 1 caller!
        token: {
          ...createBaseCallout().token,
          mint: 'SingleCallerHighConfluenceMint111111111111111',
        },
      });

      vi.spyOn(pumpfunService, 'evaluateCalloutConfluence').mockReturnValue({
        compositeScore: 95,
        momentumScore: 20,
        liquidityScore: 15,
        holderDistributionScore: 15,
        bondingCurveVelocityScore: 15,
        buySellImbalanceScore: 20,
        creatorRiskScore: 5,
        socialSignalScore: 5,
        explanation: 'High Score Single Caller',
      });

      const snipeSpy = vi.spyOn(memecoinAggregator, 'executeSnipe');
      (pumpfunService as any).hotCallouts = [highSingleCallerCallout];

      releaseHotCallouts(pumpfunService);
      await (pumpfunService as any).evaluateAutoSnipeTriggers();

      // Confluence requires multi-caller corroboration (confluenceCount >= 2)
      expect(snipeSpy).toHaveBeenCalledTimes(0);
      expect(highSingleCallerCallout.status).toBe('ACTIVE');
    });

    it('rejects auto-snipe when rules.autoSnipeOnConfluence is false, even if compositeScore is 95', async () => {
      const callout = createBaseCallout({
        confluenceCount: 3,
        token: {
          ...createBaseCallout().token,
          mint: 'ConfluenceDisabledMint1111111111111111111111',
        },
      });

      // Temporarily disable autoSnipeOnConfluence rule
      const originalRules = pumpfunService.getAutoSnipeRules();
      pumpfunService.updateAutoSnipeRules({ autoSnipeOnConfluence: false });

      vi.spyOn(pumpfunService, 'evaluateCalloutConfluence').mockReturnValue({
        compositeScore: 95,
        momentumScore: 20,
        liquidityScore: 15,
        holderDistributionScore: 15,
        bondingCurveVelocityScore: 15,
        buySellImbalanceScore: 20,
        creatorRiskScore: 5,
        socialSignalScore: 5,
        explanation: 'Confluence Disabled Rule',
      });

      const snipeSpy = vi.spyOn(memecoinAggregator, 'executeSnipe');
      (pumpfunService as any).hotCallouts = [callout];

      try {
        releaseHotCallouts(pumpfunService);
        await (pumpfunService as any).evaluateAutoSnipeTriggers();
        expect(snipeSpy).toHaveBeenCalledTimes(0);
        expect(callout.status).toBe('ACTIVE');
      } finally {
        pumpfunService.updateAutoSnipeRules(originalRules);
      }
    });

    it('MemecoinAggregator strictly enforces confluence >= 70 gate when enforceConfluence is true', async () => {
      const failingMint = 'MemecoinAggregatorFailMint1111111111111111';
      const failingPool = {
        contractAddress: failingMint,
        symbol: 'FAIL',
        name: 'Fail Meme',
        priceNative: 0.000001,
        priceUsd: 0.0001,
        marketCapUsd: 2000,
        liquidityUsd: 1000, // < 5000 -> 0 pts
        volume24hUsd: 500,
        priceChange5mPct: -10, // negative -> 0 pts
        priceChange1hPct: 0,
        priceChange24hPct: 0,
        bondingCurveProgress: 10, // 4 pts
        buys5m: 1,
        sells5m: 8, // negative order flow -> 0 pts
        top10HoldersPct: 60, // > 45 -> 0 pts
        devHoldingPct: 0.0, // Clean dev holding within limit (<= 5%) to isolate confluence test
        isMintRevoked: true,
        isFreezeRevoked: true,
        isLpBurned: false,
        rugcheckScore: 'DANGEROUS' as const,
        createdAgo: '1m ago',
        trendingRank: 0,
      };

      (memecoinAggregator as any).pools.unshift(failingPool);

      const result = await memecoinAggregator.executeSnipe({
        contractAddress: failingMint,
        amountUsd: 5.0,
        enforceConfluence: true,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('REJECTED: Confluence score');
      expect(result.message).toContain('failed minimum threshold of 70');
      expect(result.confluenceScore).toBeLessThan(70);
    });
  });
});
