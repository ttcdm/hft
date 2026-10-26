import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { CapitalSizer, CapitalSizingInputs } from '../server/capital/capitalSizer';
import { ExitEngine } from '../server/exits/exitEngine';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';
import { NormalizedPosition } from '../server/core/types';

describe('Phase 4 Challenger Adversarial & Stress Verification Suite', () => {
  let coordinator: ExecutionCoordinator;

  beforeEach(() => {
    coordinator = new ExecutionCoordinator(false);
  });

  afterEach(() => {
    coordinator.cleanup();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Part 1: B12 Capital Sizer Boundary and Adversarial Tests
  // =========================================================================
  describe('B12 Capital Sizer Boundary & Adversarial Cases', () => {
    it('1.1: Zero balance & balance below reserve yields spendable = 0 and rejects trade', () => {
      // Zero balance
      const spendableZero = CapitalSizer.calculateSpendableBankroll(0, 0.015, 0);
      expect(spendableZero).toBe(0);

      const resZero = CapitalSizer.calculateOrderSize({
        walletBalanceSol: 0,
        winProbability: 0.6,
        winLossRatio: 2.0,
        historicalTradeCount: 50,
      });
      expect(resZero.approved).toBe(false);
      expect(resZero.spendableBankrollSol).toBe(0);
      expect(resZero.rejectionReason).toBe('INSUFFICIENT_SPENDABLE_BANKROLL');

      // Balance below reserve: 0.010 SOL < 0.015 SOL reserve -> spendable = 0
      const spendableSubReserve = CapitalSizer.calculateSpendableBankroll(0.010, 0.015, 0);
      expect(spendableSubReserve).toBe(0);

      const resSubReserve = CapitalSizer.calculateOrderSize({
        walletBalanceSol: 0.010,
        reserveBalanceSol: 0.015,
        winProbability: 0.6,
        winLossRatio: 2.0,
        historicalTradeCount: 50,
      });
      expect(resSubReserve.approved).toBe(false);
      expect(resSubReserve.spendableBankrollSol).toBe(0);
      expect(resSubReserve.rejectionReason).toBe('INSUFFICIENT_SPENDABLE_BANKROLL');

      // Exactly at reserve: 0.015 SOL == 0.015 SOL reserve -> spendable = 0
      const spendableAtReserve = CapitalSizer.calculateSpendableBankroll(0.015, 0.015, 0);
      expect(spendableAtReserve).toBe(0);

      const resAtReserve = CapitalSizer.calculateOrderSize({
        walletBalanceSol: 0.015,
        reserveBalanceSol: 0.015,
        winProbability: 0.6,
        winLossRatio: 2.0,
        historicalTradeCount: 50,
      });
      expect(resAtReserve.approved).toBe(false);
      expect(resAtReserve.rejectionReason).toBe('INSUFFICIENT_SPENDABLE_BANKROLL');
    });

    it('1.2: In-flight orders consuming entire balance yields spendable <= 0 (within float tolerance) and rejects trade', () => {
      // Balance 0.07 SOL, reserve 0.015 SOL, in-flight 0.055 SOL -> spendable = 0 (float epsilon)
      const spendableInFlight = CapitalSizer.calculateSpendableBankroll(0.07, 0.015, 0.055);
      expect(spendableInFlight).toBeCloseTo(0, 6);

      const resInFlight = CapitalSizer.calculateOrderSize({
        walletBalanceSol: 0.07,
        reserveBalanceSol: 0.015,
        inFlightOrdersSol: 0.055,
        winProbability: 0.6,
        winLossRatio: 2.0,
        historicalTradeCount: 50,
      });
      expect(resInFlight.approved).toBe(false);
      expect(resInFlight.orderSizeSol).toBe(0);
      expect(resInFlight.rejectionReason).toBe('INSUFFICIENT_SPENDABLE_BANKROLL');

      // In-flight exceeding remaining spendable: inFlight = 0.060 SOL
      const spendableOverInFlight = CapitalSizer.calculateSpendableBankroll(0.07, 0.015, 0.060);
      expect(spendableOverInFlight).toBe(0);
    });

    it('1.3: Negative expectancy (win rate 30%, b=1.0) yields raw Kelly <= 0 and rejects trade', () => {
      // p = 0.30, b = 1.0 -> q = 0.70 -> rawKelly = (0.30 * 1.0 - 0.70) / 1.0 = -0.40
      const rawKelly = CapitalSizer.calculateRawKelly(0.30, 1.0);
      expect(rawKelly).toBeCloseTo(-0.40, 6);

      const res = CapitalSizer.calculateOrderSize({
        walletBalanceSol: 0.07,
        reserveBalanceSol: 0.015,
        winProbability: 0.30,
        winLossRatio: 1.0,
        historicalTradeCount: 50,
      });
      expect(res.approved).toBe(false);
      expect(res.rawKelly).toBe(0); // Clamped non-negative in output
      expect(res.orderSizeSol).toBe(0);
      expect(res.rejectionReason).toBe('NEGATIVE_OR_ZERO_EXPECTANCY');

      // Break-even case: win rate 50%, b = 1.0 -> rawKelly = 0 -> reject
      const rawKellyBreakeven = CapitalSizer.calculateRawKelly(0.50, 1.0);
      expect(rawKellyBreakeven).toBe(0);

      const resBreakeven = CapitalSizer.calculateOrderSize({
        walletBalanceSol: 0.07,
        winProbability: 0.50,
        winLossRatio: 1.0,
        historicalTradeCount: 50,
      });
      expect(resBreakeven.approved).toBe(false);
      expect(resBreakeven.rejectionReason).toBe('NEGATIVE_OR_ZERO_EXPECTANCY');
    });

    it('1.4: Bayesian shrinkage behavior: N=0 (S=0), N=5 (S=0.1667), N=25 (S=0.50), N=100 (S=0.80)', () => {
      // N = 0 -> S = 0 / 25 = 0
      const s0 = CapitalSizer.calculateShrinkage(0);
      expect(s0).toBe(0);

      // N = 5 -> S = 5 / (5 + 25) = 5 / 30 = 0.166667
      const s5 = CapitalSizer.calculateShrinkage(5);
      expect(s5).toBeCloseTo(0.166667, 4);

      // N = 25 -> S = 25 / (25 + 25) = 25 / 50 = 0.500000
      const s25 = CapitalSizer.calculateShrinkage(25);
      expect(s25).toBeCloseTo(0.50, 6);

      // N = 100 -> S = 100 / (100 + 25) = 100 / 125 = 0.800000
      const s100 = CapitalSizer.calculateShrinkage(100);
      expect(s100).toBeCloseTo(0.80, 6);

      // Verify that calculateOrderSize uses S=0 at N=0, shrinking Kelly to 0
      const resN0 = CapitalSizer.calculateOrderSize({
        walletBalanceSol: 0.07,
        winProbability: 0.80,
        winLossRatio: 2.0,
        historicalTradeCount: 0,
      });
      expect(resN0.shrinkageFactor).toBe(0);
      expect(resN0.shrunkKelly).toBe(0);
      expect(resN0.approved).toBe(false);
      expect(resN0.rejectionReason).toBe('INSUFFICIENT_SPENDABLE_BANKROLL');
    });

    it('1.5: Hard 10% ceiling clamping when unconstrained quarter-Kelly exceeds 10%', () => {
      // Set high edge where unconstrained quarter-Kelly exceeds 10%:
      // winProbability = 0.70, winLossRatio = 2.0
      // rawKelly = (0.70 * 2.0 - 0.30) / 2.0 = 1.10 / 2.0 = 0.55
      // Sample size N = 100: S = 100 / 125 = 0.80
      // Quarter-Kelly = rawKelly * S * 0.25 = 0.55 * 0.80 * 0.25 = 0.110 (11.0%)
      // 11.0% > 10% ceiling -> clamped to 0.10!
      // spendable = 0.07 - 0.015 = 0.055 SOL
      // orderSizeSol = 0.055 * 0.10 = 0.0055 SOL
      const inputsExceeding10Pct: CapitalSizingInputs = {
        walletBalanceSol: 0.07,
        reserveBalanceSol: 0.015,
        winProbability: 0.70,
        winLossRatio: 2.0,
        historicalTradeCount: 100,
      };

      const resClamped = CapitalSizer.calculateOrderSize(inputsExceeding10Pct);
      expect(resClamped.approved).toBe(true);
      expect(resClamped.shrunkKelly).toBeCloseTo(0.11, 4);
      expect(resClamped.appliedFraction).toBe(0.10);
      expect(resClamped.isHardCapped).toBe(true);
      expect(resClamped.orderSizeSol).toBe(0.0055);

      // Contrast with scenario where unconstrained quarter-Kelly is BELOW 10%:
      // winProbability = 0.55, winLossRatio = 1.5 -> rawKelly = 0.25
      // N = 25 -> S = 0.50
      // Quarter-Kelly = 0.25 * 0.50 * 0.25 = 0.03125 (3.125%)
      // 3.125% < 10% -> NOT clamped
      // orderSizeSol = 0.055 * 0.03125 = 0.001719 SOL
      const inputsBelow10Pct: CapitalSizingInputs = {
        walletBalanceSol: 0.07,
        reserveBalanceSol: 0.015,
        winProbability: 0.55,
        winLossRatio: 1.5,
        historicalTradeCount: 25,
      };

      const resUnclamped = CapitalSizer.calculateOrderSize(inputsBelow10Pct);
      expect(resUnclamped.approved).toBe(true);
      expect(resUnclamped.shrunkKelly).toBeCloseTo(0.03125, 6);
      expect(resUnclamped.appliedFraction).toBeCloseTo(0.03125, 6);
      expect(resUnclamped.isHardCapped).toBe(false);
      expect(resUnclamped.orderSizeSol).toBeCloseTo(0.001719, 6);
    });
  });

  // =========================================================================
  // Part 2: B13 Dynamic Exit Engine Boundary and Adversarial Tests
  // =========================================================================
  describe('B13 Dynamic Exit Engine Stress Cases', () => {
    it('2.1: Monotonic trailing stop full lifecycle: +25% rally -> +18% dip -> +40% rally -> stop trigger 100% exit', () => {
      const entryPrice = 0.000100;
      const t0 = Date.now();

      // Step A: Price rallies to +25% (0.000125).
      // HWM set to 0.000125. Stop ratchets to HWM * 0.85 = 0.00010625.
      const stepA = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000125,
        highWaterMarkSol: 0.000100,
        trailingStopSol: 0,
        exitStage: 0,
        entryTimestamp: t0 - 60000,
        currentTimestamp: t0,
      });

      expect(stepA.shouldExit).toBe(false);
      expect(stepA.reason).toBe('HOLD');
      expect(stepA.newHighWaterMarkSol).toBe(0.000125);
      expect(stepA.newTrailingStopSol).toBeCloseTo(0.00010625, 8);

      // Step B: Price dips to +18% (0.000118).
      // Crucial test: Stop MUST NOT MOVE DOWN! Remains 0.00010625.
      // Current price 0.000118 > stop 0.00010625 -> Hold.
      const stepB = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000118,
        highWaterMarkSol: stepA.newHighWaterMarkSol,
        trailingStopSol: stepA.newTrailingStopSol,
        exitStage: 0,
        entryTimestamp: t0 - 60000,
        currentTimestamp: t0 + 10000,
      });

      expect(stepB.shouldExit).toBe(false);
      expect(stepB.reason).toBe('HOLD');
      expect(stepB.newHighWaterMarkSol).toBe(0.000125); // Preserved
      expect(stepB.newTrailingStopSol).toBeCloseTo(0.00010625, 8); // Strictly monotonic
      expect(stepB.newTrailingStopSol).toBeGreaterThanOrEqual(stepA.newTrailingStopSol);

      // Step C: Price rallies to +40% (0.000140).
      // HWM updates to 0.000140. Stop ratchets up to 0.000140 * 0.85 = 0.000119.
      const stepC = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000140,
        highWaterMarkSol: stepB.newHighWaterMarkSol,
        trailingStopSol: stepB.newTrailingStopSol,
        exitStage: 0,
        entryTimestamp: t0 - 60000,
        currentTimestamp: t0 + 20000,
      });

      // At +40% in stage 0, take-profit ladder rule TP1 (+30%) triggers!
      expect(stepC.shouldExit).toBe(true);
      expect(stepC.reason).toBe('TAKE_PROFIT_1');
      expect(stepC.sellPercentage).toBe(33);
      expect(stepC.newExitStage).toBe(1);
      expect(stepC.newHighWaterMarkSol).toBe(0.000140);
      expect(stepC.newTrailingStopSol).toBeCloseTo(0.000119, 8);

      // Now position is in Stage 1. Price dips to 0.000118 (below trailing stop 0.000119):
      const stepD = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000118,
        highWaterMarkSol: stepC.newHighWaterMarkSol,
        trailingStopSol: stepC.newTrailingStopSol,
        exitStage: 1,
        entryTimestamp: t0 - 60000,
        currentTimestamp: t0 + 30000,
      });

      // Stop breached -> 100% exit with TRAILING_STOP!
      expect(stepD.shouldExit).toBe(true);
      expect(stepD.reason).toBe('TRAILING_STOP');
      expect(stepD.sellPercentage).toBe(100);
      expect(stepD.newTrailingStopSol).toBeCloseTo(0.000119, 8);
    });

    it('2.2: Take-profit ladder: Stage 0 -> Stage 1 at +30% (sell 33%), Stage 1 -> Stage 2 at +60% (sell 33%), Stage 2 trailing stop (34% remaining, stop at 0.90 * HWM)', () => {
      const entryPrice = 0.000100;
      const t0 = Date.now();

      // Stage 0 -> Stage 1: Profit reaches exactly +30.0% (price 0.000130)
      const tp1Decision = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000130, // +30%
        highWaterMarkSol: 0.000100,
        trailingStopSol: 0,
        exitStage: 0,
        entryTimestamp: t0 - 60000,
        currentTimestamp: t0,
      });

      expect(tp1Decision.shouldExit).toBe(true);
      expect(tp1Decision.reason).toBe('TAKE_PROFIT_1');
      expect(tp1Decision.sellPercentage).toBe(33);
      expect(tp1Decision.newExitStage).toBe(1);
      expect(tp1Decision.newHighWaterMarkSol).toBe(0.000130);

      // In Stage 1: Profit rises to +50% (price 0.000150). Between TP1 (30%) and TP2 (60%).
      const stage1Holding = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000150, // +50%
        highWaterMarkSol: tp1Decision.newHighWaterMarkSol,
        trailingStopSol: tp1Decision.newTrailingStopSol,
        exitStage: 1,
        entryTimestamp: t0 - 60000,
        currentTimestamp: t0 + 10000,
      });

      expect(stage1Holding.shouldExit).toBe(false);
      expect(stage1Holding.reason).toBe('HOLD');
      expect(stage1Holding.newExitStage).toBe(1);
      expect(stage1Holding.newHighWaterMarkSol).toBe(0.000150);

      // Stage 1 -> Stage 2: Profit reaches +60% (price 0.000160)
      const tp2Decision = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000160, // +60%
        highWaterMarkSol: stage1Holding.newHighWaterMarkSol,
        trailingStopSol: stage1Holding.newTrailingStopSol,
        exitStage: 1,
        entryTimestamp: t0 - 60000,
        currentTimestamp: t0 + 20000,
      });

      expect(tp2Decision.shouldExit).toBe(true);
      expect(tp2Decision.reason).toBe('TAKE_PROFIT_2');
      expect(tp2Decision.sellPercentage).toBe(33);
      expect(tp2Decision.newExitStage).toBe(2);
      expect(tp2Decision.newHighWaterMarkSol).toBe(0.000160);
      // In Stage 2, trailing stop tightens to 10% below HWM: 0.000160 * 0.90 = 0.000144
      expect(tp2Decision.newTrailingStopSol).toBeCloseTo(0.000160 * 0.90, 8);

      // Stage 2 Trailing Stop: Remaining 34% pulled back to 0.000140 (below 0.000144)
      const stage2Pullback = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000140, // Below 0.000144
        highWaterMarkSol: tp2Decision.newHighWaterMarkSol,
        trailingStopSol: tp2Decision.newTrailingStopSol,
        exitStage: 2,
        entryTimestamp: t0 - 60000,
        currentTimestamp: t0 + 30000,
      });

      expect(stage2Pullback.shouldExit).toBe(true);
      expect(stage2Pullback.reason).toBe('TRAILING_STOP');
      expect(stage2Pullback.sellPercentage).toBe(100); // 100% of residual 34%
    });

    it('2.3: Stale position exit: exactly 30 minutes (1,800,000 ms) with 3% profit triggers STALE_POSITION (100% sell), while 6% profit does NOT trigger stale exit', () => {
      const entryPrice = 0.000100;
      const tNow = 1_700_000_000_000;
      const tEntry = tNow - 1_800_000; // Exactly 30 minutes ago

      // Exactly 30 minutes with 3% profit (< 5% threshold):
      // Current price = 0.000103 (+3%)
      const stale3Pct = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000103, // +3%
        highWaterMarkSol: 0.000103,
        trailingStopSol: 0,
        exitStage: 0,
        entryTimestamp: tEntry,
        currentTimestamp: tNow,
      });

      expect(stale3Pct.holdTimeMs).toBe(1_800_000);
      expect(stale3Pct.profitPct).toBeCloseTo(3.0, 2);
      expect(stale3Pct.shouldExit).toBe(true);
      expect(stale3Pct.reason).toBe('STALE_POSITION');
      expect(stale3Pct.sellPercentage).toBe(100);

      // Exactly 30 minutes with 6% profit (>= 5% threshold):
      // Current price = 0.000106 (+6%)
      const nonStale6Pct = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000106, // +6%
        highWaterMarkSol: 0.000106,
        trailingStopSol: 0,
        exitStage: 0,
        entryTimestamp: tEntry,
        currentTimestamp: tNow,
      });

      expect(nonStale6Pct.holdTimeMs).toBe(1_800_000);
      expect(nonStale6Pct.profitPct).toBeCloseTo(6.0, 2);
      expect(nonStale6Pct.shouldExit).toBe(false);
      expect(nonStale6Pct.reason).toBe('HOLD');

      // Boundary condition: exactly 4.99% profit -> triggers STALE_POSITION
      const boundaryStale = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.00010499, // +4.99%
        highWaterMarkSol: 0.00010499,
        trailingStopSol: 0,
        exitStage: 0,
        entryTimestamp: tEntry,
        currentTimestamp: tNow,
      });
      expect(boundaryStale.shouldExit).toBe(true);
      expect(boundaryStale.reason).toBe('STALE_POSITION');

      // Boundary condition: 29 minutes and 59 seconds (1,799,000 ms) with 3% profit -> does NOT trigger yet
      const youngNonStale = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000103,
        highWaterMarkSol: 0.000103,
        trailingStopSol: 0,
        exitStage: 0,
        entryTimestamp: tNow - 1_799_000,
        currentTimestamp: tNow,
      });
      expect(youngNonStale.shouldExit).toBe(false);
      expect(youngNonStale.reason).toBe('HOLD');
    });

    it('2.4: Hard stop loss: drops to -20% or below triggers STOP_LOSS (sell 100%)', () => {
      const entryPrice = 0.000100;
      const t0 = Date.now();

      // Exactly -20.0% loss (price 0.000080)
      const slExact = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000080, // -20.0%
        highWaterMarkSol: 0.000100,
        trailingStopSol: 0,
        exitStage: 0,
        entryTimestamp: t0 - 10000,
        currentTimestamp: t0,
      });

      expect(slExact.shouldExit).toBe(true);
      expect(slExact.reason).toBe('STOP_LOSS');
      expect(slExact.sellPercentage).toBe(100);
      expect(slExact.profitPct).toBeCloseTo(-20.0, 2);

      // Severe rug drop: -50.0% loss (price 0.000050)
      const slRug = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.000050, // -50.0%
        highWaterMarkSol: 0.000100,
        trailingStopSol: 0,
        exitStage: 0,
        entryTimestamp: t0 - 10000,
        currentTimestamp: t0,
      });

      expect(slRug.shouldExit).toBe(true);
      expect(slRug.reason).toBe('STOP_LOSS');
      expect(slRug.sellPercentage).toBe(100);

      // Just above stop loss: -19.9% loss (price 0.0000801) -> does NOT trigger STOP_LOSS
      const slAbove = ExitEngine.evaluate({
        entryPriceSol: entryPrice,
        currentPriceSol: 0.0000801, // -19.9%
        highWaterMarkSol: 0.000100,
        trailingStopSol: 0,
        exitStage: 0,
        entryTimestamp: t0 - 10000,
        currentTimestamp: t0,
      });

      expect(slAbove.shouldExit).toBe(false);
      expect(slAbove.reason).toBe('HOLD');
    });

    it('2.5: SQLite persistence: verify high_water_mark_sol, trailing_stop_sol, and exit_stage update in SQLite', async () => {
      const posId = `pos-challenger-sqlite-${Date.now()}`;
      const mint = Keypair.generate().publicKey.toBase58();
      const entryPrice = 0.000100;
      const initialPrice = 0.000100;

      const pos: NormalizedPosition = {
        id: posId,
        mint,
        symbol: 'SQLITETEST',
        name: 'SQLite Stress Token',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000000',
        costBasisLamports: 100000000,
        entryPriceSol: entryPrice,
        currentPriceSol: initialPrice,
        currentValueSol: 0.100,
        unrealizedPnLSol: 0,
        unrealizedPnLPct: 0,
        realizedPnLSol: 0,
        entryTxSignature: 'sig-challenger-1',
        entrySlot: 500,
        entryTimestamp: Date.now() - 5000,
        executionMode: 'PAPER',
        status: 'OPEN',
        lastUpdatedTimestamp: Date.now(),
        lastMarkTimestamp: Date.now(),
        highWaterMarkSol: 0.000100,
        trailingStopSol: 0,
        exitStage: 0,
      };

      // Save initial record to SQLite
      workstationDb.savePosition(pos);

      // Verify initial state in DB
      let loaded = workstationDb.loadPositions(undefined, 'ACTIVE').find((p) => p.id === posId);
      expect(loaded).toBeDefined();
      expect(loaded!.highWaterMarkSol).toBe(0.000100);
      expect(loaded!.trailingStopSol).toBe(0);
      expect(loaded!.exitStage).toBe(0);

      // Simulate price updating to +35% (0.000135):
      // This should update HWM to 0.000135, trailing stop to 0.000135 * 0.85 = 0.00011475, and exitStage to 1 (TP1)
      pos.currentPriceSol = 0.000135;
      pos.highWaterMarkSol = 0.000135;
      pos.trailingStopSol = 0.000135 * 0.85;
      pos.exitStage = 1;
      pos.lastMarkTimestamp = Date.now();
      pos.lastUpdatedTimestamp = Date.now();
      workstationDb.savePosition(pos);

      // Re-read directly from DB and assert all 3 fields updated accurately
      loaded = workstationDb.loadPositions(undefined, 'ACTIVE').find((p) => p.id === posId);
      expect(loaded).toBeDefined();
      expect(loaded!.highWaterMarkSol).toBe(0.000135);
      expect(loaded!.trailingStopSol).toBeCloseTo(0.00011475, 6);
      expect(loaded!.exitStage).toBe(1);

      // Further update: Stage 2 at +65% (0.000165)
      pos.currentPriceSol = 0.000165;
      pos.highWaterMarkSol = 0.000165;
      pos.trailingStopSol = 0.000165 * 0.90; // 0.0001485
      pos.exitStage = 2;
      workstationDb.savePosition(pos);

      loaded = workstationDb.loadPositions(undefined, 'ACTIVE').find((p) => p.id === posId);
      expect(loaded).toBeDefined();
      expect(loaded!.highWaterMarkSol).toBe(0.000165);
      expect(loaded!.trailingStopSol).toBeCloseTo(0.0001485, 6);
      expect(loaded!.exitStage).toBe(2);
    });
  });

  // =========================================================================
  // Part 3: Deep Adversarial & Invariant Tests
  // =========================================================================
  describe('Part 3: Deep Adversarial Edge Cases & Invariant Verification', () => {
    it('3.1: Extreme Kelly inputs (100% win rate, negative balance, 0 payoff ratio, negative N)', () => {
      // 100% win rate: p = 1.0, b = 2.0 -> rawKelly = (1.0 * 2.0 - 0) / 2.0 = 1.0
      const rawKellyMax = CapitalSizer.calculateRawKelly(1.0, 2.0);
      expect(rawKellyMax).toBe(1.0);

      // Clamped to 10% ceiling despite 100% win rate
      const resMaxWin = CapitalSizer.calculateOrderSize({
        walletBalanceSol: 0.07,
        winProbability: 1.0,
        winLossRatio: 2.0,
        historicalTradeCount: 200,
      });
      expect(resMaxWin.approved).toBe(true);
      expect(resMaxWin.isHardCapped).toBe(true);
      expect(resMaxWin.appliedFraction).toBe(0.10);
      expect(resMaxWin.orderSizeSol).toBe(0.0055);

      // Negative wallet balance yields 0 spendable and rejects
      expect(CapitalSizer.calculateSpendableBankroll(-0.05, 0.015, 0)).toBe(0);
      const resNegBalance = CapitalSizer.calculateOrderSize({
        walletBalanceSol: -0.05,
        winProbability: 0.6,
        winLossRatio: 2.0,
        historicalTradeCount: 50,
      });
      expect(resNegBalance.approved).toBe(false);
      expect(resNegBalance.rejectionReason).toBe('INSUFFICIENT_SPENDABLE_BANKROLL');

      // Payoff ratio b = 0 or negative yields 0 Kelly and rejects
      expect(CapitalSizer.calculateRawKelly(0.8, 0)).toBe(0);
      expect(CapitalSizer.calculateRawKelly(0.8, -2)).toBe(0);

      // Negative sample size N = -10 returns S = 0
      expect(CapitalSizer.calculateShrinkage(-10)).toBe(0);
    });

    it('3.2: Trailing stop monotonicity invariant holds over 100 oscillating price fluctuations', () => {
      const entryPrice = 0.000100;
      let hwm = 0.000125; // Already at +25%
      let trailingStop = 0.000125 * 0.85; // 0.00010625
      const initialTrailingStop = trailingStop;

      // Simulate 100 erratic price fluctuations strictly below 0.000125
      for (let i = 0; i < 100; i++) {
        // Fluctuating price between +16% (0.000116) and +24% (0.000124)
        const currentPrice = 0.000116 + (i % 9) * 0.000001;
        const decision = ExitEngine.evaluate({
          entryPriceSol: entryPrice,
          currentPriceSol: currentPrice,
          highWaterMarkSol: hwm,
          trailingStopSol: trailingStop,
          exitStage: 0,
          entryTimestamp: Date.now() - 60000,
          currentTimestamp: Date.now(),
        });

        // INVARIANT 1: Trailing stop must never decrease
        expect(decision.newTrailingStopSol).toBeGreaterThanOrEqual(trailingStop);
        expect(decision.newTrailingStopSol).toBeGreaterThanOrEqual(initialTrailingStop);

        // INVARIANT 2: HWM must never decrease
        expect(decision.newHighWaterMarkSol).toBeGreaterThanOrEqual(hwm);

        // INVARIANT 3: Position should HOLD since price is above trailing stop
        expect(decision.shouldExit).toBe(false);

        trailingStop = decision.newTrailingStopSol;
        hwm = decision.newHighWaterMarkSol;
      }
    });

    it('3.3: Coordinator evaluateAndProcessExits handles multi-position portfolio exits correctly', async () => {
      const tNow = Date.now();
      const posStopLoss = `pos-sl-${tNow}`;
      const posTakeProfit = `pos-tp1-${tNow}`;
      const posStale = `pos-stale-${tNow}`;
      const posHold = `pos-hold-${tNow}`;

      // 1. Position in -25% loss (should trigger STOP_LOSS)
      workstationDb.savePosition({
        id: posStopLoss,
        mint: Keypair.generate().publicKey.toBase58(),
        symbol: 'POS_SL',
        name: 'Stop Loss Token',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000000',
        costBasisLamports: 100000000,
        entryPriceSol: 0.000100,
        currentPriceSol: 0.000075, // -25%
        currentValueSol: 0.075,
        unrealizedPnLSol: -0.025,
        unrealizedPnLPct: -25.0,
        realizedPnLSol: 0,
        entryTxSignature: 'sig-sl',
        entrySlot: 10,
        entryTimestamp: tNow - 10000,
        executionMode: 'PAPER',
        status: 'OPEN',
        lastUpdatedTimestamp: tNow,
        lastMarkTimestamp: tNow,
        highWaterMarkSol: 0.000100,
        trailingStopSol: 0,
        exitStage: 0,
      });

      // 2. Position in +35% profit (should trigger TAKE_PROFIT_1)
      workstationDb.savePosition({
        id: posTakeProfit,
        mint: Keypair.generate().publicKey.toBase58(),
        symbol: 'POS_TP1',
        name: 'Take Profit Token',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000000',
        costBasisLamports: 100000000,
        entryPriceSol: 0.000100,
        currentPriceSol: 0.000135, // +35%
        currentValueSol: 0.135,
        unrealizedPnLSol: 0.035,
        unrealizedPnLPct: 35.0,
        realizedPnLSol: 0,
        entryTxSignature: 'sig-tp1',
        entrySlot: 11,
        entryTimestamp: tNow - 10000,
        executionMode: 'PAPER',
        status: 'OPEN',
        lastUpdatedTimestamp: tNow,
        lastMarkTimestamp: tNow,
        highWaterMarkSol: 0.000100,
        trailingStopSol: 0,
        exitStage: 0,
      });

      // 3. Position held for 35 minutes with +2% profit (should trigger STALE_POSITION)
      workstationDb.savePosition({
        id: posStale,
        mint: Keypair.generate().publicKey.toBase58(),
        symbol: 'POS_STALE',
        name: 'Stale Token',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000000',
        costBasisLamports: 100000000,
        entryPriceSol: 0.000100,
        currentPriceSol: 0.000102, // +2%
        currentValueSol: 0.102,
        unrealizedPnLSol: 0.002,
        unrealizedPnLPct: 2.0,
        realizedPnLSol: 0,
        entryTxSignature: 'sig-stale',
        entrySlot: 12,
        entryTimestamp: tNow - (35 * 60 * 1000), // 35 minutes ago
        executionMode: 'PAPER',
        status: 'OPEN',
        lastUpdatedTimestamp: tNow,
        lastMarkTimestamp: tNow,
        highWaterMarkSol: 0.000102,
        trailingStopSol: 0,
        exitStage: 0,
      });

      // 4. Healthy running position +8% profit held for 5 minutes (should HOLD)
      workstationDb.savePosition({
        id: posHold,
        mint: Keypair.generate().publicKey.toBase58(),
        symbol: 'POS_HOLD',
        name: 'Holding Token',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000000',
        costBasisLamports: 100000000,
        entryPriceSol: 0.000100,
        currentPriceSol: 0.000108, // +8%
        currentValueSol: 0.108,
        unrealizedPnLSol: 0.008,
        unrealizedPnLPct: 8.0,
        realizedPnLSol: 0,
        entryTxSignature: 'sig-hold',
        entrySlot: 13,
        entryTimestamp: tNow - (5 * 60 * 1000), // 5 minutes ago
        executionMode: 'PAPER',
        status: 'OPEN',
        lastUpdatedTimestamp: tNow,
        lastMarkTimestamp: tNow,
        highWaterMarkSol: 0.000108,
        trailingStopSol: 0,
        exitStage: 0,
      });

      // Execute exit evaluation sweep across entire portfolio
      await coordinator.evaluateAndProcessExits();

      // Verify outcomes:
      // posStopLoss: closed via STOP_LOSS
      const slClosed = workstationDb.loadPositions(undefined, 'CLOSED').find((p) => p.id === posStopLoss);
      expect(slClosed).toBeDefined();
      expect(slClosed!.status).toBe('CLOSED');
      expect(slClosed!.exitReason).toBe('STOP_LOSS');

      // posStale: closed via STALE_POSITION
      const staleClosed = workstationDb.loadPositions(undefined, 'CLOSED').find((p) => p.id === posStale);
      expect(staleClosed).toBeDefined();
      expect(staleClosed!.status).toBe('CLOSED');
      expect(staleClosed!.exitReason).toBe('STALE_POSITION');

      // posTakeProfit: partially closed (33% sold) -> status PARTIALLY_CLOSED
      const tpPartial = workstationDb.loadPositions(undefined, 'ACTIVE').find((p) => p.id === posTakeProfit);
      expect(tpPartial).toBeDefined();
      expect(tpPartial!.status).toBe('PARTIALLY_CLOSED');
      expect(tpPartial!.exitStage).toBe(1);

      // posHold: remains OPEN and untouched
      const holdStillOpen = workstationDb.loadPositions(undefined, 'ACTIVE').find((p) => p.id === posHold);
      expect(holdStillOpen).toBeDefined();
      expect(holdStillOpen!.status).toBe('OPEN');
      expect(holdStillOpen!.exitStage).toBe(0);
    });
  });
});
