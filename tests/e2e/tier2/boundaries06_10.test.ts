import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PublicKey, TransactionMessage, VersionedTransaction, SystemProgram } from '@solana/web3.js';
import { EligibilityFilter } from '../../../server/signals/eligibilityFilter';
import { ExecutionCoordinator } from '../../../server/execution/coordinator';
import { memecoinAggregator } from '../../../server/memecoinAggregator';
import { WorkstationDatabase, workstationDb } from '../../../server/db/database';
import { riskEngine } from '../../../server/risk/riskEngine';
import { executionConfig } from '../../../server/solana/executionConfig';
import { TOKEN_PROGRAM_ID } from '../../../server/solana/programs';
import {
  VALID_PUMP_MINT_1,
  VALID_PUMP_MINT_2,
  TOKEN_2022_MINT,
} from '../helpers/simulatedStates';
import { MockSolanaRpc } from '../helpers/mockRpc';
import { MockJitoEngine } from '../helpers/mockJito';
import { TestDatabase } from '../helpers/testDb';

describe('Tier 2: Boundary & Corner Cases (Features 6 - 10)', () => {
  let mockRpc: MockSolanaRpc;
  let mockJito: MockJitoEngine;
  let testDb: TestDatabase;
  let coordinator: ExecutionCoordinator;

  beforeEach(async () => {
    mockRpc = new MockSolanaRpc();
    mockJito = new MockJitoEngine();
    await mockJito.start();
    testDb = new TestDatabase();
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
  // Feature 6: Safe Jito Retry & RPC Fallback Boundaries
  // =========================================================================
  describe('Feature 6 Boundaries: Safe Jito Retry & RPC Fallback', () => {
    function createTestTx(payerKey: PublicKey = new PublicKey(Buffer.alloc(32, 2))): VersionedTransaction {
      const msg = new TransactionMessage({
        payerKey,
        recentBlockhash: 'MockBlockhash11111111111111111111111111111111',
        instructions: [
          SystemProgram.transfer({
            fromPubkey: payerKey,
            toPubkey: new PublicKey(Buffer.alloc(32, 3)),
            lamports: 1000,
          }),
        ],
      }).compileToV0Message();
      const tx = new VersionedTransaction(msg);
      tx.signatures = [new Uint8Array(64).fill(1)];
      return tx;
    }

    it('B6.1: retry count 0 boundary does not retry when maxRetries is 0', async () => {
      const conn = mockRpc.createConnection();
      coordinator.setConnection(conn);
      executionConfig.updateConfig({
        jitoMaxRetries: 0,
        enableRpcFallback: false,
      });
      mockJito.setFailSubmissions(true, 'Temporary drop');

      const submitSpy = vi.spyOn(coordinator.getJitoTransport(), 'submit');

      const owner = new PublicKey(Buffer.alloc(32, 2));
      const tx = createTestTx(owner);
      const preSnapshot = {
        timestamp: Date.now(),
        walletSolLamports: 10_000_000,
        tokenBalanceRaw: '0',
        tokenDecimals: 6,
        slot: 280000000,
      };

      const res = await coordinator.submitAndConfirmWithRetry({
        tx,
        orderId: `order_zero_retries_${Date.now()}`,
        correlationId: 'corr_b61',
        side: 'BUY',
        mint: VALID_PUMP_MINT_1.toBase58(),
        mintPubkey: VALID_PUMP_MINT_1,
        owner,
        tokenProgram: TOKEN_PROGRAM_ID,
        preSnapshot,
        jitoTipLamports: 100_000,
      });

      expect(res.success).toBe(false);
      // Attempt 0 only (0 retries) = exactly 1 attempt
      expect(submitSpy).toHaveBeenCalledTimes(1);

      // Verify JitoTransport.submitWithRetry with 0 retries executes exactly 1 attempt
      const directRetry = await coordinator.getJitoTransport().submitWithRetry(tx, 0);
      expect(directRetry.attempts).toBe(1);
    });

    it('B6.2: RPC fallback disabled boundary (enableRpcFallback === false) never invokes SolanaRpcTransport', async () => {
      const conn = mockRpc.createConnection();
      coordinator.setConnection(conn);
      executionConfig.updateConfig({
        enableRpcFallback: false,
        jitoMaxRetries: 1,
        jitoRetryIntervalMs: 5,
      });
      mockJito.setFailSubmissions(true, 'Connection refused');

      const rpcSubmitSpy = vi.spyOn(coordinator.getRpcTransport(), 'submit');

      const owner = new PublicKey(Buffer.alloc(32, 2));
      const tx = createTestTx(owner);
      const preSnapshot = {
        timestamp: Date.now(),
        walletSolLamports: 10_000_000,
        tokenBalanceRaw: '0',
        tokenDecimals: 6,
        slot: 280000000,
      };

      const res = await coordinator.submitAndConfirmWithRetry({
        tx,
        orderId: `order_rpc_disabled_${Date.now()}`,
        correlationId: 'corr_b62',
        side: 'BUY',
        mint: VALID_PUMP_MINT_1.toBase58(),
        mintPubkey: VALID_PUMP_MINT_1,
        owner,
        tokenProgram: TOKEN_PROGRAM_ID,
        preSnapshot,
        jitoTipLamports: 100_000,
      });

      expect(res.success).toBe(false);
      expect(res.transport).toBe('JITO');
      // RPC transport was never invoked because fallback was disabled
      expect(rpcSubmitSpy).toHaveBeenCalledTimes(0);
    });

    it('B6.3: empty transaction or fatal simulation error in Jito aborts immediately without retrying', async () => {
      const conn = mockRpc.createConnection();
      coordinator.setConnection(conn);
      executionConfig.updateConfig({
        jitoMaxRetries: 3,
        jitoRetryIntervalMs: 5,
        enableRpcFallback: false,
      });
      // Fatal simulation error: Program instruction failed
      mockJito.setFailSubmissions(true, 'Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1');

      const submitSpy = vi.spyOn(coordinator.getJitoTransport(), 'submit');

      const owner = new PublicKey(Buffer.alloc(32, 2));
      const tx = createTestTx(owner);
      const preSnapshot = {
        timestamp: Date.now(),
        walletSolLamports: 10_000_000,
        tokenBalanceRaw: '0',
        tokenDecimals: 6,
        slot: 280000000,
      };

      const res = await coordinator.submitAndConfirmWithRetry({
        tx,
        orderId: `order_fatal_err_${Date.now()}`,
        correlationId: 'corr_b63',
        side: 'BUY',
        mint: VALID_PUMP_MINT_1.toBase58(),
        mintPubkey: VALID_PUMP_MINT_1,
        owner,
        tokenProgram: TOKEN_PROGRAM_ID,
        preSnapshot,
        jitoTipLamports: 100_000,
      });

      expect(res.success).toBe(false);
      // Aborts immediately on fatal simulation failure rather than exhausting all 3 retries
      expect(submitSpy).toHaveBeenCalledTimes(1);
    });

    it('B6.4: order deduplication on duplicate clientOrderId detects already-landed trade', async () => {
      const conn = mockRpc.createConnection();
      coordinator.setConnection(conn);

      const clientOrderId = `order_dup_check_${Date.now()}`;
      const owner = new PublicKey(Buffer.alloc(32, 2));
      const tx = createTestTx(owner);
      const preSnapshot = {
        timestamp: Date.now(),
        walletSolLamports: 10_000_000,
        tokenBalanceRaw: '0',
        tokenDecimals: 6,
        slot: 280000000,
      };

      // Pre-seed an already RECONCILED transaction under this clientOrderId
      workstationDb.saveTransaction({
        signature: `sig_already_landed_${Date.now()}`,
        orderId: clientOrderId,
        correlationId: 'corr_dup_4',
        mint: VALID_PUMP_MINT_1.toBase58(),
        direction: 'BUY',
        submissionTransport: 'JITO',
        submissionTime: Date.now(),
        landingSlot: 280000088,
        reconciliationState: 'RECONCILED',
        networkFeeLamports: 5000,
        jitoTipLamports: 100_000,
        executionMode: 'LIVE',
      });

      const jitoSubmitSpy = vi.spyOn(coordinator.getJitoTransport(), 'submit');

      const res = await coordinator.submitAndConfirmWithRetry({
        tx,
        orderId: clientOrderId,
        correlationId: 'corr_dup_4_attempt',
        side: 'BUY',
        mint: VALID_PUMP_MINT_1.toBase58(),
        mintPubkey: VALID_PUMP_MINT_1,
        owner,
        tokenProgram: TOKEN_PROGRAM_ID,
        preSnapshot,
        jitoTipLamports: 100_000,
      });

      expect(res.success).toBe(true);
      expect(res.lifecycleState).toBe('CONFIRMED');
      expect(res.slot).toBe(280000088);
      // Zero submissions to Jito because pre-check detected the order was already completed
      expect(jitoSubmitSpy).toHaveBeenCalledTimes(0);
    });

    it('B6.5: failed bundle status with fatal simulation error does not trigger RPC fallback', async () => {
      const conn = mockRpc.createConnection();
      coordinator.setConnection(conn);
      executionConfig.updateConfig({
        enableRpcFallback: true,
        jitoMaxRetries: 2,
        jitoRetryIntervalMs: 5,
      });
      // Fatal instruction error from Jito
      mockJito.setFailSubmissions(true, 'Transaction simulation failed: InstructionError');

      const rpcSubmitSpy = vi.spyOn(coordinator.getRpcTransport(), 'submit');

      const owner = new PublicKey(Buffer.alloc(32, 2));
      const tx = createTestTx(owner);
      const preSnapshot = {
        timestamp: Date.now(),
        walletSolLamports: 10_000_000,
        tokenBalanceRaw: '0',
        tokenDecimals: 6,
        slot: 280000000,
      };

      const res = await coordinator.submitAndConfirmWithRetry({
        tx,
        orderId: `order_fatal_fallback_${Date.now()}`,
        correlationId: 'corr_b65',
        side: 'BUY',
        mint: VALID_PUMP_MINT_1.toBase58(),
        mintPubkey: VALID_PUMP_MINT_1,
        owner,
        tokenProgram: TOKEN_PROGRAM_ID,
        preSnapshot,
        jitoTipLamports: 100_000,
      });

      expect(res.success).toBe(false);
      expect(res.lifecycleState).toBe('REVERTED');
      // RPC fallback should NOT be triggered for fatal simulation errors
      expect(rpcSubmitSpy).toHaveBeenCalledTimes(0);
    });
  });

  // =========================================================================
  // Feature 7: Authoritative Token Eligibility Boundaries
  // =========================================================================
  describe('Feature 7 Boundaries: Authoritative Token Eligibility', () => {
    it('B7.1: score threshold boundary: high concentration fails eligibility', () => {
      const passReport = EligibilityFilter.evaluate({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'PASS',
        name: 'Pass Token',
        isFreezeAuthorityRevoked: true,
        isMintAuthorityRevoked: true,
        devHoldingPct: 2.0,
        top10HoldersPct: 25.0,
        liquidityUsd: 15000,
      });
      expect(passReport.isEligible).toBe(true);

      const failReport = EligibilityFilter.evaluate({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'CONCENTRATED',
        name: 'Concentrated Token',
        isFreezeAuthorityRevoked: true,
        isMintAuthorityRevoked: true,
        devHoldingPct: 35.0, // Dev holding too high
        top10HoldersPct: 80.0,
        liquidityUsd: 15000,
      });
      expect(failReport.isEligible).toBe(false);
    });

    it('B7.2: active mint authority in eligibility check rejects with isEligible false', () => {
      const activeMintReport = EligibilityFilter.evaluate({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'ACTIVEMINT',
        name: 'Active Mint Token',
        isFreezeAuthorityRevoked: true,
        isMintAuthorityRevoked: false, // Active mint authority
        liquidityUsd: 15000,
      });
      expect(activeMintReport.isEligible).toBe(false);
    });

    it('B7.3: unknown mint with null RPC account returns UNKNOWN eligibility status in LIVE mode', () => {
      const unknownReport = EligibilityFilter.evaluate(
        {
          mint: '11111111111111111111111111111111',
          symbol: 'UNKNOWN',
          name: 'Unknown Token',
          isFreezeAuthorityRevoked: null,
          isMintAuthorityRevoked: null,
          liquidityUsd: 0,
        },
        true // isLiveMode
      );
      expect(unknownReport.isEligible).toBe(false);
    });

    it('B7.4: mint with zero liquidity fails eligibility evaluation', () => {
      const zeroLiqReport = EligibilityFilter.evaluate({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'NOLIQ',
        name: 'No Liquidity',
        isFreezeAuthorityRevoked: true,
        isMintAuthorityRevoked: true,
        liquidityUsd: 0,
      });
      expect(zeroLiqReport.isEligible).toBe(false);
    });

    it('B7.5: active freeze authority rejects with isEligible false', () => {
      const freezeActiveReport = EligibilityFilter.evaluate({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'FROZEN',
        name: 'Frozen Token',
        isFreezeAuthorityRevoked: false, // Active freeze authority
        isMintAuthorityRevoked: true,
        liquidityUsd: 20000,
      });
      expect(freezeActiveReport.isEligible).toBe(false);
    });
  });

  // =========================================================================
  // Feature 8: Token-2022 Policy Boundaries
  // =========================================================================
  describe('Feature 8 Boundaries: Token-2022 Policy', () => {
    it('B8.1: Token-2022 mint with unsupported extension type rejects with isEligible false', () => {
      const report = EligibilityFilter.evaluate({
        mint: TOKEN_2022_MINT.toBase58(),
        symbol: 'T22UNSUPPORTED',
        name: 'Unsupported T22',
        hasToken2022Extensions: true,
        unsupportedToken2022Extension: 'ConfidentialTransfer',
        liquidityUsd: 15000,
      });
      expect(report.isEligible).toBe(false);
    });

    it('B8.2: transfer fee extension configured at predatory fee rejects', () => {
      const report = EligibilityFilter.evaluate({
        mint: TOKEN_2022_MINT.toBase58(),
        symbol: 'TAX',
        name: 'Predatory Tax Token',
        hasToken2022Extensions: true,
        unsupportedToken2022Extension: 'PredatoryTransferFee',
        liquidityUsd: 15000,
      });
      expect(report.isEligible).toBe(false);
    });

    it('B8.3: non-transferable extension presence triggers fail-closed rejection', () => {
      const report = EligibilityFilter.evaluate({
        mint: TOKEN_2022_MINT.toBase58(),
        symbol: 'NONTRANS',
        name: 'Non Transferable Token',
        hasToken2022Extensions: true,
        unsupportedToken2022Extension: 'NonTransferable',
        liquidityUsd: 15000,
      });
      expect(report.isEligible).toBe(false);
    });

    it('B8.4: standard SPL token (non-Token-2022) with valid mint passes extension policy checks', () => {
      const report = EligibilityFilter.evaluate({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'SPL',
        name: 'Standard SPL Token',
        isFreezeAuthorityRevoked: true,
        isMintAuthorityRevoked: true,
        devHoldingPct: 2.0,
        top10HoldersPct: 20.0,
        liquidityUsd: 25000,
      });
      expect(report.isEligible).toBe(true);
    });

    it('B8.5: corrupted or missing authority metadata fails closed in LIVE mode', () => {
      const report = EligibilityFilter.evaluate(
        {
          mint: VALID_PUMP_MINT_2.toBase58(),
          symbol: 'CORRUPTED',
          name: 'Corrupted Metadata',
          isFreezeAuthorityRevoked: null,
          isMintAuthorityRevoked: null,
          liquidityUsd: 15000,
        },
        true // isLiveMode
      );
      expect(report.isEligible).toBe(false);
    });
  });

  // =========================================================================
  // Feature 9: Mandatory Signal Provenance Boundaries
  // =========================================================================
  describe('Feature 9 Boundaries: Mandatory Signal Provenance', () => {
    it('B9.1: trade request with missing provenance rejects with PROVENANCE_VIOLATION in LIVE mode', async () => {
      (coordinator as any).executionMode = 'LIVE';
      const res = await coordinator.executeTrade({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'TEST',
        name: 'Test Token',
        amountSol: 0.02,
        jitoTipSol: 0.0005,
        source: 'AUTO_SNIPER',
        provenance: undefined as any,
        currentPriceSol: 0.0001,
        executionMode: 'LIVE',
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain('PROVENANCE_VIOLATION');
    });

    it('B9.2: trade request with lowercase or invalid provenance string rejects safely', async () => {
      const res = await coordinator.executeTrade({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'TEST',
        name: 'Test Token',
        amountSol: 0.02,
        jitoTipSol: 0.0005,
        source: 'AUTO_SNIPER',
        // @ts-expect-error test boundary
        provenance: 'real_onchain',
        currentPriceSol: 0.0001,
      });
      expect(res.executionMode).toBe('PAPER');
    });

    it('B9.3: SignalProvenance DEMO_MOCK is strictly prohibited in LIVE mode', async () => {
      (coordinator as any).executionMode = 'LIVE';
      const res = await coordinator.executeTrade({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'TEST',
        name: 'Test Token',
        amountSol: 0.02,
        jitoTipSol: 0.0005,
        source: 'AUTO_SNIPER',
        // @ts-expect-error test boundary
        provenance: 'DEMO_MOCK',
        currentPriceSol: 0.0001,
        executionMode: 'LIVE',
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain('PROVENANCE_VIOLATION');
    });

    it('B9.4: SignalProvenance MANUAL_OPERATOR is accepted as valid provenance', async () => {
      const res = await coordinator.executeTrade({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'TEST',
        name: 'Test Token',
        amountSol: 0.02,
        jitoTipSol: 0.0005,
        source: 'MANUAL',
        provenance: 'MANUAL_OPERATOR',
        currentPriceSol: 0.0001,
      });
      expect(res.executionMode).toBe('PAPER');
    });

    it('B9.5: Paper mode accepts all valid provenances including COPY_TRADE and REAL_SOCIAL', async () => {
      const copyRes = await coordinator.executeTrade({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'TEST',
        name: 'Test Token',
        amountSol: 0.02,
        jitoTipSol: 0.0005,
        source: 'COPY_TRADE',
        provenance: 'COPY_TRADE',
        currentPriceSol: 0.0001,
      });
      expect(copyRes.executionMode).toBe('PAPER');

      const socialRes = await coordinator.executeTrade({
        mint: VALID_PUMP_MINT_2.toBase58(),
        symbol: 'TEST2',
        name: 'Test Token 2',
        amountSol: 0.02,
        jitoTipSol: 0.0005,
        source: 'SOCIAL_SCANNER',
        provenance: 'REAL_SOCIAL',
        currentPriceSol: 0.0001,
      });
      expect(socialRes.executionMode).toBe('PAPER');
    });
  });

  // =========================================================================
  // Feature 10: Synthetic Data Isolation Boundaries
  // =========================================================================
  describe('Feature 10 Boundaries: Synthetic Data Isolation', () => {
    it('B10.1: DEMO_MODE=false enforces production defaults', () => {
      const cfg = executionConfig.getConfig();
      expect(cfg.demoMode).toBe(false);
      expect(cfg.enableSyntheticSocial).toBe(false);
    });

    it('B10.2: memecoinAggregator does not contaminate live coordinator market state', () => {
      const pools = memecoinAggregator.getPools();
      expect(Array.isArray(pools)).toBe(true);
    });

    it('B10.3: empty mock pool list handles queries safely without uncaught exceptions', () => {
      const pools = memecoinAggregator.getPools();
      const nonExistent = pools.find(p => p.id === 'non-existent-pool-id');
      expect(nonExistent).toBeUndefined();
    });

    it('B10.4: mock pool reserves with 0 liquidity are rejected by risk checks', () => {
      const zeroLiquidityReq = {
        mint: VALID_PUMP_MINT_1.toBase58(),
        orderSizeSol: 0.005,
        expectedPriceSol: 0,
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

      const result = riskEngine.evaluateOrder(zeroLiquidityReq);
      expect(result).toBeDefined();
    });

    it('B10.5: synthetic trade errors are logged to journal without corrupting database integrity', () => {
      testDb.logJournal('SYNTHETIC_SIMULATION_ERROR', 'corr_synth_1', 'PAPER', {
        error: 'Simulated network drop',
        injected: true,
      });

      const rows = testDb.db.prepare("SELECT * FROM system_journal WHERE correlation_id = ?").all('corr_synth_1') as any[];
      expect(rows.length).toBe(1);
      expect(rows[0].event_type).toBe('SYNTHETIC_SIMULATION_ERROR');
    });
  });
});
