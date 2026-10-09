import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { CapitalSizer, CapitalSizingInputs } from '../server/capital/capitalSizer';
import { ExitEngine } from '../server/exits/exitEngine';
import { ExecutionCoordinator, ExecuteTradeRequest } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';
import { NormalizedPosition } from '../server/core/types';
import { localSigner } from '../server/solana/signer';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { EligibilityFilter } from '../server/signals/eligibilityFilter';

describe('Phase 4 Master Remediation Suite (B12 & B13)', () => {
  let coordinator: ExecutionCoordinator;

  beforeEach(() => {
    coordinator = new ExecutionCoordinator(false);
  });

  afterEach(() => {
    coordinator.cleanup();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Blocker B12: Capital Sizer, Spendable Bankroll, Kelly & Hard 10% Ceiling
  // =========================================================================
  describe('B12: Capital Sizer & Spendable Bankroll Logic', () => {
    it('B12.1: calculateSpendableBankroll computes correct spendable bankroll across balances and reservations', () => {
      // Standard MICRO_10 bankroll: 0.07 SOL, 0.015 SOL reserve, 0 in-flight
      const spendable1 = CapitalSizer.calculateSpendableBankroll(0.07, 0.015, 0);
      expect(spendable1).toBeCloseTo(0.055, 6);

      // With in-flight orders: 0.07 SOL balance, 0.015 SOL reserve, 0.020 SOL in-flight
      const spendable2 = CapitalSizer.calculateSpendableBankroll(0.07, 0.015, 0.020);
      expect(spendable2).toBeCloseTo(0.035, 6);

      // Custom reserve balance (e.g. 0.025 SOL reserve)
      const spendable3 = CapitalSizer.calculateSpendableBankroll(0.10, 0.025, 0.010);
      expect(spendable3).toBeCloseTo(0.065, 6);

      // Depleted bankroll below reserve returns 0 (never negative)
      const spendable4 = CapitalSizer.calculateSpendableBankroll(0.010, 0.015, 0);
      expect(spendable4).toBe(0);

      // Exactly at reserve returns 0
      const spendable5 = CapitalSizer.calculateSpendableBankroll(0.015, 0.015, 0);
      expect(spendable5).toBe(0);
    });

    it('B12.2: calculateRawKelly computes accurate mathematical Kelly expectancy', () => {
      // 60% win rate, 2.0 payoff ratio:
      // q = 1 - 0.6 = 0.4
      // rawKelly = (0.6 * 2.0 - 0.4) / 2.0 = (1.2 - 0.4) / 2.0 = 0.40
      const rawKelly1 = CapitalSizer.calculateRawKelly(0.60, 2.0);
      expect(rawKelly1).toBeCloseTo(0.40, 6);

      // 50% win rate, 1.0 payoff ratio:
      // rawKelly = (0.5 * 1.0 - 0.5) / 1.0 = 0
      const rawKelly2 = CapitalSizer.calculateRawKelly(0.50, 1.0);
      expect(rawKelly2).toBe(0);

      // 40% win rate, 1.0 payoff ratio:
      // rawKelly = (0.4 * 1.0 - 0.6) / 1.0 = -0.2 (negative expectancy)
      const rawKelly3 = CapitalSizer.calculateRawKelly(0.40, 1.0);
      expect(rawKelly3).toBeCloseTo(-0.20, 6);

      // Non-positive payoff ratio returns 0
      expect(CapitalSizer.calculateRawKelly(0.60, 0)).toBe(0);
      expect(CapitalSizer.calculateRawKelly(0.60, -1.0)).toBe(0);
    });

    it('B12.3: Bayesian shrinkage factor S = N / (N + 25) behaves monotonically as sample size increases', () => {
      // N = 0 -> S = 0
      expect(CapitalSizer.calculateShrinkage(0)).toBe(0);

      // N = 5 -> S = 5 / 30 = 0.166667
      const s5 = CapitalSizer.calculateShrinkage(5);
      expect(s5).toBeCloseTo(5 / 30, 6);

      // N = 25 -> S = 25 / 50 = 0.500000
      const s25 = CapitalSizer.calculateShrinkage(25);
      expect(s25).toBeCloseTo(0.50, 6);

      // N = 75 -> S = 75 / 100 = 0.750000
      const s75 = CapitalSizer.calculateShrinkage(75);
      expect(s75).toBeCloseTo(0.75, 6);

      // N = 100 -> S = 100 / 125 = 0.800000
      const s100 = CapitalSizer.calculateShrinkage(100);
      expect(s100).toBeCloseTo(0.80, 6);

      // Monotonic progression: 0 < s5 < s25 < s75 < s100 < 1.0
      expect(s5).toBeGreaterThan(0);
      expect(s25).toBeGreaterThan(s5);
      expect(s75).toBeGreaterThan(s25);
      expect(s100).toBeGreaterThan(s75);
      expect(s100).toBeLessThan(1.0);
    });

    it('B12.4: calculateOrderSize rejects zero or negative spendable bankroll', () => {
      const result = CapitalSizer.calculateOrderSize({
        walletBalanceSol: 0.010, // Below 0.015 reserve
        winProbability: 0.60,
        winLossRatio: 2.0,
        historicalTradeCount: 50,
      });

      expect(result.approved).toBe(false);
      expect(result.orderSizeSol).toBe(0);
      expect(result.spendableBankrollSol).toBe(0);
      expect(result.rejectionReason).toBe('INSUFFICIENT_SPENDABLE_BANKROLL');
    });

    it('B12.5: calculateOrderSize rejects negative or zero expectancy trades', () => {
      // 40% win rate with 1.0 payoff ratio -> rawKelly = -0.20 <= 0
      const result = CapitalSizer.calculateOrderSize({
        walletBalanceSol: 0.07,
        winProbability: 0.40,
        winLossRatio: 1.0,
        historicalTradeCount: 50,
      });

      expect(result.approved).toBe(false);
      expect(result.orderSizeSol).toBe(0);
      expect(result.rejectionReason).toBe('NEGATIVE_OR_ZERO_EXPECTANCY');
    });

    it('B12.6: calculateOrderSize applies quarter Kelly and Bayesian shrinkage when below 10% ceiling', () => {
      // rawKelly = (0.55 * 1.5 - 0.45) / 1.5 = (0.825 - 0.45) / 1.5 = 0.25
      // With N = 25: S = 25 / 50 = 0.50
      // f_shrunk = rawKelly * S * 0.25 = 0.25 * 0.50 * 0.25 = 0.03125 (3.125%)
      // 3.125% < 10% ceiling -> appliedFraction = 0.03125, isHardCapped = false
      // spendable = 0.07 - 0.015 = 0.055 SOL
      // orderSizeSol = 0.055 * 0.03125 = 0.001719 SOL
      const inputs: CapitalSizingInputs = {
        walletBalanceSol: 0.07,
        reserveBalanceSol: 0.015,
        winProbability: 0.55,
        winLossRatio: 1.5,
        historicalTradeCount: 25,
      };

      const result = CapitalSizer.calculateOrderSize(inputs);
      expect(result.approved).toBe(true);
      expect(result.isHardCapped).toBe(false);
      expect(result.rawKelly).toBeCloseTo(0.25, 6);
      expect(result.shrinkageFactor).toBeCloseTo(0.50, 6);
      expect(result.shrunkKelly).toBeCloseTo(0.03125, 6);
      expect(result.appliedFraction).toBeCloseTo(0.03125, 6);
      expect(result.orderSizeSol).toBeCloseTo(0.001719, 6);
    });

    it('B12.7: calculateOrderSize strictly enforces hard 10% ceiling when unconstrained Kelly exceeds 10%', () => {
      // High edge scenario:
      // winProbability = 0.80, winLossRatio = 2.5
      // rawKelly = (0.80 * 2.5 - 0.20) / 2.5 = 1.80 / 2.5 = 0.72
      // Large sample N = 225: S = 225 / 250 = 0.90
      // f_shrunk = 0.72 * 0.90 * 0.25 = 0.162 (16.2%)
      // 16.2% exceeds 10% ceiling!
      // appliedFraction = 0.10, isHardCapped = true
      // spendable = 0.07 - 0.015 = 0.055 SOL
      // orderSizeSol = 0.055 * 0.10 = 0.0055 SOL
      const inputs: CapitalSizingInputs = {
        walletBalanceSol: 0.07,
        reserveBalanceSol: 0.015,
        winProbability: 0.80,
        winLossRatio: 2.5,
        historicalTradeCount: 225,
      };

      const result = CapitalSizer.calculateOrderSize(inputs);
      expect(result.approved).toBe(true);
      expect(result.isHardCapped).toBe(true);
      expect(result.shrunkKelly).toBeCloseTo(0.162, 4);
      expect(result.appliedFraction).toBe(0.10);
      expect(result.orderSizeSol).toBe(0.0055);
    });

    it('B12.8: CapitalSizer derives historical stats from closed database positions', () => {
      const testPosId1 = `pos-test-hist-1-${Date.now()}`;
      const testPosId2 = `pos-test-hist-2-${Date.now()}`;

      workstationDb.savePosition({
        id: testPosId1,
        mint: Keypair.generate().publicKey.toBase58(),
        symbol: 'WINNER',
        name: 'Winning Trade',
        tokenDecimals: 6,
        tokenQuantityRaw: '0',
        costBasisLamports: 0,
        entryPriceSol: 0.0001,
        currentPriceSol: 0.00015,
        currentValueSol: 0,
        unrealizedPnLSol: 0,
        unrealizedPnLPct: 0,
        realizedPnLSol: 0.004, // +0.004 SOL profit
        entryTxSignature: 'sig-win',
        entrySlot: 100,
        entryTimestamp: Date.now() - 60000,
        executionMode: 'PAPER',
        status: 'CLOSED',
        lastUpdatedTimestamp: Date.now(),
      });

      workstationDb.savePosition({
        id: testPosId2,
        mint: Keypair.generate().publicKey.toBase58(),
        symbol: 'LOSER',
        name: 'Losing Trade',
        tokenDecimals: 6,
        tokenQuantityRaw: '0',
        costBasisLamports: 0,
        entryPriceSol: 0.0001,
        currentPriceSol: 0.00008,
        currentValueSol: 0,
        unrealizedPnLSol: 0,
        unrealizedPnLPct: 0,
        realizedPnLSol: -0.002, // -0.002 SOL loss
        entryTxSignature: 'sig-loss',
        entrySlot: 101,
        entryTimestamp: Date.now() - 30000,
        executionMode: 'PAPER',
        status: 'CLOSED',
        lastUpdatedTimestamp: Date.now(),
      });

      const stats = CapitalSizer.getHistoricalTradeStats('PAPER');
      expect(stats.tradeCount).toBeGreaterThanOrEqual(2);
      expect(stats.winCount).toBeGreaterThanOrEqual(1);
      expect(stats.lossCount).toBeGreaterThanOrEqual(1);
      expect(stats.winRate).toBeGreaterThan(0);
      expect(stats.winLossRatio).toBeGreaterThan(0);
    });

    it('B12.9: coordinator.executeTrade enforces pre-trade 10% spendable bankroll ceiling in LIVE mode', async () => {
      vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
      vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(Keypair.generate().publicKey);
      (coordinator as any).executionMode = 'LIVE';
      (coordinator as any).isLiveTradingArmed = true;
      (coordinator as any).realWalletBalanceSol = 0.07; // spendable = 0.07 - 0.015 = 0.055; 10% ceiling = 0.0055 SOL
      (coordinator as any).inFlightReservedSol = 0;

      const dummyMint = Keypair.generate().publicKey.toBase58();
      const dummyWallet = Keypair.generate().publicKey;

      vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue({
        complete: false,
        tokenProgram: TOKEN_PROGRAM_ID,
        baseTokenProgram: TOKEN_PROGRAM_ID,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
        bondingCurve: dummyWallet,
        associatedBondingCurve: dummyWallet,
        creator: dummyWallet,
        feeRecipient: dummyWallet,
        buybackFeeRecipient: dummyWallet,
        quoteMint: dummyWallet,
        tokenDecimals: 6,
        virtualSolReserves: 30_000_000_000n,
        virtualTokenReserves: 1_000_000_000_000_000n,
        realSolReserves: 5_000_000_000n,
        marketDataTimestamp: Date.now(),
        isMintAuthorityRevoked: true,
        isFreezeAuthorityRevoked: true,
      } as any);

      vi.spyOn(EligibilityFilter, 'evaluate').mockReturnValue({
        mint: dummyMint,
        isEligible: true,
        score: 'SAFE',
        riskScoreNumber: 0,
        checks: [
          { ruleId: 'MINT_AUTH_REVOKED', passed: true, scoreImpact: 0, observedValue: 'true', threshold: 'true', reason: 'Pass', weight: 1, status: 'PASS' },
          { ruleId: 'FREEZE_AUTH_REVOKED', passed: true, scoreImpact: 0, observedValue: 'true', threshold: 'true', reason: 'Pass', weight: 1, status: 'PASS' },
          { ruleId: 'MAX_CREATOR_EXPOSURE', passed: true, scoreImpact: 0, observedValue: '0%', threshold: '10%', reason: 'Pass', weight: 1, status: 'PASS' },
          { ruleId: 'TOP_10_CONCENTRATION', passed: true, scoreImpact: 0, observedValue: '10%', threshold: '30%', reason: 'Pass', weight: 1, status: 'PASS' },
          { ruleId: 'TOKEN_2022_POLICY', passed: true, scoreImpact: 0, observedValue: 'STANDARD_SPL', threshold: 'ALLOWED', reason: 'Pass', weight: 1, status: 'PASS' },
        ],
        failedCount: 0,
        warningCount: 0,
        passedCount: 5,
        evaluatedAt: Date.now(),
      });

      vi.spyOn(PumpCurveService, 'calculateBuyQuote').mockReturnValue({
        mint: dummyMint,
        side: 'BUY',
        tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
        tokenDecimals: 6,
        executionPriceSol: 0.00003,
        spotPriceSol: 0.00003,
        tokenAmountRaw: '1000000000',
        expectedSolAmountLamports: 10_000_000,
        maxInputLamports: 10_800_000,
        minOutputLamports: 0,
        slippageBps: 800,
        protocolFeeLamports: 100_000,
        creatorFeeLamports: 0,
        expectedJitoTipLamports: 180_000,
        expectedPriorityFeeLamports: 25_000,
        estimatedPriceImpactBps: 50,
        marketDataSource: 'ON_CHAIN',
        marketDataTimestamp: Date.now(),
        quoteTimestamp: Date.now(),
      } as any);

      // Attempt to trade 0.010 SOL (> 10% ceiling of 0.0055 SOL)
      const oversizedReq: ExecuteTradeRequest = {
        signalTimestamp: Date.now(),
        mint: dummyMint,
        symbol: 'OVERSIZED',
        name: 'Oversized Token',
        amountSol: 0.010,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        executionMode: 'LIVE',
      };

      const result = await coordinator.executeTrade(oversizedReq);
      expect(result.success).toBe(false);
      expect(result.lifecycleState).toBe('RISK_REJECTED');
      expect(result.error).toContain('EXCEEDS_CAPITAL_CEILING');
    });

    it('B12.10: coordinator.executeTrade rejects LIVE trades when spendable bankroll is <= 0', async () => {
      vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
      vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(Keypair.generate().publicKey);
      (coordinator as any).executionMode = 'LIVE';
      (coordinator as any).isLiveTradingArmed = true;
      (coordinator as any).realWalletBalanceSol = 0.010; // Below 0.015 reserve
      (coordinator as any).inFlightReservedSol = 0;

      const dummyMint = Keypair.generate().publicKey.toBase58();
      const dummyWallet = Keypair.generate().publicKey;

      vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue({
        complete: false,
        tokenProgram: TOKEN_PROGRAM_ID,
        baseTokenProgram: TOKEN_PROGRAM_ID,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
        bondingCurve: dummyWallet,
        associatedBondingCurve: dummyWallet,
        creator: dummyWallet,
        feeRecipient: dummyWallet,
        buybackFeeRecipient: dummyWallet,
        quoteMint: dummyWallet,
        tokenDecimals: 6,
        virtualSolReserves: 30_000_000_000n,
        virtualTokenReserves: 1_000_000_000_000_000n,
        realSolReserves: 5_000_000_000n,
        marketDataTimestamp: Date.now(),
        isMintAuthorityRevoked: true,
        isFreezeAuthorityRevoked: true,
      } as any);

      vi.spyOn(EligibilityFilter, 'evaluate').mockReturnValue({
        mint: dummyMint,
        isEligible: true,
        score: 'SAFE',
        riskScoreNumber: 0,
        checks: [
          { ruleId: 'MINT_AUTH_REVOKED', passed: true, scoreImpact: 0, observedValue: 'true', threshold: 'true', reason: 'Pass', weight: 1, status: 'PASS' },
          { ruleId: 'FREEZE_AUTH_REVOKED', passed: true, scoreImpact: 0, observedValue: 'true', threshold: 'true', reason: 'Pass', weight: 1, status: 'PASS' },
          { ruleId: 'MAX_CREATOR_EXPOSURE', passed: true, scoreImpact: 0, observedValue: '0%', threshold: '10%', reason: 'Pass', weight: 1, status: 'PASS' },
          { ruleId: 'TOP_10_CONCENTRATION', passed: true, scoreImpact: 0, observedValue: '10%', threshold: '30%', reason: 'Pass', weight: 1, status: 'PASS' },
          { ruleId: 'TOKEN_2022_POLICY', passed: true, scoreImpact: 0, observedValue: 'STANDARD_SPL', threshold: 'ALLOWED', reason: 'Pass', weight: 1, status: 'PASS' },
        ],
        failedCount: 0,
        warningCount: 0,
        passedCount: 5,
        evaluatedAt: Date.now(),
      });

      vi.spyOn(PumpCurveService, 'calculateBuyQuote').mockReturnValue({
        mint: dummyMint,
        side: 'BUY',
        tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
        tokenDecimals: 6,
        executionPriceSol: 0.00003,
        spotPriceSol: 0.00003,
        tokenAmountRaw: '1000000000',
        expectedSolAmountLamports: 5_000_000,
        maxInputLamports: 5_400_000,
        minOutputLamports: 0,
        slippageBps: 800,
        protocolFeeLamports: 50_000,
        creatorFeeLamports: 0,
        expectedJitoTipLamports: 180_000,
        expectedPriorityFeeLamports: 25_000,
        estimatedPriceImpactBps: 50,
        marketDataSource: 'ON_CHAIN',
        marketDataTimestamp: Date.now(),
        quoteTimestamp: Date.now(),
      } as any);

      const req: ExecuteTradeRequest = {
        signalTimestamp: Date.now(),
        mint: dummyMint,
        symbol: 'DEPLETED',
        name: 'Depleted Bankroll Token',
        amountSol: 0.005,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        executionMode: 'LIVE',
      };

      const result = await coordinator.executeTrade(req);
      expect(result.success).toBe(false);
      expect(result.lifecycleState).toBe('RISK_REJECTED');
      expect(result.error).toContain('INSUFFICIENT_SPENDABLE_BANKROLL');
    });

    it('B12.11: coordinator.executeTrade enforces pre-trade 10% spendable bankroll ceiling in PAPER mode', async () => {
      (coordinator as any).realWalletBalanceSol = 0.07; // spendable = 0.055 SOL; 10% ceiling = 0.0055 SOL
      (coordinator as any).inFlightReservedSol = 0;

      const dummyMint = Keypair.generate().publicKey.toBase58();

      const oversizedReq: ExecuteTradeRequest = {
        signalTimestamp: Date.now(),
        mint: dummyMint,
        symbol: 'PAPER_OVER',
        name: 'Paper Oversized Token',
        amountSol: 0.010, // > 0.0055 SOL
        currentPriceSol: 0.0001,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        executionMode: 'PAPER',
      };

      const result = await coordinator.executeTrade(oversizedReq);
      expect(result.success).toBe(false);
      expect(result.lifecycleState).toBe('RISK_REJECTED');
      expect(result.error).toContain('EXCEEDS_CAPITAL_CEILING');
    });
  });

  // =========================================================================
  // Blocker B13: Dynamic Exit Engine, Monotonic Trailing Stops, TP Ladders
  // =========================================================================
  describe('B13: Dynamic Exit Engine Logic', () => {
    it('B13.1: ExitEngine strictly ratchets trailing stop monotonically and never decreases', () => {
      const entryPrice = 0.000100;
      const now = Date.now();

      // 1. Initial position with +10% gain: trailing stop has not activated yet (< +15%)
      const eval1 = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000110, // +10%
        highWaterMarkSol: 0.000100,
        trailingStopSol: 0,
        exitStage: 0,
        entryTimestamp: now - 60000,
        currentTimestamp: now,
      });

      expect(eval1.shouldExit).toBe(false);
      expect(eval1.newHighWaterMarkSol).toBe(0.000110);
      expect(eval1.newTrailingStopSol).toBe(0); // Not activated yet

      // 2. Price rises to +20% (0.000120): ratchets to HWM * 0.85 = 0.000102
      const eval2 = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000120, // +20%
        highWaterMarkSol: eval1.newHighWaterMarkSol,
        trailingStopSol: eval1.newTrailingStopSol,
        exitStage: 0,
        entryTimestamp: now - 60000,
        currentTimestamp: now,
      });

      expect(eval2.shouldExit).toBe(false);
      expect(eval2.newHighWaterMarkSol).toBe(0.000120);
      expect(eval2.newTrailingStopSol).toBeCloseTo(0.000120 * 0.85, 8); // 0.000102

      // 3. Price peaks at +25% (0.000125): stop ratchets up to 0.000125 * 0.85 = 0.00010625
      const eval3 = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000125, // +25%
        highWaterMarkSol: eval2.newHighWaterMarkSol,
        trailingStopSol: eval2.newTrailingStopSol,
        exitStage: 0,
        entryTimestamp: now - 60000,
        currentTimestamp: now,
      });

      expect(eval3.shouldExit).toBe(false);
      expect(eval3.newHighWaterMarkSol).toBe(0.000125);
      expect(eval3.newTrailingStopSol).toBeCloseTo(0.00010625, 8);

      // 4. Price dips back down to +18% (0.000118): HWM and trailing stop MUST NOT DECREASE (Monotonicity)
      const eval4 = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000118, // +18% dip
        highWaterMarkSol: eval3.newHighWaterMarkSol,
        trailingStopSol: eval3.newTrailingStopSol,
        exitStage: 0,
        entryTimestamp: now - 60000,
        currentTimestamp: now,
      });

      expect(eval4.shouldExit).toBe(false);
      expect(eval4.newHighWaterMarkSol).toBe(0.000125); // HWM preserved
      expect(eval4.newTrailingStopSol).toBeCloseTo(0.00010625, 8); // Trailing stop preserved strictly!
      expect(eval4.newTrailingStopSol).toBeGreaterThanOrEqual(eval3.newTrailingStopSol);

      // 5. Price plunges to 0.000105 (below trailing stop 0.00010625): triggers TRAILING_STOP exit (sell 100%)
      const eval5 = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000105, // Below 0.00010625
        highWaterMarkSol: eval4.newHighWaterMarkSol,
        trailingStopSol: eval4.newTrailingStopSol,
        exitStage: 0,
        entryTimestamp: now - 60000,
        currentTimestamp: now,
      });

      expect(eval5.shouldExit).toBe(true);
      expect(eval5.reason).toBe('TRAILING_STOP');
      expect(eval5.sellPercentage).toBe(100);
      expect(eval5.newTrailingStopSol).toBeCloseTo(0.00010625, 8);
    });

    it('B13.2: 3-stage take-profit ladder progresses through TP1 (+30%), TP2 (+60%), and residual 34% trailing stop', () => {
      const entryPrice = 0.000100;
      const now = Date.now();

      // Stage 0 -> Stage 1: Profit >= +30% triggers TAKE_PROFIT_1 (sell 33%, exitStage = 1)
      const tp1Eval = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000132, // +32%
        highWaterMarkSol: 0.000100,
        trailingStopSol: 0,
        exitStage: 0,
        entryTimestamp: now - 60000,
        currentTimestamp: now,
      });

      expect(tp1Eval.shouldExit).toBe(true);
      expect(tp1Eval.reason).toBe('TAKE_PROFIT_1');
      expect(tp1Eval.sellPercentage).toBe(33);
      expect(tp1Eval.newExitStage).toBe(1);
      expect(tp1Eval.newHighWaterMarkSol).toBe(0.000132);

      // In Stage 1: Profit is +45% (between 30% and 60%): holds
      const stage1Hold = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000145, // +45%
        highWaterMarkSol: tp1Eval.newHighWaterMarkSol,
        trailingStopSol: tp1Eval.newTrailingStopSol,
        exitStage: 1,
        entryTimestamp: now - 60000,
        currentTimestamp: now,
      });

      expect(stage1Hold.shouldExit).toBe(false);
      expect(stage1Hold.reason).toBe('HOLD');
      expect(stage1Hold.newExitStage).toBe(1);

      // Stage 1 -> Stage 2: Profit >= +60% triggers TAKE_PROFIT_2 (sell 33%, exitStage = 2)
      const tp2Eval = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000165, // +65%
        highWaterMarkSol: stage1Hold.newHighWaterMarkSol,
        trailingStopSol: stage1Hold.newTrailingStopSol,
        exitStage: 1,
        entryTimestamp: now - 60000,
        currentTimestamp: now,
      });

      expect(tp2Eval.shouldExit).toBe(true);
      expect(tp2Eval.reason).toBe('TAKE_PROFIT_2');
      expect(tp2Eval.sellPercentage).toBe(33);
      expect(tp2Eval.newExitStage).toBe(2);
      expect(tp2Eval.newHighWaterMarkSol).toBe(0.000165);
      // In Stage 2, trailing stop tightens to 10% below HWM (0.000165 * 0.90 = 0.0001485)
      expect(tp2Eval.newTrailingStopSol).toBeCloseTo(0.000165 * 0.90, 8);

      // Stage 2: Residual 34% trails with 10% stop below HWM
      const stage2Pullback = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000145, // Below 0.0001485
        highWaterMarkSol: tp2Eval.newHighWaterMarkSol,
        trailingStopSol: tp2Eval.newTrailingStopSol,
        exitStage: 2,
        entryTimestamp: now - 60000,
        currentTimestamp: now,
      });

      expect(stage2Pullback.shouldExit).toBe(true);
      expect(stage2Pullback.reason).toBe('TRAILING_STOP');
      expect(stage2Pullback.sellPercentage).toBe(100); // 100% of remaining 34%
    });

    it('B13.3: Stale position exits after 30 minutes when profit < 5.0%', () => {
      const entryPrice = 0.000100;
      const now = Date.now();
      const thirtyOneMinutesAgo = now - (31 * 60 * 1000);

      // Position held for 31 minutes with only +2.0% profit -> STALE_POSITION
      const staleEval = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000102, // +2% profit
        highWaterMarkSol: 0.000103,
        trailingStopSol: 0,
        exitStage: 0,
        entryTimestamp: thirtyOneMinutesAgo,
        currentTimestamp: now,
      });

      expect(staleEval.shouldExit).toBe(true);
      expect(staleEval.reason).toBe('STALE_POSITION');
      expect(staleEval.sellPercentage).toBe(100);

      // Position held for 31 minutes with +8.0% profit -> NOT stale (profit >= 5%)
      const runningEval = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000108, // +8% profit
        highWaterMarkSol: 0.000108,
        trailingStopSol: 0,
        exitStage: 0,
        entryTimestamp: thirtyOneMinutesAgo,
        currentTimestamp: now,
      });

      expect(runningEval.shouldExit).toBe(false);
      expect(runningEval.reason).toBe('HOLD');

      // Position held for only 15 minutes with +2.0% profit -> NOT stale yet
      const youngEval = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000102,
        highWaterMarkSol: 0.000102,
        trailingStopSol: 0,
        exitStage: 0,
        entryTimestamp: now - (15 * 60 * 1000),
        currentTimestamp: now,
      });

      expect(youngEval.shouldExit).toBe(false);
      expect(youngEval.reason).toBe('HOLD');
    });

    it('B13.4: Hard stop loss triggers when profit drops to or below -20.0%', () => {
      const entryPrice = 0.000100;
      const now = Date.now();

      const slEval = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000079, // -21.0%
        highWaterMarkSol: 0.000100,
        trailingStopSol: 0,
        exitStage: 0,
        entryTimestamp: now - 60000,
        currentTimestamp: now,
      });

      expect(slEval.shouldExit).toBe(true);
      expect(slEval.reason).toBe('STOP_LOSS');
      expect(slEval.sellPercentage).toBe(100);
      expect(slEval.profitPct).toBeCloseTo(-21.0, 2);
    });

    it('B13.5: evaluateAndProcessExits persists HWM, trailing stop, and exit stage to SQLite', async () => {
      const posId = `pos-p4-exit-${Date.now()}`;
      const entryPrice = 0.000100;
      const currentPrice = 0.000125; // +25% profit triggers trailing stop ratchet

      const initialPos: NormalizedPosition = {
        id: posId,
        mint: Keypair.generate().publicKey.toBase58(),
        symbol: 'EXITTEST',
        name: 'Exit Test Token',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000000',
        costBasisLamports: 100000000,
        entryPriceSol: entryPrice,
        currentPriceSol: currentPrice,
        currentValueSol: 0.125,
        unrealizedPnLSol: 0.025,
        unrealizedPnLPct: 25.0,
        realizedPnLSol: 0,
        entryTxSignature: 'sig-exit-test',
        entrySlot: 100,
        entryTimestamp: Date.now() - 10000,
        executionMode: 'PAPER',
        status: 'OPEN',
        lastUpdatedTimestamp: Date.now(),
        lastMarkTimestamp: Date.now(),
        highWaterMarkSol: entryPrice,
        trailingStopSol: 0,
        exitStage: 0,
      };

      workstationDb.savePosition(initialPos);

      // Run evaluation
      await coordinator.evaluateAndProcessExits();

      // Reload position from database to confirm persistent write
      const positions = workstationDb.loadPositions(undefined, 'ACTIVE');
      const updated = positions.find((p) => p.id === posId);

      expect(updated).toBeDefined();
      expect(updated!.highWaterMarkSol).toBe(0.000125);
      expect(updated!.trailingStopSol).toBeCloseTo(0.000125 * 0.85, 6);
      expect(updated!.exitStage).toBe(0);
    });
  });
});
