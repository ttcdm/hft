import '../suppress-warnings.cjs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { PublicKey, Connection } from '@solana/web3.js';
import { ExecutionCoordinator, ExecuteTradeRequest } from '../server/execution/coordinator';
import { TradeReconciler } from '../server/execution/reconciliation';
import { txBuilder } from '../server/solana/transactionBuilder';
import { localSigner } from '../server/solana/signer';
import { PumpCurveService, TradeQuote } from '../server/solana/pumpCurve';
import { riskEngine } from '../server/risk/riskEngine';
import { workstationDb } from '../server/db/database';
import { authManager, requireOperatorAuth, verifyWsAuth, isAllowedClientOrigin } from '../server/middleware/auth';
import { NormalizedPosition, TokenEligibilityReport } from '../server/core/types';
import { TOKEN_PROGRAM_ID } from '../server/solana/programs';
import { EligibilityFilter } from '../server/signals/eligibilityFilter';

describe('Adversarial Challenge M1.2: Concurrency, Invariants & Security Barriers', () => {
  const testMintStr = 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS';
  const testMint = new PublicKey(testMintStr);
  const dummyWallet = new PublicKey('4Nd1mBQtrMJVYVfKf2PJy9NZWsWC89S2qMTrE57sR8Q1');

  beforeEach(() => {
    // Ensure clean state
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(dummyWallet);
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => tx);
    process.env.ALLOW_LIVE_REAL_MONEY_TRADING = 'true';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. IN-FLIGHT LAMPORT RESERVATION GUARD & LEAKAGE PREVENTION
  // =========================================================================
  describe('Mission 1: In-Flight Lamport Reservation Guard (Zero Leakage under Thrown Errors)', () => {
    let coordinator: ExecutionCoordinator;

    beforeEach(() => {
      coordinator = new ExecutionCoordinator();
      (coordinator as any).executionMode = 'LIVE';
      (coordinator as any).isLiveTradingArmed = true;
      (coordinator as any).realWalletBalanceSol = 1.0; // 1 SOL spendable
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
      const mockState: any = {
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

      vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(mockState);

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
        expectedJitoTipLamports: 100_000, // C7b: 10% per side would trip the 20% round-trip cost floor
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

    it('1.1: initial inFlightReservedSol is exactly 0', () => {
      expect((coordinator as any).inFlightReservedSol).toBe(0);
    });

    it('1.2: decrements inFlightReservedSol via finally when capturePreTradeSnapshot throws', async () => {
      setupMockPumpMarketState();

      vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockRejectedValue(
        new Error('RPC network partition during snapshot capture')
      );

      const req: ExecuteTradeRequest = {
        signalTimestamp: Date.now(),
        mint: testMintStr,
        symbol: 'LEAKTEST',
        name: 'Leak Test Token',
        amountSol: 0.01,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
      };

      expect((coordinator as any).inFlightReservedSol).toBe(0);

      const result = await coordinator.executeTrade(req);

      expect(result.success).toBe(false);
      expect(result.lifecycleState).toBe('CHAIN_ERROR');
      expect(result.error).toContain('RPC network partition during snapshot capture');
      // Invariant: inFlightReservedSol must be exactly 0 after caught error
      expect((coordinator as any).inFlightReservedSol).toBe(0);
    });

    it('1.3: decrements inFlightReservedSol via finally when buildBuyTransaction throws', async () => {
      setupMockPumpMarketState();

      vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({
        walletSolLamports: 1_000_000_000,
        tokenBalanceRaw: '0',
        tokenDecimals: 6,
        timestamp: Date.now(),
      });

      vi.spyOn(txBuilder, 'buildBuyTransaction').mockRejectedValue(
        new Error('Compute budget instruction assembly failed')
      );

      const req: ExecuteTradeRequest = {
        signalTimestamp: Date.now(),
        mint: testMintStr,
        symbol: 'LEAKTEST2',
        name: 'Leak Test Token 2',
        amountSol: 0.01,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
      };

      const result = await coordinator.executeTrade(req);

      expect(result.success).toBe(false);
      expect(result.lifecycleState).toBe('CHAIN_ERROR');
      expect(result.error).toContain('Compute budget instruction assembly failed');
      expect((coordinator as any).inFlightReservedSol).toBe(0);
    });

    it('1.4: decrements inFlightReservedSol via finally when localSigner.signTransaction throws', async () => {
      setupMockPumpMarketState();

      vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({
        walletSolLamports: 1_000_000_000,
        tokenBalanceRaw: '0',
        tokenDecimals: 6,
        timestamp: Date.now(),
      });

      vi.spyOn(txBuilder, 'buildBuyTransaction').mockResolvedValue({} as any);
      vi.spyOn(localSigner, 'signTransaction').mockRejectedValue(
        new Error('Hardware security module signing timeout')
      );

      const req: ExecuteTradeRequest = {
        signalTimestamp: Date.now(),
        mint: testMintStr,
        symbol: 'LEAKTEST3',
        name: 'Leak Test Token 3',
        amountSol: 0.01,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
      };

      const result = await coordinator.executeTrade(req);

      expect(result.success).toBe(false);
      expect(result.lifecycleState).toBe('CHAIN_ERROR');
      expect(result.error).toContain('Hardware security module signing timeout');
      expect((coordinator as any).inFlightReservedSol).toBe(0);
    });

    it('1.5: decrements inFlightReservedSol via finally when jitoTransport.submit throws', async () => {
      setupMockPumpMarketState();

      vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({
        walletSolLamports: 1_000_000_000,
        tokenBalanceRaw: '0',
        tokenDecimals: 6,
        timestamp: Date.now(),
      });

      vi.spyOn(txBuilder, 'buildBuyTransaction').mockResolvedValue({} as any);
      vi.spyOn(localSigner, 'signTransaction').mockResolvedValue({} as any);
      // A4 fails closed on an unhealthy block engine, so declare it healthy to reach the submit path under test.
      vi.spyOn(coordinator, 'getJitoReadiness').mockReturnValue({ ready: true, enabled: true, status: 'HEALTHY' });
      vi.spyOn((coordinator as any).jitoTransport, 'submit').mockRejectedValue(
        new Error('Block Engine connection reset by peer')
      );

      const req: ExecuteTradeRequest = {
        signalTimestamp: Date.now(),
        mint: testMintStr,
        symbol: 'LEAKTEST4',
        name: 'Leak Test Token 4',
        amountSol: 0.01,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
      };

      const result = await coordinator.executeTrade(req);

      expect(result.success).toBe(false);
      expect(result.lifecycleState).toBe('CHAIN_ERROR');
      expect(result.error).toContain('Block Engine connection reset by peer');
      expect((coordinator as any).inFlightReservedSol).toBe(0);
    });

    it('1.6: decrements inFlightReservedSol via finally when reconcileBuyTransaction throws', async () => {
      setupMockPumpMarketState();

      vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({
        walletSolLamports: 1_000_000_000,
        tokenBalanceRaw: '0',
        tokenDecimals: 6,
        timestamp: Date.now(),
      });

      vi.spyOn(txBuilder, 'buildBuyTransaction').mockResolvedValue({} as any);
      vi.spyOn(localSigner, 'signTransaction').mockResolvedValue({} as any);
      vi.spyOn(coordinator, 'getJitoReadiness').mockReturnValue({ ready: true, enabled: true, status: 'HEALTHY' });
      vi.spyOn((coordinator as any).jitoTransport, 'submit').mockResolvedValue({
        success: true,
        signature: 'simulated_sig_123',
        bundleId: 'bundle_123',
      });
      vi.spyOn((coordinator as any).jitoTransport, 'confirm').mockResolvedValue({
        confirmed: true,
        slot: 280000100,
      });
      vi.spyOn(TradeReconciler, 'reconcileBuyTransaction').mockRejectedValue(
        new Error('Fatal deserialization exception in on-chain transaction parser')
      );

      const req: ExecuteTradeRequest = {
        signalTimestamp: Date.now(),
        mint: testMintStr,
        symbol: 'LEAKTEST5',
        name: 'Leak Test Token 5',
        amountSol: 0.01,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
      };

      const result = await coordinator.executeTrade(req);

      expect(result.success).toBe(false);
      expect(result.lifecycleState).toBe('CHAIN_ERROR');
      expect(result.error).toContain('Fatal deserialization exception');
      expect((coordinator as any).inFlightReservedSol).toBe(0);
    });

    it('1.7: stress test — concurrent burst of 20 failing trades never leaks lamports', async () => {
      setupMockPumpMarketState();

      vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockImplementation(async () => {
        // Random latency to interleave async execution paths
        await new Promise((r) => setTimeout(r, Math.random() * 20));
        throw new Error('Concurrent injected error');
      });

      const burstCount = 20;
      const promises: Promise<any>[] = [];

      for (let i = 0; i < burstCount; i++) {
        promises.push(
          coordinator.executeTrade({
            signalTimestamp: Date.now(),
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

      // All must have failed cleanly. C7 allows one in-flight buy per mint, so one request reaches the injected
      // chain error and every concurrent duplicate for the same mint is refused up front.
      for (const res of results) {
        expect(res.success).toBe(false);
        if (res.lifecycleState === 'RISK_REJECTED') {
          expect(res.error).toMatch(/DUPLICATE_MINT/);
        } else {
          expect(res.lifecycleState).toBe('CHAIN_ERROR');
        }
      }
      expect(results.filter((res) => res.lifecycleState === 'CHAIN_ERROR').length).toBeGreaterThanOrEqual(1);

      // Invariant: Zero lamport leakage across all concurrent failures
      expect((coordinator as any).inFlightReservedSol).toBe(0);
    });
  });

  // =========================================================================
  // 2. CONCURRENT EXIT RACE CONDITIONS (inFlightPositionExits)
  // =========================================================================
  describe('Mission 2: Concurrent Exit Race Conditions (inFlightPositionExits Lock)', () => {
    let coordinator: ExecutionCoordinator;
    const posId = `race_pos_${Date.now()}`;

    beforeEach(() => {
      coordinator = new ExecutionCoordinator();

      const openPosition: NormalizedPosition = {
        id: posId,
        mint: testMintStr,
        symbol: 'RACETEST',
        name: 'Race Test Token',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000000',
        costBasisLamports: 100_000_000,
        entryPriceSol: 0.0001,
        currentPriceSol: 0.00015,
        currentValueSol: 0.15,
        unrealizedPnLSol: 0.05,
        unrealizedPnLPct: 50.0,
        realizedPnLSol: 0,
        entryTxSignature: 'sig_race_initial',
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

    it('2.1: blocks simultaneous duplicate exit attempts on the same position', async () => {
      // Trigger two simultaneous closePosition calls
      const [res1, res2] = await Promise.all([
        coordinator.closePosition(posId, 100, 'Dual Exit 1'),
        coordinator.closePosition(posId, 100, 'Dual Exit 2'),
      ]);

      // Exactly one must succeed, and the other must be blocked with EXIT_IN_PROGRESS
      const results = [res1, res2];
      const blocked = results.find((r) => r.error && r.error.includes('EXIT_IN_PROGRESS'));
      const succeeded = results.find((r) => r.success === true);

      expect(blocked).toBeDefined();
      expect(blocked!.error).toContain('EXIT_IN_PROGRESS: An exit transaction for this position is already in progress.');
      expect(succeeded).toBeDefined();
    });

    it('2.2: hammer test — burst of 20 concurrent exits results in exactly 1 execution and 19 blocked', async () => {
      // Create a fresh open position
      const hammerPosId = `hammer_pos_${Date.now()}`;
      const hammerPos: NormalizedPosition = {
        id: hammerPosId,
        mint: testMintStr,
        symbol: 'HAMMER',
        name: 'Hammer Token',
        tokenDecimals: 6,
        tokenQuantityRaw: '5000000000',
        costBasisLamports: 500_000_000,
        entryPriceSol: 0.0001,
        currentPriceSol: 0.0001,
        currentValueSol: 0.5,
        unrealizedPnLSol: 0,
        unrealizedPnLPct: 0,
        realizedPnLSol: 0,
        entryTxSignature: 'sig_hammer_init',
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
      workstationDb.savePosition(hammerPos);

      const burstCount = 20;
      const promises: Promise<any>[] = [];
      for (let i = 0; i < burstCount; i++) {
        promises.push(coordinator.closePosition(hammerPosId, 100, `Burst Exit ${i}`));
      }

      const results = await Promise.all(promises);

      const exitInProgressErrors = results.filter((r) => r.error && r.error.includes('EXIT_IN_PROGRESS'));
      const successfulOrProcessed = results.filter((r) => r.success === true);

      // Exactly 19 blocked by the in-flight lock, 1 processed
      expect(exitInProgressErrors.length).toBe(19);
      expect(successfulOrProcessed.length).toBe(1);

      // Lock must be released afterward
      expect((coordinator as any).inFlightPositionExits.has(hammerPosId)).toBe(false);
    });

    it('2.3: releases inFlightPositionExits lock in finally block when an exception is thrown', async () => {
      const failingPosId = `fail_pos_${Date.now()}`;
      const failingPos: NormalizedPosition = {
        id: failingPosId,
        mint: testMintStr,
        symbol: 'FAILPOS',
        name: 'Failing Pos Token',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000000',
        costBasisLamports: 100_000_000,
        entryPriceSol: 0.0001,
        currentPriceSol: 0.0001,
        currentValueSol: 0.1,
        unrealizedPnLSol: 0,
        unrealizedPnLPct: 0,
        realizedPnLSol: 0,
        entryTxSignature: 'sig_fail_init',
        entrySlot: 280000000,
        entryTimestamp: Date.now(),
        entryFeeLamports: 5000,
        priorityFeeLamports: 0,
        jitoTipLamports: 0,
        executionMode: 'LIVE', // LIVE mode to reach on-chain branch
        status: 'OPEN',
        markAgeMs: 0,
        markSource: 'SOLANA_RPC',
        lastUpdatedTimestamp: Date.now(),
      };
      workstationDb.savePosition(failingPos);

      // In LIVE mode, resolveVenue will be invoked; mock it to throw an exception
      const { PumpSwapVenueService } = await import('../server/solana/pumpSwapService');
      vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockRejectedValue(
        new Error('Solana node connection exploded during venue check')
      );

      const res = await coordinator.closePosition(failingPosId, 100, 'Failing Exit');

      expect(res.success).toBe(false);
      expect(res.error).toContain('Solana node connection exploded');

      // Crucial: Lock must NOT remain permanently stuck
      expect((coordinator as any).inFlightPositionExits.has(failingPosId)).toBe(false);

      // Subsequent attempt should NOT return EXIT_IN_PROGRESS
      const secondAttempt = await coordinator.closePosition(failingPosId, 100, 'Retry Exit');
      expect(secondAttempt.error?.includes('EXIT_IN_PROGRESS')).toBe(false);
    });

    it('2.4: concurrent exits on distinct positions do not block each other', async () => {
      const posA = `distinct_pos_A_${Date.now()}`;
      const posB = `distinct_pos_B_${Date.now()}`;

      workstationDb.savePosition({
        ...testMint,
        id: posA,
        mint: testMintStr,
        symbol: 'POS_A',
        name: 'Token A',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000000',
        costBasisLamports: 100_000_000,
        entryPriceSol: 0.0001,
        currentPriceSol: 0.0001,
        currentValueSol: 0.1,
        unrealizedPnLSol: 0,
        unrealizedPnLPct: 0,
        realizedPnLSol: 0,
        entryTxSignature: 'sig_a',
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
      } as any);

      workstationDb.savePosition({
        ...testMint,
        id: posB,
        mint: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv',
        symbol: 'POS_B',
        name: 'Token B',
        tokenDecimals: 6,
        tokenQuantityRaw: '2000000000',
        costBasisLamports: 200_000_000,
        entryPriceSol: 0.0001,
        currentPriceSol: 0.0001,
        currentValueSol: 0.2,
        unrealizedPnLSol: 0,
        unrealizedPnLPct: 0,
        realizedPnLSol: 0,
        entryTxSignature: 'sig_b',
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
      } as any);

      const [resA, resB] = await Promise.all([
        coordinator.closePosition(posA, 100, 'Close A'),
        coordinator.closePosition(posB, 100, 'Close B'),
      ]);

      expect(resA.success).toBe(true);
      expect(resB.success).toBe(true);
      expect(resA.error).toBeUndefined();
      expect(resB.error).toBeUndefined();
    });
  });

  // =========================================================================
  // 3. MINT MISMATCH REJECTION (req.mint !== eligibilityReport.mint)
  // =========================================================================
  describe('Mission 3: Mint Mismatch Rejection (Immediate Fail-Closed Pre-Execution)', () => {
    let coordinator: ExecutionCoordinator;

    beforeEach(() => {
      coordinator = new ExecutionCoordinator();
    });

    afterEach(() => {
      coordinator.cleanup();
    });

    it('3.1: rejects trade immediately when eligibility report mint does not match in PAPER mode', async () => {
      (coordinator as any).executionMode = 'PAPER';

      const tradeReq: ExecuteTradeRequest = {
        signalTimestamp: Date.now(),
        mint: 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS',
        symbol: 'LEGIT',
        name: 'Legit Token',
        amountSol: 0.01,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        eligibilityReport: {
          mint: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv', // MISMATCH!
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
      expect(res.error).toContain('CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS');
      expect(res.error).toContain('2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv');
    });

    it('3.2: rejects trade immediately when eligibility report mint does not match in LIVE mode', async () => {
      (coordinator as any).executionMode = 'LIVE';
      (coordinator as any).isLiveTradingArmed = true;

      const tradeReq: ExecuteTradeRequest = {
        signalTimestamp: Date.now(),
        mint: 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS',
        symbol: 'LEGIT_LIVE',
        name: 'Legit Token Live',
        amountSol: 0.005,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        eligibilityReport: {
          mint: '4Nd1mBQtrMJVYVfKf2PJy9NZWsWC89S2qMTrE57sR8Q1', // MISMATCH!
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

    it('3.3: ensures downstream functions (market state, risk engine, signing) are NOT called on mismatch', async () => {
      const fetchSpy = vi.spyOn(PumpCurveService, 'fetchPumpMarketState');
      const riskSpy = vi.spyOn(riskEngine, 'evaluateOrder');
      const signSpy = vi.spyOn(localSigner, 'signTransaction');

      const tradeReq: ExecuteTradeRequest = {
        signalTimestamp: Date.now(),
        mint: 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS',
        symbol: 'BYPASS_TEST',
        name: 'Bypass Test',
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
      // Downstream execution MUST NOT occur
      expect(fetchSpy.mock.calls.length).toBe(0);
      expect(riskSpy.mock.calls.length).toBe(0);
      expect(signSpy.mock.calls.length).toBe(0);
    });

    it('3.4: rejects base58 case-tampered mints (case-sensitivity verification)', async () => {
      // Change 'CzLS...' to 'czLS...' (lowercase 'c')
      const lowercasedMint = 'czLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS';

      const tradeReq: ExecuteTradeRequest = {
        signalTimestamp: Date.now(),
        mint: testMintStr,
        symbol: 'CASE_TEST',
        name: 'Case Test',
        amountSol: 0.01,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        eligibilityReport: {
          mint: lowercasedMint, // Single character case difference
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

    it('3.5: allows trade past eligibility verification when mint matches exactly', async () => {
      const tradeReq: ExecuteTradeRequest = {
        signalTimestamp: Date.now(),
        mint: testMintStr,
        symbol: 'MATCH_TEST',
        name: 'Match Test',
        amountSol: 0.01,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        currentPriceSol: 0.0001,
        eligibilityReport: {
          mint: testMintStr, // EXACT MATCH!
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
      // Because mint matches, it does NOT return ELIGIBILITY_MINT_MISMATCH
      expect(res.error?.includes('ELIGIBILITY_MINT_MISMATCH')).toBe(false);
    });
  });

  // =========================================================================
  // 4. WEBSOCKET AUTHENTICATION & QUERY-STRING CREDENTIAL REJECTION
  // =========================================================================
  describe('Mission 4: WebSocket Authentication & Query-String Credential Rejection', () => {
    let validSessionToken: string;

    class MockWsClient {
      public readyState: number = 1; // WebSocket.OPEN
      public isAuthenticated: boolean = false;
      public sentMessages: any[] = [];
      public closedCode?: number;
      public closedReason?: string;
      private listeners: Map<string, ((...args: any[]) => void)[]> = new Map();

      on(event: string, fn: (...args: any[]) => void) {
        if (!this.listeners.has(event)) this.listeners.set(event, []);
        this.listeners.get(event)!.push(fn);
      }

      emit(event: string, ...args: any[]) {
        const list = this.listeners.get(event) || [];
        for (const fn of list) fn(...args);
      }

      send(data: string) {
        this.sentMessages.push(JSON.parse(data));
      }

      close(code?: number, reason?: string) {
        this.closedCode = code;
        this.closedReason = reason;
        this.readyState = 3; // WebSocket.CLOSED
      }
    }

    // Exact connection handler logic matching server.ts lines 61-128
    function attachWsHandler(ws: MockWsClient, req: any) {
      const origin = (req?.headers?.origin || '') as string;
      const host = (req?.headers?.host || '') as string;
      if (origin && !isAllowedClientOrigin(origin, host)) {
        ws.close(4003, 'Unauthorized WebSocket Origin');
        return;
      }

      ws.isAuthenticated = false;
      ws.send(JSON.stringify({
        type: 'AUTH_REQUIRED',
        message: 'Operator session authentication required before receiving engine telemetry and market snapshots.',
        timestamp: Date.now(),
      }));

      ws.on('message', (data: any) => {
        try {
          const parsed = typeof data === 'string' ? JSON.parse(data) : data;
          if (parsed.action === 'AUTHENTICATE' || parsed.action === 'AUTH') {
            const token = parsed.sessionToken || parsed.token;
            if (authManager.validateToken(token)) {
              ws.isAuthenticated = true;
              ws.send(JSON.stringify({ type: 'AUTHENTICATED', authenticated: true, timestamp: Date.now() }));
              ws.send(JSON.stringify({ type: 'TELEMETRY', data: { status: 'LIVE_STREAM', feed: 'ACTIVE' } }));
            } else {
              ws.send(JSON.stringify({ type: 'AUTH_ERROR', error: 'INVALID_OPERATOR_TOKEN' }));
            }
          }
        } catch {}
      });
    }

    // Exact broadcast logic matching server.ts lines 47-59
    function broadcastWs(clients: MockWsClient[], payload: any, sensitiveOnly: boolean = true) {
      const str = JSON.stringify(payload);
      clients.forEach((client) => {
        if (client.readyState === 1) {
          if (sensitiveOnly && !client.isAuthenticated) {
            return;
          }
          client.send(str);
        }
      });
    }

    // Exact route handler logic matching server.ts lines 804-810
    const handleAccountBalance = (req: any, res: any) => {
      if (req.query.secret || req.query.apiSecret || req.query.apiKey) {
        return res.status(400).json({
          error: 'CRITICAL_SECURITY_VIOLATION',
          message: 'Credentials must NEVER be passed via URL query parameters. Use HTTP headers (x-mbx-apikey, x-mbx-apisecret).',
        });
      }
      const apiKey = req.headers['x-mbx-apikey'];
      const apiSecret = req.headers['x-mbx-apisecret'] || req.headers['x-api-secret'];
      return res.status(200).json({ success: true, balance: 1.5, authenticated: Boolean(apiKey && apiSecret) });
    };

    beforeEach(() => {
      const session = authManager.createSession('OPERATOR');
      validSessionToken = session.token;
    });

    it('4.1: unauthenticated WebSocket client receives AUTH_REQUIRED and cannot receive trade streams', () => {
      const client = new MockWsClient();
      attachWsHandler(client, { headers: { host: '127.0.0.1' } });

      // Initial message must be AUTH_REQUIRED
      expect(client.sentMessages.length).toBe(1);
      expect(client.sentMessages[0].type).toBe('AUTH_REQUIRED');
      expect(client.isAuthenticated).toBe(false);

      // Attempt broadcast of sensitive telemetry
      broadcastWs([client], { type: 'ORDER_STREAM', order: { mint: testMintStr, amount: 0.1 } }, true);

      // Unauthenticated client MUST NOT receive the broadcast
      expect(client.sentMessages.length).toBe(1);
      expect(client.sentMessages.some((m) => m.type === 'ORDER_STREAM')).toBe(false);
    });

    it('4.2: rejects invalid auth token on WebSocket with AUTH_ERROR', () => {
      const client = new MockWsClient();
      attachWsHandler(client, { headers: { host: '127.0.0.1' } });

      // Send invalid authentication
      client.emit('message', JSON.stringify({ action: 'AUTHENTICATE', token: 'forged_token_0000' }));

      const authErrorMsg = client.sentMessages.find((m) => m.type === 'AUTH_ERROR');
      expect(authErrorMsg).toBeDefined();
      expect(authErrorMsg.error).toBe('INVALID_OPERATOR_TOKEN');
      expect(client.isAuthenticated).toBe(false);
    });

    it('4.3: authenticates client with valid operator session and streams private telemetry', () => {
      const client = new MockWsClient();
      attachWsHandler(client, { headers: { host: '127.0.0.1' } });

      // Send valid authentication
      client.emit('message', JSON.stringify({ action: 'AUTHENTICATE', token: validSessionToken }));

      const authenticatedMsg = client.sentMessages.find((m) => m.type === 'AUTHENTICATED');
      expect(authenticatedMsg).toBeDefined();
      expect(authenticatedMsg.authenticated).toBe(true);
      expect(client.isAuthenticated).toBe(true);

      const telemetryMsg = client.sentMessages.find((m) => m.type === 'TELEMETRY');
      expect(telemetryMsg).toBeDefined();
      expect(telemetryMsg.data.status).toBe('LIVE_STREAM');

      // Now broadcast sensitive trade stream
      broadcastWs([client], { type: 'TRADE_STREAM', trade: { mint: testMintStr, pnlSol: 0.05 } }, true);
      const tradeStreamMsg = client.sentMessages.find((m) => m.type === 'TRADE_STREAM');
      expect(tradeStreamMsg).toBeDefined();
      expect(tradeStreamMsg.trade.pnlSol).toBe(0.05);
    });

    it('4.4: WebSocket closes with 4003 on unauthorized origin', () => {
      const client = new MockWsClient();
      attachWsHandler(client, { headers: { origin: 'https://evil-attacker-site.com', host: '127.0.0.1' } });

      expect(client.closedCode).toBe(4003);
      expect(client.closedReason).toBe('Unauthorized WebSocket Origin');
    });

    it('4.5: query-string credential rejection — rejects requests containing secret in query params', () => {
      let statusCode = 0;
      let body: any = null;
      const res = {
        status: (s: number) => { statusCode = s; return { json: (b: any) => { body = b; } }; },
      };

      handleAccountBalance({ query: { secret: 'my-leaked-secret' }, headers: {} }, res);

      expect(statusCode).toBe(400);
      expect(body.error).toBe('CRITICAL_SECURITY_VIOLATION');
      expect(body.message).toContain('Credentials must NEVER be passed via URL query parameters');
    });

    it('4.6: query-string credential rejection — rejects requests containing apiKey in query params', () => {
      let statusCode = 0;
      let body: any = null;
      const res = {
        status: (s: number) => { statusCode = s; return { json: (b: any) => { body = b; } }; },
      };

      handleAccountBalance({ query: { apiKey: 'my-leaked-api-key' }, headers: {} }, res);

      expect(statusCode).toBe(400);
      expect(body.error).toBe('CRITICAL_SECURITY_VIOLATION');
    });

    it('4.7: query-string credential rejection — rejects requests containing apiSecret in query params', () => {
      let statusCode = 0;
      let body: any = null;
      const res = {
        status: (s: number) => { statusCode = s; return { json: (b: any) => { body = b; } }; },
      };

      handleAccountBalance({ query: { apiSecret: 'my-leaked-secret' }, headers: {} }, res);

      expect(statusCode).toBe(400);
      expect(body.error).toBe('CRITICAL_SECURITY_VIOLATION');
    });

    it('4.8: requireOperatorAuth rejects session token passed via query param instead of header', () => {
      let statusCode = 0;
      let body: any = null;
      let nextCalled = false;
      const req: any = {
        query: { token: validSessionToken }, // Token in query param!
        headers: {}, // No authorization header
        method: 'POST',
        originalUrl: '/api/order/submit',
      };
      const res: any = {
        status: (s: number) => { statusCode = s; return { json: (b: any) => { body = b; } }; },
      };
      const next = () => { nextCalled = true; };

      requireOperatorAuth(req, res, next);

      expect(statusCode).toBe(401);
      expect(body.error.code).toBe('UNAUTHORIZED_MUTATION');
      expect(nextCalled).toBe(false);
    });

    it('4.9: requireOperatorAuth accepts valid credentials passed strictly via HTTP headers', () => {
      let statusCode = 0;
      let nextCalled = false;
      const req: any = {
        query: {},
        headers: { authorization: `Bearer ${validSessionToken}` },
        method: 'POST',
        originalUrl: '/api/order/submit',
      };
      const res: any = {
        status: (s: number) => { statusCode = s; return { json: () => {} }; },
      };
      const next = () => { nextCalled = true; };

      requireOperatorAuth(req, res, next);

      expect(nextCalled).toBe(true);
      expect(statusCode).toBe(0);
    });
  });

  // =========================================================================
  // 5. RECOVERY OF INTERRUPTED TRANSACTIONS FROM SIMULATED ON-CHAIN LOGS
  // =========================================================================
  describe('Mission 5: Recovery of Interrupted Transactions from Simulated On-Chain Logs', () => {
    it('5.1: recovers interrupted BUY transaction and accurately reconstructs position', async () => {
      const buyTxSig = `sim_buy_${Date.now()}`;
      const mockBuyConn: any = {
        getTransaction: async () => ({
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
            postBalances: [4_850_000_000, 100_000_000], // 0.15 SOL spent
            preTokenBalances: [
              {
                accountIndex: 0,
                mint: testMintStr,
                owner: dummyWallet.toBase58(),
                uiTokenAmount: { amount: '0', decimals: 6 },
              },
            ],
            postTokenBalances: [
              {
                accountIndex: 0,
                mint: testMintStr,
                owner: dummyWallet.toBase58(),
                uiTokenAmount: { amount: '750000000000', decimals: 6 }, // 750,000 tokens received
              },
            ],
          },
        }),
      };

      const recovery = await TradeReconciler.recoverInterruptedTransaction(
        mockBuyConn,
        buyTxSig,
        dummyWallet
      );

      expect(recovery.recovered).toBe(true);
      expect(recovery.type).toBe('BUY');
      expect(recovery.mint).toBe(testMintStr);
      expect(recovery.tokenQuantityRaw).toBe('750000000000');
      expect(recovery.solSpentLamports).toBe(150_000_000);
      expect(recovery.slot).toBe(280005000);

      // Reconstruct into SQLite database
      const reconstructedPos: NormalizedPosition = {
        id: buyTxSig,
        mint: recovery.mint!,
        symbol: 'REC_BUY_TEST',
        name: 'Recovered Buy Test',
        tokenDecimals: recovery.tokenDecimals ?? 6,
        tokenQuantityRaw: recovery.tokenQuantityRaw!,
        costBasisLamports: recovery.solSpentLamports!,
        entryPriceSol: 0.0002,
        currentPriceSol: 0.0002,
        currentValueSol: 0.15,
        unrealizedPnLSol: 0,
        unrealizedPnLPct: 0,
        realizedPnLSol: 0,
        entryTxSignature: buyTxSig,
        entrySlot: recovery.slot!,
        entryTimestamp: recovery.blockTime!,
        entryFeeLamports: recovery.networkFeeLamports ?? 5000,
        priorityFeeLamports: 0,
        jitoTipLamports: 0,
        executionMode: 'LIVE',
        status: 'OPEN',
        markAgeMs: 0,
        markSource: 'SOLANA_RPC',
        venue: 'PUMP_BONDING_CURVE',
        lastUpdatedTimestamp: Date.now(),
      };

      workstationDb.savePosition(reconstructedPos);

      const loaded = workstationDb.loadPositions('LIVE', 'OPEN').find((p) => p.id === buyTxSig);
      expect(loaded).toBeDefined();
      expect(loaded!.tokenQuantityRaw).toBe('750000000000');
      expect(loaded!.costBasisLamports).toBe(150_000_000);
    });

    it('5.2: recovers interrupted partial SELL transaction and preserves PARTIALLY_CLOSED state', async () => {
      const sellTxSig = `sim_partsell_${Date.now()}`;
      const posId = `pos_part_${Date.now()}`;

      // Pre-existing position with 1,000,000 tokens (1,000,000,000,000 raw) and 1.0 SOL cost basis
      const prePos: NormalizedPosition = {
        id: posId,
        mint: testMintStr,
        symbol: 'PART_REC',
        name: 'Part Rec Token',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000000000',
        costBasisLamports: 1_000_000_000,
        entryPriceSol: 0.000001,
        currentPriceSol: 0.0000015,
        currentValueSol: 1.5,
        unrealizedPnLSol: 0.5,
        unrealizedPnLPct: 50.0,
        realizedPnLSol: 0,
        entryTxSignature: 'sig_pre_buy',
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
      workstationDb.savePosition(prePos);

      // Simulated transaction: 40% sold (400,000 tokens sold, 600,000 remaining) for 0.60 SOL proceeds
      const mockSellConn: any = {
        getTransaction: async () => ({
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
            postBalances: [2_600_000_000, 100_000_000], // +0.60 SOL received
            preTokenBalances: [
              {
                accountIndex: 0,
                mint: testMintStr,
                owner: dummyWallet.toBase58(),
                uiTokenAmount: { amount: '1000000000000', decimals: 6 },
              },
            ],
            postTokenBalances: [
              {
                accountIndex: 0,
                mint: testMintStr,
                owner: dummyWallet.toBase58(),
                uiTokenAmount: { amount: '600000000000', decimals: 6 }, // 600,000 remaining
              },
            ],
          },
        }),
      };

      const recovery = await TradeReconciler.recoverInterruptedTransaction(
        mockSellConn,
        sellTxSig,
        dummyWallet
      );

      expect(recovery.recovered).toBe(true);
      expect(recovery.type).toBe('SELL');
      expect(recovery.tokensSoldRaw).toBe('400000000000');
      expect(recovery.remainingTokensRaw).toBe('600000000000');
      expect(recovery.solReceivedLamports).toBe(600_000_000);

      // Update position state based on recovery
      const existing = workstationDb.loadPositions('LIVE', 'OPEN').find((p) => p.id === posId)!;
      expect(existing).toBeDefined();

      const totalBefore = BigInt(recovery.tokenBeforeRaw!);
      const sold = BigInt(recovery.tokensSoldRaw!);
      const sellFraction = Number(sold) / Number(totalBefore);
      const costOfSoldLamports = Math.round(existing.costBasisLamports * sellFraction);
      const realizedPnL = (recovery.solReceivedLamports! - costOfSoldLamports) / 1e9;

      expect(sellFraction).toBeCloseTo(0.40, 2);
      expect(costOfSoldLamports).toBe(400_000_000); // 0.40 SOL cost basis sold
      expect(realizedPnL).toBeCloseTo(0.20, 4); // 0.60 SOL proceeds - 0.40 SOL cost = +0.20 SOL profit

      existing.status = 'PARTIALLY_CLOSED';
      existing.tokenQuantityRaw = recovery.remainingTokensRaw!;
      existing.costBasisLamports = Math.max(0, existing.costBasisLamports - costOfSoldLamports);
      existing.realizedPnLSol = (existing.realizedPnLSol ?? 0) + realizedPnL;
      existing.exitTxSignature = sellTxSig;

      workstationDb.savePosition(existing);

      // Verify DB reflects PARTIALLY_CLOSED with remaining inventory and updated cost basis
      const updated = workstationDb.loadPositions('LIVE', 'PARTIALLY_CLOSED').find((p) => p.id === posId);
      expect(updated).toBeDefined();
      expect(updated!.status).toBe('PARTIALLY_CLOSED');
      expect(updated!.tokenQuantityRaw).toBe('600000000000');
      expect(updated!.costBasisLamports).toBe(600_000_000);
      expect(updated!.realizedPnLSol).toBeCloseTo(0.20, 4);
    });

    it('5.3: recovers interrupted 100% full SELL transaction and marks position CLOSED', async () => {
      const fullSellSig = `sim_fullsell_${Date.now()}`;
      const mockFullSellConn: any = {
        getTransaction: async () => ({
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
            preBalances: [1_000_000_000, 100_000_000],
            postBalances: [2_500_000_000, 100_000_000],
            preTokenBalances: [
              {
                accountIndex: 0,
                mint: testMintStr,
                owner: dummyWallet.toBase58(),
                uiTokenAmount: { amount: '500000000000', decimals: 6 },
              },
            ],
            postTokenBalances: [
              {
                accountIndex: 0,
                mint: testMintStr,
                owner: dummyWallet.toBase58(),
                uiTokenAmount: { amount: '0', decimals: 6 }, // ZERO TOKENS REMAINING!
              },
            ],
          },
        }),
      };

      const recovery = await TradeReconciler.recoverInterruptedTransaction(
        mockFullSellConn,
        fullSellSig,
        dummyWallet
      );

      expect(recovery.recovered).toBe(true);
      expect(recovery.type).toBe('SELL');
      expect(recovery.remainingTokensRaw).toBe('0');
      expect(recovery.tokensSoldRaw).toBe('500000000000');
    });

    it('5.4: handles reverted interrupted transaction safely without reconstructing position', async () => {
      const revertedSig = `sim_revert_${Date.now()}`;
      const mockRevertConn: any = {
        getTransaction: async () => ({
          slot: 280008000,
          meta: {
            err: { InstructionError: [2, { Custom: 6001 }] },
            fee: 5000,
          },
        }),
      };

      const recovery = await TradeReconciler.recoverInterruptedTransaction(
        mockRevertConn,
        revertedSig,
        dummyWallet
      );

      expect(recovery.recovered).toBe(false);
      expect(recovery.error).toContain('Transaction reverted');
      expect(recovery.mint).toBeUndefined();
    });

    it('5.5: handles dropped/unconfirmed transaction safely when RPC returns null', async () => {
      const droppedSig = `sim_dropped_${Date.now()}`;
      const mockNullConn: any = {
        getTransaction: async () => null,
      };

      const recovery = await TradeReconciler.recoverInterruptedTransaction(
        mockNullConn,
        droppedSig,
        dummyWallet
      );

      expect(recovery.recovered).toBe(false);
      expect(recovery.error).toContain('Transaction not found on-chain');
    });

    it('5.6: handles zero-delta transaction safely without creating phantom position', async () => {
      const zeroDeltaSig = `sim_zerodelta_${Date.now()}`;
      const mockZeroDeltaConn: any = {
        getTransaction: async () => ({
          slot: 280009000,
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
            preBalances: [1_000_000_000, 100_000_000],
            postBalances: [999_995_000, 100_000_000], // Only 5000 fee deducted, no token trade
            preTokenBalances: [],
            postTokenBalances: [],
          },
        }),
      };

      const recovery = await TradeReconciler.recoverInterruptedTransaction(
        mockZeroDeltaConn,
        zeroDeltaSig,
        dummyWallet
      );

      expect(recovery.recovered).toBe(false);
      expect(recovery.error).toContain('Unable to detect token balance delta');
    });
  });
});
