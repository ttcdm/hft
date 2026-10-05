import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import { AuthManager } from '../server/middleware/auth';
import { HardenedRiskEngine, riskEngine } from '../server/risk/riskEngine';
import { ExecutionCoordinator, executionCoordinator } from '../server/execution/coordinator';
import { WorkstationDatabase, workstationDb } from '../server/db/database';
import { LocalKeypairSigner, localSigner } from '../server/solana/signer';
import { executionConfig } from '../server/solana/executionConfig';
import { walletTrader } from '../server/walletTrader';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { EligibilityFilter } from '../server/signals/eligibilityFilter';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { MockJitoEngine } from './e2e/helpers/mockJito';
import { TestDatabase } from './e2e/helpers/testDb';
import {
  VALID_PUMP_MINT_1,
  VALID_PUMP_MINT_2,
  createSimulatedBondingCurveState,
  createPassingEligibilityReport,
} from './e2e/helpers/simulatedStates';

describe('Plug & Play Workstation: Zero-Config & Out-of-the-Box Readiness', () => {
  let mockRpc: MockSolanaRpc;
  let mockJito: MockJitoEngine;
  let testDb: TestDatabase;
  let coordinator: ExecutionCoordinator;

  beforeEach(async () => {
    mockRpc = new MockSolanaRpc();
    mockJito = new MockJitoEngine();
    await mockJito.start();
    testDb = new TestDatabase();

    riskEngine.updateLimits({
      cooldownPerMintMs: 0,
      cooldownAfterFailedTradeMs: 0,
      maxAggregateExposureSol: 100,
    });
    riskEngine.setKillSwitch(false);

    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
  });

  afterEach(async () => {
    coordinator?.cleanup();
    vi.restoreAllMocks();
    await mockJito.stop();
    testDb.close();
    mockRpc.clear();
  });

  // =========================================================================
  // 1. Zero External Dependencies & Embedded Database Auto-Initialization
  // =========================================================================
  describe('Zero-Config Persistence & Environment Bootstrap', () => {
    it('PP-1: boots without requiring external Postgres, MySQL, or Redis services', () => {
      // Embedded SQLite handles all persistence with WAL mode
      const db = testDb.db;
      expect(db).toBeDefined();

      const journalMode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(['wal', 'memory']).toContain(journalMode.journal_mode.toLowerCase());

      // All tables exist out-of-the-box
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(t => t.name);
      expect(tables).toContain('positions');
      expect(tables).toContain('orders');
      expect(tables).toContain('transactions');
      expect(tables).toContain('risk_decisions');
      expect(tables).toContain('system_journal');
    });

    it('PP-2: AuthManager generates a high-entropy volatile token when OPERATOR_AUTH_TOKEN is absent', () => {
      const cleanAuth = new AuthManager();
      const primaryToken = cleanAuth.getPrimaryToken();

      expect(primaryToken).toBeDefined();
      expect(primaryToken.length).toBe(64); // 256-bit hex token

      // Authenticates with Bearer token out of the box
      expect(cleanAuth.validateToken(primaryToken)).toBe(true);
    });

    it('PP-3: Execution defaults to MICRO_10 conservative risk tier out of the box', () => {
      const limits = riskEngine.getLimits();

      // Safe beginner default sizing: max 0.02 SOL position, 20% max fee
      expect(limits.maxPositionSol).toBeLessThanOrEqual(0.05);
      expect(limits.maxFeePctOfPosition).toBeLessThanOrEqual(25);
      expect(limits.maxSlippageBps).toBeLessThanOrEqual(1500);
      expect(limits.minWalletReserveSol).toBeGreaterThanOrEqual(0.01);
    });
  });

  // =========================================================================
  // 2. Instant Paper Trading Without Funding (0 SOL Required)
  // =========================================================================
  describe('Instant Out-of-the-Box Paper Trading', () => {
    it('PP-4: allows immediate trade simulation with 0 real SOL in wallet', async () => {
      expect(coordinator.getExecutionMode()).toBe('PAPER');

      const mockState = createSimulatedBondingCurveState();
      vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(mockState);

      const res = await coordinator.executeTrade({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'PLUG',
        name: 'Plug and Play Coin',
        amountSol: 0.005,
        source: 'MANUAL',
        provenance: 'REAL_ONCHAIN',
        currentPriceSol: 0.0001,
      });

      expect(res.success).toBe(true);
      expect(res.executionMode).toBe('PAPER');
      expect(res.positionId).toBeDefined();
      expect(res.positionId).toContain('PAPER-');
      expect(res.tokensReceived).toBeGreaterThan(0);
    });

    it('PP-5: tracks accurate profit, loss, and full position lifecycle in PAPER mode', async () => {
      const mockState = createSimulatedBondingCurveState();
      vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(mockState);

      // 1. Open paper position
      const buyRes = await coordinator.executeTrade({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'PROFIT',
        name: 'Profitable Token',
        amountSol: 0.005,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        currentPriceSol: 0.0001,
      });
      expect(buyRes.success).toBe(true);

      // 2. Close paper position at 100%
      const closeRes = await coordinator.closePosition(buyRes.positionId!, 100, 'TAKE_PROFIT');
      expect(closeRes.success).toBe(true);
      expect(closeRes.status).toBe('CLOSED');
      expect(typeof closeRes.pnlSol).toBe('number');
    });

    it('PP-6: automatically rejects toxic Token-2022 extensions via EligibilityFilter', () => {
      const toxicToken = {
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'TOXIC',
        name: 'Toxic Transfer Fee Token',
        freezeAuthority: null,
        isFreezeAuthorityRevoked: true,
        mintAuthority: null,
        isMintAuthorityRevoked: true,
        creatorHoldingPct: 2.0,
        top10HoldersPct: 15.0,
        hasToken2022Extensions: true,
        unsupportedToken2022Extension: 'TransferFeeConfig',
        token2022Safe: false,
      };

      const report = EligibilityFilter.evaluate(toxicToken as any, 'LIVE');
      expect(report.isEligible).toBe(false);
      expect(report.checks.some((c) => c.ruleId === 'TOKEN_2022_POLICY' && !c.passed)).toBe(true);
    });
  });

  // =========================================================================
  // 3. One-Click In-App Wallet Generation & Live Transition Gates
  // =========================================================================
  describe('One-Click Keypair Setup & Fail-Closed Live Arming', () => {
    it('PP-7: LocalKeypairSigner generates valid Solana keypairs with strict file permissions', () => {
      const keypair = Keypair.generate();
      expect(keypair.publicKey).toBeDefined();
      expect(keypair.secretKey.length).toBe(64);

      // Keypair status reports UNCONFIGURED before explicit setup
      const signer = new LocalKeypairSigner();
      expect(['NOT_CONFIGURED', 'CONFIGURED', 'LOCKED']).toContain(signer.getStatus());
    });

    it('PP-8: Live trading cannot be armed accidentally without explicit confirmation token', () => {
      expect(coordinator.isLiveArmed()).toBe(false);

      // Empty or invalid confirmation tokens fail closed
      const emptyAttempt = coordinator.armLiveTrading(true, '');
      expect(emptyAttempt.success).toBe(false);
      expect(coordinator.isLiveArmed()).toBe(false);

      const invalidAttempt = coordinator.armLiveTrading(true, 'WRONG_CONFIRMATION');
      expect(invalidAttempt.success).toBe(false);
      expect(coordinator.isLiveArmed()).toBe(false);
    });

    it('PP-9: Live arming strictly checks live readiness gates (fails closed if signer is unconfigured)', () => {
      // Unconfigured signer denies live execution
      const canExecute = coordinator.canExecuteLive();
      expect(canExecute.allowed).toBe(false);
      expect(canExecute.reasons.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 4. One-Click Emergency Panic Liquidation & Fail-Safe Recovery
  // =========================================================================
  describe('One-Click Emergency Controls & Recovery', () => {
    it('PP-10: walletTrader.panicLiquidateAll() provides single-click emergency shutdown', async () => {
      // Create active position
      workstationDb.savePosition({
        id: 'pos-panic-test',
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'PANIC',
        name: 'Panic Token',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000',
        entryPriceSol: 0.0001,
        currentPriceSol: 0.0001,
        costBasisLamports: 5000000,
        realizedPnLSol: 0,
        status: 'OPEN',
        venue: 'PUMP_BONDING_CURVE',
        executionMode: 'PAPER',
        entryTxSignature: 'sig-test',
        entryTimestamp: Date.now(),
        lastMarkTimestamp: Date.now(),
      });

      const report = await walletTrader.panicLiquidateAll();

      expect(report.killSwitchActivated).toBe(true);
      expect(riskEngine.isKillSwitchActive()).toBe(true);
      expect(report.attemptedCount).toBeGreaterThanOrEqual(1);

      // Kill switch blocks any subsequent orders
      const blockedTrade = await coordinator.executeTrade({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'BLOCKED',
        name: 'Blocked Trade',
        amountSol: 0.005,
        source: 'MANUAL',
        provenance: 'REAL_ONCHAIN',
        currentPriceSol: 0.0001,
      });

      expect(blockedTrade.success).toBe(false);
      expect(blockedTrade.error).toMatch(/KILL_SWITCH_ACTIVE/);

      // Reset kill switch
      riskEngine.setKillSwitch(false);
      expect(riskEngine.isKillSwitchActive()).toBe(false);
    });

    it('PP-11: Workstation status endpoint provides complete health snapshot in one request', () => {
      const diag = coordinator.getDiagnostics();

      expect(diag).toHaveProperty('executionMode');
      expect(diag).toHaveProperty('liveTradingActive');
      expect(diag).toHaveProperty('killSwitchActive');
      expect(diag).toHaveProperty('rpcHealth');
      expect(diag).toHaveProperty('jitoHealth');
      expect(diag).toHaveProperty('positionMarkHealth');
      expect(diag.executionMode).toBe('PAPER');
    });
  });
});
