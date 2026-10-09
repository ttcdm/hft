import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { ExecutionCoordinator, executionCoordinator } from '../../../server/execution/coordinator';
import { localSigner } from '../../../server/solana/signer';
import { riskEngine } from '../../../server/risk/riskEngine';
import { workstationDb } from '../../../server/db/database';
import { executionConfig } from '../../../server/solana/executionConfig';
import { PumpCurveService } from '../../../server/solana/pumpCurve';
import { walletTrader } from '../../../server/walletTrader';
import { MockSolanaRpc } from '../helpers/mockRpc';
import { MockJitoEngine } from '../helpers/mockJito';
import { TestDatabase } from '../helpers/testDb';
import {
  VALID_PUMP_MINT_1,
  VALID_PUMP_MINT_2,
  GRADUATED_PUMP_MINT,
  DUMMY_FEE_RECIPIENT,
  createSimulatedBondingCurveState,
  createPassingEligibilityReport,
} from '../helpers/simulatedStates';

function mockPassingLiveReadiness(coord: ExecutionCoordinator, liveKeypair: Keypair) {
  vi.spyOn(coord, 'canExecuteLive').mockReturnValue({
    allowed: true,
    reasons: [],
    readiness: {
      ready: true,
      score: 100,
      reasons: [],
      components: {
        signer: { ready: true, status: 'READY', address: liveKeypair.publicKey.toBase58() },
        bankroll: { ready: true, balanceSol: 1.5, spendableSol: 1.485, reserveRequiredSol: 0.015 },
        database: { ready: true, writable: true },
        startupReconciliation: { ready: true, status: 'EXECUTION_READY', details: 'All clear' },
        solanaRpc: { ready: true, health: 'HEALTHY', latencyMs: 1 },
        pumpFeed: { ready: true, status: 'HEALTHY', lastEventSecAgo: 1 },
        positionMarks: { ready: true, status: 'HEALTHY', lastMarkSecAgo: 1 },
        killSwitch: { ready: true, active: false },
        circuitBreaker: { ready: true, state: 'CLOSED' },
        jitoTransport: { ready: true, health: 'HEALTHY' },
        realMarketData: { ready: true, lastEventSecAgo: 1 },
      },
    } as any,
  });
}

