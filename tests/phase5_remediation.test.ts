import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
  CurveVelocityEvaluator,
  curveVelocityEvaluator,
  CurveVelocityMetrics,
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

describe('Phase 5 Master Remediation Suite: Alpha Pipeline Integration (B14)', () => {
  const TEST_MINT_1 = 'ApexMint111111111111111111111111111111111111';
  const TEST_MINT_2 = 'ApexMint222222222222222222222222222222222222';
  const CREATOR_SEASONED = '7xK9nMQk3mPzV1W8L5tG7yD2jX4vB6nS8cF9eR3tY1uQ';
  const CREATOR_BURNER = 'BurnerWallet11111111111111111111111111111111';

  beforeEach(() => {
    curveVelocityEvaluator.clear();
    creatorRiskScorer.clearCache();
    memecoinAggregator.setConfluenceGating(false);
  });

  // =========================================================================
  // Section 1: CurveVelocityEvaluator (Slot Acceleration & Trade Flow Windows)
  // =========================================================================
  describe('CurveVelocityEvaluator: On-Chain Curve Momentum & Acceleration (B14)', () => {
    it('calculates slot acceleration v = Delta SOL / Delta slots correctly', () => {
      const evaluator = new CurveVelocityEvaluator();
      const mint = TEST_MINT_1;

      // Slot 1000: 10 SOL reserves
      evaluator.recordTransition(mint, 1000, 10.0, 100_000);
      // Slot 1010: 15 SOL reserves (Delta SOL = 5.0, Delta slots = 10 -> v = 0.5 SOL/slot)
      evaluator.recordTransition(mint, 1010, 15.0, 104_000);

      const metrics = evaluator.getMetrics(mint, 104_000);
      expect(metrics.slotAcceleration).toBe(0.5);
      expect(metrics.velocityScore).toBeGreaterThanOrEqual(6);
      expect(metrics.transitionCount).toBe(2);
      expect(metrics.lastSlot).toBe(1010);
    });

    it('identifies stagnant / zero reserve acceleration on inactive curves', () => {
      const evaluator = new CurveVelocityEvaluator();
      const mint = TEST_MINT_1;

      evaluator.recordTransition(mint, 5000, 20.0, 100_000);
      evaluator.recordTransition(mint, 5100, 20.0, 140_000);

      const metrics = evaluator.getMetrics(mint, 140_000);
      expect(metrics.slotAcceleration).toBe(0);
      expect(metrics.windowVelocitySolPerSec).toBe(0);
      expect(metrics.velocityScore).toBe(0);
      expect(metrics.isSurging).toBe(false);
    });

    it('accurately evaluates negative reserve transition (net sell pressure)', () => {
      const evaluator = new CurveVelocityEvaluator();
      const mint = TEST_MINT_1;

      evaluator.recordTransition(mint, 2000, 25.0, 100_000);
      evaluator.recordTransition(mint, 2050, 22.5, 120_000); // 2.5 SOL net sell across 50 slots

      const metrics = evaluator.getMetrics(mint, 120_000);
      expect(metrics.slotAcceleration).toBe(-0.05);
      expect(metrics.windowVelocitySolPerSec).toBeLessThan(0);
      expect(metrics.velocityScore).toBe(0); // Zero velocity score awarded for dumping curves
      expect(metrics.isSurging).toBe(false);
    });

    it('tracks sliding window volume across 10-second and 30-second trade flow boundaries', () => {
      const evaluator = new CurveVelocityEvaluator();
      const mint = TEST_MINT_1;
      const now = 200_000;

      // Trade 1: 5s ago (inside 10s and 30s) - Buy 1.5 SOL
      evaluator.recordTradeFlow(mint, 1.5, true, now - 5_000);
      // Trade 2: 8s ago (inside 10s and 30s) - Buy 0.8 SOL
      evaluator.recordTradeFlow(mint, 0.8, true, now - 8_000);
      // Trade 3: 20s ago (inside 30s ONLY) - Sell 1.2 SOL
      evaluator.recordTradeFlow(mint, 1.2, false, now - 20_000);
      // Trade 4: 45s ago (OUTSIDE both windows) - Buy 10.0 SOL
      evaluator.recordTradeFlow(mint, 10.0, true, now - 45_000);

      const metrics = evaluator.getMetrics(mint, now);

      // 10s window: 1.5 + 0.8 = 2.3 SOL
      expect(metrics.volume10sSol).toBe(2.3);
      expect(metrics.buyVolume10sSol).toBe(2.3);
      expect(metrics.buyRatio10s).toBe(1.0); // 100% buys in last 10s

      // 30s window: 1.5 + 0.8 + 1.2 = 3.5 SOL (45s trade excluded)
      expect(metrics.volume30sSol).toBe(3.5);
      expect(metrics.buyVolume30sSol).toBe(2.3);
      expect(metrics.velocityScore).toBeGreaterThanOrEqual(9);
    });

    it('detects high volume buy surges and flags isSurging', () => {
      const evaluator = new CurveVelocityEvaluator();
      const mint = TEST_MINT_1;
      const now = 300_000;

      // Positive slot acceleration
      evaluator.recordTransition(mint, 8000, 10.0, now - 5_000);
      evaluator.recordTransition(mint, 8020, 14.0, now); // Delta 4.0 SOL across 20 slots -> v = 0.2

      // High buy volume within 10s
      evaluator.recordTradeFlow(mint, 2.0, true, now - 3_000);
      evaluator.recordTradeFlow(mint, 2.0, true, now - 1_000);

      const metrics = evaluator.getMetrics(mint, now);
      expect(metrics.slotAcceleration).toBe(0.2);
      expect(metrics.volume10sSol).toBe(4.0);
      expect(metrics.buyRatio10s).toBe(1.0);
      expect(metrics.isSurging).toBe(true);
      expect(metrics.velocityScore).toBeGreaterThanOrEqual(12);
      expect(metrics.normalizedScore).toBeGreaterThanOrEqual(80);
    });

    it('maintains strict mint isolation and data cleanup', () => {
      const evaluator = new CurveVelocityEvaluator();

      evaluator.recordTransition(TEST_MINT_1, 100, 5.0, 10_000);
      evaluator.recordTransition(TEST_MINT_1, 110, 8.0, 14_000);

      evaluator.recordTransition(TEST_MINT_2, 200, 1.0, 10_000);

      expect(evaluator.hasData(TEST_MINT_1)).toBe(true);
      expect(evaluator.hasData(TEST_MINT_2)).toBe(true);

      const m1 = evaluator.getMetrics(TEST_MINT_1, 14_000);
      const m2 = evaluator.getMetrics(TEST_MINT_2, 10_000);

      expect(m1.slotAcceleration).toBe(0.3);
      expect(m2.slotAcceleration).toBe(0);

      evaluator.clear(TEST_MINT_1);
      expect(evaluator.hasData(TEST_MINT_1)).toBe(false);
      expect(evaluator.hasData(TEST_MINT_2)).toBe(true);
    });

    it('evaluateFromParams provides pure calculation matching recorded transitions', () => {
      const result = CurveVelocityEvaluator.evaluateFromParams({
        slotAcceleration: 0.5,
        volume10sSol: 2.5,
        volume30sSol: 6.0,
        buyVolume10sSol: 2.5,
      });

      expect(result.velocityScore).toBe(15); // Max points: 6 accel + 5 volume + 4 surge
      expect(result.normalizedScore).toBe(100);
      expect(result.isSurging).toBe(true);
    });
  });

  // =========================================================================
  // Section 2: CreatorRiskScorer (On-Chain History & Burner Detection)
  // =========================================================================
  describe('CreatorRiskScorer: Burner Wallet & Deploy-and-Drain Detection (B14)', () => {
    it('distinguishes seasoned creator wallets with high score and maximum confluence points', () => {
      const scorer = new CreatorRiskScorer();
      const nowSec = 1_700_000_000;

      // 50 signatures over 45 days (3,888,000s)
      const signatures: ConfirmedSignatureInfo[] = [];
      for (let i = 0; i < 50; i++) {
        signatures.push({
          signature: `sig-${i}`,
          slot: 100_000 - i * 100,
          err: null,
          memo: null,
          blockTime: nowSec - (i * 80_000), // oldest is nowSec - 3,920,000s (~45 days)
        });
      }

      const report = scorer.evaluateSignatures(CREATOR_SEASONED, signatures, nowSec);

      expect(report.isBurner).toBe(false);
      expect(report.isFreshWallet).toBe(false);
      expect(report.hasDrainPattern).toBe(false);
      expect(report.signatureCount).toBe(50);
      expect(report.riskScore).toBeGreaterThanOrEqual(80);
      expect(report.confluenceScore).toBe(5); // Maximum 5/5 confluence points
      expect(report.riskFlags).toHaveLength(0);
    });

    it('detects fresh burner wallet funded < 1 hour prior and assigns 0 confluence points', () => {
      const scorer = new CreatorRiskScorer();
      const nowSec = 1_700_000_000;

      // Wallet created and funded only 15 minutes (900 seconds) ago with 2 transactions
      const signatures: ConfirmedSignatureInfo[] = [
        {
          signature: 'sig-deploy',
          slot: 50_010,
          err: null,
          memo: null,
          blockTime: nowSec - 120, // 2 minutes ago
        },
        {
          signature: 'sig-funding',
          slot: 50_000,
          err: null,
          memo: null,
          blockTime: nowSec - 900, // 15 minutes ago (< 1 hour)
        },
      ];

      const report = scorer.evaluateSignatures(CREATOR_BURNER, signatures, nowSec);

      expect(report.isFreshWallet).toBe(true);
      expect(report.isBurner).toBe(true);
      expect(report.riskFlags).toContain('FRESH_BURNER_WALLET');
      expect(report.riskFlags).toContain('EXTREME_LOW_SIGNATURES');
      expect(report.riskScore).toBe(0);
      expect(report.confluenceScore).toBe(0); // 0 points for burner creators
    });

    it('detects rapid deploy-and-drain patterns with short lifespans', () => {
      const scorer = new CreatorRiskScorer();
      const nowSec = 1_700_000_000;

      // 4 transactions spanning just 4 minutes, wallet age 12 minutes
      const signatures: ConfirmedSignatureInfo[] = [
        { signature: 'sig-4', slot: 104, err: null, memo: null, blockTime: nowSec - 480 },
        { signature: 'sig-3', slot: 103, err: null, memo: null, blockTime: nowSec - 520 },
        { signature: 'sig-2', slot: 102, err: null, memo: null, blockTime: nowSec - 600 },
        { signature: 'sig-1', slot: 101, err: null, memo: null, blockTime: nowSec - 720 },
      ];

      const report = scorer.evaluateSignatures(CREATOR_BURNER, signatures, nowSec);

      expect(report.hasDrainPattern).toBe(true);
      expect(report.isBurner).toBe(true);
      expect(report.riskFlags).toContain('RAPID_DEPLOY_AND_DRAIN');
      expect(report.confluenceScore).toBe(0);
    });

    it('assigns zero score to wallets with zero transaction history', () => {
      const scorer = new CreatorRiskScorer();
      const report = scorer.evaluateSignatures(CREATOR_BURNER, []);

      expect(report.isBurner).toBe(true);
      expect(report.isFreshWallet).toBe(true);
      expect(report.riskScore).toBe(0);
      expect(report.confluenceScore).toBe(0);
      expect(report.riskFlags).toContain('NO_TRANSACTION_HISTORY');
    });

    it('evaluates creator via RPC provider and caches result', async () => {
      const scorer = new CreatorRiskScorer();
      const nowSec = 1_700_000_000;
      let rpcCallCount = 0;

      const mockProvider = {
        getSignaturesForAddress: vi.fn().mockImplementation(async () => {
          rpcCallCount++;
          return [
            { signature: 'sig-1', slot: 1000, err: null, memo: null, blockTime: nowSec - 50_000 },
            { signature: 'sig-2', slot: 900, err: null, memo: null, blockTime: nowSec - 100_000 },
            { signature: 'sig-3', slot: 800, err: null, memo: null, blockTime: nowSec - 200_000 },
          ];
        }),
      };

      const pubkey = Keypair.generate().publicKey;
      const report1 = await scorer.evaluateCreator(mockProvider as any, pubkey, { nowSec });
      expect(rpcCallCount).toBe(1);
      expect(report1.signatureCount).toBe(3);

      // Second call should hit in-memory cache
      const report2 = await scorer.evaluateCreator(mockProvider as any, pubkey, { nowSec });
      expect(rpcCallCount).toBe(1); // Cached, no second RPC query
      expect(report2.signatureCount).toBe(3);
    });
  });

  // =========================================================================
  // Section 3: ConfluenceEngine Multi-Factor Alpha Scoring & >= 70 Threshold
  // =========================================================================
  describe('ConfluenceEngine: Multi-Factor Scoring & >= 70 Threshold Gate (B14)', () => {
    it('enforces isConfluencePassed threshold strictly at composite score >= 70', () => {
      expect(isConfluencePassed(69)).toBe(false);
      expect(isConfluencePassed(69.9)).toBe(false);
      expect(isConfluencePassed(70)).toBe(true);
      expect(isConfluencePassed(70.1)).toBe(true);
      expect(isConfluencePassed(85)).toBe(true);
      expect(isConfluencePassed(NaN)).toBe(false);
      expect(ConfluenceEngine.isConfluencePassed(70)).toBe(true);
      expect(ConfluenceEngine.MIN_PASSING_SCORE).toBe(70);
      expect(MIN_CONFLUENCE_SCORE).toBe(70);
    });

    it('calculates composite score combining all 7 factors within [0, 100]', () => {
      const highBullish = ConfluenceEngine.calculate({
        priceChange5mPct: 40.0,      // 20/20 momentum
        liquidityUsd: 60000,         // 15/15 liquidity
        top10HoldersPct: 10.0,       // 15/15 distribution
        bondingCurveProgress: 95,    // 15/15 curve
        buys5m: 80,                  // 80% buy ratio -> 16/20 imbalance
        sells5m: 20,
        devHoldingPct: 0.0,          // 5/5 dev risk
        hasVerifiedSocialCall: true, // 10/10 social
        socialCallCount: 2,
      });

      expect(highBullish.compositeScore).toBe(96);
      expect(isConfluencePassed(highBullish.compositeScore)).toBe(true);
      expect(highBullish.momentumScore).toBe(20);
      expect(highBullish.liquidityScore).toBe(15);
      expect(highBullish.holderDistributionScore).toBe(15);
      expect(highBullish.bondingCurveVelocityScore).toBe(15);
      expect(highBullish.buySellImbalanceScore).toBe(16);
      expect(highBullish.creatorRiskScore).toBe(5);
      expect(highBullish.socialSignalScore).toBe(10);
      expect(highBullish.explanation).toContain('Confluence 96/100');
    });

    it('incorporates CurveVelocityEvaluator as a first-class on-chain factor', () => {
      const highVelocityMetrics: CurveVelocityMetrics = {
        mint: TEST_MINT_1,
        slotAcceleration: 0.6,
        windowVelocitySolPerSec: 1.5,
        volume10sSol: 3.5,
        volume30sSol: 7.0,
        buyVolume10sSol: 3.2,
        buyVolume30sSol: 6.0,
        buyRatio10s: 0.91,
        velocityScore: 15,
        normalizedScore: 100,
        isSurging: true,
        transitionCount: 10,
        lastSlot: 5000,
      };

      const resWithVelocity = ConfluenceEngine.calculate({
        priceChange5mPct: 20.0,
        liquidityUsd: 25000,
        top10HoldersPct: 20.0,
        bondingCurveProgress: 40, // Would be 8 pts under heuristic fallback
        buys5m: 30,
        sells5m: 10,
        devHoldingPct: 1.0,
        hasVerifiedSocialCall: false,
        socialCallCount: 0,
        curveVelocityMetrics: highVelocityMetrics,
      });

      // Real velocity overrides the static bondingCurveProgress heuristic
      expect(resWithVelocity.bondingCurveVelocityScore).toBe(15);
    });

    it('incorporates CreatorRiskScorer penalizing fresh burner wallets to 0 points', () => {
      // 1. With established creator
      const establishedResult = ConfluenceEngine.calculate({
        priceChange5mPct: 25.0,
        liquidityUsd: 30000,
        top10HoldersPct: 18.0,
        bondingCurveProgress: 75,
        buys5m: 40,
        sells5m: 10,
        devHoldingPct: 0.0,
        hasVerifiedSocialCall: true,
        socialCallCount: 1,
        creatorWalletAgeSeconds: 86400 * 10, // 10 days old
        creatorSignatureCount: 40,
        isCreatorBurner: false,
      });
      expect(establishedResult.creatorRiskScore).toBe(5);

      // 2. With fresh burner creator (< 1 hour old)
      const burnerResult = ConfluenceEngine.calculate({
        priceChange5mPct: 25.0,
        liquidityUsd: 30000,
        top10HoldersPct: 18.0,
        bondingCurveProgress: 75,
        buys5m: 40,
        sells5m: 10,
        devHoldingPct: 0.0,
        hasVerifiedSocialCall: true,
        socialCallCount: 1,
        creatorWalletAgeSeconds: 600, // 10 mins old
        creatorSignatureCount: 2,
        isCreatorBurner: true,
      });
      expect(burnerResult.creatorRiskScore).toBe(0);
      expect(burnerResult.compositeScore).toBe(establishedResult.compositeScore - 5);
    });

    it('evaluate method attaches boolean passed flag based on >= 70 rule', () => {
      const passing = ConfluenceEngine.evaluate({
        priceChange5mPct: 35.0,
        liquidityUsd: 40000,
        top10HoldersPct: 12.0,
        bondingCurveProgress: 85,
        buys5m: 50,
        sells5m: 10,
        devHoldingPct: 0.0,
        hasVerifiedSocialCall: true,
        socialCallCount: 2,
      });
      expect(passing.compositeScore).toBeGreaterThanOrEqual(70);
      expect(passing.passed).toBe(true);

      const failing = ConfluenceEngine.evaluate({
        priceChange5mPct: 0.0,
        liquidityUsd: 1000,
        top10HoldersPct: 60.0,
        bondingCurveProgress: 15,
        buys5m: 5,
        sells5m: 20,
        devHoldingPct: 8.0,
        hasVerifiedSocialCall: false,
        socialCallCount: 0,
      });
      expect(failing.compositeScore).toBeLessThan(70);
      expect(failing.passed).toBe(false);
    });
  });

  // =========================================================================
  // Section 4: MemecoinAggregator Confluence Gating Integration
  // =========================================================================
  describe('MemecoinAggregator: Confluence Gating Integration (B14)', () => {
    it('evaluates token confluence accurately via evaluateTokenConfluence', () => {
      const samplePool = {
        id: 'pool-test-sample',
        platform: 'PUMP_FUN' as const,
        chain: 'SOLANA' as const,
        symbol: 'SAMPLE',
        name: 'Sample Token',
        contractAddress: TEST_MINT_1,
        priceUsd: 0.000342,
        priceNative: 0.00000235,
        marketCapUsd: 342000,
        liquidityUsd: 64200,
        bondingCurveProgress: 88.5,
        isMigrated: false,
        volume5mUsd: 28400,
        volume1hUsd: 142000,
        volume24hUsd: 890000,
        priceChange5mPct: 4.8,
        priceChange1hPct: 12.5,
        buys5m: 148,
        sells5m: 82,
        top10HoldersPct: 14.2,
        devHoldingPct: 0.0,
        isMintRevoked: true,
        isFreezeRevoked: true,
        isLpBurned: false,
        rugcheckScore: 'SAFE' as const,
        createdAgo: '18m ago',
        trendingRank: 1,
      };

      (memecoinAggregator as any).pools.unshift(samplePool);

      const conf = memecoinAggregator.evaluateTokenConfluence(samplePool);
      expect(conf.score).toBeGreaterThan(0);
      expect(typeof conf.passed).toBe('boolean');
      expect(conf.breakdown.explanation).toContain('Confluence');
    });

    it('rejects snipe execution when confluence gating is enabled and score < 70', async () => {
      // Create a weak candidate pool with poor momentum, liquidity, and sell pressure
      const weakPool = {
        id: 'pool-weak-test-1',
        platform: 'PUMP_FUN',
        chain: 'SOLANA',
        symbol: 'WEAK',
        name: 'Weak Token',
        contractAddress: 'WeakMint11111111111111111111111111111111111',
        priceUsd: 0.00001,
        priceNative: 0.0000001,
        marketCapUsd: 10000,
        liquidityUsd: 2000, // < 5000 -> 0 liquidity score
        bondingCurveProgress: 10,
        isMigrated: false,
        volume5mUsd: 100,
        volume1hUsd: 500,
        volume24hUsd: 1000,
        priceChange5mPct: -15.0, // negative -> 0 momentum score
        priceChange1hPct: -25.0,
        buys5m: 2,
        sells5m: 20, // heavy sell pressure -> low imbalance score
        top10HoldersPct: 65.0, // high concentration -> 0 distribution score
        devHoldingPct: 3.0, // within allowed max 5%, but only 1 dev risk point -> composite score ~15
        isMintRevoked: true,
        isFreezeRevoked: true,
        isLpBurned: false,
        rugcheckScore: 'SAFE' as const,
        createdAgo: '5m ago',
        trendingRank: 0,
      };

      // Add pool to aggregator
      (memecoinAggregator as any).pools.unshift(weakPool);

      // Attempt snipe with enforceConfluence: true
      const result = await memecoinAggregator.executeSnipe({
        contractAddress: weakPool.contractAddress,
        amountUsd: 5.0,
        enforceConfluence: true,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('REJECTED: Confluence score');
      expect(result.message).toContain('failed minimum threshold of 70');
      expect(result.confluenceScore).toBeLessThan(70);
    });

    it('permits snipe execution when token satisfies confluence score >= 70', async () => {
      // Create a high-confluence candidate pool
      const strongPool = {
        id: 'pool-strong-test-2',
        platform: 'PUMP_FUN' as const,
        chain: 'SOLANA' as const,
        symbol: 'ALPHA',
        name: 'Alpha Token',
        contractAddress: 'AlphaMint22222222222222222222222222222222222',
        priceUsd: 0.0005,
        priceNative: 0.0000035,
        marketCapUsd: 500000,
        liquidityUsd: 55000,
        bondingCurveProgress: 85.0,
        isMigrated: false,
        volume5mUsd: 45000,
        volume1hUsd: 220000,
        volume24hUsd: 1200000,
        priceChange5mPct: 35.0,
        priceChange1hPct: 80.0,
        buys5m: 120,
        sells5m: 20,
        top10HoldersPct: 12.0,
        devHoldingPct: 0.0,
        isMintRevoked: true,
        isFreezeRevoked: true,
        isLpBurned: false,
        rugcheckScore: 'SAFE' as const,
        createdAgo: '10m ago',
        trendingRank: 1,
      };

      (memecoinAggregator as any).pools.unshift(strongPool);

      // Mock coordinator execution success to isolate aggregator confluence gating
      vi.spyOn(executionCoordinator, 'executeTrade').mockResolvedValueOnce({
        success: true,
        positionId: 'pos-test-confluence-ok',
        txSignature: 'tx-test-confluence-pass',
        executionMode: 'PAPER',
        lifecycleState: 'EXECUTED',
        correlationId: 'cid-test-1',
      } as any);

      const result = await memecoinAggregator.executeSnipe({
        contractAddress: strongPool.contractAddress,
        amountUsd: 5.0,
        enforceConfluence: true,
      });

      expect(result.success).toBe(true);
      expect(result.confluenceScore).toBeGreaterThanOrEqual(70);
    });
  });

  // =========================================================================
  // Section 5: PumpFunService Auto-Snipe Confluence Gate Integration
  // =========================================================================
  describe('PumpFunService: meetsConfluence Auto-Snipe Integration (B14)', () => {
    it('evaluates callout confluence using evaluateCalloutConfluence', () => {
      const mockCallout: PumpFunHotCallout = {
        id: 'callout-test-1',
        calloutId: 'cid-1',
        caller: {
          userId: 'test_whale',
          userUuid: 'usr-1',
          primaryWallet: CREATOR_SEASONED,
          avatarUrl: '',
          totalCallouts: 50,
          avgMultiple: 5.0,
          medianMultiple: 2.0,
          winRate1_2x: 80,
          winRate1_5x: 60,
          winRate2x: 45,
          avgTimeToPeakMs: 300_000,
          followersCount: 10000,
          totalVolumeDrivenUsd: 1_000_000,
          reputationTier: 'LEGENDARY_WHALE',
          isAutoSnipeSubscribed: true,
          topCallouts: [],
        },
        token: {
          mint: TEST_MINT_1,
          symbol: 'CALLOUT_MEME',
          name: 'Callout Meme',
          imageUri: '',
          description: '',
          bondingCurveProgress: 92, // B3: no invented liquidity or social points, so the curve factor must carry this fixture past 70
          bondingCurveAddress: '',
          creator: CREATOR_SEASONED,
          calloutPriceUsd: 0.0001,
          currentPriceUsd: 0.00025,
          marketCapAtCalloutUsd: 10000,
          currentMarketCapUsd: 25000,
          athPriceSol: 0.0005,
          peakMultiple: 2.5,
          currentMultiple: 2.5,
          complete: false,
          volume5mUsd: 25000,
          priceChange5mPct: 40, // B3: measured 5m change; missing data scores 0 and is no longer derived from the multiple
          buys5m: 85,
          sells5m: 15,
          top10HoldersPct: 14.0,
          devHoldingPct: 0.0,
          isMintRevoked: true,
          isFreezeRevoked: true,
          rugcheckScore: 'SAFE',
          createdTimestamp: Date.now() - 60_000,
          timeAgoStr: '1m ago',
        },
        calloutTimestamp: Date.now() - 30_000,
        calloutNote: 'Alpha Callout',
        confluenceCount: 3, // Multi-caller confluence
        hftAction: 'INSTANT_SNIPE',
        decayWindowSecondsRemaining: 60,
        status: 'ACTIVE',
      };

      const breakdown = pumpfunService.evaluateCalloutConfluence(mockCallout);
      expect(breakdown.compositeScore).toBeGreaterThanOrEqual(70);
      expect(isConfluencePassed(breakdown.compositeScore)).toBe(true);
    });

    it('enforces that meetsConfluence requires composite score >= 70 in auto-snipe rules', async () => {
      // Callout with confluenceCount >= 2 but poor fundamentals (composite < 70)
      const lowScoreCallout: PumpFunHotCallout = {
        id: 'callout-test-low-score',
        calloutId: 'cid-low',
        caller: {
          userId: 'test_low',
          userUuid: 'usr-2',
          primaryWallet: CREATOR_BURNER,
          avatarUrl: '',
          totalCallouts: 10,
          avgMultiple: 1.2, // Below minAvgMultiple
          medianMultiple: 1.0,
          winRate1_2x: 40,
          winRate1_5x: 20,
          winRate2x: 10,    // Below minCallerWinRate2x
          avgTimeToPeakMs: 600_000,
          followersCount: 100,
          totalVolumeDrivenUsd: 5000,
          reputationTier: 'EMERGING_CALLER' as const,
          isAutoSnipeSubscribed: false, // NOT subscribed -> must rely on confluence
          topCallouts: [],
        },
        token: {
          mint: 'LowScoreMint11111111111111111111111111111111',
          symbol: 'LOWSCORE',
          name: 'Low Score Meme',
          imageUri: '',
          description: '',
          bondingCurveProgress: 5, // very low progress
          bondingCurveAddress: '',
          creator: CREATOR_BURNER,
          calloutPriceUsd: 0.00001,
          currentPriceUsd: 0.00001,
          marketCapAtCalloutUsd: 5000,
          currentMarketCapUsd: 5000,
          athPriceSol: 0.00001,
          peakMultiple: 1.0,
          currentMultiple: 1.0,
          complete: false,
          volume5mUsd: 200,
          buys5m: 2,
          sells5m: 10, // negative order flow
          top10HoldersPct: 70.0,
          devHoldingPct: 20.0, // high dev dump risk
          isMintRevoked: false,
          isFreezeRevoked: false,
          rugcheckScore: 'DANGEROUS',
          createdTimestamp: Date.now() - 10_000,
          timeAgoStr: '10s ago',
        },
        calloutTimestamp: Date.now() - 10_000,
        calloutNote: 'Low score callout',
        confluenceCount: 2, // Confluence count is 2, but composite score is low (< 70)
        hftAction: 'INSTANT_SNIPE',
        decayWindowSecondsRemaining: 80,
        status: 'ACTIVE',
      };

      // Set callouts on pumpfunService
      (pumpfunService as any).hotCallouts = [lowScoreCallout];
      const snipeSpy = vi.spyOn(memecoinAggregator, 'executeSnipe');

      // Trigger evaluation
      await (pumpfunService as any).evaluateAutoSnipeTriggers();

      // Should NOT have triggered snipe because composite score < 70
      expect(snipeSpy.mock.calls.length).toBe(0);
      expect(lowScoreCallout.status).toBe('ACTIVE'); // Status remains ACTIVE, not SNIPED
    });
  });
});
