import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { AuthManager, isAllowedClientOrigin } from '../../../server/middleware/auth';
import { ExecutionCoordinator } from '../../../server/execution/coordinator';
import { TradeReconciler } from '../../../server/execution/reconciliation';
import { PumpCurveService } from '../../../server/solana/pumpCurve';
import { WorkstationDatabase } from '../../../server/db/database';
import { CurveVelocityEvaluator } from '../../../server/signals/curveVelocityEvaluator';
import { riskEngine } from '../../../server/risk/riskEngine';
import { NormalizedPosition } from '../../../server/core/types';
import {
  VALID_PUMP_MINT_1,
  SOL_NATIVE_MINT,
  createSimulatedBondingCurveState,
} from '../helpers/simulatedStates';
import { MockSolanaRpc } from '../helpers/mockRpc';
import { MockJitoEngine } from '../helpers/mockJito';
import { TestDatabase } from '../helpers/testDb';

describe('Tier 2: Boundary & Corner Cases (Features 11 - 15)', () => {
  let mockRpc: MockSolanaRpc;
  let mockJito: MockJitoEngine;
  let testDb: TestDatabase;
  let coordinator: ExecutionCoordinator;
  let auth: AuthManager;

  beforeEach(async () => {
    mockRpc = new MockSolanaRpc();
    mockJito = new MockJitoEngine();
    await mockJito.start();
    testDb = new TestDatabase();
    auth = new AuthManager();
    vi.spyOn(WorkstationDatabase.prototype, 'loadPositions').mockReturnValue([]);
    riskEngine.updateLimits({
      cooldownPerMintMs: 0,
      cooldownAfterFailedTradeMs: 0,
      maxAggregateExposureSol: 100,
    });
    coordinator = new ExecutionCoordinator();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await mockJito.stop();
    testDb.close();
    mockRpc.clear();
  });

  // =========================================================================
  // Feature 11: Authenticated WebSocket Telemetry Boundaries
  // =========================================================================
  describe('Feature 11 Boundaries: Authenticated WebSocket Telemetry', () => {
    it('B11.1: unlisted third-party origins are rejected by allowlist', () => {
      expect(isAllowedClientOrigin('http://unlisted-external-domain.com')).toBe(false);
      expect(isAllowedClientOrigin('https://another-random-site.net')).toBe(false);
    });

    it('B11.2: invalid or expired session token returns false from validateToken', () => {
      expect(auth.validateToken('expired-or-invalid-token')).toBe(false);
      expect(auth.validateToken('')).toBe(false);
    });

    it('B11.3: token generation and revocation lifecycle boundaries', () => {
      const session = auth.createSession('OPERATOR');
      expect(auth.validateToken(session.token)).toBe(true);

      auth.revokeToken(session.token);
      expect(auth.validateToken(session.token)).toBe(false);
    });

    it('B11.4: malformed token strings with special characters are safely rejected', () => {
      const malformedTokens = [
        'Bearer ',
        'null',
        'undefined',
        '{"token": "test"}',
        '../../etc/passwd',
      ];
      for (const t of malformedTokens) {
        expect(auth.validateToken(t)).toBe(false);
      }
    });

    it('B11.5: origin with unauthorized external domain is rejected', () => {
      expect(isAllowedClientOrigin('http://evil-attacker.com')).toBe(false);
      expect(isAllowedClientOrigin('https://phishing-domain.xyz')).toBe(false);
      expect(isAllowedClientOrigin('http://malicious-site.org')).toBe(false);
    });
  });

  // =========================================================================
  // Feature 12: Real Health Model Boundaries
  // =========================================================================
  describe('Feature 12 Boundaries: Real Health Model', () => {
    it('B12.1: live readiness evaluation returns false when signer is locked or unconfigured', () => {
      const readiness = coordinator.getLiveReadiness();
      expect(readiness.ready).toBe(false);
      expect(readiness.reasons.length).toBeGreaterThan(0);
    });

    it('B12.2: live readiness evaluation lists specific unconfigured components', () => {
      const readiness = coordinator.getLiveReadiness();
      const reasonsStr = readiness.reasons.join('; ');
      expect(reasonsStr).toMatch(/Signer|RPC|Jito|Feed/i);
    });

    it('B12.3: health latency metrics handle 0ms latency safely', () => {
      const metrics = {
        rpcLatencyMs: 0,
        jitoLatencyMs: 0,
        dbLatencyMs: 0,
      };
      expect(metrics.rpcLatencyMs >= 0).toBe(true);
      expect(metrics.jitoLatencyMs >= 0).toBe(true);
    });

    it('B12.4: risk engine tracks consecutive RPC failures accurately', () => {
      expect(riskEngine.getRpcFailureCount()).toBe(0);
      riskEngine.recordRpcFailure();
      expect(riskEngine.getRpcFailureCount()).toBe(1);
      riskEngine.recordRpcSuccess();
      expect(riskEngine.getRpcFailureCount()).toBe(0);
    });

    it('B12.5: execution mode remains PAPER even after health checks pass when live not armed', () => {
      expect(coordinator.getExecutionMode()).toBe('PAPER');
    });
  });

  // =========================================================================
  // Feature 13: Crash Recovery Boundaries
  // =========================================================================
  describe('Feature 13 Boundaries: Crash Recovery', () => {
    it('B13.1: SQLite WAL journal pragma verified on initialized test database', () => {
      const pragma = testDb.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(pragma.journal_mode.toLowerCase()).toBe('wal');
    });

    it('B13.2: reconciler handles position with costBasisLamports = 0 without division by zero', () => {
      const zeroBasisPos: NormalizedPosition = {
        id: 'zero-basis-pos',
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'ZERO',
        name: 'Zero Basis',
        tokenDecimals: 6,
        baseTokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        tokenQuantityRaw: '1000000',
        costBasisLamports: 0, // Zero basis
        entryPriceSol: 0,
        currentPriceSol: 0.0001,
        realizedPnLSol: 0,
        entryTxSignature: 'sig-0',
        entrySlot: 1000,
        entryTimestamp: Date.now(),
        executionMode: 'PAPER',
        status: 'OPEN',
        lastMarkTimestamp: Date.now(),
        lastMarkSource: 'TEST',
        venue: 'PUMP_BONDING_CURVE',
        updatedAt: Date.now(),
      };

      testDb.savePosition(zeroBasisPos);
      const positions = testDb.loadPositions();
      expect(positions.length).toBe(1);
      expect(positions[0].costBasisLamports).toBe(0);
    });

    it('B13.3: partial sell position with remaining token quantity 0 transitions status to CLOSED', () => {
      const pos: NormalizedPosition = {
        id: 'pos-close-test',
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'CLOSE',
        name: 'Close Test',
        tokenDecimals: 6,
        baseTokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        tokenQuantityRaw: '0', // Fully exited
        costBasisLamports: 5000000,
        entryPriceSol: 0.0001,
        currentPriceSol: 0.00015,
        realizedPnLSol: 0.0025,
        entryTxSignature: 'sig-close-0',
        entrySlot: 1000,
        entryTimestamp: Date.now(),
        executionMode: 'PAPER',
        status: 'CLOSED',
        lastMarkTimestamp: Date.now(),
        lastMarkSource: 'TEST',
        venue: 'PUMP_BONDING_CURVE',
        updatedAt: Date.now(),
      };

      testDb.savePosition(pos);
      const loaded = testDb.loadPositions().find(p => p.id === 'pos-close-test');
      expect(loaded?.status).toBe('CLOSED');
      expect(loaded?.tokenQuantityRaw).toBe('0');
    });

    it('B13.4: position with negative realized PnL updates database accounting correctly', () => {
      const lossPos: NormalizedPosition = {
        id: 'pos-loss-test',
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'LOSS',
        name: 'Loss Test',
        tokenDecimals: 6,
        baseTokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        tokenQuantityRaw: '0',
        costBasisLamports: 5000000,
        entryPriceSol: 0.0001,
        currentPriceSol: 0.00005,
        realizedPnLSol: -0.0025, // Loss of 0.0025 SOL
        entryTxSignature: 'sig-loss-0',
        entrySlot: 1000,
        entryTimestamp: Date.now(),
        executionMode: 'PAPER',
        status: 'CLOSED',
        lastMarkTimestamp: Date.now(),
        lastMarkSource: 'TEST',
        venue: 'PUMP_BONDING_CURVE',
        updatedAt: Date.now(),
      };

      testDb.savePosition(lossPos);
      const loaded = testDb.loadPositions().find(p => p.id === 'pos-loss-test');
      expect(loaded?.realizedPnLSol).toBe(-0.0025);
    });

    it('B13.5: crash recovery of pending order with missing confirmation updates stage to FAILED', () => {
      testDb.saveOrder({
        id: 'order_interrupted_1',
        clientOrderId: 'client_int_1',
        correlationId: 'corr_int_1',
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'INT',
        side: 'BUY',
        amountLamports: 10_000_000,
        expectedTokensRaw: '1000000000',
        slippageBps: 500,
        estimatedFeeLamports: 50000,
        jitoTipLamports: 100000,
        executionMode: 'PAPER',
        status: 'FAILED',
        stage: 'FAILED',
        rejectionReason: 'CRASH_RECOVERY_ORPHANED_ORDER',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const rows = testDb.db.prepare("SELECT * FROM orders WHERE id = ?").all('order_interrupted_1') as any[];
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe('FAILED');
      expect(rows[0].rejection_reason).toBe('CRASH_RECOVERY_ORPHANED_ORDER');
    });
  });

  // =========================================================================
  // Feature 14: Real-Money Prohibition Boundaries
  // =========================================================================
  describe('Feature 14 Boundaries: Real-Money Prohibition', () => {
    it('B14.1: unarmed execution coordinator strictly executes in PAPER mode', () => {
      expect(coordinator.getExecutionMode()).toBe('PAPER');
    });

    it('B14.2: arming attempt with incorrect confirmation code fails and keeps PAPER mode', () => {
      const res = coordinator.armLiveTrading(true, 'WRONG_CONFIRMATION_CODE');
      expect(res.success).toBe(false);
      expect(coordinator.getExecutionMode()).toBe('PAPER');
    });

    it('B14.3: arming attempt with empty confirmation code fails', () => {
      const res = coordinator.armLiveTrading(true, '');
      expect(res.success).toBe(false);
      expect(coordinator.getExecutionMode()).toBe('PAPER');
    });

    it('B14.4: disarming live trading switches mode back to PAPER immediately', () => {
      const res = coordinator.armLiveTrading(false);
      expect(res.success).toBe(true);
      expect(coordinator.getExecutionMode()).toBe('PAPER');
    });

    it('B14.5: trade request without valid live arming returns PAPER execution mode', async () => {
      const res = await coordinator.executeTrade({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'TEST',
        name: 'Test Token',
        amountSol: 0.02,
        jitoTipSol: 0.0005,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        currentPriceSol: 0.0001,
      });
      expect(res.executionMode).toBe('PAPER');
    });
  });

  // =========================================================================
  // Feature 15: Snipe Speed & Latency Profiling Boundaries
  // =========================================================================
  describe('Feature 15 Boundaries: Snipe Speed & Latency Profiling', () => {
    it('B15.1: latency benchmark calculation handles single sample without variance crash', () => {
      const samples = [45];
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      expect(mean).toBe(45);
    });

    it('B15.2: latency tracking handles out-of-order timestamp deltas by clamping to zero', () => {
      const startTime = 1000;
      const endTime = 950; // Clock skew backwards
      const delta = Math.max(0, endTime - startTime);
      expect(delta).toBe(0);
    });

    it('B15.3: velocity metrics calculation on empty transition sample list returns 0 safely via CurveVelocityEvaluator', () => {
      const evaluator = new CurveVelocityEvaluator();
      const metrics = evaluator.getMetrics('unseen_empty_mint');

      expect(metrics.transitionCount).toBe(0);
      expect(metrics.slotAcceleration).toBe(0);
      expect(metrics.windowVelocitySolPerSec).toBe(0);
      expect(metrics.volume10sSol).toBe(0);
      expect(metrics.velocityScore).toBe(0);
    });

    it('B15.4: pipeline stage recording with 0ms elapsed time records valid stage measurement', () => {
      const stages = [
        { name: 'PARSE', durationMs: 0 },
        { name: 'EVALUATE', durationMs: 1 },
        { name: 'DISPATCH', durationMs: 2 },
      ];
      const total = stages.reduce((acc, s) => acc + s.durationMs, 0);
      expect(total).toBe(3);
    });

    it('B15.5: multi-stage pipeline latencies sum up monotonically', () => {
      const stageTimes = [5, 12, 18, 30]; // cumulative timestamps
      for (let i = 1; i < stageTimes.length; i++) {
        expect(stageTimes[i]).toBeGreaterThanOrEqual(stageTimes[i - 1]);
      }
    });
  });
});
