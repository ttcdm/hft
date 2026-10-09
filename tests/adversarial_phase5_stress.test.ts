import { seedSurge } from './fixtures/velocity';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  CurveVelocityEvaluator,
  curveVelocityEvaluator,
  CurveVelocityMetrics,
  ReserveTransition,
  TradeFlowEntry,
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

describe('Empirical Challenger: Phase 5 Adversarial & Boundary Stress Test Suite', () => {
  const MINT_A = 'AdversarialMint11111111111111111111111111111';
  const MINT_B = 'AdversarialMint22222222222222222222222222222';
  const CREATOR_SEASONED = 'SeasonedCreatorPubkey11111111111111111111111';
  const CREATOR_BURNER = 'BurnerCreatorPubkey111111111111111111111111';

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
  // Section A: CurveVelocityEvaluator Adversarial Boundary Cases
  // =========================================================================
  describe('CurveVelocityEvaluator: Boundary, Zero-Div & Adversarial Cases', () => {
    it('handles empty transition and trade flow history gracefully without NaN or throwing', () => {
      const evaluator = new CurveVelocityEvaluator();
      expect(evaluator.hasData(MINT_A)).toBe(false);

      const metrics = evaluator.getMetrics(MINT_A, Date.now());
      expect(metrics.mint).toBe(MINT_A);
      expect(metrics.slotAcceleration).toBe(0);
      expect(metrics.windowVelocitySolPerSec).toBe(0);
      expect(metrics.volume10sSol).toBe(0);
      expect(metrics.volume30sSol).toBe(0);
      expect(metrics.buyRatio10s).toBe(0);
      expect(metrics.velocityScore).toBe(0);
      expect(metrics.normalizedScore).toBe(0);
      expect(metrics.isSurging).toBe(false);
      expect(metrics.transitionCount).toBe(0);
      expect(metrics.lastSlot).toBe(0);
      expect(Number.isNaN(metrics.slotAcceleration)).toBe(false);
    });

    it('handles single transition without div-by-zero or NaN', () => {
      const evaluator = new CurveVelocityEvaluator();
      evaluator.recordTransition(MINT_A, 500, 12.5, 100_000);

      const metrics = evaluator.getMetrics(MINT_A, 100_000);
      expect(metrics.slotAcceleration).toBe(0);
      expect(metrics.windowVelocitySolPerSec).toBe(0);
      expect(metrics.transitionCount).toBe(1);
      expect(metrics.lastSlot).toBe(500);
      expect(metrics.velocityScore).toBe(0);
    });

    it('avoids div-by-zero on same-slot transitions (deltaSlots === 0)', () => {
      const evaluator = new CurveVelocityEvaluator();

      // Case 1: Positive delta in same slot (e.g., 2 transactions processed in same slot)
      evaluator.recordTransition(MINT_A, 1000, 10.0, 100_000);
      evaluator.recordTransition(MINT_A, 1000, 15.0, 100_100);

      const metricsPos = evaluator.getMetrics(MINT_A, 100_100);
      expect(Number.isNaN(metricsPos.slotAcceleration)).toBe(false);
      expect(Number.isFinite(metricsPos.slotAcceleration)).toBe(true);
      expect(metricsPos.slotAcceleration).toBe(5.0); // Safe fallback: deltaSol > 0 ? deltaSol : 0
      expect(metricsPos.velocityScore).toBeGreaterThan(0);

      // Case 2: Negative delta in same slot
      evaluator.clear(MINT_A);
      evaluator.recordTransition(MINT_A, 2000, 20.0, 200_000);
      evaluator.recordTransition(MINT_A, 2000, 15.0, 200_100);

      const metricsNeg = evaluator.getMetrics(MINT_A, 200_100);
      expect(Number.isNaN(metricsNeg.slotAcceleration)).toBe(false);
      expect(metricsNeg.slotAcceleration).toBe(0); // Clamped to 0 for non-positive same-slot delta
      expect(metricsNeg.velocityScore).toBe(0);
    });

    it('handles out-of-order slot insertion and sorts accurately', () => {
      const evaluator = new CurveVelocityEvaluator();

      // Insert out of chronological order
      evaluator.recordTransition(MINT_A, 1050, 25.0, 150_000);
      evaluator.recordTransition(MINT_A, 1000, 10.0, 100_000);
      evaluator.recordTransition(MINT_A, 1020, 16.0, 120_000);

      // Sorted order should be: 1000 (10 SOL), 1020 (16 SOL), 1050 (25 SOL)
      // Latest vs previous: 1050 vs 1020 -> deltaSol = 9.0, deltaSlots = 30 -> v = 0.3 SOL/slot
      const metrics = evaluator.getMetrics(MINT_A, 150_000);
      expect(metrics.lastSlot).toBe(1050);
      expect(metrics.slotAcceleration).toBe(0.3);
      expect(metrics.transitionCount).toBe(3);
    });

    it('handles massive buy surge without arithmetic overflow or score corruption', () => {
      const evaluator = new CurveVelocityEvaluator();
      const now = 500_000;

      // Extreme values: 100,000 SOL surge in 1 slot
      evaluator.recordTransition(MINT_A, 100, 10.0, now - 1000);
      evaluator.recordTransition(MINT_A, 101, 100_010.0, now);

      evaluator.recordTradeFlow(MINT_A, 50_000, true, now - 500);
      evaluator.recordTradeFlow(MINT_A, 50_000, true, now);

      const metrics = evaluator.getMetrics(MINT_A, now);
      expect(metrics.slotAcceleration).toBe(100_000);
      expect(metrics.volume10sSol).toBe(100_000);
      expect(metrics.buyRatio10s).toBe(1.0);
      expect(metrics.velocityScore).toBe(15); // Strict cap at 15
      expect(metrics.normalizedScore).toBe(100); // Strict cap at 100
      expect(metrics.isSurging).toBe(true);
    });

    it('accurately enforces sliding window expiration at exact millisecond boundaries', () => {
      const evaluator = new CurveVelocityEvaluator();
      const now = 100_000;

      // Trade 1: Exactly at 10s boundary (now - 10_000 = 90_000) -> INCLUDED in 10s
      evaluator.recordTradeFlow(MINT_A, 1.0, true, 90_000);

      // Trade 2: 1ms expired from 10s window (now - 10_001 = 89_999) -> EXCLUDED from 10s, INCLUDED in 30s
      evaluator.recordTradeFlow(MINT_A, 2.0, true, 89_999);

      // Trade 3: Exactly at 30s boundary (now - 30_000 = 70_000) -> INCLUDED in 30s
      evaluator.recordTradeFlow(MINT_A, 4.0, false, 70_000);

      // Trade 4: 1ms expired from 30s window (now - 30_001 = 69_999) -> EXCLUDED from both
      evaluator.recordTradeFlow(MINT_A, 8.0, true, 69_999);

      const metrics = evaluator.getMetrics(MINT_A, now);

      // 10s window should only have Trade 1 (1.0 SOL)
      expect(metrics.volume10sSol).toBe(1.0);
      expect(metrics.buyVolume10sSol).toBe(1.0);

      // 30s window should have Trade 1 (1.0) + Trade 2 (2.0) + Trade 3 (4.0) = 7.0 SOL
      expect(metrics.volume30sSol).toBe(7.0);
      expect(metrics.buyVolume30sSol).toBe(3.0); // Trade 1 + Trade 2
    });

    it('enforces maximum transition buffer eviction (max 120 entries)', () => {
      const evaluator = new CurveVelocityEvaluator();

      // Record 150 transitions
      for (let i = 0; i < 150; i++) {
        evaluator.recordTransition(MINT_A, 1000 + i, 10.0 + i * 0.1, 1000 + i * 10);
      }

      const metrics = evaluator.getMetrics(MINT_A);
      expect(metrics.transitionCount).toBe(120); // Capped at maxTransitionsPerMint
      expect(metrics.lastSlot).toBe(1149);
      expect(metrics.slotAcceleration).toBe(0.1);
    });

    it('enforces maximum trade flow buffer eviction (max 600 entries)', () => {
      const evaluator = new CurveVelocityEvaluator();
      const now = 200_000;

      // Record 700 trade flows spanning 35 seconds (i * 50ms)
      for (let i = 0; i < 700; i++) {
        evaluator.recordTradeFlow(MINT_A, 0.01, true, now - i * 50);
      }

      // Check internal buffer length is capped at 600
      expect((evaluator as any).tradeFlowsByMint.get(MINT_A)?.length).toBe(600);

      // Check that metrics compute cleanly and sliding window excludes older entries
      const metrics = evaluator.getMetrics(MINT_A, now);
      expect(metrics.volume10sSol).toBeGreaterThan(0);
      expect(metrics.volume30sSol).toBeGreaterThan(metrics.volume10sSol);
    });

    it('evaluates parametric boundaries accurately in evaluateFromParams', () => {
      // Empty input defaults to 0
      const empty = CurveVelocityEvaluator.evaluateFromParams({});
      expect(empty.velocityScore).toBe(0);
      expect(empty.normalizedScore).toBe(0);
      expect(empty.isSurging).toBe(false);

      // Boundary tests for acceleration tiers:
      expect(CurveVelocityEvaluator.evaluateFromParams({ slotAcceleration: 0 }).velocityScore).toBe(0);
      expect(CurveVelocityEvaluator.evaluateFromParams({ slotAcceleration: 0.009 }).velocityScore).toBe(1);
      expect(CurveVelocityEvaluator.evaluateFromParams({ slotAcceleration: 0.01 }).velocityScore).toBe(2);
      expect(CurveVelocityEvaluator.evaluateFromParams({ slotAcceleration: 0.049 }).velocityScore).toBe(2);
      expect(CurveVelocityEvaluator.evaluateFromParams({ slotAcceleration: 0.05 }).velocityScore).toBe(4);
      expect(CurveVelocityEvaluator.evaluateFromParams({ slotAcceleration: 0.199 }).velocityScore).toBe(4);
      expect(CurveVelocityEvaluator.evaluateFromParams({ slotAcceleration: 0.2 }).velocityScore).toBe(5);
      expect(CurveVelocityEvaluator.evaluateFromParams({ slotAcceleration: 0.499 }).velocityScore).toBe(5);
      expect(CurveVelocityEvaluator.evaluateFromParams({ slotAcceleration: 0.5 }).velocityScore).toBe(6);

      // Boundary tests for volume tiers (with buyVolume10sSol: 0 to isolate pure volume points):
      expect(CurveVelocityEvaluator.evaluateFromParams({ volume10sSol: 0, buyVolume10sSol: 0 }).velocityScore).toBe(0);
      expect(CurveVelocityEvaluator.evaluateFromParams({ volume10sSol: 0.09, buyVolume10sSol: 0 }).velocityScore).toBe(1);
      expect(CurveVelocityEvaluator.evaluateFromParams({ volume10sSol: 0.1, buyVolume10sSol: 0 }).velocityScore).toBe(2);
      expect(CurveVelocityEvaluator.evaluateFromParams({ volume10sSol: 0.39, buyVolume10sSol: 0 }).velocityScore).toBe(2);
      expect(CurveVelocityEvaluator.evaluateFromParams({ volume10sSol: 0.4, buyVolume10sSol: 0 }).velocityScore).toBe(3);
      expect(CurveVelocityEvaluator.evaluateFromParams({ volume10sSol: 0.99, buyVolume10sSol: 0 }).velocityScore).toBe(3);
      expect(CurveVelocityEvaluator.evaluateFromParams({ volume10sSol: 1.0, buyVolume10sSol: 0 }).velocityScore).toBe(4);
      expect(CurveVelocityEvaluator.evaluateFromParams({ volume10sSol: 1.99, buyVolume10sSol: 0 }).velocityScore).toBe(4);
      expect(CurveVelocityEvaluator.evaluateFromParams({ volume10sSol: 2.0, buyVolume10sSol: 0 }).velocityScore).toBe(5);
    });
  });

  // =========================================================================
  // Section B: CreatorRiskScorer Adversarial & Resilience Stress Tests
  // =========================================================================
  describe('CreatorRiskScorer: Adversarial, Resilience & Boundary Stress Tests', () => {
    it('accurately evaluates exact 1-hour wallet age boundary (3599s vs 3601s)', () => {
      const scorer = new CreatorRiskScorer();
      const nowSec = 1_700_000_000;

      // Case 1: Wallet age 3599 seconds (< 1 hour -> FRESH BURNER)
      const freshSignatures: ConfirmedSignatureInfo[] = [
        { signature: 's1', slot: 100, err: null, memo: null, blockTime: nowSec - 100 },
        { signature: 's2', slot: 90, err: null, memo: null, blockTime: nowSec - 3599 },
      ];
      const freshReport = scorer.evaluateSignatures(CREATOR_BURNER, freshSignatures, nowSec);
      expect(freshReport.isFreshWallet).toBe(true);
      expect(freshReport.isBurner).toBe(true);
      expect(freshReport.confluenceScore).toBe(0);
      expect(freshReport.riskScore).toBe(0);
      expect(freshReport.riskFlags).toContain('FRESH_BURNER_WALLET');

      // Case 2: Wallet age 3601 seconds (> 1 hour) with 10 txs -> NOT fresh burner
      const notFreshSignatures: ConfirmedSignatureInfo[] = [];
      for (let i = 0; i < 10; i++) {
        notFreshSignatures.push({
          signature: `sig-${i}`,
          slot: 200 - i,
          err: null,
          memo: null,
          blockTime: nowSec - 3601 - i * 100,
        });
      }
      const notFreshReport = scorer.evaluateSignatures(CREATOR_SEASONED, notFreshSignatures, nowSec);
      expect(notFreshReport.isFreshWallet).toBe(false);
      expect(notFreshReport.isBurner).toBe(false);
      expect(notFreshReport.confluenceScore).toBeGreaterThanOrEqual(2);
      expect(notFreshReport.riskScore).toBeGreaterThan(0);
    });

    it('penalizes creators with high transaction failure rates (>= 40%)', () => {
      const scorer = new CreatorRiskScorer();
      const nowSec = 1_700_000_000;

      // 10 transactions over 2 days, but 5 are failed (50% failure rate)
      const failingSignatures: ConfirmedSignatureInfo[] = [];
      for (let i = 0; i < 10; i++) {
        failingSignatures.push({
          signature: `sig-${i}`,
          slot: 500 - i,
          err: i % 2 === 0 ? { InstructionError: [0, 'Custom'] } : null,
          memo: null,
          blockTime: nowSec - 172800 + i * 1000,
        });
      }

      const report = scorer.evaluateSignatures('FailingWallet1111111111111111111111111111', failingSignatures, nowSec);
      expect(report.failedTxCount).toBe(5);
      expect(report.riskFlags).toContain('HIGH_FAILURE_RATE');
    });

    it('fails closed and gracefully handles RPC query rejection / network timeout', async () => {
      const scorer = new CreatorRiskScorer();
      const pubkey = Keypair.generate().publicKey;

      // Mock RPC throwing a network timeout error
      const mockFailingRpc = {
        getSignaturesForAddress: vi.fn().mockRejectedValue(new Error('Connection timeout to Solana RPC node after 5000ms')),
      };

      const report = await scorer.evaluateCreator(mockFailingRpc as any, pubkey);

      expect(report.creatorAddress).toBe(pubkey.toBase58());
      expect(report.isBurner).toBe(true);
      expect(report.confluenceScore).toBe(0); // C2: a failed lookup earns no points
      expect(report.riskFlags).toContain('RPC_HISTORY_QUERY_FAILED');
      expect(report.details).toContain('Connection timeout');
    });

    it('handles non-Error thrown objects during RPC call without crashing', async () => {
      const scorer = new CreatorRiskScorer();
      const pubkey = Keypair.generate().publicKey;

      const mockCrashingRpc = {
        getSignaturesForAddress: vi.fn().mockRejectedValue('Fatal string exception'),
      };

      const report = await scorer.evaluateCreator(mockCrashingRpc as any, pubkey);
      expect(report.isBurner).toBe(true);
      expect(report.riskFlags).toContain('RPC_HISTORY_QUERY_FAILED');
      expect(report.details).toContain('Fatal string exception');
    });

    it('honors cache TTL and bypassCache options', async () => {
      const scorer = new CreatorRiskScorer();
      const pubkey = Keypair.generate().publicKey;
      let queryCount = 0;

      const mockRpc = {
        getSignaturesForAddress: vi.fn().mockImplementation(async () => {
          queryCount++;
          return [{ signature: 'sig-test', slot: 100, err: null, memo: null, blockTime: 1_700_000_000 }];
        }),
      };

      // Call 1: Populates cache
      await scorer.evaluateCreator(mockRpc as any, pubkey);
      expect(queryCount).toBe(1);

      // Call 2: Returns from cache
      await scorer.evaluateCreator(mockRpc as any, pubkey);
      expect(queryCount).toBe(1);

      // Call 3: bypassCache forces fresh RPC query
      await scorer.evaluateCreator(mockRpc as any, pubkey, { bypassCache: true });
      expect(queryCount).toBe(2);
    });

    it('evaluates static helper evaluateFromParams accurately', () => {
      // Burner wallet by age
      const burner = CreatorRiskScorer.evaluateFromParams({
        walletAgeSeconds: 1200,
        signatureCount: 2,
      });
      expect(burner.isBurner).toBe(true);
      expect(burner.confluenceScore).toBe(0);
      expect(burner.riskScore).toBe(0);

      // Seasoned wallet
      const seasoned = CreatorRiskScorer.evaluateFromParams({
        walletAgeSeconds: 86400 * 30, // 30 days
        signatureCount: 60,
      });
      expect(seasoned.isBurner).toBe(false);
      expect(seasoned.confluenceScore).toBe(5);
      expect(seasoned.riskScore).toBeGreaterThanOrEqual(80);
    });
  });

  // =========================================================================
  // Section C: ConfluenceEngine 7-Factor & Threshold Boundary Stress Tests
  // =========================================================================
  describe('ConfluenceEngine: 7-Factor Arithmetic & Boundary Tests', () => {
    it('guarantees composite score is capped strictly between [0, 100]', () => {
      // Worst possible inputs
      const worst = ConfluenceEngine.calculate({
        priceChange5mPct: -50,
        liquidityUsd: 0,
        top10HoldersPct: 100,
        bondingCurveProgress: 0, curveVelocityMetrics: { velocityScore: 4 } as any, // C2: measured velocity stands in for the removed progress fallback
        buys5m: 0,
        sells5m: 50,
        devHoldingPct: 100,
        hasVerifiedSocialCall: false,
        socialCallCount: 0,
        isCreatorBurner: true,
      });

      expect(worst.compositeScore).toBe(4);
      expect(worst.momentumScore).toBe(0);
      expect(worst.liquidityScore).toBe(0);
      expect(worst.holderDistributionScore).toBe(0);
      expect(worst.bondingCurveVelocityScore).toBe(4); // min fallback
      expect(worst.buySellImbalanceScore).toBe(0);
      expect(worst.creatorRiskScore).toBe(0);
      expect(worst.socialSignalScore).toBe(0);
      expect(isConfluencePassed(worst.compositeScore)).toBe(false);

      // Theoretical overflow inputs: all scores maxed
      const maxed = ConfluenceEngine.calculate({
        priceChange5mPct: 100,
        liquidityUsd: 500_000,
        top10HoldersPct: 5,
        bondingCurveProgress: 95,
        buys5m: 100,
        sells5m: 0,
        devHoldingPct: 0,
        hasVerifiedSocialCall: true,
        socialCallCount: 10,
        slotAcceleration: 1.0,
        volume10sSol: 10.0,
        creatorWalletAgeSeconds: 86400 * 60,
        creatorSignatureCount: 100,
      });

      expect(maxed.compositeScore).toBeLessThanOrEqual(100);
      expect(maxed.compositeScore).toBe(100);
      expect(isConfluencePassed(maxed.compositeScore)).toBe(true);
    });

    it('strictly tests the boundary at exactly 69 vs 70 points', () => {
      // Construct exact score 69:
      // Momentum: 15 (priceChange5mPct = 30)
      // Liquidity: 10 (liquidityUsd = 40000)
      // Distribution: 10 (top10HoldersPct = 25)
      // Curve: 15 (curveProgress = 95)
      // OrderFlow: 14 (buys = 70, sells = 30 -> 70% of 20 = 14)
      // Creator: 5 (devHoldingPct = 0)
      // Social: 0 (hasVerifiedSocialCall = false)
      // Sum = 15 + 10 + 10 + 15 + 14 + 5 + 0 = 69
      const score69 = ConfluenceEngine.calculate({
        priceChange5mPct: 30,
        liquidityUsd: 40000,
        top10HoldersPct: 25,
        bondingCurveProgress: 95, curveVelocityMetrics: { velocityScore: 15 } as any, // C2: measured velocity stands in for the removed progress fallback
        buys5m: 70,
        sells5m: 30,
        devHoldingPct: 0,
        hasVerifiedSocialCall: false,
        socialCallCount: 0,
      });

      expect(score69.compositeScore).toBe(69);
      expect(isConfluencePassed(score69.compositeScore)).toBe(false);
      expect(ConfluenceEngine.evaluate({
        priceChange5mPct: 30,
        liquidityUsd: 40000,
        top10HoldersPct: 25,
        bondingCurveProgress: 95, curveVelocityMetrics: { velocityScore: 15 } as any, // C2: measured velocity stands in for the removed progress fallback
        buys5m: 70,
        sells5m: 30,
        devHoldingPct: 0,
        hasVerifiedSocialCall: false,
        socialCallCount: 0,
      }).passed).toBe(false);

      // Now add 1 point by improving order flow or liquidity to reach 70
      // Buys = 75, Sells = 25 -> 75% of 20 = 15 points (adds +1 point -> sum 70)
      const score70 = ConfluenceEngine.calculate({
        priceChange5mPct: 30,
        liquidityUsd: 40000,
        top10HoldersPct: 25,
        bondingCurveProgress: 95, curveVelocityMetrics: { velocityScore: 15 } as any, // C2: measured velocity stands in for the removed progress fallback
        buys5m: 75,
        sells5m: 25,
        devHoldingPct: 0,
        hasVerifiedSocialCall: false,
        socialCallCount: 0,
      });

      expect(score70.compositeScore).toBe(70);
      expect(isConfluencePassed(score70.compositeScore)).toBe(true);
      expect(ConfluenceEngine.evaluate({
        priceChange5mPct: 30,
        liquidityUsd: 40000,
        top10HoldersPct: 25,
        bondingCurveProgress: 95, curveVelocityMetrics: { velocityScore: 15 } as any, // C2: measured velocity stands in for the removed progress fallback
        buys5m: 75,
        sells5m: 25,
        devHoldingPct: 0,
        hasVerifiedSocialCall: false,
        socialCallCount: 0,
      }).passed).toBe(true);
    });

    it('gives priority to real on-chain metrics over static heuristic fallbacks', () => {
      // Real curve metrics provided vs static curve progress
      const withRealMetrics = ConfluenceEngine.calculate({
        priceChange5mPct: 10,
        liquidityUsd: 10000,
        top10HoldersPct: 20,
        bondingCurveProgress: 10, // heuristic would give 4 pts
        buys5m: 10,
        sells5m: 5,
        devHoldingPct: 5,
        hasVerifiedSocialCall: false,
        socialCallCount: 0,
        slotAcceleration: 0.5, // real acceleration gives 6 pts + volume
        volume10sSol: 2.0,
      });

      expect(withRealMetrics.bondingCurveVelocityScore).toBeGreaterThanOrEqual(11);

      // Creator burner flag explicitly given
      const withBurnerFlag = ConfluenceEngine.calculate({
        priceChange5mPct: 10,
        liquidityUsd: 10000,
        top10HoldersPct: 20,
        bondingCurveProgress: 10, curveVelocityMetrics: { velocityScore: 4 } as any, // C2: measured velocity stands in for the removed progress fallback
        buys5m: 10,
        sells5m: 5,
        devHoldingPct: 0.0, // fallback heuristic would give 5 pts
        hasVerifiedSocialCall: false,
        socialCallCount: 0,
        isCreatorBurner: true, // OVERRIDES fallback to 0 pts
      });

      expect(withBurnerFlag.creatorRiskScore).toBe(0);
    });
  });

  // =========================================================================
  // Section D: MemecoinAggregator & PumpFunService Adversarial Integration
  // =========================================================================
  describe('Integration: MemecoinAggregator & PumpFunService Confluence Enforcement', () => {
    it('memecoinAggregator respects global confluence gating vs per-trade enforceConfluence override', async () => {
      const weakPool = {
        id: 'pool-test-adversarial-weak',
        platform: 'PUMP_FUN' as const,
        chain: 'SOLANA' as const,
        symbol: 'WEAK',
        name: 'Weak Meme',
        contractAddress: 'WeakAdversarial1111111111111111111111111111',
        priceUsd: 0.00001,
        priceNative: 0.0000001,
        marketCapUsd: 10000,
        liquidityUsd: 1000,
        bondingCurveProgress: 10,
        isMigrated: false,
        volume5mUsd: 100,
        volume1hUsd: 500,
        volume24hUsd: 1000,
        priceChange5mPct: -10,
        priceChange1hPct: -20,
        buys5m: 1,
        sells5m: 15,
        top10HoldersPct: 80,
        devHoldingPct: 4,
        isMintRevoked: true,
        isFreezeRevoked: true,
        isLpBurned: false,
        rugcheckScore: 'SAFE' as const,
        createdAgo: '5m ago',
        trendingRank: 0,
      };

      (memecoinAggregator as any).pools.unshift(weakPool);

      // Coordinator mock
      const coordSpy = vi.spyOn(executionCoordinator, 'executeTrade').mockResolvedValue({
        success: true,
        positionId: 'pos-test-1',
        txSignature: 'tx-sig-1',
        executionMode: 'PAPER',
        lifecycleState: 'EXECUTED',
        correlationId: 'cid-1',
      } as any);

      // Case 1: Gating disabled globally, enforceConfluence false -> snipe reaches coordinator
      memecoinAggregator.setConfluenceGating(false);
      const res1 = await memecoinAggregator.executeSnipe({
        contractAddress: weakPool.contractAddress,
        amountUsd: 5.0,
        enforceConfluence: false,
      });
      expect(res1.success).toBe(true);
      expect(coordSpy.mock.calls.length).toBe(1);

      coordSpy.mockClear();

      // Case 2: Gating enabled globally -> snipe blocked BEFORE reaching coordinator
      memecoinAggregator.setConfluenceGating(true);
      const res2 = await memecoinAggregator.executeSnipe({
        contractAddress: weakPool.contractAddress,
        amountUsd: 5.0,
      });
      expect(res2.success).toBe(false);
      expect(res2.message).toContain('failed minimum threshold of 70');
      expect(coordSpy.mock.calls.length).toBe(0);

      // Case 3: Gating disabled globally, but enforceConfluence: true in params -> snipe blocked
      memecoinAggregator.setConfluenceGating(false);
      const res3 = await memecoinAggregator.executeSnipe({
        contractAddress: weakPool.contractAddress,
        amountUsd: 5.0,
        enforceConfluence: true,
      });
      expect(res3.success).toBe(false);
      expect(res3.message).toContain('failed minimum threshold of 70');
      expect(coordSpy.mock.calls.length).toBe(0);
    });

    it('ingestOnChainCreateEvent records curve reserve transition into curveVelocityEvaluator', () => {
      const testMint = 'OnChainIngestMint111111111111111111111111111';
      expect(curveVelocityEvaluator.hasData(testMint)).toBe(false);

      memecoinAggregator.ingestOnChainCreateEvent({
        signature: 'sig-create-1',
        slot: 123456,
        mint: testMint,
        bondingCurve: 'BCurve11111111111111111111111111111111111',
        creator: 'User11111111111111111111111111111111111111',
        realSolReserves: 30_000_000_000n, // 30 SOL
        realTokenReserves: 793_100_000_000_000n,
        virtualSolReserves: 30_000_000_000n,
        virtualTokenReserves: 1_000_000_000_000_000n,
        tokenTotalSupply: 1_000_000_000_000_000n,
        initialPriceSol: 0.00000003,
        initialMarketCapSol: 30,
        name: 'Ingest Meme',
        symbol: 'INGEST',
        uri: 'https://pump.fun/test.json',
        receivedAt: 150_000,
        parsedAt: 150_000,
        parseLatencyMs: 1,
        source: 'SOLANA_WS_LOGS',
      });

      expect(curveVelocityEvaluator.hasData(testMint)).toBe(true);
      const metrics = curveVelocityEvaluator.getMetrics(testMint, 150_000);
      expect(metrics.lastSlot).toBe(123456);
      expect(metrics.transitionCount).toBe(1);
    });

    it('pumpfunService auto-snipe strictly enforces confluenceCount >= 2 and compositeScore >= 70', async () => {
      const calloutBase: PumpFunHotCallout = {
        id: 'callout-adv-1',
        calloutId: 'cid-adv-1',
        caller: {
          userId: 'test_caller',
          userUuid: 'uuid-1',
          primaryWallet: CREATOR_SEASONED,
          avatarUrl: '',
          totalCallouts: 5,
          avgMultiple: 1.1,
          medianMultiple: 1.0,
          winRate1_2x: 20,
          winRate1_5x: 10,
          winRate2x: 5,
          avgTimeToPeakMs: 900_000,
          followersCount: 50,
          totalVolumeDrivenUsd: 1000,
          reputationTier: 'EMERGING_CALLER',
          isAutoSnipeSubscribed: false, // NOT subscribed -> must qualify via confluence
          topCallouts: [],
        },
        token: {
          mint: 'AdvCalloutMint111111111111111111111111111111',
          symbol: 'ADVCALL',
          name: 'Adversarial Callout',
          imageUri: '',
          description: '',
          bondingCurveProgress: 90,
          bondingCurveAddress: '',
          creator: CREATOR_SEASONED,
          calloutPriceUsd: 0.0001,
          currentPriceUsd: 0.00012,
          marketCapAtCalloutUsd: 10000,
          currentMarketCapUsd: 12000,
          athPriceSol: 0.0002,
          peakMultiple: 1.2,
          currentMultiple: 1.2, // <= maxEntryMultiple (1.35)
          complete: false,
          volume5mUsd: 50000,
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
        calloutTimestamp: Date.now() - 10_000, // <= maxElapsedSeconds (60s)
        calloutNote: 'Alpha Callout',
        confluenceCount: 1, // Only 1 caller
        hftAction: 'INSTANT_SNIPE',
        decayWindowSecondsRemaining: 90,
        status: 'ACTIVE',
      };

      const snipeSpy = vi.spyOn(memecoinAggregator, 'executeSnipe').mockResolvedValue({
        success: true,
        message: 'Mock Snipe Success',
        txHash: '0x123',
      });

      // Scenario 1: High composite score (> 80) BUT confluenceCount = 1 -> REJECTED
      (pumpfunService as any).hotCallouts = [{ ...calloutBase, confluenceCount: 1 }];
      await (pumpfunService as any).evaluateAutoSnipeTriggers();
      expect(snipeSpy.mock.calls.length).toBe(0);

      snipeSpy.mockClear();

      // Scenario 2: confluenceCount = 2 BUT degraded token fundamentals (compositeScore < 70) -> REJECTED
      (pumpfunService as any).hotCallouts = [{
        ...calloutBase,
        confluenceCount: 2,
        token: {
          ...calloutBase.token,
          bondingCurveProgress: 5,
          volume5mUsd: 100,
          buys5m: 2,
          sells5m: 20,
          top10HoldersPct: 75.0,
          devHoldingPct: 15.0,
        },
      }];
      await (pumpfunService as any).evaluateAutoSnipeTriggers();
      expect(snipeSpy.mock.calls.length).toBe(0);

      snipeSpy.mockClear();

      // Scenario 3: confluenceCount = 2 AND high composite score (>= 70) -> TRIGGERED!
      seedSurge(calloutBase.token.mint); // C2: velocity must be measured, curve progress earns nothing
      (pumpfunService as any).hotCallouts = [{ ...calloutBase, confluenceCount: 2 }];
      await (pumpfunService as any).evaluateAutoSnipeTriggers();
      expect(snipeSpy.mock.calls.length).toBe(1);
      expect(snipeSpy).toHaveBeenCalledWith(expect.objectContaining({
        contractAddress: calloutBase.token.mint,
        enforceConfluence: true,
      }));
    });
  });
});
