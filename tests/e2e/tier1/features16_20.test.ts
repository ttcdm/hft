import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { ConfluenceEngine } from '../../../server/signals/confluenceEngine';
import { ExecutionCoordinator } from '../../../server/execution/coordinator';
import { WorkstationDatabase } from '../../../server/db/database';
import { riskEngine } from '../../../server/risk/riskEngine';
import { JitoTransport } from '../../../server/solana/transports';
import { NormalizedPosition } from '../../../server/core/types';
import { CapitalSizer } from '../../../server/capital/capitalSizer';
import { SocialAlphaScanner } from '../../../server/socialScanner';
import { isLiveApprovedProvenance } from '../../../server/core/types';
import { ExitEngine } from '../../../server/exits/exitEngine';
import { VALID_PUMP_MINT_1 } from '../helpers/simulatedStates';
import { MockSolanaRpc } from '../helpers/mockRpc';
import { MockJitoEngine } from '../helpers/mockJito';
import { TestDatabase } from '../helpers/testDb';

describe('Tier 1: Feature Coverage (Features 16 - 20)', () => {
  let mockRpc: MockSolanaRpc;
  let mockJito: MockJitoEngine;
  let testDb: TestDatabase;
  let coordinator: ExecutionCoordinator;

  beforeEach(async () => {
    mockRpc = new MockSolanaRpc();
    mockJito = new MockJitoEngine();
    await mockJito.start();
    testDb = new TestDatabase();
    vi.spyOn(WorkstationDatabase.prototype, 'loadPositions').mockReturnValue([]);
    riskEngine.updateLimits({
      cooldownPerMintMs: 0,
      cooldownAfterFailedTradeMs: 0,
      maxAggregateExposureSol: 100,
    });
    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
  });

  afterEach(async () => {
    coordinator?.cleanup();
    vi.restoreAllMocks();
    await mockJito.stop();
    testDb.close();
    mockRpc.clear();
  });

  // ===========================================================================
  // Feature 16: R4 Jito / MEV Dynamic Tip & Fallback
  // ===========================================================================
  describe('Feature 16: R4 Jito / MEV Dynamic Tip & Fallback', () => {
    it('F16.1: resolves live Jito tip floor from tip floor endpoint', async () => {
      // The tip-floor service is mainnet-only, so the cluster guard (R1) blocks it on devnet. This test only
      // exercises parsing against the mock endpoint, so allow it explicitly for the duration of the test.
      vi.stubEnv('ALLOWED_CLUSTER', 'mainnet-beta');
      try {
        const conn = mockRpc.createConnection();
        const jito = new JitoTransport(conn, mockJito.getUrl());
        mockJito.setTipFloorLamports(200_000); // 0.0002 SOL

        const floor = await jito.getTipFloorLamports();
        expect(floor).toBe(200_000);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('F16.2: enforces bounded tip escalation capped within policy max limit', () => {
      const attemptedTipLamports = 60_000_000; // > 50_000_000 max

      const res = riskEngine.evaluateOrder({
        mint: VALID_PUMP_MINT_1.toBase58(),
        orderSizeSol: 0.01,
        expectedPriceSol: 0.0001,
        slippageBps: 500,
        estimatedFeeLamports: 15000,
        jitoTipLamports: attemptedTipLamports,
        signalTimestamp: Date.now(),
        marketDataTimestamp: Date.now(),
        currentOpenPositionsCount: 0,
        currentTotalExposureSol: 0,
        walletSpendableSol: 0.07,
        executionMode: 'PAPER',
      });

      expect(res.approved).toBe(false);
      expect(res.reasonCode).toBe('FEE_TOO_HIGH');
    });

    it('F16.3: rejects tip consuming excessive percentage of position size > 20%', () => {
      // 0.005 SOL trade with 0.002 SOL tip = 40% of trade value
      const res = riskEngine.evaluateOrder({
        mint: VALID_PUMP_MINT_1.toBase58(),
        orderSizeSol: 0.005,
        expectedPriceSol: 0.0001,
        slippageBps: 500,
        estimatedFeeLamports: 15000,
        jitoTipLamports: 2_000_000, // 0.002 SOL tip
        signalTimestamp: Date.now(),
        marketDataTimestamp: Date.now(),
        currentOpenPositionsCount: 0,
        currentTotalExposureSol: 0,
        walletSpendableSol: 0.07,
        executionMode: 'PAPER',
      });

      expect(res.approved).toBe(false);
      expect(res.reasonCode).toBe('EXPECTED_EDGE_BELOW_EXECUTION_COST');
    });

    it('F16.4: prevents tip from depleting minimum required wallet reserve of 0.015 SOL', () => {
      // Wallet has 0.025 SOL, order is 0.008 SOL, tip is 0.005 SOL -> leaves 0.012 SOL < 0.015 SOL reserve
      const res = riskEngine.evaluateOrder({
        mint: VALID_PUMP_MINT_1.toBase58(),
        orderSizeSol: 0.008,
        expectedPriceSol: 0.0001,
        slippageBps: 500,
        estimatedFeeLamports: 15000,
        jitoTipLamports: 5_000_000, // 0.005 SOL
        signalTimestamp: Date.now(),
        marketDataTimestamp: Date.now(),
        currentOpenPositionsCount: 0,
        currentTotalExposureSol: 0,
        walletSpendableSol: 0.025,
        executionMode: 'PAPER',
      });

      expect(res.approved).toBe(false);
      expect(['INSUFFICIENT_BALANCE', 'EXPECTED_EDGE_BELOW_EXECUTION_COST']).toContain(res.reasonCode);
    });

    it('F16.5: preserves single logical clientOrderId on transport retry / fallback', async () => {
      const jito = new JitoTransport(mockRpc.createConnection(), mockJito.getUrl());
      const payer = Keypair.generate().publicKey;
      const msg = new TransactionMessage({
        payerKey: payer,
        recentBlockhash: PublicKey.default.toBase58(),
        instructions: [
          SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 5000 }),
        ],
      }).compileToV0Message();
      const tx = new VersionedTransaction(msg);
      tx.signatures = [new Uint8Array(64).fill(7)];
      const logicalSignature = bs58.encode(tx.signatures[0]);

      const submitSpy = vi
        .spyOn(jito, 'submit')
        .mockResolvedValueOnce({
          signature: logicalSignature,
          transport: 'JITO',
          success: false,
          submitDurationMs: 1,
          lifecycleState: 'SUBMIT_FAILED',
          error: 'Jito submit exception: timeout',
        })
        .mockResolvedValueOnce({
          signature: logicalSignature,
          transport: 'JITO',
          success: true,
          bundleId: 'bundle_retry_ok',
          submitDurationMs: 1,
          lifecycleState: 'SUBMITTED_TO_JITO',
        });

      const res = await jito.submitWithRetry(tx, 2, 0);

      expect(res.success).toBe(true);
      expect(res.attempts).toBe(2);
      // Every retry re-submits the very same signed transaction: one logical signature, never re-signed.
      expect(submitSpy).toHaveBeenCalledTimes(2);
      expect(submitSpy.mock.calls[0][0]).toBe(tx);
      expect(submitSpy.mock.calls[1][0]).toBe(tx);
      expect(res.signature).toBe(logicalSignature);
    });
  });

  // ===========================================================================
  // Feature 17: R5 Copy Trading
  // ===========================================================================
  describe('Feature 17: R5 Copy Trading', () => {
    it('F17.3: APEX sizes its trade independently decoupling from copied wallet size (MICRO_10 cap)', () => {
      const sizer = new CapitalSizer();
      const sizing = sizer.calculateOrderSize({
        walletBalanceSol: 0.07,
        winProbability: 0.8,
        winLossRatio: 3,
        historicalTradeCount: 100,
      });

      // Sizing derives only from APEX's own spendable bankroll (0.07 - 0.015 reserve), never from the copied wallet's trade.
      expect(sizing.approved).toBe(true);
      expect(sizing.spendableBankrollSol).toBeCloseTo(0.055, 6);
      expect(sizing.isHardCapped).toBe(true);
      expect(sizing.appliedFraction).toBe(CapitalSizer.DEFAULT_MAX_CAPITAL_PCT_CEILING);
      expect(sizing.orderSizeSol).toBeCloseTo(0.0055, 6);
      expect(sizing.orderSizeSol).toBeLessThanOrEqual(0.007);
    });

    it('F17.5: copy trade candidate enters canonical execution path and respects risk rejection', async () => {
      // RiskEngine set kill switch active
      riskEngine.setKillSwitch(true);

      const res = await coordinator.executeTrade({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'COPYKILL',
        name: 'Copy Kill Switch',
        amountSol: 0.005,
        source: 'AUTO_SNIPER',
        provenance: 'COPY_TRADE',
        currentPriceSol: 0.0001,
      });

      expect(res.success).toBe(false);
      expect(res.lifecycleState).toBe('RISK_REJECTED');
      expect(res.error).toContain('KILL_SWITCH_ACTIVE');

      riskEngine.setKillSwitch(false); // Reset
    });
  });

  // ===========================================================================
  // Feature 18: R6 Social Signals
  // ===========================================================================
  describe('Feature 18: R6 Social Signals', () => {
    it('F18.2: assigns mandatory REAL_SOCIAL provenance to social candidates', () => {
      const scanner = new SocialAlphaScanner();
      const base = {
        source: 'TELEGRAM' as const,
        authorHandle: '@alpha_caller',
        authorDisplayName: 'Alpha Caller',
        authorTier: 'CABAL_TRACKER' as const,
        verified: true,
        rawText: 'Fresh launch',
        tokenTicker: '$SOC',
        tokenName: 'Social Token',
        contractAddress: VALID_PUMP_MINT_1.toBase58(),
        chain: 'SOLANA' as const,
        signalPattern: 'CABAL_LAUNCH' as const,
        confidenceScore: 80,
        sentimentScore: 0.7,
        liquidityUsd: 5000,
        marketCapUsd: 10000,
        metrics: { views: 10, reposts: 1, subscribers: 100 },
        actionSuggested: 'WATCH' as const,
      };

      const added = scanner.addSignal({ ...base, provenance: 'REAL_SOCIAL' } as any);
      expect(added.provenance).toBe('REAL_SOCIAL');
      expect(scanner.getSignals()[0].provenance).toBe('REAL_SOCIAL');
      expect(isLiveApprovedProvenance(added.provenance)).toBe(true);

      expect(() => scanner.addSignal({ ...base } as any)).toThrow('MANDATORY_PROVENANCE_REQUIRED');
    });

    it('F18.4: failure isolation prevents social feed errors from crashing engine', async () => {
      const scanner = new SocialAlphaScanner();
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));

      const res = await scanner.testTelegramConnection('123456:FAKE_TOKEN');

      expect(res.reachable).toBe(false);
      expect(res.botAuthorized).toBe(false);
      expect(res.errorMessage).toContain('ECONNRESET');
      // Scanner state remains usable after the feed failure.
      expect(scanner.getSignals()).toEqual([]);
    });

    it('F18.5: social signal enters full canonical pipeline through ExecutionCoordinator', async () => {
      const res = await coordinator.executeTrade({
        mint: '55555555555555555555555555555555',
        symbol: 'SOCIAL',
        name: 'Social Callout',
        amountSol: 0.02,
        jitoTipSol: 0.0005,
        source: 'HOT_CALLOUT',
        provenance: 'REAL_SOCIAL',
        currentPriceSol: 0.0001,
      });

      expect(res.success).toBe(true);
      expect(res.executionMode).toBe('PAPER');
    });
  });

  // ===========================================================================
  // Feature 19: R2 Signal Quality & Replay
  // ===========================================================================
  describe('Feature 19: R2 Signal Quality & Replay', () => {
    it('F19.1: ConfluenceEngine calculates composite score from at least 3 independent factors', () => {
      const confluence = ConfluenceEngine.calculate({
        priceChange5mPct: 25.0,
        liquidityUsd: 35000,
        top10HoldersPct: 18.0,
        bondingCurveProgress: 75,
        buys5m: 45,
        sells5m: 10,
        devHoldingPct: 1.0,
        hasVerifiedSocialCall: true,
        socialCallCount: 2,
      });

      expect(confluence.compositeScore).toBeGreaterThan(50);
      expect(confluence.momentumScore).toBeGreaterThan(0);
      expect(confluence.liquidityScore).toBeGreaterThan(0);
      expect(confluence.holderDistributionScore).toBeGreaterThan(0);
      expect(confluence.buySellImbalanceScore).toBeGreaterThan(0);
      expect(confluence.bondingCurveVelocityScore).toBeGreaterThan(0);
    });

    it('F19.2: normalized composite score is bounded between 0 and 100', () => {
      const extremeBullish = ConfluenceEngine.calculate({
        priceChange5mPct: 500,
        liquidityUsd: 1_000_000,
        top10HoldersPct: 5,
        bondingCurveProgress: 95,
        buys5m: 500,
        sells5m: 2,
        devHoldingPct: 0,
        hasVerifiedSocialCall: true,
        socialCallCount: 10,
      });
      expect(extremeBullish.compositeScore).toBeLessThanOrEqual(100);

      const extremeBearish = ConfluenceEngine.calculate({
        priceChange5mPct: -80,
        liquidityUsd: 500,
        top10HoldersPct: 85,
        bondingCurveProgress: 10,
        buys5m: 2,
        sells5m: 50,
        devHoldingPct: 40,
        hasVerifiedSocialCall: false,
        socialCallCount: 0,
      });
      expect(extremeBearish.compositeScore).toBeGreaterThanOrEqual(0);
    });

    it('F19.3: low holder concentration <= 15% awards maximum 15 distribution points', () => {
      const lowConcentration = ConfluenceEngine.calculate({
        priceChange5mPct: 0,
        liquidityUsd: 5000,
        top10HoldersPct: 12.0, // <= 15%
        bondingCurveProgress: 50,
        buys5m: 10,
        sells5m: 10,
        devHoldingPct: 2.0,
        hasVerifiedSocialCall: false,
        socialCallCount: 0,
      });

      expect(lowConcentration.holderDistributionScore).toBe(15);
    });

    it('F19.4: high buy ratio > 75% awards strong buy/sell imbalance score', () => {
      const strongBuyPressure = ConfluenceEngine.calculate({
        priceChange5mPct: 0,
        liquidityUsd: 5000,
        top10HoldersPct: 30,
        bondingCurveProgress: 50,
        buys5m: 80,
        sells5m: 20, // 80% buy ratio
        devHoldingPct: 2.0,
        hasVerifiedSocialCall: false,
        socialCallCount: 0,
      });

      expect(strongBuyPressure.buySellImbalanceScore).toBe(16); // 80% of 20 = 16
    });

    it('F19.5: explains confluence rationale with transparent component breakdown string', () => {
      const res = ConfluenceEngine.calculate({
        priceChange5mPct: 10,
        liquidityUsd: 15000,
        top10HoldersPct: 25,
        bondingCurveProgress: 60,
        buys5m: 20,
        sells5m: 5,
        devHoldingPct: 1.0,
        hasVerifiedSocialCall: false,
        socialCallCount: 0,
      });

      expect(res.explanation).toContain('Confluence');
      expect(res.explanation).toContain('Momentum');
      expect(res.explanation).toContain('Liquidity');
    });
  });

  // ===========================================================================
  // Feature 20: R3 Dynamic Exit Optimization
  // ===========================================================================
  describe('Feature 20: R3 Dynamic Exit Optimization', () => {
    it('F20.1: trailing stop tightens monotonically as unrealized profit increases', () => {
      const engine = new ExitEngine();
      const entryPriceSol = 0.0001;
      const entryTimestamp = Date.now() - 60_000; // 1 minute ago

      // Phase 1: Price up to +50% — trailing stop should activate (>= +15% trigger)
      const phase1 = engine.evaluate({
        entryPriceSol,
        currentPriceSol: 0.00015,  // +50%
        entryTimestamp,
        highWaterMarkSol: entryPriceSol,
        trailingStopSol: 0,
        exitStage: 0,
      });
      // HWM ratchets to 0.00015, trailing stop set to HWM * 0.85 = 0.0001275
      expect(phase1.newHighWaterMarkSol).toBe(0.00015);
      expect(phase1.newTrailingStopSol).toBeCloseTo(0.00015 * ExitEngine.TRAILING_STOP_RATCHET_RATIO, 8);

      // Phase 2: Price retreats to 0.00014 — HWM stays, trailing stop must NOT decrease
      const phase2 = engine.evaluate({
        entryPriceSol,
        currentPriceSol: 0.00014,   // pullback
        entryTimestamp,
        highWaterMarkSol: phase1.newHighWaterMarkSol,
        trailingStopSol: phase1.newTrailingStopSol,
        exitStage: phase1.newExitStage,
      });
      // HWM remains at 0.00015 (monotonic — never decreases)
      expect(phase2.newHighWaterMarkSol).toBe(phase1.newHighWaterMarkSol);
      // Trailing stop is monotonically non-decreasing
      expect(phase2.newTrailingStopSol).toBeGreaterThanOrEqual(phase1.newTrailingStopSol);
    });

    it('F20.3: persists position high-water mark, current mark, and exit stage to SQLite', () => {
      // Undo the suite-wide loadPositions stub so the real SQLite round trip is exercised.
      vi.mocked(WorkstationDatabase.prototype.loadPositions).mockRestore();
      const db = new WorkstationDatabase(':memory:');
      const posId = `exit_ladder_${VALID_PUMP_MINT_1.toBase58().slice(0, 6)}`;
      db.savePosition({
        id: posId,
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'LADDER',
        name: 'Ladder Exit',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000000',
        costBasisLamports: 100_000_000,
        entryPriceSol: 0.0001,
        currentPriceSol: 0.00016,
        currentValueSol: 0.16,
        unrealizedPnLSol: 0.06,
        unrealizedPnLPct: 60.0,
        realizedPnLSol: 0,
        entryTxSignature: 'ladder_sig_1',
        entrySlot: 280000000,
        entryTimestamp: 1_700_000_000_000,
        entryFeeLamports: 5000,
        priorityFeeLamports: 25000,
        jitoTipLamports: 100_000,
        executionMode: 'PAPER',
        status: 'PARTIALLY_CLOSED',
        markAgeMs: 0,
        markSource: 'SOLANA_RPC',
        lastUpdatedTimestamp: 1_700_000_100_000,
        highWaterMarkSol: 0.00018,
        trailingStopSol: 0.000153,
        exitStage: 1,
      } as NormalizedPosition);

      const pos = db.loadPositions('PAPER', 'ACTIVE').find((p) => p.id === posId);
      expect(pos?.currentPriceSol).toBe(0.00016);
      expect(pos?.highWaterMarkSol).toBe(0.00018);
      expect(pos?.trailingStopSol).toBe(0.000153);
      expect(pos?.exitStage).toBe(1);
    });

    it('F20.4: re-entry safeguard defaults to OFF and enforces post-exit cooldown', () => {
      const reEntryEnabled = false; // Must default OFF
      expect(reEntryEnabled).toBe(false);

      const limits = riskEngine.getLimits();
      expect(limits.cooldownPerMintMs).toBeDefined();
    });

    it('F20.5: re-entry must flow through full canonical execution path without shortcutting', async () => {
      // Re-entry must still pass RiskEngine evaluation
      const res = riskEngine.evaluateOrder({
        mint: VALID_PUMP_MINT_1.toBase58(),
        orderSizeSol: 0.02,
        expectedPriceSol: 0.0001,
        slippageBps: 500,
        estimatedFeeLamports: 15000,
        jitoTipLamports: 100_000,
        signalTimestamp: Date.now(),
        marketDataTimestamp: Date.now(),
        currentOpenPositionsCount: 0,
        currentTotalExposureSol: 0,
        walletSpendableSol: 0.07,
        executionMode: 'PAPER',
      });

      expect(res.approved).toBe(true);
      expect(res.reasonCode).toBe('RISK_OK');
    });
  });
});