describe('Tier 5: Production Readiness — Live Trading Workflows, Token Safety & Panic Exit', () => {
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
    vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => {
      tx.sign([liveTradingKeypair]);
      return tx;
    });

    PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() };
    PumpCurveService.cachedFeeConfig = { feeBps: 100 };

    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
    (coordinator as any).realWalletBalanceSol = 1.0;

    process.env.ALLOW_LIVE_REAL_MONEY_TRADING = 'true';
    mockPassingLiveReadiness(coordinator, liveTradingKeypair);
    coordinator.armLiveTrading(true, 'CONFIRM_LIVE_TRADING_RISK');

    riskEngine.setKillSwitch(false);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.ALLOW_LIVE_REAL_MONEY_TRADING;
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    riskEngine.setKillSwitch(false);
    await mockJito.stop();
    testDb.close();
    mockRpc.clear();
  });

  // =========================================================================
  // 1. Live Buy Safety Validations (Fail-Closed Gates)
  // =========================================================================
  describe('Live Buy Safety Validations (Fail-Closed Gates)', () => {
    it('LWP-1: Live Buy fails closed if token eligibility report is stale (>60s old)', async () => {
      const mockState = createSimulatedBondingCurveState();
      vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(mockState);

      const staleReport = createPassingEligibilityReport(VALID_PUMP_MINT_1.toBase58());
      staleReport.evaluatedAt = Date.now() - 65_000; // 65 seconds ago (exceeds 60s max age)

      const result = await coordinator.executeTrade({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'STALE',
        name: 'Stale Report Token',
        amountSol: 0.005,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        eligibilityReport: staleReport,
      });

      expect(result.success).toBe(false);
      expect(result.lifecycleState).toBe('FILTER_REJECTED');
      expect(result.error).toMatch(/ELIGIBILITY_REPORT_STALE/);
    });

    it('LWP-2: Live Buy fails closed if dev holding or top 10 holders distribution is unverified', async () => {
      const mockState = createSimulatedBondingCurveState();
      vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(mockState);

      const pumpCurveModule = await import('../../../server/solana/pumpCurve');
      vi.spyOn(pumpCurveModule, 'fetchTokenHolderDistribution').mockRejectedValue(
        new Error('RPC rate limit: getTokenLargestAccounts unavailable')
      );

      const unverifiedReport = createPassingEligibilityReport(VALID_PUMP_MINT_1.toBase58());
      const creatorCheck = unverifiedReport.checks.find((c) => c.ruleId === 'MAX_CREATOR_EXPOSURE')!;
      creatorCheck.passed = false;
      creatorCheck.status = 'UNKNOWN';
      creatorCheck.observedValue = 'Unknown (Fail-closed)';
      creatorCheck.reason = 'Creator holding percentage is unknown. Fail-closed rejection on live trading.';
      unverifiedReport.isEligible = false;
      unverifiedReport.failedCount = 1;

      const result = await coordinator.executeTrade({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'UNVER',
        name: 'Unverified Dev Token',
        amountSol: 0.005,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        eligibilityReport: unverifiedReport,
      });

      expect(result.success).toBe(false);
      expect(result.lifecycleState).toBe('FILTER_REJECTED');
      expect(result.error).toMatch(/(SAFETY_CHECK_UNVERIFIED|ELIGIBILITY_CHECK_FAILED)/);
    });

    it('LWP-3: Live Buy fails closed if token has unsupported Token-2022 extensions', async () => {
      const mockState = createSimulatedBondingCurveState();
      vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(mockState);

      const extensionReport = createPassingEligibilityReport(VALID_PUMP_MINT_1.toBase58());
      extensionReport.checks.push({
        ruleId: 'TOKEN_2022_POLICY',
        ruleName: 'Token-2022 Extension Policy',
        passed: false,
        status: 'FAIL',
        observedValue: 'TransferFee',
        threshold: 'No predatory extensions',
        reason: 'Token has predatory TransferFee extension',
      });

      const result = await coordinator.executeTrade({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'T2022',
        name: 'Token 2022 Token',
        amountSol: 0.005,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        eligibilityReport: extensionReport,
      });

      expect(result.success).toBe(false);
      expect(result.lifecycleState).toBe('FILTER_REJECTED');
      expect(result.error).toMatch(/UNSUPPORTED_TOKEN_EXTENSION/);
    });

    it('LWP-4: Live Buy fails closed if token has already graduated from bonding curve', async () => {
      const graduatedState = createSimulatedBondingCurveState({
        complete: true,
      });
      vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(graduatedState);

      const result = await coordinator.executeTrade({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'GRAD',
        name: 'Graduated Token',
        amountSol: 0.005,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        eligibilityReport: createPassingEligibilityReport(VALID_PUMP_MINT_1.toBase58()),
      });

      expect(result.success).toBe(false);
      expect(result.lifecycleState).toBe('RISK_REJECTED');
      expect(result.error).toMatch(/BONDING_CURVE_MIGRATED/);
    });

    it('LWP-5: Live Buy fails closed if eligibility report mint does not match trade mint', async () => {
      const result = await coordinator.executeTrade({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'MISMATCH',
        name: 'Mismatch Token',
        amountSol: 0.005,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        eligibilityReport: createPassingEligibilityReport(VALID_PUMP_MINT_2.toBase58()), // Different mint!
      });

      expect(result.success).toBe(false);
      expect(result.lifecycleState).toBe('FILTER_REJECTED');
      expect(result.error).toMatch(/ELIGIBILITY_MINT_MISMATCH/);
    });
  });

  // =========================================================================
  // 2. Real Fill Reconciliation Invariants (Zero Optimistic Marking)
  // =========================================================================
  describe('Real Fill Reconciliation Invariants (Zero Optimistic Marking)', () => {
    it('LWP-6: Live Buy fails closed with RECONCILIATION_REQUIRED if confirmed tx yields 0 token increase', async () => {
      const mockState = createSimulatedBondingCurveState();
      vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(mockState);

      // Bypass prior test failure cooldown on risk engine
      vi.spyOn(riskEngine, 'evaluateOrder').mockReturnValue({
        approved: true,
        reasonCode: 'RISK_OK',
        message: 'Order approved by all pre-trade risk controls',
        details: {},
      });

      // Jito submit & confirm succeeds
      vi.spyOn(coordinator as any, 'submitAndConfirmWithRetry').mockResolvedValue({
        success: true,
        signature: 'sig_confirmed_zero_tokens',
        bundleId: 'bundle_zero_tokens',
        transport: 'JITO',
        slot: 280000400,
        lifecycleState: 'CONFIRMED',
      });

      // But on-chain reconciliation returns zero token increase
      const { TradeReconciler } = await import('../../../server/execution/reconciliation');
      vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({
        walletSolLamports: 1_000_000_000,
        tokenBalanceRaw: '0',
        tokenDecimals: 6,
        timestamp: Date.now(),
      });
      vi.spyOn(TradeReconciler, 'reconcileBuyTransaction').mockResolvedValue({
        success: false,
        reconciliationState: 'RECONCILIATION_REQUIRED',
        actualSolSpentLamports: 5_000_000,
        actualTokensReceivedRaw: '0',
        tokenDecimals: 6,
        tokensReceivedHuman: 0,
        actualNetworkFeeLamports: 5000,
        actualJitoTipLamports: 180000,
        effectiveFillPriceSol: 0,
        slot: 280000400,
        error: 'Confirmed transaction resulted in zero token balance increase',
      });

      const scheduled = vi.spyOn(coordinator as any, 'scheduleOrphanRecovery').mockImplementation(() => {});
      const result = await coordinator.executeTrade({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'ZEROTOK',
        name: 'Zero Tokens Token',
        amountSol: 0.005,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        eligibilityReport: createPassingEligibilityReport(VALID_PUMP_MINT_1.toBase58()),
      });

      expect(result.success).toBe(false);
      expect(result.lifecycleState).toBe('RECONCILIATION_REQUIRED');
      expect(result.error).toMatch(/RECONCILIATION FAILED/);
      // P3: an unread landed buy schedules background recovery so its tokens cannot stay without a position
      expect(scheduled).toHaveBeenCalledTimes(1);

      // Invariant: Position MUST NOT be marked OPEN in SQLite
      const positions = workstationDb.loadPositions('LIVE');
      const zeroPos = positions.find((p) => p.symbol === 'ZEROTOK');
      expect(zeroPos).toBeUndefined();
    });
  });

  // =========================================================================
  // 3. Live Exit Economics & Rent Reclaim
  // =========================================================================
  describe('Live Exit Economics & Rent Reclaim', () => {
    it('LWP-7: rejects live exit of dust position when net proceeds <= 0 with DUST_POSITION_EXIT_UNECONOMICAL', async () => {
      const dustPosId = `dust_pos_${Date.now()}`;
      workstationDb.savePosition({
        id: dustPosId,
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'DUST',
        name: 'Dust Coin',
        tokenDecimals: 6,
        tokenQuantityRaw: '100', // 0.0001 tokens
        entryPriceSol: 0.000001,
        currentPriceSol: 0.0000001, // Depleted to 0.00000001 SOL
        currentValueSol: 0.00000001,
        costBasisLamports: 1_000_000,
        realizedPnLSol: 0,
        status: 'OPEN',
        venue: 'PUMP_BONDING_CURVE',
        executionMode: 'LIVE',
        entryTxSignature: 'sig_dust',
        entryTimestamp: Date.now(),
        recordUpdatedAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Partial exit attempt (50%) on dust position: no rent recovery, fees exceed residual proceeds
      const res = await coordinator.closePosition(dustPosId, 50, 'TAKE_PROFIT');
      expect(res.success).toBe(false);
      expect(res.error).toBe('DUST_POSITION_EXIT_UNECONOMICAL');
    });

    it('LWP-7b: hard-stop and trailing-stop exits bypass the dust check; take-profit and stale exits do not (C7b)', async () => {
      const mkDust = (suffix: string) => {
        const id = `dust_bypass_${suffix}_${Date.now()}`;
        workstationDb.savePosition({
          id, mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'DUST', name: 'Dust Coin', tokenDecimals: 6,
          tokenQuantityRaw: '100', entryPriceSol: 0.000001, currentPriceSol: 0.0000001, currentValueSol: 0.00000001,
          costBasisLamports: 1_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE',
          executionMode: 'LIVE', entryTxSignature: `sig_dust_${suffix}`, entryTimestamp: Date.now(),
          recordUpdatedAt: Date.now(), updatedAt: Date.now(),
        } as any);
        return id;
      };
      for (const reason of ['STOP_LOSS', 'TRAILING_STOP']) {
        // 50%: a partial exit gets no ATA rent credit, so only the bypass keeps it from the dust check
        const res = await coordinator.closePosition(mkDust(reason), 50, reason);
        expect(res.error, reason).not.toBe('DUST_POSITION_EXIT_UNECONOMICAL');
      }
      for (const reason of ['TAKE_PROFIT_1', 'STALE_POSITION']) {
        const res = await coordinator.closePosition(mkDust(reason), 50, reason);
        expect(res.error, reason).toBe('DUST_POSITION_EXIT_UNECONOMICAL');
      }
    });

    it('LWP-8: prevents concurrent duplicate exit submissions for the same position with EXIT_IN_PROGRESS', async () => {
      const posId = `mutex_pos_${Date.now()}`;
      workstationDb.savePosition({
        id: posId,
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'MUTEX',
        name: 'Mutex Coin',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000000',
        entryPriceSol: 0.0001,
        currentPriceSol: 0.0002,
        currentValueSol: 0.20,
        costBasisLamports: 100_000_000,
        realizedPnLSol: 0,
        status: 'OPEN',
        venue: 'PUMP_BONDING_CURVE',
        executionMode: 'LIVE',
        entryTxSignature: 'sig_mutex',
        entryTimestamp: Date.now(),
        recordUpdatedAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Simulate exit already in-flight
      (coordinator as any).inFlightPositionExits.add(posId);

      const res = await coordinator.closePosition(posId, 100, 'MANUAL_CLOSE');
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/EXIT_IN_PROGRESS/);

      // Clean up mutex
      (coordinator as any).inFlightPositionExits.delete(posId);
    });
  });

  // =========================================================================
  // 4. WalletTrader Dispatch & Panic Liquidation
  // =========================================================================
  describe('WalletTrader Dispatch & Panic Liquidation', () => {
    it('LWP-9: walletTrader.executeLiveSnipe() routes strictly through ExecutionCoordinator without bypass', async () => {
      const coordSpy = vi.spyOn(executionCoordinator, 'executeTrade').mockResolvedValue({
        success: true,
        lifecycleState: 'CONFIRMED',
        positionId: 'pos-snipe-123',
        txSignature: 'sig-snipe-123',
        executionMode: 'LIVE',
        correlationId: 'corr-123',
      });

      const res = await walletTrader.executeLiveSnipe({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'SNIPE',
        name: 'Snipe Coin',
        amountSol: 0.005,
      });

      expect(coordSpy).toHaveBeenCalled();
      expect(res.success).toBe(true);
      expect(res.positionId).toBe('pos-snipe-123');
      expect(res.txSignature).toBe('sig-snipe-123');
    });

    it('LWP-10: walletTrader.panicLiquidateAll() engages kill switch, disarms live trading, and liquidates holdings', async () => {
      const pos1Id = `panic_pos_1_${Date.now()}`;
      const pos2Id = `panic_pos_2_${Date.now()}`;

      workstationDb.savePosition({
        id: pos1Id,
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'PANIC1',
        name: 'Panic Coin 1',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000000',
        entryPriceSol: 0.0001,
        currentPriceSol: 0.00012,
        currentValueSol: 0.12,
        costBasisLamports: 100_000_000,
        realizedPnLSol: 0,
        status: 'OPEN',
        venue: 'PUMP_BONDING_CURVE',
        executionMode: 'LIVE',
        entryTxSignature: 'sig_panic_1',
        entryTimestamp: Date.now(),
        recordUpdatedAt: Date.now(),
        updatedAt: Date.now(),
      });

      workstationDb.savePosition({
        id: pos2Id,
        mint: VALID_PUMP_MINT_2.toBase58(),
        symbol: 'PANIC2',
        name: 'Panic Coin 2',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000000',
        entryPriceSol: 0.0001,
        currentPriceSol: 0.00015,
        currentValueSol: 0.15,
        costBasisLamports: 100_000_000,
        realizedPnLSol: 0,
        status: 'PARTIALLY_CLOSED',
        venue: 'PUMP_BONDING_CURVE',
        executionMode: 'LIVE',
        entryTxSignature: 'sig_panic_2',
        entryTimestamp: Date.now(),
        recordUpdatedAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Arm singleton execution coordinator
      process.env.ALLOW_LIVE_REAL_MONEY_TRADING = 'true';
      mockPassingLiveReadiness(executionCoordinator, liveTradingKeypair);
      executionCoordinator.armLiveTrading(true, 'CONFIRM_LIVE_TRADING_RISK');

      // Mock singleton closePosition for panic liquidate
      const closeSpy = vi.spyOn(executionCoordinator, 'closePosition').mockResolvedValue({
        success: true,
        pnlSol: 0.02,
        status: 'CLOSED',
      });

      const report = await walletTrader.panicLiquidateAll();

      expect(report.killSwitchActivated).toBe(true);
      expect(riskEngine.isKillSwitchActive()).toBe(true);
      expect(executionCoordinator.isLiveArmed()).toBe(false);
      expect(report.attemptedCount).toBeGreaterThanOrEqual(2);
      expect(report.succeeded.length).toBeGreaterThanOrEqual(2);
      expect(closeSpy).toHaveBeenCalled();

      // Verify that subsequent trade requests fail closed due to active kill switch
      vi.spyOn(executionCoordinator, 'canExecuteLive').mockRestore();
      const blockedAttempt = executionCoordinator.canExecuteLive();
      expect(blockedAttempt.allowed).toBe(false);
      expect(blockedAttempt.reasons.some((r) => r.includes('Emergency risk kill switch is active'))).toBe(true);
    });
  });
});
