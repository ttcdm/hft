import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HardenedRiskEngine } from '../../../server/risk/riskEngine';
import { executionConfig } from '../../../server/solana/executionConfig';
import { WorkstationDatabase } from '../../../server/db/database';
import { ExecutionCoordinator } from '../../../server/execution/coordinator';
import { EligibilityFilter } from '../../../server/signals/eligibilityFilter';
import { CapitalSizer } from '../../../server/capital/capitalSizer';
import { TestDatabase } from '../helpers/testDb';
import { MockSolanaRpc } from '../helpers/mockRpc';
import { MockJitoEngine } from '../helpers/mockJito';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Tier 2: Boundary & Corner Cases (Features 21 - 25)', () => {
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
      maxFeePctOfPosition: 20.0,
      maxSlippageBps: 800,
    });
    vi.spyOn(WorkstationDatabase.prototype, 'loadPositions').mockReturnValue([]);
    vi.spyOn(WorkstationDatabase.prototype, 'getDailyRealizedPnLSol').mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    testDb.close();
  });

  // =========================================================================
  // Feature 21 Boundaries: R7 MICRO_10 Capital Efficiency
  // =========================================================================
  describe('Feature 21 Boundaries: R7 MICRO_10 Capital Efficiency', () => {
    it('B21.1: wallet balance exactly equal to minimum reserve (0.015 SOL) yields exactly 0 spendable bankroll', () => {
      // CapitalSizer.calculateSpendableBankroll enforces the production formula
      const minReserve = CapitalSizer.DEFAULT_RESERVE_SOL; // 0.015

      expect(CapitalSizer.calculateSpendableBankroll(0.015, minReserve, 0)).toBe(0);
      expect(CapitalSizer.calculateSpendableBankroll(0.014999, minReserve, 0)).toBe(0);
      expect(CapitalSizer.calculateSpendableBankroll(0.015001, minReserve, 0)).toBeCloseTo(0.000001, 6);
    });

    it('B21.2: win rate boundary: 0% win rate yields zero sizing; 100% win rate is capped by Kelly fraction and 10% hard cap', () => {
      // CapitalSizer.calculateRawKelly(p, b) + shrinkage + fraction + hard cap
      const bankroll = 0.070;
      const b = 2.0; // 2:1 payoff ratio
      const fraction = CapitalSizer.DEFAULT_FRACTION_MULTIPLIER; // 0.25
      const ceiling = CapitalSizer.DEFAULT_MAX_CAPITAL_PCT_CEILING; // 0.10

      // 0% win rate -> rawKelly <= 0 -> 0 sizing
      const rawKellyZeroWin = CapitalSizer.calculateRawKelly(0.0, b);
      expect(Math.max(0, rawKellyZeroWin) * fraction * bankroll).toBe(0);

      // 100% win rate with 2.0 payoff -> rawKelly = 1.0 * fraction -> 0.07 * 0.25 = 0.0175,
      // but hard 10% cap clamps to bankroll * 0.10 = 0.007 SOL
      const rawKellyFullWin = CapitalSizer.calculateRawKelly(1.0, b);
      const shrinkage = CapitalSizer.calculateShrinkage(30); // assume sufficient history
      const uncapped = bankroll * Math.max(0, rawKellyFullWin) * shrinkage * fraction;
      const hardCapped = Math.min(bankroll * ceiling, uncapped);
      expect(hardCapped).toBeCloseTo(0.007, 4);
    });

    it('B21.3: order size boundary at exactly 10.000% of bankroll (0.007000 SOL) is approved; 10.001% (0.007001 SOL) is rejected', () => {
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

      // Exactly 0.007000 SOL (10% of 0.07 SOL)
      const exactPass = riskEngine.evaluateOrder({ ...baseReq, orderSizeSol: 0.007 });
      expect(exactPass.approved).toBe(true);

      // Exceeding by 1 micro-SOL (0.007001 SOL)
      const exactFail = riskEngine.evaluateOrder({ ...baseReq, orderSizeSol: 0.007001 });
      expect(exactFail.approved).toBe(false);
      expect(exactFail.reasonCode).toBe('MAX_POSITION_SIZE');
    });

    it('B21.4: daily loss boundary: daily loss exceeding maxDailyLossSol rejects with DAILY_LOSS_LIMIT', () => {
      // Exactly at daily loss limit (-0.05 SOL):
      vi.spyOn(WorkstationDatabase.prototype, 'getDailyRealizedPnLSol').mockReturnValue(-0.05);

      const baseReq = {
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

      const atLimitResult = riskEngine.evaluateOrder(baseReq);
      // At or beyond -0.05 daily loss, trading must halt
      expect(atLimitResult.approved).toBe(false);
      expect(atLimitResult.reasonCode).toBe('DAILY_LOSS_LIMIT');

      // Beyond daily loss limit (-0.0501 SOL)
      vi.spyOn(WorkstationDatabase.prototype, 'getDailyRealizedPnLSol').mockReturnValue(-0.0501);
      const beyondResult = riskEngine.evaluateOrder(baseReq);
      expect(beyondResult.approved).toBe(false);
      expect(beyondResult.reasonCode).toBe('DAILY_LOSS_LIMIT');
    });

    it('B21.5: fee ratio boundary: execution cost > 20.00% of trade size rejects with EXPECTED_EDGE_BELOW_EXECUTION_COST', () => {
      // Position size: 0.005 SOL = 5,000,000 lamports
      // 20% limit = 1,000,000 lamports
      const baseReq = {
        mint: '11111111111111111111111111111111',
        orderSizeSol: 0.005,
        expectedPriceSol: 0.0001,
        slippageBps: 300,
        signalTimestamp: Date.now(),
        marketDataTimestamp: Date.now(),
        currentOpenPositionsCount: 0,
        currentTotalExposureSol: 0,
        walletSpendableSol: 0.05,
        executionMode: 'PAPER' as const,
      };

      // Case A: Total fees = 1,000,000 lamports = exactly 20.00%
      const boundaryPass = riskEngine.evaluateOrder({
        ...baseReq,
        estimatedFeeLamports: 100000,
        jitoTipLamports: 900000, // Total = 1,000,000 lamports = exactly 20%
      });
      expect(boundaryPass.approved).toBe(true);

      // Case B: Total fees = 1,000,500 lamports = 20.01% (> 20.00%)
      const boundaryFail = riskEngine.evaluateOrder({
        ...baseReq,
        estimatedFeeLamports: 100500,
        jitoTipLamports: 900000, // Total = 1,000,500 lamports = 20.01%
      });
      expect(boundaryFail.approved).toBe(false);
      expect(boundaryFail.reasonCode).toBe('EXPECTED_EDGE_BELOW_EXECUTION_COST');
    });
  });

  // =========================================================================
  // Feature 22 Boundaries: Final E2E Test Pass (Tiers 1-4)
  // =========================================================================
  describe('Feature 22 Boundaries: Final E2E Test Pass', () => {
    it('B22.1: independent TestDatabase instances can be instantiated and closed rapidly without locking errors', () => {
      for (let i = 0; i < 5; i++) {
        const dbInstance = new TestDatabase();
        expect(fs.existsSync(dbInstance.dbPath)).toBe(true);
        dbInstance.saveOrder({
          id: `order_${i}`,
          clientOrderId: `client_${i}`,
          correlationId: `corr_${i}`,
          mint: '11111111111111111111111111111111',
          symbol: 'TEST',
          side: 'BUY',
          amountLamports: 5000000,
          expectedTokensRaw: '1000000',
          slippageBps: 300,
          status: 'PENDING',
          executionMode: 'PAPER',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        const saved = dbInstance.db.prepare('SELECT * FROM orders WHERE id = ?').get(`order_${i}`) as any;
        expect(saved).toBeDefined();
        expect(saved?.client_order_id).toBe(`client_${i}`);
        dbInstance.close();
        expect(fs.existsSync(dbInstance.dbPath)).toBe(false);
      }
    });

    it('B22.2: mock RPC responds synchronously with 0ms latency without timing out', async () => {
      const mockRpc = new MockSolanaRpc();
      const conn = mockRpc.createConnection();
      const startTime = Date.now();
      const slot = await conn.getSlot();
      const elapsed = Date.now() - startTime;

      expect(slot).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(100);
    });

    it('B22.3: mock Jito engine simulates bundle drop/timeout correctly without infinite hang', async () => {
      const mockJito = new MockJitoEngine();
      await mockJito.start();
      const res = await fetch('https://mock-jito-engine.local/api/v1/bundles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getBundleStatuses',
          params: [['non_existent_bundle_id']],
        }),
      });
      const json = await res.json();
      expect(json.result).toBeDefined();
      expect(json.result.value.length).toBe(1);
      expect(json.result.value[0]).toBeNull();
      mockJito.clear();
    });

    it('B22.4: sequential order evaluations execute with deterministic state isolation', () => {
      const baseReq = {
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

      for (let i = 0; i < 10; i++) {
        const mint = `MintAddressSequentialTest${i.toString().padStart(4, '0')}111111`;
        const res = riskEngine.evaluateOrder({
          ...baseReq,
          mint,
          orderSizeSol: 0.005,
        });
        expect(res.approved).toBe(true);
      }
    });

    it('B22.5: TestDatabase creates zero residual temp files after closing WAL', () => {
      const tempInstance = new TestDatabase();
      const dbPath = tempInstance.dbPath;
      const walPath = `${dbPath}-wal`;
      const shmPath = `${dbPath}-shm`;

      expect(fs.existsSync(dbPath)).toBe(true);
      tempInstance.close();

      expect(fs.existsSync(dbPath)).toBe(false);
      expect(fs.existsSync(walPath)).toBe(false);
      expect(fs.existsSync(shmPath)).toBe(false);
    });
  });

  // =========================================================================
  // Feature 23 Boundaries: Adversarial Coverage Hardening
  // =========================================================================
  describe('Feature 23 Boundaries: Adversarial Coverage Hardening', () => {
    it('B23.1: extreme integer values in order requests are handled safely without overflowing', () => {
      const extremeReq = {
        mint: '11111111111111111111111111111111',
        orderSizeSol: Number.MAX_SAFE_INTEGER,
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

      const result = riskEngine.evaluateOrder(extremeReq);
      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('MAX_POSITION_SIZE');
    });

    it('B23.2: SQL injection strings in mint or symbol are safely parameterized in database', () => {
      const maliciousMint = "'; DROP TABLE positions; --";
      const maliciousSymbol = "TEST' UNION SELECT * FROM orders; --";

      testDb.savePosition({
        id: 'pos_injection_test',
        mint: maliciousMint,
        symbol: maliciousSymbol,
        name: 'Injection Token',
        tokenDecimals: 6,
        baseTokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        entryPriceSol: 0.0001,
        currentPriceSol: 0.0001,
        tokenQuantityRaw: '1000000',
        costBasisLamports: 5000000,
        realizedPnLSol: 0,
        status: 'OPEN',
        venue: 'PUMP_BONDING_CURVE',
        executionMode: 'PAPER',
        entryTxSignature: 'mock_tx_sig',
        entryTimestamp: Date.now(),
        recordUpdatedAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Confirm positions table still exists and record was inserted verbatim
      const pos = testDb.db.prepare('SELECT * FROM positions WHERE id = ?').get('pos_injection_test') as any;
      expect(pos).toBeDefined();
      expect(pos?.mint).toBe(maliciousMint);
      expect(pos?.symbol).toBe(maliciousSymbol);

      // Verify table count is still 1
      const count = testDb.db.prepare("SELECT count(*) as count FROM positions").get() as { count: number };
      expect(count.count).toBe(1);
    });

    it('B23.3: rapid repeated burst requests trigger cooldown fail-closed rejection', () => {
      const mint = 'RapidBurstTestMint1111111111111111111111';
      riskEngine.updateLimits({ cooldownPerMintMs: 15000 });

      // First trade succeeds
      riskEngine.recordTradeSuccess(mint);

      const burstReq = {
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

      const result = riskEngine.evaluateOrder(burstReq);
      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('DUPLICATE_MINT');
    });

    it('B23.4: circuit breaker trips on consecutive RPC failures and cleanly resumes after reset', () => {
      expect(riskEngine.getCircuitBreakerState()).toBe('CLOSED');

      // 3 consecutive failures trips circuit breaker
      riskEngine.recordRpcFailure();
      riskEngine.recordRpcFailure();
      riskEngine.recordRpcFailure();

      expect(riskEngine.getCircuitBreakerState()).toBe('OPEN');
      expect(riskEngine.isKillSwitchActive()).toBe(true);

      // Reset circuit breaker and kill switch
      riskEngine.setCircuitBreaker('CLOSED');
      riskEngine.setKillSwitch(false);

      expect(riskEngine.getCircuitBreakerState()).toBe('CLOSED');
      expect(riskEngine.isKillSwitchActive()).toBe(false);

      // Can now approve valid order
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
      const res = riskEngine.evaluateOrder(validReq);
      expect(res.approved).toBe(true);
    });

    it('B23.5: malformed token evaluation in LIVE mode fails-closed safely', () => {
      // In LIVE mode, any unknown/unmodeled authority or missing data rejects
      const badReport = EligibilityFilter.evaluate({
        mint: '',
        symbol: '',
        name: '',
        liquidityUsd: 0,
        isFreezeAuthorityRevoked: 'UNKNOWN',
      }, 'LIVE');

      expect(badReport.isEligible).toBe(false);
      expect(badReport.failedCount).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Feature 24 Boundaries: Build, Typecheck, Lint & Rust Gates
  // =========================================================================
  describe('Feature 24 Boundaries: Build, Typecheck, Lint & Rust Gates', () => {
    it('B24.1: tsconfig enforces target, moduleResolution, and skipLibCheck', () => {
      const tsconfigPath = path.resolve(process.cwd(), 'tsconfig.json');
      const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));

      expect(tsconfig.compilerOptions).toBeDefined();
      expect(tsconfig.compilerOptions.target).toBe('ES2022');
      expect(tsconfig.compilerOptions.moduleResolution).toBe('bundler');
      expect(tsconfig.compilerOptions.skipLibCheck).toBe(true);
    });

    it('B24.2: package.json specifies pinned dependencies without loose wildcard versions', () => {
      const pkgPath = path.resolve(process.cwd(), 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

      // Crucial SDKs pinned
      const deps = pkg.dependencies || {};
      expect(deps['@pump-fun/pump-sdk']).toBe('1.37.0');
      expect(deps['@pump-fun/pump-swap-sdk']).toBe('1.20.0');
    });

    it('B24.3: Cargo workspace defines native Rust release optimization settings', () => {
      const cargoPath = path.resolve(process.cwd(), 'Cargo.toml');
      const cargoContent = fs.readFileSync(cargoPath, 'utf8');

      expect(cargoContent).toContain('[profile.release]');
      expect(cargoContent).toContain('opt-level = 3');
      expect(cargoContent).toContain('lto = "fat"');
    });

    it('B24.4: SQLite database schema includes required performance and integrity indexes', () => {
      const db = testDb.db;
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[];
      const indexNames = indexes.map(idx => idx.name);

      expect(indexNames.some(name => name.includes('positions'))).toBe(true);
      expect(indexNames.some(name => name.includes('orders'))).toBe(true);
    });

    it('B24.5: coordinator provides authoritative fail-closed live readiness model', () => {
      const coordinator = new ExecutionCoordinator();
      const readiness = coordinator.getLiveReadiness();
      expect(readiness).toBeDefined();
      expect(readiness.ready).toBe(false);
      expect(readiness.reasons.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Feature 25 Boundaries: Deliverables & Release Package
  // =========================================================================
  describe('Feature 25 Boundaries: Deliverables & Release Package', () => {
    it('B25.1: .gitignore enforces exclusion of sensitive runtime artifacts and logs', () => {
      const gitignorePath = path.resolve(process.cwd(), '.gitignore');
      const content = fs.readFileSync(gitignorePath, 'utf8');

      expect(content).toContain('.env');
      expect(content).toContain('node_modules');
      expect(content).toContain('dist');
      expect(content).toContain('*.log');
    });

    it('B25.2: repository sample configuration does not expose unmasked Solana private keys', () => {
      const exampleEnvPath = path.resolve(process.cwd(), '.env.example');
      if (fs.existsSync(exampleEnvPath)) {
        const content = fs.readFileSync(exampleEnvPath, 'utf8');
        // Must not contain an 88-char base58 private key
        const base58PrivateKeyRegex = /[1-9A-HJ-NP-Za-km-z]{87,88}/;
        expect(base58PrivateKeyRegex.test(content)).toBe(false);
      }
    });

    it('B25.3: execution configuration validates non-zero priority fee and slippage ceilings', () => {
      const config = executionConfig.getConfig();
      expect(config.priorityFeeMicrolamports).toBeGreaterThanOrEqual(1000);
      expect(config.maxSlippageBps).toBeGreaterThan(0);
      expect(config.maxSlippageBps).toBeLessThanOrEqual(2500);
    });

    it('B25.4: arming LIVE mode strictly validates confirmation token format', () => {
      const coordinator = new ExecutionCoordinator();
      const emptyArm = coordinator.armLiveTrading(true, '');
      expect(emptyArm.success).toBe(false);

      const spaceArm = coordinator.armLiveTrading(true, '   ');
      expect(spaceArm.success).toBe(false);

      const wrongArm = coordinator.armLiveTrading(true, 'CONFIRM');
      expect(wrongArm.success).toBe(false);
    });

    it('B25.5: master project architecture documents interface contracts and error standards', () => {
      const projectPath = path.resolve(process.cwd(), 'PROJECT.md');
      const projectDoc = fs.readFileSync(projectPath, 'utf8');

      expect(projectDoc).toContain('Interface Contracts');
      expect(projectDoc).toContain('ExecutionCoordinator');
      expect(projectDoc).toContain('PumpSwap');
    });
  });
});
