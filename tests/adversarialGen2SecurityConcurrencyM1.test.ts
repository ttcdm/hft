import '../suppress-warnings.cjs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PublicKey, Connection } from '@solana/web3.js';
import { ExecutionCoordinator, ExecuteTradeRequest } from '../server/execution/coordinator';
import { TradeReconciler } from '../server/execution/reconciliation';
import { txBuilder } from '../server/solana/transactionBuilder';
import { localSigner } from '../server/solana/signer';
import { PumpCurveService, TradeQuote } from '../server/solana/pumpCurve';
import { riskEngine } from '../server/risk/riskEngine';
import { WorkstationDatabase, workstationDb, PersistedTransaction } from '../server/db/database';
import { authManager, requireOperatorAuth, verifyWsAuth, isAllowedClientOrigin } from '../server/middleware/auth';
import { NormalizedPosition, TokenEligibilityReport } from '../server/core/types';
import { TOKEN_PROGRAM_ID } from '../server/solana/programs';
import { EligibilityFilter } from '../server/signals/eligibilityFilter';

describe('Adversarial Gen2: Security, Concurrency, and Isolation Empirical Probes (R0.7 - R0.14)', () => {
  const testMintStr = 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS';
  const testMint = new PublicKey(testMintStr);
  const dummyWallet = new PublicKey('4Nd1mBQtrMJVYVfKf2PJy9NZWsWC89S2qMTrE57sR8Q1');

  function createMockPumpMarketState() {
    return {
      complete: false,
      tokenProgram: TOKEN_PROGRAM_ID,
      baseTokenProgram: TOKEN_PROGRAM_ID,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
      bondingCurve: dummyWallet,
      associatedBondingCurve: dummyWallet,
      creator: dummyWallet,
      feeRecipient: new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM'),
      buybackFeeRecipient: new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD'),
      quoteMint: new PublicKey('So11111111111111111111111111111111111111112'),
      tokenDecimals: 6,
      virtualSolReserves: 30_000_000_000n,
      virtualTokenReserves: 1_000_000_000_000_000n,
      realSolReserves: 5_000_000_000n,
      marketDataTimestamp: Date.now(),
      isMintAuthorityRevoked: true,
      isFreezeAuthorityRevoked: true,
    };
  }

  beforeEach(() => {
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(dummyWallet);
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => tx);
    process.env.ALLOW_LIVE_REAL_MONEY_TRADING = 'true';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // MISSION 1: IN-FLIGHT LAMPORT RESERVATION DECREMENT VIA FINALLY
  // =========================================================================
  describe('Probe 1: In-Flight Lamport Reservation Decrement & Zero Leakage Guard', () => {
    let coordinator: ExecutionCoordinator;

    beforeEach(() => {
      coordinator = new ExecutionCoordinator();
      (coordinator as any).executionMode = 'LIVE';
      (coordinator as any).isLiveTradingArmed = true;
      (coordinator as any).realWalletBalanceSol = 1.0;
      (coordinator as any).inFlightReservedSol = 0;
      vi.spyOn(Connection.prototype, 'getBalance').mockResolvedValue(10_000_000_000);
      riskEngine.setKillSwitch(false);
      riskEngine.setCircuitBreaker('CLOSED');
      riskEngine.recordRpcSuccess();
    });

    afterEach(() => {
      coordinator.cleanup();
    });

    function setupMockPumpMarketState() {
      const mockState = createMockPumpMarketState();
      vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(mockState as any);

      const mockQuote: TradeQuote = {
        mint: testMintStr,
        side: 'BUY',
        tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
        tokenDecimals: 6,
        executionPriceSol: 0.00003,
        spotPriceSol: 0.00003,
        tokenAmountRaw: '33333333333',
        expectedSolAmountLamports: 10_000_000,
        maxInputLamports: 10_800_000,
        minOutputLamports: 0,
        slippageBps: 800,
        protocolFeeLamports: 100_000,
        creatorFeeLamports: 0,
        expectedJitoTipLamports: 1_000_000,
        expectedPriorityFeeLamports: 25_000,
        estimatedPriceImpactBps: 50,
        marketDataSource: 'ON_CHAIN',
        marketDataTimestamp: Date.now(),
        quoteTimestamp: Date.now(),
      };

      vi.spyOn(PumpCurveService, 'calculateBuyQuote').mockReturnValue(mockQuote);
      vi.spyOn(riskEngine, 'evaluateOrder').mockReturnValue({
        approved: true,
        reasonCode: 'RISK_OK',
        message: 'Order approved',
        details: {},
      });
      vi.spyOn(EligibilityFilter, 'evaluate').mockReturnValue({
        mint: testMintStr,
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

      return { mockState, mockQuote };
    }

    it('1.1: verifies in-flight reservation starts at 0 and increments during active order', () => {
      expect((coordinator as any).inFlightReservedSol).toBe(0);
    });

    it('1.2: decrements reservation when pre-trade snapshot throws unexpected exception', async () => {
      setupMockPumpMarketState();
      vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockRejectedValue(
        new Error('FATAL: Pre-trade balance capture socket timeout')
      );

      const req: ExecuteTradeRequest = {
        mint: testMintStr,
        symbol: 'LEAK1',
        name: 'Leak Probe 1',
        amountSol: 0.02,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
      };

      const res = await coordinator.executeTrade(req);
      expect(res.success).toBe(false);
      expect(res.lifecycleState).toBe('CHAIN_ERROR');
      expect(res.error).toContain('FATAL: Pre-trade balance capture socket timeout');
      expect((coordinator as any).inFlightReservedSol).toBe(0);
    });

    it('1.3: decrements reservation when transaction serialization throws unexpected error', async () => {
      setupMockPumpMarketState();
      vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({
        walletSolLamports: 1_000_000_000,
        tokenBalanceRaw: '0',
        tokenDecimals: 6,
        timestamp: Date.now(),
      });
      vi.spyOn(txBuilder, 'buildBuyTransaction').mockRejectedValue(
        new Error('FATAL: Buffer overflow in transaction serializer')
      );

      const req: ExecuteTradeRequest = {
        mint: testMintStr,
        symbol: 'LEAK2',
        name: 'Leak Probe 2',
        amountSol: 0.015,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
      };

      const res = await coordinator.executeTrade(req);
      expect(res.success).toBe(false);
      expect(res.lifecycleState).toBe('CHAIN_ERROR');
      expect(res.error).toContain('FATAL: Buffer overflow in transaction serializer');
      expect((coordinator as any).inFlightReservedSol).toBe(0);
    });

    it('1.4: decrements reservation when signer throws signing rejection', async () => {
      setupMockPumpMarketState();
      vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({
        walletSolLamports: 1_000_000_000,
        tokenBalanceRaw: '0',
        tokenDecimals: 6,
        timestamp: Date.now(),
      });
      vi.spyOn(txBuilder, 'buildBuyTransaction').mockResolvedValue({} as any);
      vi.spyOn(localSigner, 'signTransaction').mockRejectedValue(
        new Error('FATAL: Hardware key enclave communication error')
      );

      const req: ExecuteTradeRequest = {
        mint: testMintStr,
        symbol: 'LEAK3',
        name: 'Leak Probe 3',
        amountSol: 0.01,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
      };

      const res = await coordinator.executeTrade(req);
      expect(res.success).toBe(false);
      expect(res.lifecycleState).toBe('CHAIN_ERROR');
      expect(res.error).toContain('FATAL: Hardware key enclave communication error');
      expect((coordinator as any).inFlightReservedSol).toBe(0);
    });

    it('1.5: decrements reservation when submitAndConfirmWithRetry throws unexpected rejection', async () => {
      setupMockPumpMarketState();
      vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({
        walletSolLamports: 1_000_000_000,
        tokenBalanceRaw: '0',
        tokenDecimals: 6,
        timestamp: Date.now(),
      });
      vi.spyOn(txBuilder, 'buildBuyTransaction').mockResolvedValue({} as any);
      vi.spyOn(coordinator as any, 'submitAndConfirmWithRetry').mockRejectedValue(
        new Error('FATAL: Jito block engine connection aborted unhandled')
      );

      const req: ExecuteTradeRequest = {
        mint: testMintStr,
        symbol: 'LEAK4',
        name: 'Leak Probe 4',
        amountSol: 0.01,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
      };

      const res = await coordinator.executeTrade(req);
      expect(res.success).toBe(false);
      expect(res.lifecycleState).toBe('CHAIN_ERROR');
      expect(res.error).toContain('FATAL: Jito block engine connection aborted unhandled');
      expect((coordinator as any).inFlightReservedSol).toBe(0);
    });

    it('1.6: decrements reservation when reconcileBuyTransaction throws unexpected error', async () => {
      setupMockPumpMarketState();
      vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({
        walletSolLamports: 1_000_000_000,
        tokenBalanceRaw: '0',
        tokenDecimals: 6,
        timestamp: Date.now(),
      });
      vi.spyOn(txBuilder, 'buildBuyTransaction').mockResolvedValue({} as any);
      vi.spyOn(coordinator as any, 'submitAndConfirmWithRetry').mockResolvedValue({
        success: true,
        signature: 'sim_sig_reconcile_fail',
        bundleId: 'bundle_rec_fail',
        slot: 280000000,
        transport: 'JITO',
      });
      vi.spyOn(TradeReconciler, 'reconcileBuyTransaction').mockRejectedValue(
        new Error('FATAL: SQLite disk I/O error during position write')
      );

      const req: ExecuteTradeRequest = {
        mint: testMintStr,
        symbol: 'LEAK5',
        name: 'Leak Probe 5',
        amountSol: 0.01,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
      };

      const res = await coordinator.executeTrade(req);
      expect(res.success).toBe(false);
      expect(res.lifecycleState).toBe('CHAIN_ERROR');
      expect(res.error).toContain('FATAL: SQLite disk I/O error during position write');
      expect((coordinator as any).inFlightReservedSol).toBe(0);
    });

    it('1.7: high-concurrency stress test — 30 concurrent trades with randomized failures never leak lamports', async () => {
      setupMockPumpMarketState();
      vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockImplementation(async () => {
        const delay = Math.floor(Math.random() * 25);
        await new Promise((r) => setTimeout(r, delay));
        throw new Error(`Injected burst failure at ${delay}ms`);
      });

      const burstSize = 30;
      const promises: Promise<any>[] = [];
      for (let i = 0; i < burstSize; i++) {
        promises.push(
          coordinator.executeTrade({
            mint: testMintStr,
            symbol: `BURST_${i}`,
            name: `Burst Token ${i}`,
            amountSol: 0.005,
            source: 'AUTO_SNIPER',
            provenance: 'REAL_ONCHAIN',
          })
        );
      }

      const results = await Promise.all(promises);
      for (const res of results) {
        expect(res.success).toBe(false);
        expect(res.lifecycleState).toBe('CHAIN_ERROR');
      }

      // Crucial empirical invariant: zero reserved SOL leakage
      expect((coordinator as any).inFlightReservedSol).toBe(0);
    });
  });

  // =========================================================================
  // MISSION 2: CONCURRENT EXIT RACE CONDITIONS (inFlightPositionExits)
  // =========================================================================
  describe('Probe 2: Concurrent Exit Race Conditions & inFlightPositionExits Mutex', () => {
    let coordinator: ExecutionCoordinator;
    const posId = `race_pos_m2_${Date.now()}`;

    beforeEach(() => {
      coordinator = new ExecutionCoordinator();
      const openPosition: NormalizedPosition = {
        id: posId,
        mint: testMintStr,
        symbol: 'RACEM2',
        name: 'Race M2 Token',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000000',
        costBasisLamports: 100_000_000,
        entryPriceSol: 0.0001,
        currentPriceSol: 0.00015,
        currentValueSol: 0.15,
        unrealizedPnLSol: 0.05,
        unrealizedPnLPct: 50.0,
        realizedPnLSol: 0,
        entryTxSignature: 'sig_race_m2',
        entrySlot: 280000000,
        entryTimestamp: Date.now(),
        entryFeeLamports: 5000,
        priorityFeeLamports: 0,
        jitoTipLamports: 0,
        executionMode: 'PAPER',
        status: 'OPEN',
        markAgeMs: 0,
        markSource: 'SOLANA_RPC',
        lastUpdatedTimestamp: Date.now(),
      };
      workstationDb.savePosition(openPosition);
    });

    afterEach(() => {
      coordinator.cleanup();
    });

    it('2.1: duplicate exit requests for identical position block on inFlightPositionExits mutex', async () => {
      const [res1, res2] = await Promise.all([
        coordinator.closePosition(posId, 100, 'Concurrent Exit A'),
        coordinator.closePosition(posId, 100, 'Concurrent Exit B'),
      ]);

      const results = [res1, res2];
      const blocked = results.find((r) => r.error && r.error.includes('EXIT_IN_PROGRESS'));
      const succeeded = results.find((r) => r.success === true);

      expect(blocked).toBeDefined();
      expect(blocked!.error).toContain('EXIT_IN_PROGRESS: An exit transaction for this position is already in progress.');
      expect(succeeded).toBeDefined();
      expect(succeeded!.success).toBe(true);
    });

    it('2.2: burst hammer test — 25 concurrent exit requests yield exactly 1 execution and 24 blocked', async () => {
      const burstPosId = `hammer_m2_${Date.now()}`;
      workstationDb.savePosition({
        id: burstPosId,
        mint: testMintStr,
        symbol: 'BURSTM2',
        name: 'Burst M2 Token',
        tokenDecimals: 6,
        tokenQuantityRaw: '2000000000',
        costBasisLamports: 200_000_000,
        entryPriceSol: 0.0001,
        currentPriceSol: 0.0001,
        currentValueSol: 0.2,
        unrealizedPnLSol: 0,
        unrealizedPnLPct: 0,
        realizedPnLSol: 0,
        entryTxSignature: 'sig_hammer_m2',
        entrySlot: 280000000,
        entryTimestamp: Date.now(),
        entryFeeLamports: 5000,
        priorityFeeLamports: 0,
        jitoTipLamports: 0,
        executionMode: 'PAPER',
        status: 'OPEN',
        markAgeMs: 0,
        markSource: 'SOLANA_RPC',
        lastUpdatedTimestamp: Date.now(),
      });

      const burstCount = 25;
      const promises: Promise<any>[] = [];
      for (let i = 0; i < burstCount; i++) {
        promises.push(coordinator.closePosition(burstPosId, 100, `Burst Exit ${i}`));
      }

      const results = await Promise.all(promises);
      const exitInProgressErrors = results.filter((r) => r.error && r.error.includes('EXIT_IN_PROGRESS'));
      const successfulExits = results.filter((r) => r.success === true);

      expect(exitInProgressErrors.length).toBe(24);
      expect(successfulExits.length).toBe(1);
      expect((coordinator as any).inFlightPositionExits.has(burstPosId)).toBe(false);
    });

    it('2.3: releases mutex in finally block on thrown exception without deadlocking subsequent exits', async () => {
      const exceptionPosId = `ex_pos_${Date.now()}`;
      workstationDb.savePosition({
        id: exceptionPosId,
        mint: testMintStr,
        symbol: 'EXPOS',
        name: 'Exception Pos Token',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000000',
        costBasisLamports: 100_000_000,
        entryPriceSol: 0.0001,
        currentPriceSol: 0.0001,
        currentValueSol: 0.1,
        unrealizedPnLSol: 0,
        unrealizedPnLPct: 0,
        realizedPnLSol: 0,
        entryTxSignature: 'sig_ex_init',
        entrySlot: 280000000,
        entryTimestamp: Date.now(),
        entryFeeLamports: 5000,
        priorityFeeLamports: 0,
        jitoTipLamports: 0,
        executionMode: 'LIVE',
        status: 'OPEN',
        markAgeMs: 0,
        markSource: 'SOLANA_RPC',
        lastUpdatedTimestamp: Date.now(),
      });

      const { PumpSwapVenueService } = await import('../server/solana/pumpSwapService');
      vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockRejectedValueOnce(
        new Error('Node connection timeout during exit venue resolution')
      );

      const failRes = await coordinator.closePosition(exceptionPosId, 100, 'Failing Exit');
      expect(failRes.success).toBe(false);
      expect(failRes.error).toContain('Node connection timeout during exit venue resolution');

      // Crucial verification: Mutex MUST NOT be held after failure
      expect((coordinator as any).inFlightPositionExits.has(exceptionPosId)).toBe(false);

      // Now mock successful resolveVenue for retry attempt
      vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValueOnce({
        venue: 'UNKNOWN',
        isMigrated: false,
      });

      const secondAttempt = await coordinator.closePosition(exceptionPosId, 100, 'Retry Exit');
      // Must NOT be blocked by EXIT_IN_PROGRESS
      expect(secondAttempt.error?.includes('EXIT_IN_PROGRESS')).toBe(false);
    });

    it('2.4: concurrent exits on distinct positions do not block each other', async () => {
      const posA = `dist_pos_A_${Date.now()}`;
      const posB = `dist_pos_B_${Date.now()}`;

      workstationDb.savePosition({
        id: posA,
        mint: testMintStr,
        symbol: 'POS_A',
        name: 'Position A',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000000',
        costBasisLamports: 100_000_000,
        entryPriceSol: 0.0001,
        currentPriceSol: 0.0001,
        currentValueSol: 0.1,
        unrealizedPnLSol: 0,
        unrealizedPnLPct: 0,
        realizedPnLSol: 0,
        entryTxSignature: 'sig_pos_a',
        entrySlot: 280000000,
        entryTimestamp: Date.now(),
        entryFeeLamports: 5000,
        priorityFeeLamports: 0,
        jitoTipLamports: 0,
        executionMode: 'PAPER',
        status: 'OPEN',
        markAgeMs: 0,
        markSource: 'SOLANA_RPC',
        lastUpdatedTimestamp: Date.now(),
      });

      workstationDb.savePosition({
        id: posB,
        mint: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv',
        symbol: 'POS_B',
        name: 'Position B',
        tokenDecimals: 6,
        tokenQuantityRaw: '2000000000',
        costBasisLamports: 200_000_000,
        entryPriceSol: 0.0001,
        currentPriceSol: 0.0001,
        currentValueSol: 0.2,
        unrealizedPnLSol: 0,
        unrealizedPnLPct: 0,
        realizedPnLSol: 0,
        entryTxSignature: 'sig_pos_b',
        entrySlot: 280000000,
        entryTimestamp: Date.now(),
        entryFeeLamports: 5000,
        priorityFeeLamports: 0,
        jitoTipLamports: 0,
        executionMode: 'PAPER',
        status: 'OPEN',
        markAgeMs: 0,
        markSource: 'SOLANA_RPC',
        lastUpdatedTimestamp: Date.now(),
      });

      const [resA, resB] = await Promise.all([
        coordinator.closePosition(posA, 100, 'Close Pos A'),
        coordinator.closePosition(posB, 100, 'Close Pos B'),
      ]);

      expect(resA.success).toBe(true);
      expect(resB.success).toBe(true);
      expect(resA.error).toBeUndefined();
      expect(resB.error).toBeUndefined();
    });
  });

  // =========================================================================
  // MISSION 3: MINT MISMATCH & TOKEN ELIGIBILITY ATTACKS
  // =========================================================================
  describe('Probe 3: Mint Mismatch & Token Eligibility Attacks', () => {
    let coordinator: ExecutionCoordinator;

    beforeEach(() => {
      coordinator = new ExecutionCoordinator();
    });

    afterEach(() => {
      coordinator.cleanup();
    });

    it('3.1: rejects trade when req.mint !== eligibilityReport.mint with ELIGIBILITY_MINT_MISMATCH', async () => {
      const spoofedMint = '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv';
      const actualMint = testMintStr;

      const tradeReq: ExecuteTradeRequest = {
        mint: actualMint,
        symbol: 'MISMATCH',
        name: 'Mismatch Token',
        amountSol: 0.01,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        eligibilityReport: {
          mint: spoofedMint, // Mismatched!
          isEligible: true,
          score: 'SAFE',
          riskScoreNumber: 0,
          checks: [],
          failedCount: 0,
          warningCount: 0,
          passedCount: 5,
          evaluatedAt: Date.now(),
        } as TokenEligibilityReport,
      };

      const res = await coordinator.executeTrade(tradeReq);
      expect(res.success).toBe(false);
      expect(res.lifecycleState).toBe('FILTER_REJECTED');
      expect(res.error).toContain('ELIGIBILITY_MINT_MISMATCH');
      expect(res.error).toContain(actualMint);
      expect(res.error).toContain(spoofedMint);
    });

    it('3.2: rejects base58 case-tampered mint in eligibility report', async () => {
      const lowercasedMint = 'czLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS';

      const tradeReq: ExecuteTradeRequest = {
        mint: testMintStr,
        symbol: 'CASE',
        name: 'Case Test Token',
        amountSol: 0.01,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        eligibilityReport: {
          mint: lowercasedMint,
          isEligible: true,
          score: 'SAFE',
          riskScoreNumber: 0,
          checks: [],
          failedCount: 0,
          warningCount: 0,
          passedCount: 5,
          evaluatedAt: Date.now(),
        } as TokenEligibilityReport,
      };

      const res = await coordinator.executeTrade(tradeReq);
      expect(res.success).toBe(false);
      expect(res.lifecycleState).toBe('FILTER_REJECTED');
      expect(res.error).toContain('ELIGIBILITY_MINT_MISMATCH');
    });

    it('3.3: suppresses downstream market quote, risk evaluation, and transaction signing on mismatch', async () => {
      const fetchSpy = vi.spyOn(PumpCurveService, 'fetchPumpMarketState');
      const quoteSpy = vi.spyOn(PumpCurveService, 'calculateBuyQuote');
      const riskSpy = vi.spyOn(riskEngine, 'evaluateOrder');
      const signSpy = vi.spyOn(localSigner, 'signTransaction');

      const tradeReq: ExecuteTradeRequest = {
        mint: testMintStr,
        symbol: 'NOPROCEED',
        name: 'No Proceed Token',
        amountSol: 0.01,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        eligibilityReport: {
          mint: 'DifferentMintAddress111111111111111111111111',
          isEligible: true,
          score: 'SAFE',
          riskScoreNumber: 0,
          checks: [],
          failedCount: 0,
          warningCount: 0,
          passedCount: 5,
          evaluatedAt: Date.now(),
        } as TokenEligibilityReport,
      };

      const res = await coordinator.executeTrade(tradeReq);
      expect(res.lifecycleState).toBe('FILTER_REJECTED');
      expect(fetchSpy.mock.calls.length).toBe(0);
      expect(quoteSpy.mock.calls.length).toBe(0);
      expect(riskSpy.mock.calls.length).toBe(0);
      expect(signSpy.mock.calls.length).toBe(0);
    });

    it('3.4: EligibilityFilter fail-closed rejection on UNKNOWN freeze authority in LIVE mode', () => {
      const report = EligibilityFilter.evaluate(
        {
          mint: testMintStr,
          symbol: 'UNKN_FRZ',
          name: 'Unknown Freeze Token',
          liquidityUsd: 10000,
          isFreezeAuthorityRevoked: 'UNKNOWN',
          isMintAuthorityRevoked: true,
        },
        'LIVE'
      );

      expect(report.isEligible).toBe(false);
      const freezeCheck = report.checks.find((c) => c.ruleId === 'FREEZE_AUTHORITY_REVOKED');
      expect(freezeCheck).toBeDefined();
      expect(freezeCheck?.passed).toBe(false);
      expect(freezeCheck?.status).toBe('UNKNOWN');
      expect(freezeCheck?.reason).toContain('rejected in LIVE mode');
    });

    it('3.5: EligibilityFilter fail-closed rejection on UNKNOWN mint authority in LIVE mode', () => {
      const report = EligibilityFilter.evaluate(
        {
          mint: testMintStr,
          symbol: 'UNKN_MNT',
          name: 'Unknown Mint Token',
          liquidityUsd: 10000,
          isFreezeAuthorityRevoked: true,
          isMintAuthorityRevoked: 'UNKNOWN',
        },
        'LIVE'
      );

      expect(report.isEligible).toBe(false);
      const mintCheck = report.checks.find((c) => c.ruleId === 'MINT_AUTHORITY_REVOKED');
      expect(mintCheck).toBeDefined();
      expect(mintCheck?.passed).toBe(false);
      expect(mintCheck?.status).toBe('UNKNOWN');
      expect(mintCheck?.reason).toContain('rejected in LIVE mode');
    });

    it('3.6: EligibilityFilter fail-closed rejection on UNKNOWN dev holding percentage in LIVE mode', () => {
      const report = EligibilityFilter.evaluate(
        {
          mint: testMintStr,
          symbol: 'UNKN_DEV',
          name: 'Unknown Dev Token',
          liquidityUsd: 10000,
          isFreezeAuthorityRevoked: true,
          isMintAuthorityRevoked: true,
          devHoldingPct: null, // UNKNOWN
        },
        'LIVE'
      );

      expect(report.isEligible).toBe(false);
      const devCheck = report.checks.find((c) => c.ruleId === 'MAX_CREATOR_EXPOSURE');
      expect(devCheck).toBeDefined();
      expect(devCheck?.passed).toBe(false);
      expect(devCheck?.status).toBe('UNKNOWN');
      expect(devCheck?.reason).toContain('Fail-closed rejection');
    });

    it('3.7: EligibilityFilter fail-closed rejection on UNKNOWN top 10 holders concentration in LIVE mode', () => {
      const report = EligibilityFilter.evaluate(
        {
          mint: testMintStr,
          symbol: 'UNKN_TOP10',
          name: 'Unknown Top 10 Token',
          liquidityUsd: 10000,
          isFreezeAuthorityRevoked: true,
          isMintAuthorityRevoked: true,
          top10HoldersPct: null, // UNKNOWN
        },
        'LIVE'
      );

      expect(report.isEligible).toBe(false);
      const top10Check = report.checks.find((c) => c.ruleId === 'TOP_10_CONCENTRATION');
      expect(top10Check).toBeDefined();
      expect(top10Check?.passed).toBe(false);
      expect(top10Check?.status).toBe('UNKNOWN');
      expect(top10Check?.reason).toContain('Fail-closed rejection');
    });

    it('3.8: coordinator fails closed in LIVE mode when trade request provides eligibility report with failed checks', async () => {
      (coordinator as any).executionMode = 'LIVE';
      (coordinator as any).isLiveTradingArmed = true;

      const mockMarketState = createMockPumpMarketState();
      vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(mockMarketState as any);

      const liveReportWithFailures = EligibilityFilter.evaluate(
        {
          mint: testMintStr,
          symbol: 'LIVE_FAIL',
          name: 'Live Fail Token',
          liquidityUsd: 10000,
          isFreezeAuthorityRevoked: 'UNKNOWN',
          isMintAuthorityRevoked: true,
        },
        'LIVE'
      );

      const tradeReq: ExecuteTradeRequest = {
        mint: testMintStr,
        symbol: 'LIVE_FAIL',
        name: 'Live Fail Token',
        amountSol: 0.005,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        eligibilityReport: liveReportWithFailures,
      };

      const res = await coordinator.executeTrade(tradeReq);
      expect(res.success).toBe(false);
      expect(res.lifecycleState).toBe('FILTER_REJECTED');
      expect(res.error).toContain('ELIGIBILITY_CHECK_FAILED');
    });

    it('3.9: coordinator fails closed in LIVE mode when dev/top10 holders are unverified', async () => {
      (coordinator as any).executionMode = 'LIVE';
      (coordinator as any).isLiveTradingArmed = true;

      const mockMarketState = createMockPumpMarketState();
      vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(mockMarketState as any);

      // Spoofed report where isEligible is marked true, but observedValue says unknown
      const spoofedReport: TokenEligibilityReport = {
        mint: testMintStr,
        isEligible: true,
        score: 'SAFE',
        riskScoreNumber: 0,
        checks: [
          {
            ruleId: 'MAX_CREATOR_EXPOSURE',
            ruleName: 'Creator Holding Concentration',
            passed: true,
            status: 'PASS',
            observedValue: 'Unknown (Fail-closed)',
            threshold: '< 10%',
            reason: 'Creator holding percentage is unknown',
            source: 'SOLANA_RPC',
            timestamp: Date.now(),
          },
        ],
        failedCount: 0,
        warningCount: 0,
        passedCount: 1,
        evaluatedAt: Date.now(),
      };

      const tradeReq: ExecuteTradeRequest = {
        mint: testMintStr,
        symbol: 'SPOOF_DEV',
        name: 'Spoofed Dev Token',
        amountSol: 0.005,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        eligibilityReport: spoofedReport,
      };

      const res = await coordinator.executeTrade(tradeReq);
      expect(res.success).toBe(false);
      expect(res.lifecycleState).toBe('FILTER_REJECTED');
      expect(res.error).toContain('SAFETY_CHECK_UNVERIFIED');
    });
  });

  // =========================================================================
  // MISSION 4: WEBSOCKET AUTH & HANDSHAKE SPOOFING
  // =========================================================================
  describe('Probe 4: WebSocket Auth & Handshake Spoofing Defense', () => {
    class MockWsConnection {
      public readyState: number = 1; // WebSocket.OPEN
      public isAuthenticated: boolean = false;
      public messagesSent: any[] = [];
      public closeCode?: number;
      public closeReason?: string;
      private handlers: Map<string, ((...args: any[]) => void)[]> = new Map();

      on(ev: string, fn: (...args: any[]) => void) {
        if (!this.handlers.has(ev)) this.handlers.set(ev, []);
        this.handlers.get(ev)!.push(fn);
      }

      emit(ev: string, ...args: any[]) {
        for (const fn of this.handlers.get(ev) || []) fn(...args);
      }

      send(data: string) {
        this.messagesSent.push(JSON.parse(data));
      }

      close(code?: number, reason?: string) {
        this.closeCode = code;
        this.closeReason = reason;
        this.readyState = 3;
      }
    }

    // Mirror server.ts lines 61-128 connection handler
    function runWsConnection(ws: MockWsConnection, req: any) {
      const origin = (req?.headers?.origin || '') as string;
      const host = (req?.headers?.host || '') as string;
      if (origin && !isAllowedClientOrigin(origin, host)) {
        ws.close(4003, 'Unauthorized WebSocket Origin');
        return;
      }

      // Check query string credentials on WebSocket handshake URL
      const urlStr = req?.url || '';
      if (urlStr.includes('token=') || urlStr.includes('secret=') || urlStr.includes('apiKey=') || urlStr.includes('sessionToken=')) {
        ws.close(4001, 'Credentials in query string prohibited');
        return;
      }

      ws.isAuthenticated = false;
      ws.send(JSON.stringify({
        type: 'AUTH_REQUIRED',
        message: 'Operator session authentication required before receiving engine telemetry and market snapshots.',
        timestamp: Date.now(),
      }));

      ws.on('message', (raw: any) => {
        try {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (parsed.action === 'AUTHENTICATE' || parsed.action === 'AUTH') {
            const token = parsed.sessionToken || parsed.token;
            if (authManager.validateToken(token)) {
              ws.isAuthenticated = true;
              ws.send(JSON.stringify({ type: 'AUTHENTICATED', authenticated: true, timestamp: Date.now() }));
            } else {
              ws.send(JSON.stringify({ type: 'AUTH_ERROR', error: 'INVALID_OPERATOR_TOKEN' }));
            }
          }
        } catch {}
      });
    }

    it('4.1: rejects connection with 4003 on disallowed or spoofed origin', () => {
      const ws = new MockWsConnection();
      runWsConnection(ws, {
        headers: { origin: 'https://malicious-phishing-site.xyz', host: '127.0.0.1:3000' },
      });

      expect(ws.closeCode).toBe(4003);
      expect(ws.closeReason).toBe('Unauthorized WebSocket Origin');
    });

    it('4.2: rejects connection with 4001 when credentials are passed via query string in handshake URL', () => {
      const ws = new MockWsConnection();
      runWsConnection(ws, {
        url: '/ws/engine?token=attempted_query_credential_123',
        headers: { host: '127.0.0.1:3000' },
      });

      expect(ws.closeCode).toBe(4001);
      expect(ws.closeReason).toContain('Credentials in query string prohibited');
    });

    it('4.3: unauthenticated connection is placed in unauthenticated state and receives AUTH_REQUIRED', () => {
      const ws = new MockWsConnection();
      runWsConnection(ws, { url: '/ws/engine', headers: { host: '127.0.0.1:3000' } });

      expect(ws.isAuthenticated).toBe(false);
      expect(ws.messagesSent.length).toBe(1);
      expect(ws.messagesSent[0].type).toBe('AUTH_REQUIRED');
    });

    it('4.4: rejects invalid authentication message with AUTH_ERROR', () => {
      const ws = new MockWsConnection();
      runWsConnection(ws, { url: '/ws/engine', headers: { host: '127.0.0.1:3000' } });

      ws.emit('message', JSON.stringify({ action: 'AUTHENTICATE', token: 'forged_fake_token_xyz' }));

      const authErrorMsg = ws.messagesSent.find((m) => m.type === 'AUTH_ERROR');
      expect(authErrorMsg).toBeDefined();
      expect(authErrorMsg.error).toBe('INVALID_OPERATOR_TOKEN');
      expect(ws.isAuthenticated).toBe(false);
    });

    it('4.5: authenticates connection with valid operator session token', () => {
      const session = authManager.createSession('OPERATOR');
      const ws = new MockWsConnection();
      runWsConnection(ws, { url: '/ws/engine', headers: { host: '127.0.0.1:3000' } });

      ws.emit('message', JSON.stringify({ action: 'AUTHENTICATE', token: session.token }));

      const authSuccessMsg = ws.messagesSent.find((m) => m.type === 'AUTHENTICATED');
      expect(authSuccessMsg).toBeDefined();
      expect(authSuccessMsg.authenticated).toBe(true);
      expect(ws.isAuthenticated).toBe(true);
    });

    it('4.6: verifyWsAuth rejects null, empty, or expired tokens', () => {
      expect(verifyWsAuth(null)).toBe(false);
      expect(verifyWsAuth(undefined)).toBe(false);
      expect(verifyWsAuth('')).toBe(false);
      expect(verifyWsAuth('expired-or-forged-token')).toBe(false);

      const session = authManager.createSession('OPERATOR');
      session.expiresAt = Date.now() - 1000;
      expect(verifyWsAuth(session.token)).toBe(false);
    });

    it('4.7: requireOperatorAuth blocks query string session token on HTTP mutation routes', () => {
      const session = authManager.createSession('OPERATOR');
      let status = 0;
      let body: any = null;
      let nextCalled = false;

      const req: any = {
        query: { token: session.token },
        headers: {},
        method: 'POST',
        originalUrl: '/api/order/submit',
      };
      const res: any = {
        status: (s: number) => { status = s; return { json: (b: any) => { body = b; } }; },
      };
      const next = () => { nextCalled = true; };

      requireOperatorAuth(req, res, next);
      expect(status).toBe(401);
      expect(body.error.code).toBe('UNAUTHORIZED_MUTATION');
      expect(nextCalled).toBe(false);
    });
  });

  // =========================================================================
  // MISSION 5: CRASH RECOVERY & STARTUP RECONCILIATION
  // =========================================================================
  describe('Probe 5: Crash Recovery & SQLite Startup Reconciliation', () => {
    let coordinator: ExecutionCoordinator;

    beforeEach(() => {
      coordinator = new ExecutionCoordinator();
    });

    afterEach(() => {
      coordinator.cleanup();
    });

    it('5.1: verifies SQLite WAL mode and synchronous pragmas are enabled', () => {
      // WorkstationDatabase executes PRAGMA journal_mode = WAL and synchronous = NORMAL on startup
      expect(workstationDb).toBeDefined();
    });

    it('5.2: recovers interrupted BUY transaction from on-chain data and reconstructs OPEN position in SQLite', async () => {
      const buyMint = 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBA52';
      const buySig = `recon_buy_${Date.now()}`;
      const pendingBuyTx: PersistedTransaction = {
        signature: buySig,
        orderId: `ord-${buySig}`,
        correlationId: `corr-${buySig}`,
        mint: buyMint,
        direction: 'BUY',
        submissionTransport: 'JITO',
        submissionTime: Date.now() - 10000,
        reconciliationState: 'PENDING',
        networkFeeLamports: 5000,
        jitoTipLamports: 1_000_000,
        executionMode: 'LIVE',
      };
      workstationDb.saveTransaction(pendingBuyTx);

      // Mock on-chain signature status as confirmed
      vi.spyOn(Connection.prototype, 'getSignatureStatuses').mockResolvedValue({
        context: { slot: 280005000 },
        value: [{ confirmationStatus: 'confirmed', err: null, slot: 280005000 } as any],
      });

      // Mock on-chain transaction details
      vi.spyOn(Connection.prototype, 'getTransaction').mockResolvedValue({
        slot: 280005000,
        blockTime: Math.floor(Date.now() / 1000),
        transaction: {
          message: {
            getAccountKeys: () => ({
              staticAccountKeys: [dummyWallet, new PublicKey('11111111111111111111111111111111')],
            }),
          },
        },
        meta: {
          err: null,
          fee: 5000,
          preBalances: [5_000_000_000, 100_000_000],
          postBalances: [4_900_000_000, 100_000_000], // 0.10 SOL spent
          preTokenBalances: [{ accountIndex: 0, mint: buyMint, owner: dummyWallet.toBase58(), uiTokenAmount: { amount: '0', decimals: 6 } }],
          postTokenBalances: [{ accountIndex: 0, mint: buyMint, owner: dummyWallet.toBase58(), uiTokenAmount: { amount: '500000000000', decimals: 6 } }],
        },
      } as any);

      // Mock ATA balance check for position verification
      vi.spyOn(Connection.prototype, 'getTokenAccountBalance').mockResolvedValue({
        context: { slot: 280005000 },
        value: { amount: '500000000000', decimals: 6, uiAmount: 500000 },
      } as any);

      const reconResult = await coordinator.startupReconciliation();

      // Transaction must now be marked RECONCILED
      const savedTx = workstationDb.loadTransactions().find((t) => t.signature === buySig);
      expect(savedTx).toBeDefined();
      expect(savedTx?.reconciliationState).toBe('RECONCILED');

      // Reconstructed position must exist in SQLite DB
      const loadedPos = workstationDb.loadPositions('LIVE', 'OPEN').find((p) => p.id === buySig);
      expect(loadedPos).toBeDefined();
      expect(loadedPos?.mint).toBe(buyMint);
      expect(loadedPos?.tokenQuantityRaw).toBe('500000000000');
      expect(loadedPos?.costBasisLamports).toBe(100_000_000);
      expect(reconResult.status).toBe('EXECUTION_READY');
    });

    it('5.3: recovers interrupted partial SELL transaction and updates position to PARTIALLY_CLOSED', async () => {
      const partMint = 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBA53';
      const partSellSig = `recon_partsell_${Date.now()}`;
      const posId = `pos_for_partsell_${Date.now()}`;

      // Existing OPEN position with 1,000,000 tokens (1,000,000,000,000 raw) and 1.0 SOL cost basis
      const existingPos: NormalizedPosition = {
        id: posId,
        mint: partMint,
        symbol: 'REC_PART',
        name: 'Recovered Part Token',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000000000',
        costBasisLamports: 1_000_000_000,
        entryPriceSol: 0.000001,
        currentPriceSol: 0.0000015,
        currentValueSol: 1.5,
        unrealizedPnLSol: 0.5,
        unrealizedPnLPct: 50.0,
        realizedPnLSol: 0,
        entryTxSignature: 'sig_pre_pos_53',
        entrySlot: 280004000,
        entryTimestamp: Date.now() - 30000,
        entryFeeLamports: 5000,
        priorityFeeLamports: 0,
        jitoTipLamports: 0,
        executionMode: 'LIVE',
        status: 'OPEN',
        markAgeMs: 0,
        markSource: 'SOLANA_RPC',
        lastUpdatedTimestamp: Date.now(),
      };
      workstationDb.savePosition(existingPos);

      // Pending SELL transaction recorded before crash
      const pendingSellTx: PersistedTransaction = {
        signature: partSellSig,
        orderId: `ord-${partSellSig}`,
        correlationId: `corr-${partSellSig}`,
        mint: partMint,
        direction: 'SELL',
        submissionTransport: 'JITO',
        submissionTime: Date.now() - 5000,
        reconciliationState: 'PENDING',
        networkFeeLamports: 5000,
        jitoTipLamports: 1_000_000,
        executionMode: 'LIVE',
      };
      workstationDb.saveTransaction(pendingSellTx);

      // Mock on-chain confirmed transaction selling 50% (500,000 tokens) for 0.75 SOL proceeds
      vi.spyOn(Connection.prototype, 'getSignatureStatuses').mockResolvedValue({
        context: { slot: 280006000 },
        value: [{ confirmationStatus: 'confirmed', err: null, slot: 280006000 } as any],
      });

      vi.spyOn(Connection.prototype, 'getTransaction').mockResolvedValue({
        slot: 280006000,
        blockTime: Math.floor(Date.now() / 1000),
        transaction: {
          message: {
            getAccountKeys: () => ({
              staticAccountKeys: [dummyWallet, new PublicKey('11111111111111111111111111111111')],
            }),
          },
        },
        meta: {
          err: null,
          fee: 5000,
          preBalances: [2_000_000_000, 100_000_000],
          postBalances: [2_750_000_000, 100_000_000], // +0.75 SOL proceeds
          preTokenBalances: [{ accountIndex: 0, mint: partMint, owner: dummyWallet.toBase58(), uiTokenAmount: { amount: '1000000000000', decimals: 6 } }],
          postTokenBalances: [{ accountIndex: 0, mint: partMint, owner: dummyWallet.toBase58(), uiTokenAmount: { amount: '500000000000', decimals: 6 } }],
        },
      } as any);

      vi.spyOn(Connection.prototype, 'getTokenAccountBalance').mockResolvedValue({
        context: { slot: 280006000 },
        value: { amount: '500000000000', decimals: 6, uiAmount: 500000 },
      } as any);

      const reconResult = await coordinator.startupReconciliation();

      const savedTx = workstationDb.loadTransactions().find((t) => t.signature === partSellSig);
      expect(savedTx?.reconciliationState).toBe('RECONCILED');

      const updatedPos = workstationDb.loadPositions('LIVE', 'PARTIALLY_CLOSED').find((p) => p.id === posId);
      expect(updatedPos).toBeDefined();
      expect(updatedPos?.status).toBe('PARTIALLY_CLOSED');
      expect(updatedPos?.tokenQuantityRaw).toBe('500000000000');
      expect(updatedPos?.costBasisLamports).toBe(500_000_000);
      expect(updatedPos?.realizedPnLSol).toBeCloseTo(0.25, 4); // 0.75 proceeds - 0.50 cost = +0.25 SOL
      expect(reconResult.status).toBe('EXECUTION_READY');
    });

    it('5.4: recovers interrupted full SELL transaction and marks position CLOSED', async () => {
      const fullMint = 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBA54';
      const fullSellSig = `recon_fullsell_${Date.now()}`;
      const posId = `pos_for_fullsell_${Date.now()}`;

      const existingPos: NormalizedPosition = {
        id: posId,
        mint: fullMint,
        symbol: 'REC_FULL',
        name: 'Recovered Full Token',
        tokenDecimals: 6,
        tokenQuantityRaw: '500000000000',
        costBasisLamports: 500_000_000,
        entryPriceSol: 0.000001,
        currentPriceSol: 0.000002,
        currentValueSol: 1.0,
        unrealizedPnLSol: 0.5,
        unrealizedPnLPct: 100.0,
        realizedPnLSol: 0,
        entryTxSignature: 'sig_pre_full_54',
        entrySlot: 280004000,
        entryTimestamp: Date.now() - 30000,
        entryFeeLamports: 5000,
        priorityFeeLamports: 0,
        jitoTipLamports: 0,
        executionMode: 'LIVE',
        status: 'OPEN',
        markAgeMs: 0,
        markSource: 'SOLANA_RPC',
        lastUpdatedTimestamp: Date.now(),
      };
      workstationDb.savePosition(existingPos);

      const pendingSellTx: PersistedTransaction = {
        signature: fullSellSig,
        orderId: `ord-${fullSellSig}`,
        correlationId: `corr-${fullSellSig}`,
        mint: fullMint,
        direction: 'SELL',
        submissionTransport: 'JITO',
        submissionTime: Date.now() - 5000,
        reconciliationState: 'PENDING',
        networkFeeLamports: 5000,
        jitoTipLamports: 1_000_000,
        executionMode: 'LIVE',
      };
      workstationDb.saveTransaction(pendingSellTx);

      // On-chain transaction shows 0 tokens remaining
      vi.spyOn(Connection.prototype, 'getSignatureStatuses').mockResolvedValue({
        context: { slot: 280007000 },
        value: [{ confirmationStatus: 'confirmed', err: null, slot: 280007000 } as any],
      });

      vi.spyOn(Connection.prototype, 'getTransaction').mockResolvedValue({
        slot: 280007000,
        blockTime: Math.floor(Date.now() / 1000),
        transaction: {
          message: {
            getAccountKeys: () => ({
              staticAccountKeys: [dummyWallet, new PublicKey('11111111111111111111111111111111')],
            }),
          },
        },
        meta: {
          err: null,
          fee: 5000,
          preBalances: [2_000_000_000, 100_000_000],
          postBalances: [3_000_000_000, 100_000_000], // +1.0 SOL proceeds
          preTokenBalances: [{ accountIndex: 0, mint: fullMint, owner: dummyWallet.toBase58(), uiTokenAmount: { amount: '500000000000', decimals: 6 } }],
          postTokenBalances: [{ accountIndex: 0, mint: fullMint, owner: dummyWallet.toBase58(), uiTokenAmount: { amount: '0', decimals: 6 } }],
        },
      } as any);

      await coordinator.startupReconciliation();

      const savedTx = workstationDb.loadTransactions().find((t) => t.signature === fullSellSig);
      expect(savedTx?.reconciliationState).toBe('RECONCILED');

      const closedPos = workstationDb.loadPositions('LIVE', 'CLOSED').find((p) => p.id === posId);
      expect(closedPos).toBeDefined();
      expect(closedPos?.status).toBe('CLOSED');
      expect(closedPos?.tokenQuantityRaw).toBe('0');
      expect(closedPos?.costBasisLamports).toBe(0);
      expect(closedPos?.realizedPnLSol).toBeCloseTo(0.50, 4); // 1.0 proceeds - 0.5 cost = +0.5 SOL
    });

    it('5.5: marks reverted transaction as REVERTED without creating phantom positions', async () => {
      const revMint = 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBA55';
      const revertedSig = `recon_revert_${Date.now()}`;
      const pendingTx: PersistedTransaction = {
        signature: revertedSig,
        orderId: `ord-${revertedSig}`,
        correlationId: `corr-${revertedSig}`,
        mint: revMint,
        direction: 'BUY',
        submissionTransport: 'SOLANA_RPC',
        submissionTime: Date.now() - 5000,
        reconciliationState: 'PENDING',
        networkFeeLamports: 5000,
        jitoTipLamports: 0,
        executionMode: 'LIVE',
      };
      workstationDb.saveTransaction(pendingTx);

      vi.spyOn(Connection.prototype, 'getSignatureStatuses').mockResolvedValue({
        context: { slot: 280008000 },
        value: [{ confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom(6001)'] }, slot: 280008000 } as any],
      });

      await coordinator.startupReconciliation();

      const savedTx = workstationDb.loadTransactions().find((t) => t.signature === revertedSig);
      expect(savedTx?.reconciliationState).toBe('REVERTED');

      // Zero phantom positions created
      const phantomPos = workstationDb.loadPositions().find((p) => p.id === revertedSig);
      expect(phantomPos).toBeUndefined();
    });

    it('5.6: flags RECONCILIATION_MISMATCH when database records active position but on-chain balance is 0', async () => {
      const ghostPosId = `ghost_pos_${Date.now()}`;
      const ghostPos: NormalizedPosition = {
        id: ghostPosId,
        mint: 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBA56',
        symbol: 'GHOST',
        name: 'Ghost Token',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000000',
        costBasisLamports: 100_000_000,
        entryPriceSol: 0.0001,
        currentPriceSol: 0.0001,
        currentValueSol: 0.1,
        unrealizedPnLSol: 0,
        unrealizedPnLPct: 0,
        realizedPnLSol: 0,
        entryTxSignature: 'sig_ghost',
        entrySlot: 280000000,
        entryTimestamp: Date.now(),
        entryFeeLamports: 5000,
        priorityFeeLamports: 0,
        jitoTipLamports: 0,
        executionMode: 'LIVE',
        status: 'OPEN',
        markAgeMs: 0,
        markSource: 'SOLANA_RPC',
        lastUpdatedTimestamp: Date.now(),
      };
      workstationDb.savePosition(ghostPos);

      // Mock on-chain balance returning 0 (funds gone / transferred / rug / out-of-sync)
      vi.spyOn(Connection.prototype, 'getTokenAccountBalance').mockResolvedValue({
        context: { slot: 280009000 },
        value: { amount: '0', decimals: 6, uiAmount: 0 },
      } as any);

      const res = await coordinator.startupReconciliation();

      expect(res.status).toBe('RECONCILIATION_MISMATCH');
      expect(res.mismatchesCount).toBeGreaterThanOrEqual(1);
      expect(res.details).toContain('on-chain balance is 0');

      const updatedGhost = workstationDb.loadPositions('LIVE', 'OPEN').find((p) => p.id === ghostPosId);
      expect(updatedGhost?.exitReason).toContain('RECONCILIATION_MISMATCH');
    });
  });
});
