import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator } from '../../../server/execution/coordinator';
import { localSigner } from '../../../server/solana/signer';
import { riskEngine } from '../../../server/risk/riskEngine';
import { workstationDb, WorkstationDatabase } from '../../../server/db/database';
import { executionConfig } from '../../../server/solana/executionConfig';
import { CapitalSizer } from '../../../server/capital/capitalSizer';
import { MockSolanaRpc } from '../helpers/mockRpc';
import { MockJitoEngine } from '../helpers/mockJito';
import { TestDatabase } from '../helpers/testDb';
import { PumpCurveService } from '../../../server/solana/pumpCurve';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState, createPassingEligibilityReport } from '../helpers/simulatedStates';

describe('Tier 5 [mock-level]: Live Production Readiness Gates & Capital Safety Limits', () => {
  let mockRpc: MockSolanaRpc;
  let mockJito: MockJitoEngine;
  let testDb: TestDatabase;
  let coordinator: ExecutionCoordinator;
  let liveTradingKeypair: Keypair;

  beforeEach(async () => {
    liveTradingKeypair = Keypair.generate();
    mockRpc = new MockSolanaRpc();
    mockJito = new MockJitoEngine();
    await mockJito.start();
    testDb = new TestDatabase();

    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(liveTradingKeypair.publicKey);

    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
    (coordinator as any).realWalletBalanceSol = 1.0;
    (coordinator as any).rpcHealth = 'HEALTHY';
    (coordinator as any).pumpFeedHealth = 'HEALTHY';
    (coordinator as any).positionMarkHealth = 'HEALTHY';
    (coordinator as any).lastPumpFeedTimestamp = Date.now();
    (coordinator as any).lastPositionMarkTimestamp = Date.now();
    (coordinator as any).lastRealMarketEventTimestamp = Date.now();
    (coordinator as any).lastStartupReconciliation = {
      status: 'EXECUTION_READY',
      details: 'All on-chain state reconciled. Systems verified.',
      unresolvedPositionsCount: 0,
      timestamp: Date.now(),
    };

    riskEngine.setKillSwitch(false);
    (coordinator.getJitoTransport() as any).lastHealthStatus = 'HEALTHY';
    PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() };
    PumpCurveService.cachedFeeConfig = { feeBps: 100 };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.ALLOW_LIVE_REAL_MONEY_TRADING;
    riskEngine.setKillSwitch(false);
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    await mockJito.stop();
    testDb.close();
    mockRpc.clear();
  });

  // PRG-1, 2, 3, 5, 8, 10 (environment gate, confirmation code, disarm, empty wallet, RPC down, kill switch) moved to
  // tests/behaviour_http.test.ts, which asserts the same rules through the real server's HTTP API (see docs/TEST_FIDELITY.md).

  // =========================================================================
  // 2. Comprehensive Subsystem Live Readiness Invariants (canExecuteLive)
  // =========================================================================
  describe('Comprehensive Subsystem Live Readiness Invariants (canExecuteLive)', () => {
    beforeEach(() => {
      process.env.ALLOW_LIVE_REAL_MONEY_TRADING = 'true';
    });

    it('PRG-4: fails closed if signer is NOT_CONFIGURED or LOCKED', () => {
      vi.spyOn(localSigner, 'getStatus').mockReturnValue('NOT_CONFIGURED');
      const check = coordinator.canExecuteLive();
      expect(check.allowed).toBe(false);
      expect(check.reasons.some((r) => r.includes('Signer status is NOT_CONFIGURED'))).toBe(true);

      vi.spyOn(localSigner, 'getStatus').mockReturnValue('LOCKED');
      const checkLocked = coordinator.canExecuteLive();
      expect(checkLocked.allowed).toBe(false);
      expect(checkLocked.reasons.some((r) => r.includes('Signer status is LOCKED'))).toBe(true);
    });

    it('PRG-6: fails closed if database is not writable', () => {
      vi.spyOn(workstationDb, 'isWritable').mockReturnValue(false);
      const check = coordinator.canExecuteLive();
      expect(check.allowed).toBe(false);
      expect(check.reasons.some((r) => r.includes('database is not writable'))).toBe(true);
    });

    it('PRG-7: fails closed if startup reconciliation is unresolved or missing', () => {
      (coordinator as any).lastStartupReconciliation = null;
      const checkNull = coordinator.canExecuteLive();
      expect(checkNull.allowed).toBe(false);
      expect(checkNull.reasons.some((r) => r.includes('Startup reconciliation'))).toBe(true);

      (coordinator as any).lastStartupReconciliation = {
        status: 'RECONCILIATION_MISMATCH',
        details: 'Unreconciled active positions detected',
      };
      const checkMismatch = coordinator.canExecuteLive();
      expect(checkMismatch.allowed).toBe(false);
      expect(checkMismatch.reasons.some((r) => r.includes('unresolved issues'))).toBe(true);
    });

    it('PRG-9: fails closed if Jito Block Engine health is not HEALTHY', () => {
      vi.spyOn((coordinator as any).jitoTransport, 'getTelemetry').mockReturnValue({
        health: 'DEGRADED',
        lastResponseMsAgo: 5000,
        lastLatencyMs: 850,
        tipFloorLamports: 150000,
        activeTipAccount: null,
        lastError: 'High block engine latency',
      });

      const check = coordinator.canExecuteLive();
      expect(check.allowed).toBe(false);
      expect(check.reasons.some((r) => r.includes('Jito Block Engine is DEGRADED'))).toBe(true);
    });

    it('PRG-11: fails closed if risk circuit breaker is tripped', () => {
      vi.spyOn(riskEngine, 'getCircuitBreakerState').mockReturnValue('OPEN');
      const check = coordinator.canExecuteLive();
      expect(check.allowed).toBe(false);
      expect(check.reasons.some((r) => r.includes('Risk circuit breaker is tripped (OPEN)'))).toBe(true);
    });

    it('PRG-12: allows arming during startup grace period when pump feed is WARMING_UP', () => {
      (coordinator as any).lastPumpFeedTimestamp = 0;
      (coordinator as any).pumpFeedHealth = 'DISCONNECTED';
      (coordinator as any).isDefaultSingleton = true;
      (coordinator as any).startedAt = Date.now();
      (coordinator as any).startupGracePeriodMs = 120_000;

      const check = coordinator.canExecuteLive();
      expect(check.allowed).toBe(true);
      expect(check.readiness.components.pumpFeed.status).toBe('WARMING_UP');

      const armResult = coordinator.armLiveTrading(true, 'CONFIRM_LIVE_TRADING_RISK');
      expect(armResult.success).toBe(true);
      expect(armResult.message).toMatch(/feeds warming up/);
    });
  });

  // =========================================================================
  // 3. Pre-Trade Capital Sizing & In-Flight Concurrency Controls
  // =========================================================================
  describe('Pre-Trade Capital Sizing & In-Flight Concurrency Controls', () => {
    beforeEach(() => {
      process.env.ALLOW_LIVE_REAL_MONEY_TRADING = 'true';
      coordinator.armLiveTrading(true, 'CONFIRM_LIVE_TRADING_RISK');
      const mockState = createSimulatedBondingCurveState();
      vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(mockState);
    });

    it('PRG-13: strictly rejects trade sizes exceeding 10% spendable bankroll ceiling with EXCEEDS_CAPITAL_CEILING', async () => {
      // Wallet = 0.50 SOL. Reserve = 0.015 SOL. Spendable = 0.485 SOL.
      (coordinator as any).realWalletBalanceSol = 0.50;
      (coordinator as any).inFlightReservedSol = 0;

      const spendable = CapitalSizer.calculateSpendableBankroll(0.50, 0.015, 0);
      const ceilingSol = Number((spendable * 0.10).toFixed(6)); // ~0.0485 SOL

      // Order size 0.06 SOL exceeds 10% ceiling
      const result = await coordinator.executeTrade({
        signalTimestamp: Date.now(),
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'TEST1',
        name: 'Test Token 1',
        amountSol: 0.06,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        eligibilityReport: createPassingEligibilityReport(VALID_PUMP_MINT_1.toBase58()),
      });

      expect(result.success).toBe(false);
      expect(result.lifecycleState).toBe('RISK_REJECTED');
      expect(result.error).toMatch(/EXCEEDS_CAPITAL_CEILING/);
      expect(result.error).toMatch(new RegExp(ceilingSol.toString()));
    });

    it('PRG-14: in-flight balance reservation blocks concurrent orders that would breach reserve', async () => {
      // Wallet = 0.01517 SOL. Reserve = 0.01500 SOL. Spendable = 0.00017 SOL.
      // 10% ceiling = 0.000017 SOL.
      // Order size = 0.000010 SOL (passes 10% ceiling).
      // Required = order + tip (0.00015) + fees > spendable -> breaches 0.015 reserve
      (coordinator as any).realWalletBalanceSol = 0.01517;
      (coordinator as any).inFlightReservedSol = 0;

      const result = await coordinator.executeTrade({
        signalTimestamp: Date.now(),
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'TEST1',
        name: 'Test Token 1',
        amountSol: 0.00001,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        eligibilityReport: createPassingEligibilityReport(VALID_PUMP_MINT_1.toBase58()),
      });

      expect(result.success).toBe(false);
      expect(result.lifecycleState).toBe('RISK_REJECTED');
      expect(result.error).toMatch(/INSUFFICIENT_FUNDS_CONCURRENCY/);
    });

    it('PRG-15: in-flight reservation is safely released when trade execution fails', async () => {
      (coordinator as any).realWalletBalanceSol = 0.10;
      (coordinator as any).inFlightReservedSol = 0;

      // Force quote error to trigger failure after reservation acquire
      vi.spyOn(coordinator as any, 'submitAndConfirmWithRetry').mockResolvedValue({
        success: false,
        signature: 'failed_tx_sig',
        transport: 'JITO',
        error: 'Network timeout',
        lifecycleState: 'SUBMIT_FAILED',
      });

      // Execute trade
      await coordinator.executeTrade({
        signalTimestamp: Date.now(),
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'TEST1',
        name: 'Test Token 1',
        amountSol: 0.005,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
      });

      // Verify inFlightReservedSol is released back to 0
      expect((coordinator as any).inFlightReservedSol).toBe(0);
    });
  });
});
