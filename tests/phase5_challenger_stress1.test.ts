import { seedSurge } from './fixtures/velocity';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
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
  ConfluenceFactorsInput,
} from '../server/signals/confluenceEngine';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { pumpfunService } from '../server/pumpfunService';
import { executionCoordinator } from '../server/execution/coordinator';
import { PumpFunHotCallout } from '../src/types';

describe('Adversarial Stress & Empirical Challenge Suite: Alpha Pipeline Integration (B14)', () => {
  const MINT_A = 'ApexStressToken1111111111111111111111111111';
  const MINT_B = 'ApexStressToken2222222222222222222222222222';
  const CREATOR_ADDR = '7xK9nMQk3mPzV1W8L5tG7yD2jX4vB6nS8cF9eR3tY1uQ';

  beforeEach(() => {
    curveVelocityEvaluator.clear();
    creatorRiskScorer.clearCache();
    memecoinAggregator.setConfluenceGating(false);
  });

  // =========================================================================
  // Dimension 1: CurveVelocityEvaluator Stress & Anomaly Harnesses
  // =========================================================================
  describe('Dimension 1: CurveVelocityEvaluator Adversarial Stress', () => {
    it('handles out-of-order block arrivals by maintaining strict ascending slot order', () => {
      const evaluator = new CurveVelocityEvaluator();
      const mint = MINT_A;

      // Ingest out-of-order slots: 1020, then 1010, then 1030, then 1000
      evaluator.recordTransition(mint, 1020, 20.0, 102_000);
      evaluator.recordTransition(mint, 1010, 15.0, 101_000);
      evaluator.recordTransition(mint, 1030, 25.0, 103_000);
      evaluator.recordTransition(mint, 1000, 10.0, 100_000);

      const metrics = evaluator.getMetrics(mint, 103_000);

      // Latest two transitions should be 1020 (20.0 SOL) and 1030 (25.0 SOL)
      // Delta SOL = 5.0, Delta slots = 10 -> v = 0.5 SOL/slot
      expect(metrics.lastSlot).toBe(1030);
      expect(metrics.slotAcceleration).toBe(0.5);
      expect(metrics.transitionCount).toBe(4);
      expect(metrics.velocityScore).toBeGreaterThanOrEqual(6);
    });

    it('survives zero-slot differences (deltaSlots = 0) without division-by-zero or NaN', () => {
      const evaluator = new CurveVelocityEvaluator();
      const mint = MINT_A;

      // Two updates in the exact same slot (e.g. multi-instruction bundle)
      evaluator.recordTransition(mint, 5000, 10.0, 100_000);
      evaluator.recordTransition(mint, 5000, 14.5, 100_050);

      const metrics = evaluator.getMetrics(mint, 100_050);
      expect(metrics.lastSlot).toBe(5000);
      expect(Number.isFinite(metrics.slotAcceleration)).toBe(true);
      expect(isNaN(metrics.slotAcceleration)).toBe(false);
      // Fallback: deltaSol > 0 ? deltaSol : 0
      expect(metrics.slotAcceleration).toBe(4.5);
      expect(metrics.velocityScore).toBeGreaterThanOrEqual(6);
    });

    it('handles same-slot sell (deltaSlots = 0, deltaSol < 0) safely with 0 acceleration', () => {
      const evaluator = new CurveVelocityEvaluator();
      const mint = MINT_A;

      evaluator.recordTransition(mint, 5000, 10.0, 100_000);
      evaluator.recordTransition(mint, 5000, 7.5, 100_050);

      const metrics = evaluator.getMetrics(mint, 100_050);
      expect(metrics.slotAcceleration).toBe(0);
      expect(metrics.velocityScore).toBe(0);
      expect(metrics.isSurging).toBe(false);
    });

    it('handles massive slot gaps (500,000 slots) with ultra-small acceleration without underflow error', () => {
      const evaluator = new CurveVelocityEvaluator();
      const mint = MINT_A;

      evaluator.recordTransition(mint, 1_000_000, 30.0, 100_000);
      evaluator.recordTransition(mint, 1_500_000, 40.0, 300_000);

      const metrics = evaluator.getMetrics(mint, 300_000);
      // deltaSol = 10, deltaSlots = 500,000 -> 10 / 500,000 = 0.00002
      expect(metrics.slotAcceleration).toBe(0.00002);
      expect(metrics.slotAcceleration).toBeGreaterThan(0);
      expect(metrics.velocityScore).toBe(1); // slotAcceleration > 0 gives 1 point
    });

    it('stress-tests extreme buy surge (1,000,000 SOL reserves added) and caps score at 15', () => {
      const evaluator = new CurveVelocityEvaluator();
      const mint = MINT_A;
      const now = 200_000;

      evaluator.recordTransition(mint, 1000, 30.0, now - 5_000);
      evaluator.recordTransition(mint, 1005, 1_000_030.0, now);

      evaluator.recordTradeFlow(mint, 1_000_000.0, true, now - 1_000);

      const metrics = evaluator.getMetrics(mint, now);
      expect(metrics.slotAcceleration).toBe(200_000);
      expect(metrics.velocityScore).toBe(15); // Capped at max 15
      expect(metrics.normalizedScore).toBe(100); // Capped at max 100
      expect(metrics.isSurging).toBe(true);
    });

    it('stress-tests massive reserve dump without trade flows and yields 0 velocity score', () => {
      const evaluator = new CurveVelocityEvaluator();
      const mint = MINT_A;
      const now = 200_000;

      // Curve reserves dump 5,000 SOL across 10 slots with no trade flows recorded
      evaluator.recordTransition(mint, 2000, 5030.0, now - 5_000);
      evaluator.recordTransition(mint, 2010, 30.0, now);

      const metrics = evaluator.getMetrics(mint, now);
      expect(metrics.slotAcceleration).toBe(-500);
      expect(metrics.velocityScore).toBe(0); // 0 accel + 0 volume + 0 surge = 0
      expect(metrics.isSurging).toBe(false);
    });

    it('verifies that sell-only volume awards flow activity but strictly zeroes surge points and flags isSurging=false', () => {
      const evaluator = new CurveVelocityEvaluator();
      const mint = MINT_A;
      const now = 200_000;

      evaluator.recordTransition(mint, 2000, 5030.0, now - 5_000);
      evaluator.recordTransition(mint, 2010, 30.0, now); // Net sell
      evaluator.recordTradeFlow(mint, 5000.0, false, now - 2_000); // 100% sell

      const metrics = evaluator.getMetrics(mint, now);
      expect(metrics.slotAcceleration).toBe(-500);
      expect(metrics.buyRatio10s).toBe(0);
      expect(metrics.buyVolume10sSol).toBe(0);
      expect(metrics.isSurging).toBe(false);
      // Volume points = 5 (due to high raw liquidity turnover), but surgePoints = 0, accelPoints = 0
      expect(metrics.velocityScore).toBe(5);
    });

    it('returns clean zero state for empty evaluator or single-transition mint', () => {
      const evaluator = new CurveVelocityEvaluator();
      const emptyMetrics = evaluator.getMetrics(MINT_A);

      expect(emptyMetrics.slotAcceleration).toBe(0);
      expect(emptyMetrics.windowVelocitySolPerSec).toBe(0);
      expect(emptyMetrics.volume10sSol).toBe(0);
      expect(emptyMetrics.volume30sSol).toBe(0);
      expect(emptyMetrics.velocityScore).toBe(0);
      expect(emptyMetrics.normalizedScore).toBe(0);
      expect(emptyMetrics.isSurging).toBe(false);
      expect(emptyMetrics.transitionCount).toBe(0);

      evaluator.recordTransition(MINT_A, 777, 10.0, 100_000);
      const singleMetrics = evaluator.getMetrics(MINT_A, 100_000);
      expect(singleMetrics.slotAcceleration).toBe(0);
      expect(singleMetrics.transitionCount).toBe(1);
      expect(singleMetrics.lastSlot).toBe(777);
    });

    it('verifies exact boundary condition at 10,000ms and 30,000ms sliding windows', () => {
      const evaluator = new CurveVelocityEvaluator();
      const mint = MINT_A;
      const now = 100_000;

      // Exactly at 10s boundary (timestamp = 90,000): MUST be included in 10s window (>= 90_000)
      evaluator.recordTradeFlow(mint, 1.0, true, now - 10_000);

      // Exactly 1ms past 10s boundary (timestamp = 89,999): Excluded from 10s, included in 30s
      evaluator.recordTradeFlow(mint, 2.0, true, now - 10_001);

      // Exactly at 30s boundary (timestamp = 70,000): MUST be included in 30s window (>= 70_000)
      evaluator.recordTradeFlow(mint, 4.0, false, now - 30_000);

      // Exactly 1ms past 30s boundary (timestamp = 69,999): Excluded from both
      evaluator.recordTradeFlow(mint, 8.0, true, now - 30_001);

      const metrics = evaluator.getMetrics(mint, now);

      // 10s window includes ONLY the 1.0 SOL trade at 90_000
      expect(metrics.volume10sSol).toBe(1.0);
      expect(metrics.buyVolume10sSol).toBe(1.0);

      // 30s window includes 1.0 SOL + 2.0 SOL + 4.0 SOL = 7.0 SOL
      expect(metrics.volume30sSol).toBe(7.0);
      expect(metrics.buyVolume30sSol).toBe(3.0); // 1.0 + 2.0
    });

    it('sanitizes negative trade flow volumes and avoids NaN', () => {
      const evaluator = new CurveVelocityEvaluator();
      const mint = MINT_A;
      const now = 50_000;

      // Ingest negative volume
      evaluator.recordTradeFlow(mint, -10.5, true, now - 1_000);
      const metrics = evaluator.getMetrics(mint, now);

      expect(metrics.volume10sSol).toBe(0);
      expect(metrics.buyVolume10sSol).toBe(0);
    });

    it('enforces circular buffer capacity under high-frequency stream without unbounded growth', () => {
      const evaluator = new CurveVelocityEvaluator();
      const mint = MINT_A;

      // Ingest 250 transitions (max is 120)
      for (let i = 0; i < 250; i++) {
        evaluator.recordTransition(mint, 1000 + i, 10 + i * 0.1, 100_000 + i * 400);
      }

      // Ingest 800 trade flows (max is 600)
      for (let i = 0; i < 800; i++) {
        evaluator.recordTradeFlow(mint, 0.1, true, 100_000 + i * 100);
      }

      const metrics = evaluator.getMetrics(mint, 200_000);
      expect(metrics.transitionCount).toBe(120); // Capped at max 120
      expect(metrics.lastSlot).toBe(1249);
    });
  });

  // =========================================================================
  // Dimension 2: CreatorRiskScorer Edge Cases & Burner Wallet Harnesses
  // =========================================================================
  describe('Dimension 2: CreatorRiskScorer Adversarial Edge Cases', () => {
    it('penalizes empty transaction history to riskScore = 0 and confluenceScore = 0', () => {
      const scorer = new CreatorRiskScorer();
      const report = scorer.evaluateSignatures(CREATOR_ADDR, []);

      expect(report.riskScore).toBe(0);
      expect(report.confluenceScore).toBe(0);
      expect(report.isBurner).toBe(true);
      expect(report.isFreshWallet).toBe(true);
      expect(report.signatureCount).toBe(0);
      expect(report.riskFlags).toContain('NO_TRANSACTION_HISTORY');
      expect(report.riskFlags).toContain('FRESH_BURNER_WALLET');
    });

    it('gracefully handles signatures with null/undefined blockTime without NaN', () => {
      const scorer = new CreatorRiskScorer();
      const nowSec = 1_700_000_000;

      const signatures: ConfirmedSignatureInfo[] = [
        { signature: 'sig1', slot: 100, err: null, memo: null, blockTime: null },
        { signature: 'sig2', slot: 99, err: null, memo: null, blockTime: undefined },
      ];

      const report = scorer.evaluateSignatures(CREATOR_ADDR, signatures, nowSec);

      expect(isNaN(report.walletAgeSeconds)).toBe(false);
      expect(report.walletAgeSeconds).toBe(0);
      expect(report.isFreshWallet).toBe(true);
      expect(report.isBurner).toBe(true);
      expect(report.confluenceScore).toBe(0);
    });

    it('handles future blockTime timestamps (clock skew) safely without negative wallet age', () => {
      const scorer = new CreatorRiskScorer();
      const nowSec = 1_700_000_000;

      // Node clock or validator reported timestamp 5,000s in the future
      const signatures: ConfirmedSignatureInfo[] = [
        { signature: 'sig1', slot: 200, err: null, memo: null, blockTime: nowSec + 5000 },
        { signature: 'sig2', slot: 190, err: null, memo: null, blockTime: nowSec + 5000 },
      ];

      const report = scorer.evaluateSignatures(CREATOR_ADDR, signatures, nowSec);

      expect(report.walletAgeSeconds).toBe(0);
      expect(report.isFreshWallet).toBe(true);
      expect(report.isBurner).toBe(true);
      expect(report.confluenceScore).toBe(0);
    });

    it('detects high-frequency deploy-and-drain pattern (4 txs within 2 minutes)', () => {
      const scorer = new CreatorRiskScorer();
      const nowSec = 1_700_000_000;

      // Wallet created 120s ago, deployed token, drained liquidity in 4 txs
      const signatures: ConfirmedSignatureInfo[] = [
        { signature: 'sig4', slot: 104, err: null, memo: null, blockTime: nowSec - 10 },
        { signature: 'sig3', slot: 103, err: null, memo: null, blockTime: nowSec - 40 },
        { signature: 'sig2', slot: 102, err: null, memo: null, blockTime: nowSec - 80 },
        { signature: 'sig1', slot: 101, err: null, memo: null, blockTime: nowSec - 120 },
      ];

      const report = scorer.evaluateSignatures(CREATOR_ADDR, signatures, nowSec);

      expect(report.hasDrainPattern).toBe(true);
      expect(report.isBurner).toBe(true);
      expect(report.confluenceScore).toBe(0);
      expect(report.riskFlags).toContain('RAPID_DEPLOY_AND_DRAIN');
      expect(report.riskFlags).toContain('FRESH_BURNER_WALLET');
    });

    it('flags high transaction failure rate (> 40% failures) and zeros reliability points', () => {
      const scorer = new CreatorRiskScorer();
      const nowSec = 1_700_000_000;
      const walletAge = 86400 * 10; // 10 days old

      // 10 transactions where 6 failed
      const signatures: ConfirmedSignatureInfo[] = Array.from({ length: 10 }, (_, i) => ({
        signature: `sig_${i}`,
        slot: 1000 + i,
        err: i < 6 ? { InstructionError: [0, 'Custom'] } : null,
        memo: null,
        blockTime: nowSec - walletAge + i * 3600,
      })).reverse();

      const report = scorer.evaluateSignatures(CREATOR_ADDR, signatures, nowSec);

      expect(report.failedTxCount).toBe(6);
      expect(report.riskFlags).toContain('HIGH_FAILURE_RATE');
      // Even though wallet is 10 days old, failure rate reduces score
      expect(report.riskScore).toBeLessThan(60);
    });

    it('awards max score (100) and confluence 5/5 to high-reputation seasoned creator', () => {
      const scorer = new CreatorRiskScorer();
      const nowSec = 1_700_000_000;
      const walletAge = 86400 * 60; // 60 days old

      // 60 successful transactions
      const signatures: ConfirmedSignatureInfo[] = Array.from({ length: 60 }, (_, i) => ({
        signature: `sig_seasoned_${i}`,
        slot: 5000 + i,
        err: null,
        memo: null,
        blockTime: nowSec - walletAge + i * 86400,
      })).reverse();

      const report = scorer.evaluateSignatures(CREATOR_ADDR, signatures, nowSec);

      expect(report.isBurner).toBe(false);
      expect(report.isFreshWallet).toBe(false);
      expect(report.hasDrainPattern).toBe(false);
      expect(report.riskScore).toBe(100);
      expect(report.confluenceScore).toBe(5);
    });

    it('handles RPC network errors conservatively with fallback burner report', async () => {
      const scorer = new CreatorRiskScorer();
      const mockFailingConnection = {
        getSignaturesForAddress: vi.fn().mockRejectedValue(new Error('RPC 429 Too Many Requests')),
      };

      const report = await scorer.evaluateCreator(mockFailingConnection, CREATOR_ADDR);

      expect(report.isBurner).toBe(true);
      expect(report.confluenceScore).toBe(0); // C2: a failed lookup earns no points
      expect(report.riskScore).toBe(30);
      expect(report.riskFlags).toContain('RPC_HISTORY_QUERY_FAILED');
      expect(report.details).toContain('RPC error querying creator history');
    });

    it('respects bypassCache option during RPC evaluations', async () => {
      const scorer = new CreatorRiskScorer();
      const mockRpc = {
        getSignaturesForAddress: vi.fn().mockResolvedValue([
          { signature: 'sig1', slot: 100, err: null, memo: null, blockTime: 1_700_000_000 - 86400 * 10 },
        ]),
      };

      // Call 1: Populates cache
      await scorer.evaluateCreator(mockRpc, CREATOR_ADDR);
      expect(mockRpc.getSignaturesForAddress).toHaveBeenCalledTimes(1);

      // Call 2: Uses cache
      await scorer.evaluateCreator(mockRpc, CREATOR_ADDR);
      expect(mockRpc.getSignaturesForAddress).toHaveBeenCalledTimes(1);

      // Call 3: bypassCache forces RPC invocation
      await scorer.evaluateCreator(mockRpc, CREATOR_ADDR, { bypassCache: true });
      expect(mockRpc.getSignaturesForAddress).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // Dimension 3: ConfluenceEngine Boundary Values & Saturation Harnesses
  // =========================================================================
  describe('Dimension 3: ConfluenceEngine Boundary Values & Score Saturation', () => {
    it('strictly tests isConfluencePassed boundary condition at 70.0', () => {
      expect(isConfluencePassed(69.999)).toBe(false);
      expect(isConfluencePassed(69.9999999)).toBe(false);
      expect(isConfluencePassed(70.0)).toBe(true);
      expect(isConfluencePassed(70.000001)).toBe(true);
      expect(isConfluencePassed(100)).toBe(true);

      // Adversarial inputs
      expect(isConfluencePassed(NaN)).toBe(false);
      expect(isConfluencePassed(undefined as any)).toBe(false);
      expect(isConfluencePassed(null as any)).toBe(false);
      expect(isConfluencePassed(-50)).toBe(false);
      expect(isConfluencePassed('75' as any)).toBe(false);
    });

    it('clamps composite score strictly between 0 and 100 under extreme parameter saturation', () => {
      // Overwhelmingly positive factors
      const maxInput: ConfluenceFactorsInput = {
        priceChange5mPct: 500.0, // max 20 pts
        liquidityUsd: 10_000_000, // max 15 pts
        top10HoldersPct: 2.0,    // max 15 pts
        bondingCurveProgress: 99.0, curveVelocityMetrics: { velocityScore: 15 } as any, // C2: measured velocity stands in for the removed progress fallback // max 15 pts
        buys5m: 5000,
        sells5m: 10,             // max 20 pts
        devHoldingPct: 0.0,      // max 5 pts
        hasVerifiedSocialCall: true,
        socialCallCount: 10,     // max 10 pts
      };

      const maxBreakdown = ConfluenceEngine.calculate(maxInput);
      expect(maxBreakdown.compositeScore).toBe(100);
      expect(isConfluencePassed(maxBreakdown.compositeScore)).toBe(true);

      // Worst possible factors
      const minInput: ConfluenceFactorsInput = {
        priceChange5mPct: -95.0,
        liquidityUsd: 0,
        top10HoldersPct: 98.0,
        bondingCurveProgress: 5.0,
        buys5m: 0,
        sells5m: 500,
        devHoldingPct: 50.0,
        hasVerifiedSocialCall: false,
        socialCallCount: 0,
        isCreatorBurner: true,
        slotAcceleration: -50.0,
        volume10sSol: 0,
      };

      const minBreakdown = ConfluenceEngine.calculate(minInput);
      expect(minBreakdown.compositeScore).toBeLessThanOrEqual(5);
      expect(minBreakdown.compositeScore).toBeGreaterThanOrEqual(0);
      expect(isConfluencePassed(minBreakdown.compositeScore)).toBe(false);
    });

    it('verifies that burner wallet penalty can cause a marginal token to fail the >= 70 threshold', () => {
      // Base token with moderate momentum, liquidity, distribution, curve, orderflow
      // Momentum: 15/20, Liquidity: 12/15, Holder: 15/15, Curve: 15/15, Imbalance: 10/20 = 67 pts
      const baseInput: ConfluenceFactorsInput = {
        priceChange5mPct: 30.0,  // Math.round((30/40)*20) = 15
        liquidityUsd: 48_000,    // Math.round((48000/60000)*15) = 12
        top10HoldersPct: 10.0,   // <= 15 -> 15
        bondingCurveProgress: 92, curveVelocityMetrics: { velocityScore: 15 } as any, // C2: measured velocity stands in for the removed progress fallback// >= 90 -> 15
        buys5m: 25,
        sells5m: 25,             // buyRatio 0.5 -> 10
        devHoldingPct: 0,
        hasVerifiedSocialCall: false,
        socialCallCount: 0,
      };

      // Case A: Seasoned creator wallet (+5 pts) -> 67 + 5 = 72 (PASSES >= 70)
      const seasonedInput: ConfluenceFactorsInput = {
        ...baseInput,
        creatorWalletAgeSeconds: 86400 * 30,
        creatorSignatureCount: 100,
        isCreatorBurner: false,
      };
      const seasonedRes = ConfluenceEngine.evaluate(seasonedInput);
      expect(seasonedRes.compositeScore).toBe(72);
      expect(seasonedRes.passed).toBe(true);

      // Case B: Burner wallet (0 pts) -> 67 + 0 = 67 (FAILS < 70)
      const burnerInput: ConfluenceFactorsInput = {
        ...baseInput,
        creatorWalletAgeSeconds: 300,
        creatorSignatureCount: 2,
        isCreatorBurner: true,
      };
      const burnerRes = ConfluenceEngine.evaluate(burnerInput);
      expect(burnerRes.compositeScore).toBe(67);
      expect(burnerRes.passed).toBe(false);
    });
  });

  // =========================================================================
  // Dimension 4: MemecoinAggregator Execution Gating Integration
  // =========================================================================
  describe('Dimension 4: MemecoinAggregator Confluence Gating Enforcement', () => {
    it('strictly blocks trade when enforceConfluence is true and score is 69 or below', async () => {
      const lowScoreMint = 'LowScoreToken11111111111111111111111111111';
      const lowScorePool = {
        id: 'pool-low-score',
        platform: 'PUMP_FUN' as const,
        chain: 'SOLANA' as const,
        name: 'Low Score Token',
        symbol: 'LOW',
        contractAddress: lowScoreMint,
        priceUsd: 0.001,
        priceNative: 0.000007,
        marketCapUsd: 20_000,
        liquidityUsd: 20_000,
        volume24hUsd: 50_000,
        volume1hUsd: 10_000,
        volume5mUsd: 2_000,
        priceChange24hPct: 5,
        priceChange1hPct: 5,
        priceChange5mPct: 15,
        bondingCurveProgress: 50,
        devHoldingPct: 2.0,
        top10HoldersPct: 35,
        buys5m: 12,
        sells5m: 8,
        createdAt: Date.now() - 3600_000,
        createdAgo: '1h ago',
        isMintRevoked: true,
        isFreezeRevoked: true,
        isLpBurned: false,
        isMigrated: false,
        rugcheckScore: 'SAFE' as const,
        trendingRank: 0,
      };
      (memecoinAggregator as any).pools.unshift(lowScorePool);

      const execSpy = vi.spyOn(executionCoordinator, 'executeTrade');

      const result = await memecoinAggregator.executeSnipe({
        contractAddress: lowScoreMint,
        amountUsd: 50,
        enforceConfluence: true,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('REJECTED: Confluence score');
      expect(result.message).toContain('failed minimum threshold of 70');
      expect(result.confluenceScore).toBeLessThan(70);
      expect(execSpy).toHaveBeenCalledTimes(0);

      execSpy.mockRestore();
    });

    it('permits trade execution when enforceConfluence is true and score is >= 70', async () => {
      const highScoreMint = 'HighScoreToken11111111111111111111111111111';
      const highScorePool = {
        id: 'pool-high-score',
        platform: 'PUMP_FUN' as const,
        chain: 'SOLANA' as const,
        name: 'High Score Token',
        symbol: 'HIGH',
        contractAddress: highScoreMint,
        priceUsd: 0.005,
        priceNative: 0.000035,
        marketCapUsd: 200_000,
        liquidityUsd: 65_000,
        volume24hUsd: 500_000,
        volume1hUsd: 100_000,
        volume5mUsd: 25_000,
        priceChange24hPct: 40,
        priceChange1hPct: 20,
        priceChange5mPct: 38,
        bondingCurveProgress: 95,
        devHoldingPct: 0.0,
        top10HoldersPct: 12,
        buys5m: 90,
        sells5m: 10,
        trendingRank: 1,
        createdAt: Date.now() - 3600_000,
        createdAgo: '1h ago',
        isMintRevoked: true,
        isFreezeRevoked: true,
        isLpBurned: false,
        isMigrated: false,
        rugcheckScore: 'SAFE' as const,
      };
      (memecoinAggregator as any).pools.unshift(highScorePool);

      const execSpy = vi.spyOn(executionCoordinator, 'executeTrade').mockResolvedValueOnce({
        success: true,
        positionId: 'ord-stress-01',
        txSignature: '5xStressTxHashApproved',
        executionMode: 'PAPER',
        lifecycleState: 'EXECUTED',
        correlationId: 'cid-stress-1',
      } as any);

      const result = await memecoinAggregator.executeSnipe({
        contractAddress: highScoreMint,
        amountUsd: 50,
        enforceConfluence: true,
      });

      expect(result.success).toBe(true);
      expect(result.confluenceScore).toBeGreaterThanOrEqual(70);
      expect(execSpy).toHaveBeenCalledTimes(1);

      execSpy.mockRestore();
    });

    it('supports custom minConfluenceScore thresholds (e.g. 80.0)', async () => {
      const customMint = 'CustomScoreToken111111111111111111111111111';
      const customPool = {
        id: 'pool-custom-score',
        platform: 'PUMP_FUN' as const,
        chain: 'SOLANA' as const,
        name: 'Custom Score Token',
        symbol: 'CUST',
        contractAddress: customMint,
        priceUsd: 0.002,
        priceNative: 0.000014,
        marketCapUsd: 80_000,
        liquidityUsd: 50_000,
        volume24hUsd: 150_000,
        volume1hUsd: 50_000,
        volume5mUsd: 12_000,
        priceChange24hPct: 20,
        priceChange1hPct: 10,
        priceChange5mPct: 25,
        bondingCurveProgress: 80,
        devHoldingPct: 0.0,
        top10HoldersPct: 20,
        buys5m: 35,
        sells5m: 15,
        createdAt: Date.now() - 3600_000,
        createdAgo: '1h ago',
        isMintRevoked: true,
        isFreezeRevoked: true,
        isLpBurned: false,
        isMigrated: false,
        rugcheckScore: 'SAFE' as const,
        trendingRank: 0,
      };
      (memecoinAggregator as any).pools.unshift(customPool);

      seedSurge(customMint); // C2: velocity must be measured
      const evalScore = memecoinAggregator.evaluateTokenConfluence(customMint).score;
      expect(evalScore).toBeGreaterThanOrEqual(60);
      expect(evalScore).toBeLessThan(85);

      // Require score >= 90 (which fails)
      const resFail = await memecoinAggregator.executeSnipe({
        contractAddress: customMint,
        amountUsd: 50,
        enforceConfluence: true,
        minConfluenceScore: 90,
      });
      expect(resFail.success).toBe(false);
      expect(resFail.message).toContain('failed minimum threshold of 90');

      // Require score >= 50 (which passes)
      const execSpy = vi.spyOn(executionCoordinator, 'executeTrade').mockResolvedValueOnce({
        success: true,
        positionId: 'ord-stress-custom',
        txSignature: '5xCustomPassed',
        executionMode: 'PAPER',
        lifecycleState: 'EXECUTED',
        correlationId: 'cid-custom-1',
      } as any);

      const resPass = await memecoinAggregator.executeSnipe({
        contractAddress: customMint,
        amountUsd: 50,
        enforceConfluence: true,
        minConfluenceScore: 50,
      });
      expect(resPass.success).toBe(true);

      execSpy.mockRestore();
    });
  });

  // =========================================================================
  // Dimension 5: PumpFunService Auto-Snipe Multi-Caller Confluence Gating
  // =========================================================================
  describe('Dimension 5: PumpFunService Confluence Auto-Snipe Integration', () => {
    it('blocks auto-snipe if confluenceCount >= 2 but composite score < 70', () => {
      const weakCallout: PumpFunHotCallout = {
        id: 'callout-weak-1',
        calloutId: 'cid-weak',
        caller: {
          userId: 'alpha_caller',
          userUuid: 'usr-weak',
          primaryWallet: CREATOR_ADDR,
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
          isAutoSnipeSubscribed: false,
          topCallouts: [],
        },
        token: {
          mint: 'WeakCalloutMint1111111111111111111111111111',
          symbol: 'WEAK',
          name: 'Weak Confluence Coin',
          imageUri: '',
          description: '',
          bondingCurveProgress: 20, // Low curve progress -> low curve points
          bondingCurveAddress: '',
          creator: CREATOR_ADDR,
          calloutPriceUsd: 0.0001,
          currentPriceUsd: 0.000105,
          marketCapAtCalloutUsd: 10000,
          currentMarketCapUsd: 10500,
          athPriceSol: 0.00015,
          peakMultiple: 1.05,
          currentMultiple: 1.05,
          complete: false,
          volume5mUsd: 1000,
          buys5m: 5,
          sells5m: 10,
          top10HoldersPct: 40.0,
          devHoldingPct: 4.5,
          isMintRevoked: true,
          isFreezeRevoked: true,
          rugcheckScore: 'SAFE',
          createdTimestamp: Date.now() - 60_000,
          timeAgoStr: '1m ago',
        },
        calloutTimestamp: Date.now() - 30_000,
        calloutNote: 'Weak Callout',
        confluenceCount: 2, // 2 callers
        otherCallers: ['beta_caller'],
        hftAction: 'INSTANT_SNIPE',
        decayWindowSecondsRemaining: 60,
        status: 'ACTIVE',
      };

      const confluence = pumpfunService.evaluateCalloutConfluence(weakCallout);
      expect(confluence.compositeScore).toBeLessThan(70);
      expect(isConfluencePassed(confluence.compositeScore)).toBe(false);
    });

    it('enables auto-snipe when confluenceCount >= 2 and composite score >= 70', () => {
      const strongMint = 'StrongCalloutMint11111111111111111111111111';
      const strongCallout: PumpFunHotCallout = {
        id: 'callout-strong-1',
        calloutId: 'cid-strong',
        caller: {
          userId: 'top_caller',
          userUuid: 'usr-strong',
          primaryWallet: CREATOR_ADDR,
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
          isAutoSnipeSubscribed: false,
          topCallouts: [],
        },
        token: {
          mint: strongMint,
          symbol: 'STRONG',
          name: 'Strong Confluence Coin',
          imageUri: '',
          description: '',
          bondingCurveProgress: 92,
          bondingCurveAddress: '',
          creator: CREATOR_ADDR,
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
        otherCallers: ['caller2', 'caller3'],
        hftAction: 'INSTANT_SNIPE',
        decayWindowSecondsRemaining: 60,
        status: 'ACTIVE',
      };

      // Record high velocity metrics for this mint
      curveVelocityEvaluator.recordTransition(strongMint, 9000, 15.0, Date.now() - 15_000);
      curveVelocityEvaluator.recordTransition(strongMint, 9030, 28.0, Date.now());
      curveVelocityEvaluator.recordTradeFlow(strongMint, 13.0, true, Date.now() - 5_000);

      const confluence = pumpfunService.evaluateCalloutConfluence(strongCallout);
      expect(confluence.compositeScore).toBeGreaterThanOrEqual(70);
      expect(isConfluencePassed(confluence.compositeScore)).toBe(true);
    });
  });
});
