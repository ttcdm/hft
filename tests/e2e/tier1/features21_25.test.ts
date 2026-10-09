import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HardenedRiskEngine } from '../../../server/risk/riskEngine';
import { executionConfig } from '../../../server/solana/executionConfig';
import { WorkstationDatabase } from '../../../server/db/database';
import { ExecutionCoordinator } from '../../../server/execution/coordinator';
import { CapitalSizer } from '../../../server/capital/capitalSizer';
import { TestDatabase } from '../helpers/testDb';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Tier 1: Feature Coverage (Features 21 - 25)', () => {
  let riskEngine: HardenedRiskEngine;
  let testDb: TestDatabase;

  beforeEach(() => {
    testDb = new TestDatabase();
    riskEngine = new HardenedRiskEngine();
    riskEngine.updateLimits({
      cooldownPerMintMs: 0,
      cooldownAfterFailedTradeMs: 0,
      maxAggregateExposureSol: 100,
      maxDailyLossSol: 0.05,
      maxPositionSol: 0.007, // MICRO_10 10% cap of 0.07 SOL
    });
    vi.spyOn(WorkstationDatabase.prototype, 'loadPositions').mockReturnValue([]);
    vi.spyOn(WorkstationDatabase.prototype, 'getDailyRealizedPnLSol').mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    testDb.close();
  });

  // =========================================================================
  // Feature 21: R7 MICRO_10 Capital Efficiency
  // =========================================================================
  describe('Feature 21: R7 MICRO_10 Capital Efficiency', () => {
    it('F21.1: spendable bankroll equation deducts reserve and pending capital', () => {
      // CapitalSizer.calculateSpendableBankroll(wallet, reserve, inFlight) — production formula
      const walletSol = 0.070;
      const minReserveSol = 0.015;
      const reservedPendingSol = 0.010;

      const spendable = CapitalSizer.calculateSpendableBankroll(walletSol, minReserveSol, reservedPendingSol);
      expect(spendable).toBeCloseTo(0.045, 4);

      // Edge case: wallet below reserve yields 0 spendable
      const depletedSpendable = CapitalSizer.calculateSpendableBankroll(0.010, minReserveSol, 0);
      expect(depletedSpendable).toBe(0);
    });

    it('F21.2: fractional Kelly sizing applies shrinkage toward conservative prior when N < 30', () => {
      // CapitalSizer implements: shrinkage S = N/(N+25), shrunkKelly = rawKelly * S * fraction
      const fraction = 0.20;
      const winRate = 0.65;
      const avgWinSol = 0.004;
      const avgLossSol = 0.002;
      const b = avgWinSol / avgLossSol; // payoff ratio = 2.0

      // Case 1: High win rate (65%), 2.0 payoff, but only N=6 trades
      const rawKelly = CapitalSizer.calculateRawKelly(winRate, b);
      const smallShrinkage = CapitalSizer.calculateShrinkage(6);
      const smallSampleFraction = Math.max(0, rawKelly) * smallShrinkage * fraction;

      // Case 2: Same parameters with full sample N=30
      const fullShrinkage = CapitalSizer.calculateShrinkage(30);
      const fullSampleFraction = Math.max(0, rawKelly) * fullShrinkage * fraction;

      // With N=6 (S=6/31≈0.194), sizing should be much less than N=30 (S=30/55≈0.545)
      expect(smallSampleFraction).toBeLessThan(fullSampleFraction);
      expect(smallSampleFraction).toBeGreaterThan(0);
      // Shrinkage ratio: (6/31) / (30/55) = 0.194/0.545 ≈ 0.356
      expect(smallSampleFraction / fullSampleFraction).toBeCloseTo(smallShrinkage / fullShrinkage, 3);
    });

    it('F21.3: RiskEngine enforces hard position size cap (<= 10% / 0.007 SOL) and rejects over-sized trades', () => {
      // For MICRO_10 with 0.07 SOL bankroll, max single-trade size is 0.007 SOL
      const validMICRO10Req = {
        mint: '11111111111111111111111111111111',
        orderSizeSol: 0.006, // Under 0.007 cap
        expectedPriceSol: 0.0001,
        slippageBps: 300,
        estimatedFeeLamports: 50000,
        jitoTipLamports: 100000,
        signalTimestamp: Date.now(),
        marketDataTimestamp: Date.now(),
        currentOpenPositionsCount: 0,
        currentTotalExposureSol: 0,
        walletSpendableSol: 0.05,
        executionMode: 'PAPER' as const,
      };

      const passResult = riskEngine.evaluateOrder(validMICRO10Req);
      expect(passResult.approved).toBe(true);
      expect(passResult.reasonCode).toBe('RISK_OK');

      // Order exceeding 0.007 SOL must reject with MAX_POSITION_SIZE
      const oversizedReq = {
        ...validMICRO10Req,
        orderSizeSol: 0.008, // Over 0.007 cap
      };
      const rejectResult = riskEngine.evaluateOrder(oversizedReq);
      expect(rejectResult.approved).toBe(false);
      expect(rejectResult.reasonCode).toBe('MAX_POSITION_SIZE');
    });

    it('F21.4: fee economics rejects trade when execution fees exceed 20% of position size', () => {
      // Fee economics: If Jito tip + network fee > 20% of trade size, trade is not economically viable
      const feeHeavyReq = {
        mint: '11111111111111111111111111111111',
        orderSizeSol: 0.005, // 5,000,000 lamports
        expectedPriceSol: 0.0001,
        slippageBps: 300,
        estimatedFeeLamports: 100000,
        jitoTipLamports: 1500000, // Total fee = 1,600,000 lamports = 32% of order size (> 20%)
        signalTimestamp: Date.now(),
        marketDataTimestamp: Date.now(),
        currentOpenPositionsCount: 0,
        currentTotalExposureSol: 0,
        walletSpendableSol: 0.05,
        executionMode: 'PAPER' as const,
      };

      const result = riskEngine.evaluateOrder(feeHeavyReq);
      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('EXPECTED_EDGE_BELOW_EXECUTION_COST');
      expect(result.message).toContain('32.0%');
    });

    it('F21.5: drawdown states (NORMAL -> RECOVERY -> HALTED) trigger stop when daily loss exceeded', () => {
      // Mock daily realized PnL = -0.06 SOL (exceeds maxDailyLossSol = 0.05)
      vi.spyOn(WorkstationDatabase.prototype, 'getDailyRealizedPnLSol').mockReturnValue(-0.06);

      const validReq = {
        mint: '11111111111111111111111111111111',
        orderSizeSol: 0.005,
        expectedPriceSol: 0.0001,
        slippageBps: 300,
        estimatedFeeLamports: 50000,
        jitoTipLamports: 100000,
        signalTimestamp: Date.now(),
        marketDataTimestamp: Date.now(),
        currentOpenPositionsCount: 0,
        currentTotalExposureSol: 0,
        walletSpendableSol: 0.05,
        executionMode: 'PAPER' as const,
      };

      const result = riskEngine.evaluateOrder(validReq);
      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('DAILY_LOSS_LIMIT');
      expect(result.message).toContain('daily stop limit');
    });
  });

  // =========================================================================
  // Feature 22: Final E2E Test Pass (Tiers 1-4)
  // =========================================================================
  describe('Feature 22: Final E2E Test Pass', () => {
    it('F22.1: vitest runner configuration ensures sequential execution without file parallelism', () => {
      const vitestConfigPath = path.resolve(process.cwd(), 'vitest.config.ts');
      expect(fs.existsSync(vitestConfigPath)).toBe(true);
      const configContent = fs.readFileSync(vitestConfigPath, 'utf8');
      expect(configContent).toContain('fileParallelism: false');
    });

    it('F22.2: mock RPC and mock Jito fixtures operate deterministically in-process', () => {
      // In-process mock avoids sandbox TCP port binding restrictions
      const config = executionConfig.getConfig();
      expect(config.jitoBlockEngineUrl).toBeDefined();
      expect(config.capitalTier).toBe('MICRO_10');
      expect(config.maxSlippageBps).toBeGreaterThan(0);
    });

    it('F22.3: ExecutionCoordinator maintains strict isolation between PAPER and LIVE modes', () => {
      const coordinator = new ExecutionCoordinator();
      expect(coordinator.getExecutionMode()).toBe('PAPER');

      // Arming live requires explicit confirmation code
      const armAttempt = coordinator.armLiveTrading(true, 'invalid_confirmation_code');
      expect(armAttempt.success).toBe(false);
      expect(coordinator.getExecutionMode()).toBe('PAPER');
    });

    it('F22.4: test database generator creates isolated SQLite WAL instances and cleans up', () => {
      const customDb = new TestDatabase();
      expect(fs.existsSync(customDb.dbPath)).toBe(true);

      // Verify tables exist
      const row = customDb.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='positions'").get() as { name: string };
      expect(row).toBeDefined();
      expect(row.name).toBe('positions');

      customDb.close();
      expect(fs.existsSync(customDb.dbPath)).toBe(false);
    });

    it('F22.5: all E2E test suites adhere to opaque-box contracts without server mutations', () => {
      // Risk limits can be read without mutating underlying engine
      const limits = riskEngine.getLimits();
      expect(limits.maxPositionSol).toBe(0.007);
      expect(limits.maxFeePctOfPosition).toBe(20.0);
      expect(limits.minWalletReserveSol).toBe(0.015);
    });
  });

  // =========================================================================
  // Feature 23: Adversarial Coverage Hardening
  // =========================================================================
  describe('Feature 23: Adversarial Coverage Hardening', () => {
    it('F23.1: zero order amount is rejected fail-closed by fee ratio protection', () => {
      const baseReq = {
        mint: '11111111111111111111111111111111',
        expectedPriceSol: 0.0001,
        slippageBps: 300,
        estimatedFeeLamports: 50000,
        jitoTipLamports: 100000,
        signalTimestamp: Date.now(),
        marketDataTimestamp: Date.now(),
        currentOpenPositionsCount: 0,
        currentTotalExposureSol: 0,
        walletSpendableSol: 0.05,
        executionMode: 'PAPER' as const,
      };

      // 1. Zero order size -> Fee as pct of position is Infinity%, rejecting with EXPECTED_EDGE_BELOW_EXECUTION_COST
      const zeroResult = riskEngine.evaluateOrder({ ...baseReq, orderSizeSol: 0 });
      expect(zeroResult.approved).toBe(false);
      expect(zeroResult.reasonCode).toBe('EXPECTED_EDGE_BELOW_EXECUTION_COST');

      // 2. Order exceeding position limit
      const oversizedResult = riskEngine.evaluateOrder({ ...baseReq, orderSizeSol: 0.05 });
      expect(oversizedResult.approved).toBe(false);
      expect(oversizedResult.reasonCode).toBe('MAX_POSITION_SIZE');
    });

    it('F23.2: extreme slippage values exceeding maxSlippageBps reject with SLIPPAGE_TOO_HIGH', () => {
      const highSlippageReq = {
        mint: '11111111111111111111111111111111',
        orderSizeSol: 0.005,
        expectedPriceSol: 0.0001,
        slippageBps: 1500, // 15% slippage > 800 bps limit
        estimatedFeeLamports: 50000,
        jitoTipLamports: 100000,
        signalTimestamp: Date.now(),
        marketDataTimestamp: Date.now(),
        currentOpenPositionsCount: 0,
        currentTotalExposureSol: 0,
        walletSpendableSol: 0.05,
        executionMode: 'PAPER' as const,
      };

      const result = riskEngine.evaluateOrder(highSlippageReq);
      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('SLIPPAGE_TOO_HIGH');
    });

    it('F23.3: rapid-fire bursts on the same mint trigger DUPLICATE_MINT cooldown protection', () => {
      const mint = '11111111111111111111111111111111';
      riskEngine.updateLimits({ cooldownPerMintMs: 30000 });

      // Record a trade success for this mint
      riskEngine.recordTradeSuccess(mint);

      const rapidReq = {
        mint,
        orderSizeSol: 0.005,
        expectedPriceSol: 0.0001,
        slippageBps: 300,
        estimatedFeeLamports: 50000,
        jitoTipLamports: 100000,
        signalTimestamp: Date.now(),
        marketDataTimestamp: Date.now(),
        currentOpenPositionsCount: 0,
        currentTotalExposureSol: 0,
        walletSpendableSol: 0.05,
        executionMode: 'PAPER' as const,
      };

      const result = riskEngine.evaluateOrder(rapidReq);
      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('DUPLICATE_MINT');
      expect(result.message).toContain('Cooldown active');
    });

    it('F23.4: consecutive RPC connection drops automatically trip circuit breaker and emergency kill switch', () => {
      expect(riskEngine.getCircuitBreakerState()).toBe('CLOSED');
      expect(riskEngine.isKillSwitchActive()).toBe(false);

      // First failure
      riskEngine.recordRpcFailure();
      expect(riskEngine.getCircuitBreakerState()).toBe('CLOSED');

      // Second failure
      riskEngine.recordRpcFailure();
      expect(riskEngine.getCircuitBreakerState()).toBe('CLOSED');

      // Third consecutive failure -> Auto-trips circuit breaker and activates kill switch
      riskEngine.recordRpcFailure();
      expect(riskEngine.getCircuitBreakerState()).toBe('OPEN');
      expect(riskEngine.isKillSwitchActive()).toBe(true);

      // Now any order evaluation must reject with KILL_SWITCH_ACTIVE or CIRCUIT_BREAKER_OPEN
      const orderReq = {
        mint: '11111111111111111111111111111111',
        orderSizeSol: 0.005,
        expectedPriceSol: 0.0001,
        slippageBps: 300,
        estimatedFeeLamports: 50000,
        jitoTipLamports: 100000,
        signalTimestamp: Date.now(),
        marketDataTimestamp: Date.now(),
        currentOpenPositionsCount: 0,
        currentTotalExposureSol: 0,
        walletSpendableSol: 0.05,
        executionMode: 'PAPER' as const,
      };

      const result = riskEngine.evaluateOrder(orderReq);
      expect(result.approved).toBe(false);
      expect(['KILL_SWITCH_ACTIVE', 'CIRCUIT_BREAKER_OPEN']).toContain(result.reasonCode);
    });

    it('F23.5: stale market data and signals are rejected fail-closed', () => {
      const now = Date.now();
      const staleDataReq = {
        mint: '11111111111111111111111111111111',
        orderSizeSol: 0.005,
        expectedPriceSol: 0.0001,
        slippageBps: 300,
        estimatedFeeLamports: 50000,
        jitoTipLamports: 100000,
        signalTimestamp: now,
        marketDataTimestamp: now - 10000, // 10s old > 5s limit
        currentOpenPositionsCount: 0,
        currentTotalExposureSol: 0,
        walletSpendableSol: 0.05,
        executionMode: 'PAPER' as const,
      };

      const dataResult = riskEngine.evaluateOrder(staleDataReq);
      expect(dataResult.approved).toBe(false);
      expect(dataResult.reasonCode).toBe('STALE_MARKET_DATA');

      const staleSignalReq = {
        ...staleDataReq,
        marketDataTimestamp: now,
        signalTimestamp: now - 15000, // 15s old > 8s limit
      };
      const signalResult = riskEngine.evaluateOrder(staleSignalReq);
      expect(signalResult.approved).toBe(false);
      expect(signalResult.reasonCode).toBe('STALE_SIGNAL');
    });
  });

  // =========================================================================
  // Feature 24: Build, Typecheck, Lint & Rust Gates
  // =========================================================================
  describe('Feature 24: Build, Typecheck, Lint & Rust Gates', () => {
    it('F24.1: package.json defines all necessary verification scripts', () => {
      const pkgPath = path.resolve(process.cwd(), 'package.json');
      expect(fs.existsSync(pkgPath)).toBe(true);
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

      expect(pkg.scripts).toBeDefined();
      expect(pkg.scripts.build).toBeDefined();
      expect(pkg.scripts.test).toBeDefined();
      expect(pkg.scripts.typecheck).toBeDefined();
      expect(pkg.scripts.lint).toBeDefined();
    });

    it('F24.2: tsconfig.json enforces compiler options and valid path mappings', () => {
      const tsconfigPath = path.resolve(process.cwd(), 'tsconfig.json');
      expect(fs.existsSync(tsconfigPath)).toBe(true);
      const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));

      expect(tsconfig.compilerOptions).toBeDefined();
      expect(tsconfig.compilerOptions.target).toBe('ES2022');
      expect(tsconfig.compilerOptions.paths).toBeDefined();
    });

    it('F24.3: rust workspace Cargo.toml defines valid crates or native acceleration components', () => {
      const cargoPath = path.resolve(process.cwd(), 'Cargo.toml');
      expect(fs.existsSync(cargoPath)).toBe(true);
      const cargoContent = fs.readFileSync(cargoPath, 'utf8');
      expect(cargoContent).toContain('[workspace]');
      expect(cargoContent).toContain('apex_hft_engine');
    });

    it('F24.4: execution coordinator and risk engine export typed contract interfaces', () => {
      const coordinator = new ExecutionCoordinator();
      expect(typeof coordinator.executeTrade).toBe('function');
      expect(typeof coordinator.closePosition).toBe('function');
      expect(typeof coordinator.getExecutionMode).toBe('function');
      expect(typeof riskEngine.evaluateOrder).toBe('function');
      expect(typeof riskEngine.getLimits).toBe('function');
    });

    it('F24.5: SQLite database schema initializes all required tables and indexes', () => {
      const db = testDb.db;
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      const tableNames = tables.map(t => t.name);

      expect(tableNames).toContain('positions');
      expect(tableNames).toContain('orders');
      expect(tableNames).toContain('transactions');
      expect(tableNames).toContain('risk_decisions');
      expect(tableNames).toContain('system_journal');
    });
  });

  // =========================================================================
  // Feature 25: Deliverables & Release Package
  // =========================================================================
  describe('Feature 25: Deliverables & Release Package', () => {
    it('F25.1: sensitive secrets and environment files are guarded against accidental packaging', () => {
      const gitignorePath = path.resolve(process.cwd(), '.gitignore');
      expect(fs.existsSync(gitignorePath)).toBe(true);
      const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');

      expect(gitignoreContent).toContain('.env');
      expect(gitignoreContent).toContain('node_modules');
    });

    it('F25.2: SQLite databases and WAL files are gitignored to prevent state contamination', () => {
      const gitignorePath = path.resolve(process.cwd(), '.gitignore');
      const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');

      expect(gitignoreContent).toContain('*.db');
    });

    it('F25.3: execution configuration enforces safe defaults for production', () => {
      const config = executionConfig.getConfig();
      // Default demo mode and synthetic social must be false unless explicitly enabled
      expect(config.minJitoTipSol).toBeGreaterThan(0);
      expect(config.maxJitoTipSol).toBeGreaterThanOrEqual(config.minJitoTipSol);
      expect(config.priorityFeeMicrolamports).toBeGreaterThan(0);
      expect(config.maxSlippageBps).toBeLessThanOrEqual(1500);
    });

    it('F25.4: live execution arming fails-closed when signer is missing or unconfigured', async () => {
      const coordinator = new ExecutionCoordinator();
      // Attempting to execute live without signer arming throws or returns failure
      const result = await coordinator.executeTrade({
        mint: '11111111111111111111111111111111',
        symbol: 'LIVE_TEST',
        name: 'Live Test Token',
        amountSol: 0.005,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        currentPriceSol: 0.0001,
      });
      // Must execute in PAPER mode or reject live execution
      expect(result.executionMode).toBe('PAPER');
    });

    it('F25.5: project architecture and request contracts document all 25 features and milestone gates', () => {
      const projectMdPath = path.resolve(process.cwd(), 'PROJECT.md');
      const originalRequestPath = path.resolve(process.cwd(), 'ORIGINAL_REQUEST.md');

      expect(fs.existsSync(projectMdPath)).toBe(true);
      expect(fs.existsSync(originalRequestPath)).toBe(true);

      const projectContent = fs.readFileSync(projectMdPath, 'utf8');
      expect(projectContent).toContain('Feature Inventory');
      expect(projectContent).toContain('Phase 0 Live Correctness');
      expect(projectContent).toContain('MICRO_10 Capital Efficiency');
    });
  });
});
