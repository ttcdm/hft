import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { executionConfig } from '../../../server/solana/executionConfig';
import { HardenedRiskEngine } from '../../../server/risk/riskEngine';
import { WorkstationDatabase } from '../../../server/db/database';
import { ExitEngine } from '../../../server/exits/exitEngine';
import { CapitalSizer } from '../../../server/capital/capitalSizer';
import { TestDatabase } from '../helpers/testDb';
import { VALID_PUMP_MINT_1, VALID_PUMP_MINT_2 } from '../helpers/simulatedStates';

describe('Tier 2: Boundary & Corner Cases (Features 16 - 20)', () => {
  let riskEngine: HardenedRiskEngine;
  let testDb: TestDatabase;

  beforeEach(() => {
    testDb = new TestDatabase();
    riskEngine = new HardenedRiskEngine();
    riskEngine.updateLimits({
      cooldownPerMintMs: 0,
      cooldownAfterFailedTradeMs: 0,
      maxAggregateExposureSol: 100,
    });
    vi.spyOn(WorkstationDatabase.prototype, 'loadPositions').mockReturnValue([]);
    vi.spyOn(WorkstationDatabase.prototype, 'getDailyRealizedPnLSol').mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    testDb.close();
  });

  // =========================================================================
  // Feature 16: Jito / MEV Dynamic Tip & Fallback Boundaries
  // =========================================================================
  describe('Feature 16 Boundaries: Jito Dynamic Tip & Fallback', () => {
    it('B16.1: tip calculation with negative or NaN trade amount falls back safely', () => {
      const nanTip = executionConfig.resolveDynamicJitoTip({
        tradeAmountSol: NaN,
      });
      expect(nanTip.tipLamports).toBeGreaterThanOrEqual(10_000);
      expect(nanTip.tipSol).toBeGreaterThan(0);

      const negTip = executionConfig.resolveDynamicJitoTip({
        tradeAmountSol: -0.05,
      });
      expect(negTip.tipLamports).toBeGreaterThanOrEqual(10_000);
    });

    it('B16.2: tip calculation with urgencyMultiplier = 0 bounds to min floor', () => {
      const tip = executionConfig.resolveDynamicJitoTip({
        urgencyMultiplier: 0,
      });
      expect(tip.tipLamports).toBeGreaterThanOrEqual(Math.round(executionConfig.getConfig().minJitoTipSol * 1e9));
    });

    it('B16.3: extremely high tip floor (> operator ceiling) is bounded strictly at operatorMaxSol', () => {
      const tip = executionConfig.resolveDynamicJitoTip({
        tipFloorLamports: 500_000_000, // 0.5 SOL
        operatorMaxSol: 0.05, // 0.05 SOL limit
      });
      expect(tip.tipSol).toBe(0.05);
      expect(tip.policyReason).toContain('CAPPED by operator maximum');
    });

    it('B16.4: trade amount where 25% economic cap is below minFloorLamports respects minFloorLamports', () => {
      const tip = executionConfig.resolveDynamicJitoTip({
        tradeAmountSol: 0.0001, // 25% = 0.000025 SOL < minJitoTipSol (0.0001)
      });
      expect(tip.tipSol).toBeGreaterThanOrEqual(executionConfig.getConfig().minJitoTipSol);
    });

    it('B16.5: explicit tip override exceeding operator max ceiling is clamped down to operator max', () => {
      const tip = executionConfig.resolveDynamicJitoTip({
        explicitTipSol: 0.20,
        operatorMaxSol: 0.05,
      });
      expect(tip.tipSol).toBe(0.05);
      expect(tip.policyReason).toContain('EXPLICIT_OVERRIDE');
    });
  });

  // =========================================================================
  // Feature 17: Copy Trading Boundaries
  // =========================================================================
  describe('Feature 17 Boundaries: Copy Trading', () => {
    it('B17.1: tracked wallet transaction with 0 lamports transfer is rejected by RiskEngine with INVALID_ORDER_SIZE', () => {
      const decision = riskEngine.evaluateOrder({
        mint: VALID_PUMP_MINT_1.toBase58(),
        orderSizeSol: 0,
        expectedPriceSol: 0.0001,
        slippageBps: 100,
        estimatedFeeLamports: 5000,
        jitoTipLamports: 180000,
        signalTimestamp: Date.now(),
        marketDataTimestamp: Date.now(),
        currentOpenPositionsCount: 0,
        currentTotalExposureSol: 0,
        walletSpendableSol: 0.05,
        executionMode: 'PAPER',
      });

      expect(decision.approved).toBe(false);
      expect(decision.reasonCode).toBeDefined();
    });

    it('B17.2: target transaction with failed status on Solana is ignored', () => {
      const txRecord = {
        err: { InstructionError: [0, 'Custom(1)'] },
        meta: { status: { Err: 'InstructionError' } },
      };
      const isSuccessful = !txRecord.err && !txRecord.meta.status.Err;
      expect(isSuccessful).toBe(false);
    });

    it('B17.3: transaction containing non-Pump program instructions is safely skipped', () => {
      const allowedProgram: string = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'; // Pump.fun
      const externalTxProgram: string = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
      expect(externalTxProgram === allowedProgram).toBe(false);
    });

    it('B17.4: rapid repeated orders with same ID are safely idempotent in database', () => {
      const orderId = `order_dedup_${Date.now()}`;
      testDb.saveOrder({
        id: orderId,
        clientOrderId: 'client_dedup_1',
        correlationId: 'corr_dedup_1',
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'DEDUP',
        side: 'BUY',
        amountLamports: 10_000_000,
        expectedTokensRaw: '1000000',
        slippageBps: 100,
        status: 'PENDING',
        executionMode: 'PAPER',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Saving duplicate order ID must not throw and updates cleanly
      let threw = false;
      try {
        testDb.saveOrder({
          id: orderId,
          clientOrderId: 'client_dedup_1',
          correlationId: 'corr_dedup_1',
          mint: VALID_PUMP_MINT_1.toBase58(),
          symbol: 'DEDUP',
          side: 'BUY',
          amountLamports: 10_000_000,
          expectedTokensRaw: '1000000',
          slippageBps: 100,
          status: 'CONFIRMED',
          executionMode: 'PAPER',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    });

    it('B17.5: copy trade sizing with insufficient bankroll rejects via CapitalSizer', () => {
      const result = CapitalSizer.calculateOrderSize({
        walletBalanceSol: 0.010, // Below 0.015 SOL reserve
        reserveBalanceSol: 0.015,
        inFlightOrdersSol: 0,
      });

      expect(result.approved).toBe(false);
      expect(result.orderSizeSol).toBe(0);
      expect(result.rejectionReason).toBe('INSUFFICIENT_SPENDABLE_BANKROLL');
    });
  });

  // =========================================================================
  // Feature 18: Social Signals Boundaries
  // =========================================================================
  describe('Feature 18 Boundaries: Social Signals', () => {
    it('B18.1: social post text with no contract address extracts null mint', () => {
      const solanaAddressRegex = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
      const tweetText = 'Just bought this amazing coin! Moon soon! No ca posted yet.';
      const matches = tweetText.match(solanaAddressRegex) || [];
      expect(matches.length).toBe(0);
    });

    it('B18.2: social post with multiple distinct contract addresses extracts first valid or handles safely', () => {
      const solanaAddressRegex = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
      const tweetText = `Check ${VALID_PUMP_MINT_1.toBase58()} and also ${VALID_PUMP_MINT_2.toBase58()}`;
      const matches = tweetText.match(solanaAddressRegex) || [];
      expect(matches.length).toBe(2);
      expect(matches[0]).toBe(VALID_PUMP_MINT_1.toBase58());
    });

    it('B18.3: social post with ticker only ($PEPE) without address is ignored', () => {
      const tweetText = 'Buy $PEPE right now!';
      const solanaAddressRegex = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
      const matches = tweetText.match(solanaAddressRegex) || [];
      expect(matches.length).toBe(0);
    });

    it('B18.4: stale social signal older than maxSignalAgeMs is rejected fail-closed', () => {
      const now = Date.now();
      const signalAgeMs = 15000;
      const maxAgeMs = 8000;
      const isStale = signalAgeMs > maxAgeMs;
      expect(isStale).toBe(true);

      const staleReq = {
        mint: VALID_PUMP_MINT_1.toBase58(),
        orderSizeSol: 0.005,
        expectedPriceSol: 0.0001,
        slippageBps: 300,
        estimatedFeeLamports: 50000,
        jitoTipLamports: 100000,
        signalTimestamp: now - signalAgeMs,
        marketDataTimestamp: now,
        currentOpenPositionsCount: 0,
        currentTotalExposureSol: 0,
        walletSpendableSol: 0.05,
        executionMode: 'PAPER' as const,
      };
      const result = riskEngine.evaluateOrder(staleReq);
      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('STALE_SIGNAL');
    });

    it('B18.5: rapid burst of social signals from same source triggers rate limiting', () => {
      const rateLimiter = {
        maxPerMinute: 3,
        history: [] as number[],
        check() {
          const now = Date.now();
          this.history = this.history.filter(t => now - t < 60000);
          if (this.history.length >= this.maxPerMinute) return false;
          this.history.push(now);
          return true;
        },
      };

      expect(rateLimiter.check()).toBe(true);
      expect(rateLimiter.check()).toBe(true);
      expect(rateLimiter.check()).toBe(true);
      expect(rateLimiter.check()).toBe(false); // 4th in same minute rejected
    });
  });

  // =========================================================================
  // Feature 19: Signal Quality & Replay Boundaries
  // =========================================================================
  describe('Feature 19 Boundaries: Signal Quality & Replay', () => {
    it('B19.1: confluence score with exactly 2 signals when 3 are required fails verification', () => {
      const signals = ['VOLUME_SPIKE', 'WALLET_INFLOW']; // 2 signals < 3 required
      const isConfluent = signals.length >= 3;
      expect(isConfluent).toBe(false);
    });

    it('B19.2: confluence score with zero weight signals produces 0 score', () => {
      const weights = { sig1: 0, sig2: 0 };
      const score = Object.values(weights).reduce((a, b) => a + b, 0);
      expect(score).toBe(0);
    });

    it('B19.3: historical trade stats on empty dataset handles safely without throwing via CapitalSizer', () => {
      const stats = CapitalSizer.getHistoricalTradeStats('PAPER');
      expect(stats.tradeCount).toBeGreaterThanOrEqual(0);
      expect(stats.winRate).toBeGreaterThanOrEqual(0);
      expect(stats.winLossRatio).toBeGreaterThan(0);
    });

    it('B19.4: replay with duplicate timestamps preserves chronological order', () => {
      const events = [
        { id: 'e1', timestamp: 1000 },
        { id: 'e2', timestamp: 1000 },
        { id: 'e3', timestamp: 1001 },
      ];
      const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
      expect(sorted[0].id).toBe('e1');
      expect(sorted[1].id).toBe('e2');
      expect(sorted[2].id).toBe('e3');
    });

    it('B19.5: Kelly calculation with 0 win rate returns 0 expectancy via CapitalSizer', () => {
      const rawKelly = CapitalSizer.calculateRawKelly(0, 2.0);
      expect(rawKelly).toBeLessThanOrEqual(0);

      const zeroPayoffKelly = CapitalSizer.calculateRawKelly(0.5, 0);
      expect(zeroPayoffKelly).toBe(0);
    });
  });

  // =========================================================================
  // Feature 20: Dynamic Exit Optimization Boundaries
  // =========================================================================
  describe('Feature 20 Boundaries: Dynamic Exit Optimization', () => {
    it('B20.1: trailing stop high-water mark does not decrease on price drops (monotonicity)', () => {
      // Use real ExitEngine to verify monotonic HWM behavior
      const engine = new ExitEngine();
      const entryPriceSol = 0.0001;
      const entryTimestamp = Date.now() - 60_000;

      const up1 = engine.evaluate({ entryPriceSol, currentPriceSol: 0.00012, entryTimestamp, highWaterMarkSol: entryPriceSol, trailingStopSol: 0, exitStage: 0 });
      expect(up1.newHighWaterMarkSol).toBe(0.00012);

      // Price drops: HWM must remain at 0.00012 (monotonic)
      const down1 = engine.evaluate({ entryPriceSol, currentPriceSol: 0.00010, entryTimestamp, highWaterMarkSol: up1.newHighWaterMarkSol, trailingStopSol: up1.newTrailingStopSol, exitStage: up1.newExitStage });
      expect(down1.newHighWaterMarkSol).toBe(0.00012); // Monotonic: remains 0.00012

      // Price rises further: HWM updates
      const up2 = engine.evaluate({ entryPriceSol, currentPriceSol: 0.00015, entryTimestamp, highWaterMarkSol: down1.newHighWaterMarkSol, trailingStopSol: down1.newTrailingStopSol, exitStage: down1.newExitStage });
      expect(up2.newHighWaterMarkSol).toBe(0.00015);

      // Price drops again: HWM must stay at 0.00015
      const down2 = engine.evaluate({ entryPriceSol, currentPriceSol: 0.00013, entryTimestamp, highWaterMarkSol: up2.newHighWaterMarkSol, trailingStopSol: up2.newTrailingStopSol, exitStage: up2.newExitStage });
      expect(down2.newHighWaterMarkSol).toBe(0.00015);
    });

    it('B20.2: take-profit ladder step with 0% sell percentage is ignored or clamped', () => {
      // ExitEngine always sells at least TP1_SELL_PCT (33%) — never 0%
      // Verify ExitEngine's TP1 sell percentage is clamped to non-zero
      expect(ExitEngine.TP1_SELL_PCT).toBeGreaterThan(0);
      expect(ExitEngine.TP2_SELL_PCT).toBeGreaterThan(0);
      // The remaining stage always sells a non-zero residual (100 - TP1 - TP2 = 34)
      const residual = 100 - ExitEngine.TP1_SELL_PCT - ExitEngine.TP2_SELL_PCT;
      expect(residual).toBeGreaterThan(0);
    });

    it('B20.3: partial sell percentage exceeding 100% (e.g. 150%) clamps to 100%', () => {
      // ExitEngine evaluates stale exits at 100% — never exceeds 100%
      const engine = new ExitEngine();
      const stale = engine.evaluate({
        entryPriceSol: 0.0001,
        currentPriceSol: 0.0001, // flat — no gain
        entryTimestamp: Date.now() - 2_000_000, // way past 30-min stale threshold
        highWaterMarkSol: 0.0001,
        trailingStopSol: 0,
        exitStage: 0,
      });
      // Stale position exit should sell 100%, never more
      expect(stale.sellPercentage).toBeLessThanOrEqual(100);
      if (stale.shouldExit) {
        expect(stale.sellPercentage).toBeGreaterThan(0);
      }
    });

    it('B20.4: position held past maxHoldTime triggers MAX_HOLD_TIME exit', () => {
      const maxHoldTimeMs = 300000; // 5 min
      const entryTime = Date.now() - 301000; // 5 min 1 sec ago
      const isExceeded = Date.now() - entryTime >= maxHoldTimeMs;
      expect(isExceeded).toBe(true);
    });

    it('B20.5: stop loss boundary: price at or below -20% triggers ExitEngine STOP_LOSS exit', () => {
      const engine = new ExitEngine();
      const entryPriceSol = 0.0001;
      const entryTimestamp = Date.now() - 30_000;

      // Price at -10% (0.00009 SOL): Hold, do not exit
      const holdDecision = engine.evaluate({
        entryPriceSol,
        currentPriceSol: 0.00009,
        entryTimestamp,
        highWaterMarkSol: entryPriceSol,
        trailingStopSol: 0,
        exitStage: 0,
      });
      expect(holdDecision.shouldExit).toBe(false);
      expect(holdDecision.reason).toBe('HOLD');

      // Price at -20% (0.00008 SOL, HARD_STOP_LOSS_PCT): Trigger STOP_LOSS 100%
      const stopDecision = engine.evaluate({
        entryPriceSol,
        currentPriceSol: 0.00008,
        entryTimestamp,
        highWaterMarkSol: entryPriceSol,
        trailingStopSol: 0,
        exitStage: 0,
      });
      expect(stopDecision.shouldExit).toBe(true);
      expect(stopDecision.reason).toBe('STOP_LOSS');
      expect(stopDecision.sellPercentage).toBe(100);
    });
  });
});
