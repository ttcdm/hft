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
import { PumpCreateEvent } from '../server/solana/pumpFeedListener';

describe('Adversarial Stress Test Suite: Blocker B14 Alpha Pipeline Integration', () => {
  const MINT_A = 'MintAdversarial1111111111111111111111111111111';
  const MINT_B = 'MintAdversarial2222222222222222222222222222222';
  const CREATOR_ADDR = 'CreatorStressTestWallet11111111111111111111111';

  beforeEach(() => {
    curveVelocityEvaluator.clear();
    creatorRiskScorer.clearCache();
    memecoinAggregator.setConfluenceGating(false);
    (pumpfunService as any).snipedMints.clear();
    vi.restoreAllMocks();
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // =========================================================================
  // 1. CurveVelocityEvaluator Adversarial & Boundary Tests
  // =========================================================================
  describe('CurveVelocityEvaluator: Boundary & Adversarial Cases', () => {
    it('handles same-slot transitions without div-by-zero, NaN, or Infinity', () => {
      const evaluator = new CurveVelocityEvaluator();
      const mint = MINT_A;

      // Transition 1 & 2 on the exact same slot (deltaSlots = 0)
      evaluator.recordTransition(mint, 500, 10.0, 1000);
      evaluator.recordTransition(mint, 500, 15.0, 1000);

      const metrics = evaluator.getMetrics(mint, 1000);
      expect(Number.isFinite(metrics.slotAcceleration)).toBe(true);
      expect(isNaN(metrics.slotAcceleration)).toBe(false);
      // deltaSol > 0 on same slot sets acceleration to deltaSol (5.0)
      expect(metrics.slotAcceleration).toBe(5.0);
      expect(metrics.velocityScore).toBeGreaterThanOrEqual(6);

      // Same-slot with negative deltaSol (sell on same slot)
      evaluator.recordTransition(mint, 500, 8.0, 1000);
      const metricsSell = evaluator.getMetrics(mint, 1000);
      expect(Number.isFinite(metricsSell.slotAcceleration)).toBe(true);
      expect(metricsSell.slotAcceleration).toBe(0); // Clamped non-positive
    });

    it('correctly calculates negative deltas (sells) and awards zero velocity points', () => {
      const evaluator = new CurveVelocityEvaluator();
      const mint = MINT_A;

      // Heavy dump: reserves collapse by 40 SOL across 10 slots
      evaluator.recordTransition(mint, 1000, 50.0, 10_000);
      evaluator.recordTransition(mint, 1010, 10.0, 14_000);

      const metrics = evaluator.getMetrics(mint, 14_000);
      expect(metrics.slotAcceleration).toBe(-4.0);
      expect(metrics.windowVelocitySolPerSec).toBeLessThan(0);
      expect(metrics.velocityScore).toBe(0); // Dumping curves get 0 velocity points
      expect(metrics.isSurging).toBe(false);
    });

    it('survives massive buy surges and correctly clamps scores to max boundaries', () => {
      const evaluator = new CurveVelocityEvaluator();
      const mint = MINT_A;
      const now = 50_000;

      // Massive buy: 1,000,000 SOL surge in 1 slot
      evaluator.recordTransition(mint, 10000, 10.0, now - 1000);
      evaluator.recordTransition(mint, 10001, 1_000_010.0, now);

      // Huge buy trade flow
      evaluator.recordTradeFlow(mint, 500_000, true, now - 500);

      const metrics = evaluator.getMetrics(mint, now);
      expect(metrics.slotAcceleration).toBe(1_000_000);
      expect(metrics.velocityScore).toBe(15); // Capped at max 15 points
      expect(metrics.normalizedScore).toBe(100); // Capped at max 100
      expect(metrics.isSurging).toBe(true);
    });

    it('handles empty transition history without errors', () => {
      const evaluator = new CurveVelocityEvaluator();
      const metrics = evaluator.getMetrics('NonExistentMint', 100_000);

      expect(metrics.slotAcceleration).toBe(0);
      expect(metrics.windowVelocitySolPerSec).toBe(0);
      expect(metrics.volume10sSol).toBe(0);
      expect(metrics.volume30sSol).toBe(0);
      expect(metrics.velocityScore).toBe(0);
      expect(metrics.normalizedScore).toBe(0);
      expect(metrics.isSurging).toBe(false);
      expect(metrics.transitionCount).toBe(0);
      expect(metrics.lastSlot).toBe(0);
    });

    it('handles single transition history without errors', () => {
      const evaluator = new CurveVelocityEvaluator();
      evaluator.recordTransition(MINT_A, 5000, 25.0, 10_000);

      const metrics = evaluator.getMetrics(MINT_A, 10_000);
      expect(metrics.slotAcceleration).toBe(0);
      expect(metrics.windowVelocitySolPerSec).toBe(0);
      expect(metrics.transitionCount).toBe(1);
      expect(metrics.lastSlot).toBe(5000);
      expect(metrics.velocityScore).toBe(0);
    });

    it('correctly sorts out-of-order slot transitions ascending', () => {
      const evaluator = new CurveVelocityEvaluator();
      // Record in reverse order: slot 1020 first, then slot 1000
      evaluator.recordTransition(MINT_A, 1020, 30.0, 20_000);
      evaluator.recordTransition(MINT_A, 1000, 20.0, 10_000);

      const metrics = evaluator.getMetrics(MINT_A, 20_000);
      // Delta SOL = 30 - 20 = 10, Delta slots = 1020 - 1000 = 20 -> v = 0.5
      expect(metrics.slotAcceleration).toBe(0.5);
      expect(metrics.lastSlot).toBe(1020);
    });

    it('strictly expires transactions at 10s and 30s sliding window boundaries', () => {
      const evaluator = new CurveVelocityEvaluator();
      const now = 100_000;

      // Exactly at 10s boundary (timestamp = now - 10_000) -> INCLUDED in 10s & 30s
      evaluator.recordTradeFlow(MINT_A, 1.0, true, now - 10_000);
      // Just past 10s boundary (timestamp = now - 10_001) -> EXCLUDED from 10s, INCLUDED in 30s
      evaluator.recordTradeFlow(MINT_A, 2.0, true, now - 10_001);
      // Exactly at 30s boundary (timestamp = now - 30_000) -> INCLUDED in 30s, EXCLUDED from 10s
      evaluator.recordTradeFlow(MINT_A, 4.0, true, now - 30_000);
      // Just past 30s boundary (timestamp = now - 30_001) -> EXPIRED from both
      evaluator.recordTradeFlow(MINT_A, 8.0, true, now - 30_001);

      const metrics = evaluator.getMetrics(MINT_A, now);
      // 10s window: only trade 1 (1.0 SOL)
      expect(metrics.volume10sSol).toBe(1.0);
      expect(metrics.buyVolume10sSol).toBe(1.0);

      // 30s window: trade 1 (1.0) + trade 2 (2.0) + trade 3 (4.0) = 7.0 SOL
      expect(metrics.volume30sSol).toBe(7.0);
      expect(metrics.buyVolume30sSol).toBe(7.0);
    });

    it('handles buffer overflow (>600 trade flows) without data corruption', () => {
      const evaluator = new CurveVelocityEvaluator();
      const now = 200_000;

      // Record 700 trade flows
      for (let i = 0; i < 700; i++) {
        // Last 50 trades are within 5s
        const ageMs = i >= 650 ? 2000 : 50_000;
        evaluator.recordTradeFlow(MINT_A, 0.1, true, now - ageMs);
      }

      const metrics = evaluator.getMetrics(MINT_A, now);
      // 50 recent trades * 0.1 = 5.0 SOL in 10s window
      expect(metrics.volume10sSol).toBe(5.0);
      expect(metrics.buyVolume10sSol).toBe(5.0);
      expect(metrics.velocityScore).toBeGreaterThanOrEqual(9);
    });

    it('clamps negative or invalid trade flow SOL amounts to zero', () => {
      const evaluator = new CurveVelocityEvaluator();
      const now = 100_000;

      evaluator.recordTradeFlow(MINT_A, -50.0, true, now - 1000);
      const metrics = evaluator.getMetrics(MINT_A, now);
      expect(metrics.volume10sSol).toBe(0);
      expect(metrics.buyVolume10sSol).toBe(0);
    });
  });

  // =========================================================================
  // 2. CreatorRiskScorer Adversarial & RPC Fault Resilience Tests
  // =========================================================================
  describe('CreatorRiskScorer: Adversarial & Fault Tolerance Cases', () => {
    it('accurately identifies fresh burner wallet funded < 1 hour prior and gives 0 points', () => {
      const scorer = new CreatorRiskScorer();
      const nowSec = 1_700_000_000;

      // Funded 20 minutes ago (1200s), 3 total transactions
      const signatures: ConfirmedSignatureInfo[] = [
        { signature: 's3', slot: 102, err: null, memo: null, blockTime: nowSec - 60 },
        { signature: 's2', slot: 101, err: null, memo: null, blockTime: nowSec - 600 },
        { signature: 's1', slot: 100, err: null, memo: null, blockTime: nowSec - 1200 },
      ];

      const report = scorer.evaluateSignatures(CREATOR_ADDR, signatures, nowSec);
      expect(report.isFreshWallet).toBe(true);
      expect(report.isBurner).toBe(true);
      expect(report.riskFlags).toContain('FRESH_BURNER_WALLET');
      expect(report.confluenceScore).toBe(0);
      expect(report.riskScore).toBeLessThanOrEqual(15);
    });

    it('rewards seasoned wallet with >30 days history and high transaction count with 5 points', () => {
      const scorer = new CreatorRiskScorer();
      const nowSec = 1_700_000_000;

      // 60 signatures, oldest 40 days ago (3,456,000s)
      const signatures: ConfirmedSignatureInfo[] = [];
      for (let i = 0; i < 60; i++) {
        signatures.push({
          signature: `sig-${i}`,
          slot: 200_000 - i * 50,
          err: null,
          memo: null,
          blockTime: nowSec - (i * 60_000), // oldest: nowSec - 3,540,000s
        });
      }

      const report = scorer.evaluateSignatures(CREATOR_ADDR, signatures, nowSec);
      expect(report.isFreshWallet).toBe(false);
      expect(report.isBurner).toBe(false);
      expect(report.hasDrainPattern).toBe(false);
      expect(report.riskScore).toBeGreaterThanOrEqual(80);
      expect(report.confluenceScore).toBe(5); // Maximum points
    });

    it('detects rapid deploy-and-drain pattern (< 15 mins active lifespan)', () => {
      const scorer = new CreatorRiskScorer();
      const nowSec = 1_700_000_000;

      // 5 signatures across 3 minutes, wallet age 10 minutes
      const signatures: ConfirmedSignatureInfo[] = [
        { signature: 's5', slot: 105, err: null, memo: null, blockTime: nowSec - 100 },
        { signature: 's4', slot: 104, err: null, memo: null, blockTime: nowSec - 150 },
        { signature: 's3', slot: 103, err: null, memo: null, blockTime: nowSec - 200 },
        { signature: 's2', slot: 102, err: null, memo: null, blockTime: nowSec - 240 },
        { signature: 's1', slot: 101, err: null, memo: null, blockTime: nowSec - 600 },
      ];

      const report = scorer.evaluateSignatures(CREATOR_ADDR, signatures, nowSec);
      expect(report.hasDrainPattern).toBe(true);
      expect(report.isBurner).toBe(true);
      expect(report.riskFlags).toContain('RAPID_DEPLOY_AND_DRAIN');
      expect(report.confluenceScore).toBe(0);
    });

    it('flags high failure rate (> 40% errors) in transaction history', () => {
      const scorer = new CreatorRiskScorer();
      const nowSec = 1_700_000_000;

      // 10 transactions, 5 failed (50% failure rate), age 2 days
      const signatures: ConfirmedSignatureInfo[] = [];
      for (let i = 0; i < 10; i++) {
        signatures.push({
          signature: `sig-err-${i}`,
          slot: 1000 - i,
          err: i % 2 === 0 ? { InstructionError: [0, 'Custom'] } : null,
          memo: null,
          blockTime: nowSec - (172800 - i * 1000),
        });
      }

      const report = scorer.evaluateSignatures(CREATOR_ADDR, signatures, nowSec);
      expect(report.failedTxCount).toBe(5);
      expect(report.riskFlags).toContain('HIGH_FAILURE_RATE');
    });

    it('fails closed and gracefully returns fallback report on RPC error without unhandled rejection', async () => {
      const scorer = new CreatorRiskScorer();
      const failingRpc = {
        getSignaturesForAddress: vi.fn().mockRejectedValue(new Error('RPC rate limit exceeded (HTTP 429)')),
      };

      const pubkey = Keypair.generate().publicKey;
      const report = await scorer.evaluateCreator(failingRpc as any, pubkey);

      expect(report.isBurner).toBe(true);
      expect(report.confluenceScore).toBe(1); // Conservative fallback
      expect(report.riskFlags).toContain('RPC_HISTORY_QUERY_FAILED');
      expect(report.details).toContain('RPC rate limit exceeded');
    });

    it('handles RPC timeout gracefully without crashing', async () => {
      const scorer = new CreatorRiskScorer();
      const timeoutRpc = {
        getSignaturesForAddress: vi.fn().mockImplementation(() => {
          return new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Gateway Timeout 504')), 5);
          });
        }),
      };

      const pubkey = Keypair.generate().publicKey;
      const report = await scorer.evaluateCreator(timeoutRpc as any, pubkey);

      expect(report.isBurner).toBe(true);
      expect(report.riskFlags).toContain('RPC_HISTORY_QUERY_FAILED');
      expect(report.details).toContain('Gateway Timeout 504');
    });

    it('handles null/undefined connection provider gracefully', async () => {
      const scorer = new CreatorRiskScorer();
      const pubkey = Keypair.generate().publicKey;
      const report = await scorer.evaluateCreator(null as any, pubkey);

      // Without provider, signatures = [], treats as zero transaction history
      expect(report.isBurner).toBe(true);
      expect(report.confluenceScore).toBe(0);
      expect(report.riskFlags).toContain('NO_TRANSACTION_HISTORY');
    });

    it('supports cache bypass when bypassCache is explicitly requested', async () => {
      const scorer = new CreatorRiskScorer();
      let queryCount = 0;
      const mockRpc = {
        getSignaturesForAddress: vi.fn().mockImplementation(async () => {
          queryCount++;
          return [{ signature: 's1', slot: 100, err: null, memo: null, blockTime: 1_700_000_000 - 100_000 }];
        }),
      };

      const pubkey = Keypair.generate().publicKey;
      await scorer.evaluateCreator(mockRpc as any, pubkey);
      expect(queryCount).toBe(1);

      // Normal call: cache hit
      await scorer.evaluateCreator(mockRpc as any, pubkey);
      expect(queryCount).toBe(1);

      // Bypass cache: queries RPC again
      await scorer.evaluateCreator(mockRpc as any, pubkey, { bypassCache: true });
      expect(queryCount).toBe(2);
    });
  });

  // =========================================================================
  // 3. ConfluenceEngine Composite Score & Threshold Stress Tests
  // =========================================================================
  describe('ConfluenceEngine: 7-Factor Arithmetic & Boundary Gating', () => {
    it('strictly enforces the >= 70 score threshold across decimal boundaries', () => {
      expect(isConfluencePassed(69.9999)).toBe(false);
      expect(isConfluencePassed(70.0000)).toBe(true);
      expect(isConfluencePassed(70.0001)).toBe(true);
      expect(isConfluencePassed(-10)).toBe(false);
      expect(isConfluencePassed(0)).toBe(false);
      expect(isConfluencePassed(NaN)).toBe(false);
      expect(isConfluencePassed(undefined as any)).toBe(false);
      expect(isConfluencePassed(null as any)).toBe(false);
    });

    it('calculates 0 score when all 7 factors are at minimum values', () => {
      const zeroInput = ConfluenceEngine.calculate({
        priceChange5mPct: -50,   // <= 0 -> 0 momentum
        liquidityUsd: 1000,      // < 5000 -> 0 liquidity
        top10HoldersPct: 80,     // > 45 -> 0 distribution
        bondingCurveProgress: 10,// Heuristic fallback: progress < 40 -> 4 curve pts
        buys5m: 0,
        sells5m: 50,             // 0% buy ratio -> 0 imbalance
        devHoldingPct: 20,       // > 5% -> 0 dev risk pts
        hasVerifiedSocialCall: false, // 0 social
        socialCallCount: 0,
        slotAcceleration: 0,     // Overrides heuristic curve velocity -> 0 pts
        volume10sSol: 0,
        volume30sSol: 0,
        isCreatorBurner: true,   // Overrides creator score -> 0 pts
      });

      expect(zeroInput.momentumScore).toBe(0);
      expect(zeroInput.liquidityScore).toBe(0);
      expect(zeroInput.holderDistributionScore).toBe(0);
      expect(zeroInput.bondingCurveVelocityScore).toBe(0);
      expect(zeroInput.buySellImbalanceScore).toBe(0);
      expect(zeroInput.creatorRiskScore).toBe(0);
      expect(zeroInput.socialSignalScore).toBe(0);
      expect(zeroInput.compositeScore).toBe(0);
      expect(isConfluencePassed(zeroInput.compositeScore)).toBe(false);
    });

    it('calculates 100 score when all 7 factors are at maximum values', () => {
      const maxInput = ConfluenceEngine.calculate({
        priceChange5mPct: 50,    // >= 40 -> 20/20 momentum
        liquidityUsd: 100_000,   // >= 60000 -> 15/15 liquidity
        top10HoldersPct: 10,     // <= 15 -> 15/15 distribution
        bondingCurveProgress: 95,
        slotAcceleration: 1.0,   // 6 accel + 5 volume + 4 surge = 15/15 curve velocity
        volume10sSol: 5.0,
        volume30sSol: 10.0,
        buyVolume10sSol: 5.0,
        buys5m: 100,             // 100% buy ratio -> 20/20 imbalance
        sells5m: 0,
        devHoldingPct: 0.0,
        creatorWalletAgeSeconds: 86400 * 45, // Seasoned creator -> 5/5 creator risk
        creatorSignatureCount: 100,
        isCreatorBurner: false,
        hasVerifiedSocialCall: true, // >= 2 calls -> 10/10 social
        socialCallCount: 3,
      });

      expect(maxInput.momentumScore).toBe(20);
      expect(maxInput.liquidityScore).toBe(15);
      expect(maxInput.holderDistributionScore).toBe(15);
      expect(maxInput.bondingCurveVelocityScore).toBe(15);
      expect(maxInput.buySellImbalanceScore).toBe(20);
      expect(maxInput.creatorRiskScore).toBe(5);
      expect(maxInput.socialSignalScore).toBe(10);
      // Sum = 20 + 15 + 15 + 15 + 20 + 5 + 10 = 100
      expect(maxInput.compositeScore).toBe(100);
      expect(isConfluencePassed(maxInput.compositeScore)).toBe(true);
    });

    it('safely clamps composite score even if arithmetic components exceed theoretical sums', () => {
      const clamped = ConfluenceEngine.calculate({
        priceChange5mPct: 200,
        liquidityUsd: 1_000_000,
        top10HoldersPct: 0,
        bondingCurveProgress: 100,
        buys5m: 1000,
        sells5m: 0,
        devHoldingPct: 0,
        hasVerifiedSocialCall: true,
        socialCallCount: 100,
      });

      expect(clamped.compositeScore).toBeLessThanOrEqual(100);
      expect(clamped.socialSignalScore).toBe(10); // Capped at 10
      expect(clamped.momentumScore).toBe(20);     // Capped at 20
      expect(clamped.liquidityScore).toBe(15);    // Capped at 15
    });
  });

  // =========================================================================
  // 4. MemecoinAggregator & PumpFunService Hot Path Integration Stress
  // =========================================================================
  describe('Full Hot Path Integration: MemecoinAggregator & PumpFunService', () => {
    it('MemecoinAggregator rejects snipe with score 68 and allows snipe with score 73', async () => {
      // Pool with score ~68 (Momentum 15, Liquidity 10, Distribution 10, Curve 12, Imbalance 16, Dev 5 = 68)
      const borderlinePool68 = {
        id: 'pool-borderline-68',
        platform: 'PUMP_FUN' as const,
        chain: 'SOLANA' as const,
        symbol: 'BORDER68',
        name: 'Borderline 68 Token',
        contractAddress: 'Borderline68Mint1111111111111111111111111',
        priceUsd: 0.0001,
        priceNative: 0.000001,
        marketCapUsd: 100000,
        liquidityUsd: 40000,      // 10 pts
        bondingCurveProgress: 75, // 12 pts
        isMigrated: false,
        volume5mUsd: 15000,
        volume1hUsd: 50000,
        volume24hUsd: 200000,
        priceChange5mPct: 30.0,   // 15 pts
        priceChange1hPct: 45.0,
        buys5m: 80,
        sells5m: 20,              // 16 pts
        top10HoldersPct: 25.0,    // 10 pts
        devHoldingPct: 0.0,       // 5 pts (heuristic)
        isMintRevoked: true,
        isFreezeRevoked: true,
        isLpBurned: false,
        rugcheckScore: 'SAFE' as const,
        createdAgo: '12m ago',
        trendingRank: 0,          // 0 social pts
      };

      (memecoinAggregator as any).pools.unshift(borderlinePool68);

      // 1. With enforceConfluence = true -> Score is 68 -> REJECTED
      const evalRes = memecoinAggregator.evaluateTokenConfluence(borderlinePool68);
      expect(evalRes.score).toBe(68);
      expect(evalRes.passed).toBe(false);

      const rejectedSnipe = await memecoinAggregator.executeSnipe({
        contractAddress: borderlinePool68.contractAddress,
        amountUsd: 10,
        enforceConfluence: true,
      });
      expect(rejectedSnipe.success).toBe(false);
      expect(rejectedSnipe.message).toContain('REJECTED: Confluence score 68/100 failed minimum threshold of 70');

      // 2. Now boost token slightly (add verified social trending rank -> +5 social pts -> score 73)
      borderlinePool68.trendingRank = 3; // Rank 3 gives Math.max(1, 4 - 3) * 5 = 5 pts
      const evalRes73 = memecoinAggregator.evaluateTokenConfluence(borderlinePool68);
      expect(evalRes73.score).toBe(73);
      expect(evalRes73.passed).toBe(true);

      vi.spyOn(executionCoordinator, 'executeTrade').mockResolvedValueOnce({
        success: true,
        positionId: 'pos-test-73',
        txSignature: 'tx-test-73',
        executionMode: 'PAPER',
        lifecycleState: 'EXECUTED',
      } as any);

      const approvedSnipe = await memecoinAggregator.executeSnipe({
        contractAddress: borderlinePool68.contractAddress,
        amountUsd: 10,
        enforceConfluence: true,
      });
      expect(approvedSnipe.success).toBe(true);
      expect(approvedSnipe.confluenceScore).toBe(73);
    });

    it('respects global setConfluenceGating flag across all snipes', async () => {
      const borderlinePool = {
        id: 'pool-gating-test',
        platform: 'PUMP_FUN' as const,
        chain: 'SOLANA' as const,
        symbol: 'GATE',
        name: 'Gated Token',
        contractAddress: 'GatedMint11111111111111111111111111111111',
        priceUsd: 0.0001,
        priceNative: 0.000001,
        marketCapUsd: 50000,
        liquidityUsd: 10000,
        bondingCurveProgress: 50,
        isMigrated: false,
        volume5mUsd: 5000,
        volume1hUsd: 10000,
        volume24hUsd: 20000,
        priceChange5mPct: 5.0,
        priceChange1hPct: 10.0,
        buys5m: 10,
        sells5m: 10,
        top10HoldersPct: 40.0,
        devHoldingPct: 2.0,
        isMintRevoked: true,
        isFreezeRevoked: true,
        isLpBurned: false,
        rugcheckScore: 'SAFE' as const,
        createdAgo: '5m ago',
        trendingRank: 0,
      };

      (memecoinAggregator as any).pools.unshift(borderlinePool);

      // When gating is enabled globally
      memecoinAggregator.setConfluenceGating(true);
      expect(memecoinAggregator.getConfluenceGating()).toBe(true);

      const rejectedResult = await memecoinAggregator.executeSnipe({
        contractAddress: borderlinePool.contractAddress,
        amountUsd: 5,
        // No explicit enforceConfluence passed! Global gate should reject
      });
      expect(rejectedResult.success).toBe(false);
      expect(rejectedResult.message).toContain('failed minimum threshold of 70');

      // When gating is disabled globally
      memecoinAggregator.setConfluenceGating(false);
      vi.spyOn(executionCoordinator, 'executeTrade').mockResolvedValueOnce({
        success: true,
        positionId: 'pos-test-nogate',
        txSignature: 'tx-test-nogate',
        executionMode: 'PAPER',
        lifecycleState: 'EXECUTED',
      } as any);

      const allowedResult = await memecoinAggregator.executeSnipe({
        contractAddress: borderlinePool.contractAddress,
        amountUsd: 5,
      });
      expect(allowedResult.success).toBe(true);
    });

    it('supports custom minConfluenceScore parameter overrides', async () => {
      const goodPool = {
        id: 'pool-high-bar',
        platform: 'PUMP_FUN' as const,
        chain: 'SOLANA' as const,
        symbol: 'HIGHBAR',
        name: 'High Bar Token',
        contractAddress: 'HighBarMint1111111111111111111111111111111',
        priceUsd: 0.0005,
        priceNative: 0.000003,
        marketCapUsd: 300000,
        liquidityUsd: 50000,
        bondingCurveProgress: 80,
        isMigrated: false,
        volume5mUsd: 30000,
        volume1hUsd: 100000,
        volume24hUsd: 500000,
        priceChange5mPct: 25.0,
        priceChange1hPct: 50.0,
        buys5m: 70,
        sells5m: 20,
        top10HoldersPct: 15.0,
        devHoldingPct: 0.0,
        isMintRevoked: true,
        isFreezeRevoked: true,
        isLpBurned: false,
        rugcheckScore: 'SAFE' as const,
        createdAgo: '8m ago',
        trendingRank: 2,
      };

      (memecoinAggregator as any).pools.unshift(goodPool);

      // Score is ~75. Default threshold (70) passes, but custom threshold (85) rejects
      const result = await memecoinAggregator.executeSnipe({
        contractAddress: goodPool.contractAddress,
        amountUsd: 5,
        enforceConfluence: true,
        minConfluenceScore: 85, // Require extra high conviction
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('failed minimum threshold of 85');
    });

    it('ingestOnChainCreateEvent populates curveVelocityEvaluator and affects confluence score', () => {
      const event: PumpCreateEvent = {
        signature: 'sig-pump-create-1',
        slot: 123456,
        mint: MINT_B,
        bondingCurve: 'CurveAddr111111111111111111111111111111111',
        creator: CREATOR_ADDR,
        initialPriceSol: 0.00000003,
        initialMarketCapSol: 30,
        realSolReserves: 30_000_000_000n, // 30 SOL
        virtualTokenReserves: 1_000_000_000_000_000n,
        virtualSolReserves: 30_000_000_000n,
        realTokenReserves: 793_100_000_000_000n,
        tokenTotalSupply: 1_000_000_000_000_000n,
        name: 'Pump Meme',
        symbol: 'PMEME',
        uri: 'https://pump.fun/metadata.json',
        receivedAt: Date.now(),
        parsedAt: Date.now(),
        parseLatencyMs: 1,
        source: 'SOLANA_WS_LOGS',
      };

      expect(curveVelocityEvaluator.hasData(MINT_B)).toBe(false);

      // Ingest event
      memecoinAggregator.ingestOnChainCreateEvent(event);

      // CurveVelocityEvaluator now has transition recorded
      expect(curveVelocityEvaluator.hasData(MINT_B)).toBe(true);
      const metrics = curveVelocityEvaluator.getMetrics(MINT_B);
      expect(metrics.transitionCount).toBe(1);
      expect(metrics.lastSlot).toBe(123456);
    });

    it('PumpFunService: does not auto-snipe when confluenceCount is high but composite score < 70', async () => {
      const mockCallout: PumpFunHotCallout = {
        id: 'callout-adversarial-low',
        calloutId: 'adv-low-1',
        caller: {
          userId: 'low_caller',
          userUuid: 'u-low',
          primaryWallet: CREATOR_ADDR,
          avatarUrl: '',
          totalCallouts: 10,
          avgMultiple: 1.1,
          medianMultiple: 1.0,
          winRate1_2x: 30,
          winRate1_5x: 10,
          winRate2x: 5,
          avgTimeToPeakMs: 600_000,
          followersCount: 50,
          totalVolumeDrivenUsd: 1000,
          reputationTier: 'EMERGING_CALLER',
          isAutoSnipeSubscribed: false, // NOT subscribed
          topCallouts: [],
        },
        token: {
          mint: 'LowMemeMint11111111111111111111111111111111',
          symbol: 'LOWMEME',
          name: 'Low Meme',
          imageUri: '',
          description: '',
          bondingCurveProgress: 5, // very low
          bondingCurveAddress: '',
          creator: CREATOR_ADDR,
          calloutPriceUsd: 0.00001,
          currentPriceUsd: 0.00001,
          marketCapAtCalloutUsd: 5000,
          currentMarketCapUsd: 5000,
          athPriceSol: 0.00001,
          peakMultiple: 1.0,
          currentMultiple: 1.0,
          complete: false,
          volume5mUsd: 50,
          buys5m: 1,
          sells5m: 20,
          top10HoldersPct: 80.0,
          devHoldingPct: 15.0,
          isMintRevoked: false,
          isFreezeRevoked: false,
          rugcheckScore: 'DANGEROUS',
          createdTimestamp: Date.now() - 5000,
          timeAgoStr: '5s ago',
        },
        calloutTimestamp: Date.now() - 5000,
        calloutNote: 'Dump callout',
        confluenceCount: 5, // 5 callers called it!
        hftAction: 'INSTANT_SNIPE',
        decayWindowSecondsRemaining: 90,
        status: 'ACTIVE',
      };

      (pumpfunService as any).hotCallouts = [mockCallout];
      const snipeSpy = vi.spyOn(memecoinAggregator, 'executeSnipe');

      await (pumpfunService as any).evaluateAutoSnipeTriggers();

      // Even with 5 callers, composite score is poor (< 70) so snipe is BLOCKED
      expect(snipeSpy.mock.calls.length).toBe(0);
      expect(mockCallout.status).toBe('ACTIVE');
    });

    it('PumpFunService: triggers auto-snipe when confluenceCount >= 2 and composite score >= 70', async () => {
      const highQualityCallout: PumpFunHotCallout = {
        id: 'callout-adversarial-high',
        calloutId: 'adv-high-1',
        caller: {
          userId: 'alpha_caller',
          userUuid: 'u-alpha',
          primaryWallet: CREATOR_ADDR,
          avatarUrl: '',
          totalCallouts: 50,
          avgMultiple: 3.5,
          medianMultiple: 2.2,
          winRate1_2x: 75,
          winRate1_5x: 60,
          winRate2x: 45,
          avgTimeToPeakMs: 250_000,
          followersCount: 5000,
          totalVolumeDrivenUsd: 500_000,
          reputationTier: 'LEGENDARY_WHALE',
          isAutoSnipeSubscribed: false, // NOT subscribed -> tests confluence path directly!
          topCallouts: [],
        },
        token: {
          mint: 'HighQualityMint1111111111111111111111111111',
          symbol: 'HIGHQ',
          name: 'High Quality Meme',
          imageUri: '',
          description: '',
          bondingCurveProgress: 92,
          bondingCurveAddress: '',
          creator: CREATOR_ADDR,
          calloutPriceUsd: 0.0001,
          currentPriceUsd: 0.00025,
          marketCapAtCalloutUsd: 15000,
          currentMarketCapUsd: 35000,
          athPriceSol: 0.0005,
          peakMultiple: 1.25,
          currentMultiple: 1.25,
          complete: false,
          volume5mUsd: 30000,
          priceChange5mPct: 40, // B3: measured 5m change; missing data scores 0 and is no longer derived from the multiple
          buys5m: 90,
          sells5m: 10,
          top10HoldersPct: 12.0,
          devHoldingPct: 0.0,
          isMintRevoked: true,
          isFreezeRevoked: true,
          rugcheckScore: 'SAFE',
          createdTimestamp: Date.now() - 30_000,
          timeAgoStr: '30s ago',
        },
        calloutTimestamp: Date.now() - 20_000,
        calloutNote: 'Confirmed Alpha',
        confluenceCount: 3, // Confluence >= 2
        hftAction: 'INSTANT_SNIPE',
        decayWindowSecondsRemaining: 70,
        status: 'ACTIVE',
      };

      (pumpfunService as any).hotCallouts = [highQualityCallout];
      const snipeSpy = vi.spyOn(memecoinAggregator, 'executeSnipe').mockResolvedValueOnce({
        success: true,
        message: 'Snipe triggered',
        txHash: 'tx-snipe-confluence-ok',
      });

      await (pumpfunService as any).evaluateAutoSnipeTriggers();

      // Triggered snipe through confluence path
      expect(snipeSpy).toHaveBeenCalledTimes(1);
      expect(snipeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          contractAddress: highQualityCallout.token.mint,
          enforceConfluence: true,
          provenance: 'REAL_SOCIAL',
        })
      );
      expect(highQualityCallout.status).toBe('SNIPED');
    });
  });
});
