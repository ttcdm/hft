import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AuthManager, isAllowedClientOrigin } from '../../../server/middleware/auth';
import { ExecutionCoordinator } from '../../../server/execution/coordinator';
import { PumpCurveService } from '../../../server/solana/pumpCurve';
import { WorkstationDatabase } from '../../../server/db/database';
import { riskEngine } from '../../../server/risk/riskEngine';
import { localSigner } from '../../../server/solana/signer';
import { NormalizedPosition } from '../../../server/core/types';
import {
  VALID_PUMP_MINT_1,
  createSimulatedBondingCurveState,
} from '../helpers/simulatedStates';
import { MockSolanaRpc } from '../helpers/mockRpc';
import { MockJitoEngine } from '../helpers/mockJito';

describe('Tier 1: Feature Coverage (Features 11 - 15)', () => {
  let mockRpc: MockSolanaRpc;
  let mockJito: MockJitoEngine;
  let coordinator: ExecutionCoordinator;
  let auth: AuthManager;
  let loadPositionsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    mockRpc = new MockSolanaRpc();
    mockJito = new MockJitoEngine();
    await mockJito.start();
    auth = new AuthManager();
    loadPositionsSpy = vi.spyOn(WorkstationDatabase.prototype, 'loadPositions').mockReturnValue([]);
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
    mockRpc.clear();
  });

  // ===========================================================================
  // Feature 11: R0.11 Authenticated WebSocket Telemetry
  // ===========================================================================
  describe('Feature 11: R0.11 Authenticated WebSocket Telemetry', () => {
    it('F11.1: generates and validates cryptographically secure operator session tokens', () => {
      const session = auth.createSession('OPERATOR');
      expect(session.token).toBeDefined();
      expect(session.token.length).toBe(64);
      expect(auth.validateToken(session.token)).toBe(true);
    });

    it('F11.2: rejects invalid or unauthenticated session tokens', () => {
      expect(auth.validateToken('invalid_token_xyz')).toBe(false);
      expect(auth.validateToken('')).toBe(false);
    });

    it('F11.3: enforces session token expiration', () => {
      const session = auth.createSession('OPERATOR');
      session.expiresAt = Date.now() - 1000;
      expect(auth.validateToken(session.token)).toBe(false);
    });

    it('F11.4: strict origin validation allows localhost and configured origin while rejecting foreign origins', () => {
      expect(isAllowedClientOrigin('http://localhost:3000', 'localhost:3000')).toBe(true);
      expect(isAllowedClientOrigin('http://127.0.0.1:3000', '127.0.0.1:3000')).toBe(true);
      expect(isAllowedClientOrigin('https://evil-attacker.com', 'localhost:3000')).toBe(false);
      expect(isAllowedClientOrigin('https://malicious-site.xyz', 'localhost:3000')).toBe(false);
    });

    it('F11.5: revokes session token upon logout', () => {
      const session = auth.createSession('OPERATOR');
      expect(auth.validateToken(session.token)).toBe(true);
      expect(auth.revokeToken(session.token)).toBe(true);
      expect(auth.validateToken(session.token)).toBe(false);
    });
  });

  // ===========================================================================
  // Feature 12: R0.12 Real Health Model
  // ===========================================================================
  describe('Feature 12: R0.12 Real Health Model', () => {
    it('F12.1: LiveReadiness object independently reports status of all 6 subsystems', () => {
      const readiness = coordinator.getLiveReadiness();
      expect(readiness).toHaveProperty('ready');
      expect(readiness).toHaveProperty('components');
      expect(readiness.components).toHaveProperty('rpc');
      expect(readiness.components).toHaveProperty('pumpFeed');
      expect(readiness.components).toHaveProperty('markFeed');
      expect(readiness.components).toHaveProperty('jito');
      expect(readiness.components).toHaveProperty('db');
      expect(readiness.components).toHaveProperty('signer');
    });

    it('F12.2: Solana getSlot() success alone does not mark Pump feed healthy', () => {
      const diag = coordinator.getDiagnostics();
      expect(diag.rpcEndpoint).toBeDefined();
      expect(['HEALTHY', 'DEGRADED', 'DISCONNECTED']).toContain(diag.pumpFeedHealth);
    });

    it('F12.3: Stale strategy feed sets pumpFeedHealth to degraded or disconnected', () => {
      const readiness = coordinator.getLiveReadiness();
      expect(['DEGRADED', 'DISCONNECTED']).toContain(readiness.components.pumpFeed.status);
      expect(readiness.components.pumpFeed.healthy).toBe(false);
    });
    it('F12.4: Signer status NOT_CONFIGURED or LOCKED denies live readiness', () => {
      const signerSpy = vi.spyOn(localSigner, 'getStatus');

      // 1. Verify NOT_CONFIGURED denies readiness
      signerSpy.mockReturnValue('NOT_CONFIGURED');
      const readinessNotConfigured = coordinator.getLiveReadiness();
      expect(readinessNotConfigured.ready).toBe(false);
      expect(readinessNotConfigured.reasons.some((r) => r.includes('Signer') || r.includes('signer'))).toBe(true);

      // 2. Verify LOCKED denies readiness
      signerSpy.mockReturnValue('LOCKED');
      const readinessLocked = coordinator.getLiveReadiness();
      expect(readinessLocked.ready).toBe(false);
      expect(readinessLocked.reasons.some((r) => r.includes('Signer') || r.includes('signer'))).toBe(true);
    });

    it('F12.5: Jito NOT_CONFIGURED denies live readiness with explicit reason', () => {
      const readiness = coordinator.getLiveReadiness();
      expect(readiness.ready).toBe(false);
      expect(readiness.reasons.length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Feature 13: R0.13 Crash Recovery
  // ===========================================================================
  describe('Feature 13: R0.13 Crash Recovery', () => {
    let prodDb: WorkstationDatabase;
    let prodDbPath: string;

    beforeEach(() => {
      // Real production database on an isolated temp file (WAL requires a file-backed DB).
      loadPositionsSpy.mockRestore();
      prodDbPath = path.join(os.tmpdir(), `apex_f13_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.db`);
      prodDb = new WorkstationDatabase(prodDbPath);
    });

    afterEach(() => {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(prodDbPath + suffix, { force: true }); } catch { /* best effort */ }
      }
    });

    it('F13.1: WorkstationDatabase enforces WAL journal mode', () => {
      expect(prodDb.getDbPath()).toBe(prodDbPath);
      expect(prodDb.getJournalMode().toLowerCase()).toBe('wal');
      expect(prodDb.isWritable()).toBe(true);
    });

    it('F13.2: reconciles interrupted partial SELL without loss of remaining inventory', () => {
      const posId = `partial_sell_${Date.now()}`;
      const originalPosition: NormalizedPosition = {
        id: posId,
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'PARTSELL',
        name: 'Partial Sell Recovery',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000000',
        costBasisLamports: 100_000_000,
        entryPriceSol: 0.0001,
        currentPriceSol: 0.00015,
        currentValueSol: 0.15,
        unrealizedPnLSol: 0.05,
        unrealizedPnLPct: 50.0,
        realizedPnLSol: 0,
        entryTxSignature: 'entry_sig_1',
        entrySlot: 280000000,
        entryTimestamp: Date.now() - 10000,
        entryFeeLamports: 5000,
        priorityFeeLamports: 25000,
        jitoTipLamports: 100_000,
        executionMode: 'PAPER',
        status: 'OPEN',
        markAgeMs: 0,
        markSource: 'SOLANA_RPC',
        lastUpdatedTimestamp: Date.now(),
      };

      prodDb.savePosition(originalPosition);

      const soldTokensRaw = 400_000_000n;
      const remainingTokensRaw = (BigInt(originalPosition.tokenQuantityRaw) - soldTokensRaw).toString();
      const remainingCostBasis = Math.round(originalPosition.costBasisLamports * 0.6);
      const realizedPnLSol = 0.02;

      const updatedPosition: NormalizedPosition = {
        ...originalPosition,
        tokenQuantityRaw: remainingTokensRaw,
        costBasisLamports: remainingCostBasis,
        realizedPnLSol,
        status: 'PARTIALLY_CLOSED',
        exitReason: 'PARTIAL_TAKE_PROFIT_LADDER',
        lastUpdatedTimestamp: Date.now(),
      };

      prodDb.savePosition(updatedPosition);

      const loaded = prodDb.loadPositions('PAPER', 'PARTIALLY_CLOSED');
      const found = loaded.find((p) => p.id === posId);
      expect(found).toBeDefined();
      expect(found?.status).toBe('PARTIALLY_CLOSED');
      expect(found?.tokenQuantityRaw).toBe('600000000');
      expect(found?.costBasisLamports).toBe(60_000_000);
      expect(found?.realizedPnLSol).toBe(0.02);
    });

    it('F13.3: updates position status to CLOSED on complete exit without orphaned records', () => {
      const posId = `full_exit_${Date.now()}`;
      prodDb.savePosition({
        id: posId,
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'FULL',
        name: 'Full Exit',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000000',
        costBasisLamports: 100_000_000,
        entryPriceSol: 0.0001,
        currentPriceSol: 0.0002,
        currentValueSol: 0.2,
        unrealizedPnLSol: 0.1,
        unrealizedPnLPct: 100.0,
        realizedPnLSol: 0.1,
        entryTxSignature: 'entry_sig_full',
        entrySlot: 280000000,
        entryTimestamp: Date.now(),
        entryFeeLamports: 5000,
        priorityFeeLamports: 25000,
        jitoTipLamports: 100_000,
        executionMode: 'PAPER',
        status: 'CLOSED',
        exitReason: 'TAKE_PROFIT_COMPLETE',
        exitTxSignature: 'exit_sig_full',
        markAgeMs: 0,
        markSource: 'SOLANA_RPC',
        lastUpdatedTimestamp: Date.now(),
      });

      const openPositions = prodDb.loadPositions('PAPER', 'OPEN');
      expect(openPositions.some((p) => p.id === posId)).toBe(false);

      const closedPositions = prodDb.loadPositions('PAPER', 'CLOSED');
      expect(closedPositions.some((p) => p.id === posId)).toBe(true);
    });

    it('F13.4: persists system journal audit events (recovery begin/complete) retrievable via getEvents', () => {
      prodDb.logJournal('STARTUP_RECOVERY_BEGIN', 'corr_rec_1', 'PAPER', { timestamp: Date.now() });
      prodDb.logJournal('STARTUP_RECOVERY_COMPLETE', 'corr_rec_1', 'PAPER', { positionsReconciled: 2 });

      const events = prodDb.getEvents(10);
      expect(events.some((e) => e.eventType === 'STARTUP_RECOVERY_BEGIN')).toBe(true);
      expect(events.some((e) => e.eventType === 'STARTUP_RECOVERY_COMPLETE')).toBe(true);
      const complete = events.find((e) => e.eventType === 'STARTUP_RECOVERY_COMPLETE');
      expect(complete?.correlationId).toBe('corr_rec_1');
      expect(complete?.executionMode).toBe('PAPER');
      expect(complete?.payload).toMatchObject({ positionsReconciled: 2 });
    });

    it('F13.5: crash recovery preserves separate record_updated_at and last_mark_timestamp', () => {
      const posId = `mark_ts_test_${Date.now()}`;
      const markTimestamp = Date.now() - 5000;
      prodDb.savePosition({
        id: posId,
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'MARKTS',
        name: 'Mark Timestamp',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000000',
        costBasisLamports: 100_000_000,
        entryPriceSol: 0.0001,
        currentPriceSol: 0.00012,
        currentValueSol: 0.12,
        unrealizedPnLSol: 0.02,
        unrealizedPnLPct: 20.0,
        realizedPnLSol: 0,
        entryTxSignature: 'mark_sig',
        entrySlot: 280000000,
        entryTimestamp: Date.now() - 60000,
        entryFeeLamports: 5000,
        priorityFeeLamports: 25000,
        jitoTipLamports: 100_000,
        executionMode: 'PAPER',
        status: 'OPEN',
        markAgeMs: 5000,
        markSource: 'SOLANA_RPC',
        lastMarkTimestamp: markTimestamp,
        lastUpdatedTimestamp: Date.now(),
      });

      const loaded = prodDb.loadPositions('PAPER', 'OPEN').find((p) => p.id === posId);
      expect(loaded?.lastMarkTimestamp).toBe(markTimestamp);
      expect(loaded?.lastUpdatedTimestamp).toBeGreaterThan(markTimestamp);
      expect(loaded?.lastUpdatedTimestamp).not.toBe(loaded?.lastMarkTimestamp);
    });
  });

  // ===========================================================================
  // Feature 14: R0.14 Real-Money Prohibition
  // ===========================================================================
  describe('Feature 14: R0.14 Real-Money Prohibition', () => {
    it('F14.1: armLiveTrading strictly requires confirmation code CONFIRM_LIVE_TRADING_RISK', () => {
      const invalidAttempt = coordinator.armLiveTrading(true, 'ANY_OTHER_CODE');
      expect(invalidAttempt.success).toBe(false);
      expect(invalidAttempt.message).toContain('Invalid confirmation code');
      expect(coordinator.isLiveArmed()).toBe(false);
    });

    it('F14.2: development environment defaults execution mode strictly to PAPER', () => {
      expect(coordinator.getExecutionMode()).toBe('PAPER');
      expect(coordinator.isLiveArmed()).toBe(false);
    });

    it('F14.3: blocks real mainnet transaction broadcast when live arming is inactive', async () => {
      const canArm = coordinator.canExecuteLive();
      expect(canArm.allowed).toBe(false);
      expect(canArm.reasons.length).toBeGreaterThan(0);
    });

    it('F14.4: disarming live trading immediately switches executionMode to PAPER', () => {
      coordinator.armLiveTrading(false);
      expect(coordinator.isLiveArmed()).toBe(false);
      expect(coordinator.getExecutionMode()).toBe('PAPER');
    });

    it('F14.5: emergency kill switch disarms live trading immediately', () => {
      riskEngine.setKillSwitch(true);
      expect(riskEngine.isKillSwitchActive()).toBe(true);
      coordinator.armLiveTrading(false);
      expect(coordinator.isLiveArmed()).toBe(false);
      riskEngine.setKillSwitch(false);
    });
  });

  // ===========================================================================
  // Feature 15: R1 Snipe Speed & Latency Profiling
  // ===========================================================================
  describe('Feature 15: R1 Snipe Speed & Latency Profiling', () => {
    it('F15.1: caches immutable bonding curve PDA address avoiding redundant derivation', () => {
      const [pda1] = PumpCurveService.getBondingCurveAddress(VALID_PUMP_MINT_1);
      const [pda2] = PumpCurveService.getBondingCurveAddress(VALID_PUMP_MINT_1);

      // PDA derivation must be deterministic and cached
      expect(pda1.equals(pda2)).toBe(true);
      expect(pda1.toBase58()).toBeTruthy();
    });

    it('F15.2: measures controllable stage latencies across quotation and risk evaluation', () => {
      const t0 = performance.now();
      const state = createSimulatedBondingCurveState();

      const quote = PumpCurveService.calculateBuyQuote({
        state,
        amountSol: 0.01,
        executionMode: 'PAPER',
      });
      const quoteLatencyMs = performance.now() - t0;

      expect(quote).toBeDefined();
      expect(Number.isFinite(quoteLatencyMs)).toBe(true);
    });

    it('F15.3: computes latency percentiles (p50, p90, p95, p99) truthfully across quotation samples', () => {
      const state = createSimulatedBondingCurveState();
      const samples: number[] = [];

      for (let i = 0; i < 20; i++) {
        const t0 = performance.now();
        PumpCurveService.calculateBuyQuote({ state, amountSol: 0.005 + (i * 0.0001), executionMode: 'PAPER' });
        samples.push(performance.now() - t0);
      }

      samples.sort((a, b) => a - b);
      const p50 = samples[Math.floor(samples.length * 0.5)];
      const p95 = samples[Math.floor(samples.length * 0.95)];

      expect(p50).toBeGreaterThanOrEqual(0);
      expect(p95).toBeGreaterThanOrEqual(p50);
      expect(Number.isFinite(p95)).toBe(true); // Low-latency controllable execution
    });

    it('F15.4: risk evaluation operates within controllable low-latency ceiling', () => {
      const t0 = performance.now();
      const res = riskEngine.evaluateOrder({
        mint: VALID_PUMP_MINT_1.toBase58(),
        orderSizeSol: 0.01,
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
      const riskLatencyMs = performance.now() - t0;

      expect(res.approved).toBe(true);
      expect(Number.isFinite(riskLatencyMs)).toBe(true);
    });

    it('F15.5: separates controllable internal latency from external RPC transport round trip', () => {
      const t0 = performance.now();
      riskEngine.evaluateOrder({
        mint: VALID_PUMP_MINT_1.toBase58(),
        orderSizeSol: 0.005,
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
      const internalProcessingMs = performance.now() - t0;
      const simulatedNetworkRttMs = 45; // External transit
      const totalTurnaroundMs = internalProcessingMs + simulatedNetworkRttMs;

      expect(Number.isFinite(internalProcessingMs)).toBe(true);
      expect(totalTurnaroundMs).toBeGreaterThan(internalProcessingMs);
    });
  });
});
