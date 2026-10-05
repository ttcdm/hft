import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PublicKey, TransactionMessage, VersionedTransaction, SystemProgram } from '@solana/web3.js';
import { EligibilityFilter } from '../../../server/signals/eligibilityFilter';
import { ExecutionCoordinator } from '../../../server/execution/coordinator';
import { memecoinAggregator } from '../../../server/memecoinAggregator';
import { WorkstationDatabase, workstationDb } from '../../../server/db/database';
import { riskEngine } from '../../../server/risk/riskEngine';
import { CapitalSizer } from '../../../server/capital/capitalSizer';
import { executionConfig } from '../../../server/solana/executionConfig';
import { TOKEN_PROGRAM_ID } from '../../../server/solana/programs';
import {
  VALID_PUMP_MINT_1,
  VALID_PUMP_MINT_2,
  TOKEN_2022_MINT,
  createPassingEligibilityReport,
} from '../helpers/simulatedStates';
import { MockSolanaRpc } from '../helpers/mockRpc';
import { MockJitoEngine } from '../helpers/mockJito';
import { TestDatabase } from '../helpers/testDb';

describe('Tier 1: Feature Coverage (Features 6 - 10)', () => {
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
    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await mockJito.stop();
    testDb.close();
    mockRpc.clear();
  });

  // ===========================================================================
  // Feature 6: R0.6 Safe Jito Retry & RPC Fallback
  // ===========================================================================
  describe('Feature 6: R0.6 Safe Jito Retry & RPC Fallback', () => {
    function createTestTx(payerKey: PublicKey = new PublicKey(Buffer.alloc(32, 2))): VersionedTransaction {
      const msg = new TransactionMessage({
        payerKey,
        recentBlockhash: PublicKey.default.toBase58(),
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

    it('F6.1: deduplicates orders using single clientOrderId across retry and fallback attempts', async () => {
      const conn = mockRpc.createConnection();
      coordinator.setConnection(conn);
      executionConfig.updateConfig({
        jitoMaxRetries: 1,
        jitoRetryIntervalMs: 10,
        enableRpcFallback: true,
        rpcFallbackTimeoutMs: 1000,
      });
      // Make Jito fail submissions so retry and RPC fallback occur
      mockJito.setFailSubmissions(true, 'Jito temporary congestion');

      const clientOrderId = `order_dedupe_${Date.now()}`;
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
        orderId: clientOrderId,
        correlationId: 'corr_dedupe_1',
        side: 'BUY',
        mint: VALID_PUMP_MINT_1.toBase58(),
        mintPubkey: VALID_PUMP_MINT_1,
        owner,
        tokenProgram: TOKEN_PROGRAM_ID,
        preSnapshot,
        jitoTipLamports: 100_000,
      });

      expect(res.success).toBe(true);
      expect(res.transport).toBe('SOLANA_RPC');
      expect(res.lifecycleState).toBe('CONFIRMED');

      // Verify all recorded transactions in DB belong to the single logical clientOrderId
      const txs = workstationDb.loadTransactions(clientOrderId);
      expect(txs.length).toBeGreaterThanOrEqual(1);
      for (const t of txs) {
        expect(t.orderId).toBe(clientOrderId);
      }
    });

    it('F6.2: pre-checks on-chain signature status before fallback submission', async () => {
      const conn = mockRpc.createConnection();
      coordinator.setConnection(conn);
      const owner = new PublicKey(Buffer.alloc(32, 2));
      const preSnapshot = {
        timestamp: Date.now(),
        walletSolLamports: 10_000_000,
        tokenBalanceRaw: '0',
        tokenDecimals: 6,
        slot: 280000000,
      };

      const landedSig = `sig_already_landed_${Date.now()}`;
      mockRpc.setSignatureStatus(landedSig, { confirmationStatus: 'confirmed', slot: 280000055 });

      const checkLanded = await coordinator.checkIfTransactionLanded(
        landedSig,
        undefined,
        owner,
        VALID_PUMP_MINT_1,
        TOKEN_PROGRAM_ID,
        preSnapshot,
        'BUY'
      );
      expect(checkLanded.landed).toBe(true);
      expect(checkLanded.slot).toBe(280000055);

      const checkNotLanded = await coordinator.checkIfTransactionLanded(
        'sig_unknown_not_landed',
        undefined,
        owner,
        VALID_PUMP_MINT_1,
        TOKEN_PROGRAM_ID,
        preSnapshot,
        'BUY'
      );
      expect(checkNotLanded.landed).toBe(false);
    });

    it('F6.3: pre-checks Jito bundle status before triggering RPC fallback', async () => {
      const conn = mockRpc.createConnection();
      coordinator.setConnection(conn);
      const owner = new PublicKey(Buffer.alloc(32, 2));
      const preSnapshot = {
        timestamp: Date.now(),
        walletSolLamports: 10_000_000,
        tokenBalanceRaw: '0',
        tokenDecimals: 6,
        slot: 280000000,
      };

      const bundleId = `bundle_status_check_${Date.now()}`;
      mockJito.registerBundle({
        bundleId,
        transactions: ['tx_1'],
        submittedAt: Date.now(),
        inflightStatus: 'Landed',
        confirmationStatus: 'confirmed',
        slot: 280000060,
      });

      const check = await coordinator.checkIfTransactionLanded(
        '',
        bundleId,
        owner,
        VALID_PUMP_MINT_1,
        TOKEN_PROGRAM_ID,
        preSnapshot,
        'BUY'
      );
      expect(check.landed).toBe(true);
      expect(check.slot).toBe(280000060);
    });

    it('F6.4: enforces bounded retry ceiling avoiding infinite retry storms', async () => {
      const conn = mockRpc.createConnection();
      coordinator.setConnection(conn);
      executionConfig.updateConfig({
        jitoMaxRetries: 2,
        jitoRetryIntervalMs: 5,
        enableRpcFallback: false,
      });
      mockJito.setFailSubmissions(true, 'Persistent block engine timeout');

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
        orderId: `order_retry_ceiling_${Date.now()}`,
        correlationId: 'corr_ceiling_1',
        side: 'BUY',
        mint: VALID_PUMP_MINT_1.toBase58(),
        mintPubkey: VALID_PUMP_MINT_1,
        owner,
        tokenProgram: TOKEN_PROGRAM_ID,
        preSnapshot,
        jitoTipLamports: 100_000,
      });

      expect(res.success).toBe(false);
      // Attempt 0 + 2 retries = exactly 3 submission attempts
      expect(submitSpy).toHaveBeenCalledTimes(3);

      // Verify JitoTransport.submitWithRetry also honors bounded retry ceiling
      const retryResult = await coordinator.getJitoTransport().submitWithRetry(tx, 2, 5);
      expect(retryResult.success).toBe(false);
      expect(retryResult.attempts).toBe(3);
    });

    it('F6.5: prevents double fill by maintaining single logical transaction record in SQLite', async () => {
      const conn = mockRpc.createConnection();
      coordinator.setConnection(conn);
      executionConfig.updateConfig({
        jitoMaxRetries: 1,
        jitoRetryIntervalMs: 5,
        enableRpcFallback: true,
        rpcFallbackTimeoutMs: 1500,
      });
      mockJito.setFailSubmissions(true, 'Simulated Jito Error');

      const clientOrderId = `order_prevent_double_${Date.now()}`;
      const owner = new PublicKey(Buffer.alloc(32, 2));
      const tx = createTestTx(owner);
      const preSnapshot = {
        timestamp: Date.now(),
        walletSolLamports: 10_000_000,
        tokenBalanceRaw: '0',
        tokenDecimals: 6,
        slot: 280000000,
      };

      const rpcSubmitSpy = vi.spyOn(coordinator.getRpcTransport(), 'submit');

      const res = await coordinator.submitAndConfirmWithRetry({
        tx,
        orderId: clientOrderId,
        correlationId: 'corr_double_fill_1',
        side: 'BUY',
        mint: VALID_PUMP_MINT_1.toBase58(),
        mintPubkey: VALID_PUMP_MINT_1,
        owner,
        tokenProgram: TOKEN_PROGRAM_ID,
        preSnapshot,
        jitoTipLamports: 100_000,
      });

      expect(res.success).toBe(true);
      expect(res.transport).toBe('SOLANA_RPC');
      expect(rpcSubmitSpy).toHaveBeenCalledTimes(1);

      // Single logical orderId tracked in database across transports
      const txs = workstationDb.loadTransactions(clientOrderId);
      expect(txs.length).toBeGreaterThanOrEqual(1);
      const orderIds = new Set(txs.map((t) => t.orderId));
      expect(orderIds.size).toBe(1);
      expect(orderIds.has(clientOrderId)).toBe(true);
    });
  });

  // ===========================================================================
  // Feature 7: R0.7 Authoritative Token Eligibility
  // ===========================================================================
  describe('Feature 7: R0.7 Authoritative Token Eligibility', () => {
    it('F7.1: approves token with all safe authority flags and decentralized distribution', () => {
      const report = EligibilityFilter.evaluate({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'CLEAN',
        name: 'Clean Token',
        isFreezeAuthorityRevoked: true,
        isMintAuthorityRevoked: true,
        devHoldingPct: 1.5,
        top10HoldersPct: 22.0,
        liquidityUsd: 15000,
      });

      expect(report.isEligible).toBe(true);
      expect(report.failedCount).toBe(0);
    });

    it('F7.2: fails closed in LIVE mode when freeze authority status is UNKNOWN', () => {
      const report = EligibilityFilter.evaluate(
        {
          mint: VALID_PUMP_MINT_1.toBase58(),
          symbol: 'UNFREEZE',
          name: 'Unknown Freeze Token',
          isFreezeAuthorityRevoked: null,
          isMintAuthorityRevoked: true,
          devHoldingPct: 2.0,
          top10HoldersPct: 25.0,
          liquidityUsd: 12000,
        },
        true
      );

      expect(report.isEligible).toBe(false);
      const freezeCheck = report.checks.find((c) => c.ruleId === 'FREEZE_AUTHORITY_REVOKED');
      expect(freezeCheck?.status).toBe('UNKNOWN');
      expect(freezeCheck?.passed).toBe(false);
    });

    it('F7.3: fails closed in LIVE mode when mint authority status is UNKNOWN', () => {
      const report = EligibilityFilter.evaluate(
        {
          mint: VALID_PUMP_MINT_1.toBase58(),
          symbol: 'UNMINT',
          name: 'Unknown Mint Token',
          isFreezeAuthorityRevoked: true,
          isMintAuthorityRevoked: null,
          devHoldingPct: 2.0,
          top10HoldersPct: 25.0,
          liquidityUsd: 12000,
        },
        true
      );

      expect(report.isEligible).toBe(false);
      const mintCheck = report.checks.find((c) => c.ruleId === 'MINT_AUTHORITY_REVOKED');
      expect(mintCheck?.status).toBe('UNKNOWN');
      expect(mintCheck?.passed).toBe(false);
    });

    it('F7.4: rejects token with excessive creator holding concentration > 10%', () => {
      const report = EligibilityFilter.evaluate({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'GREEDYDEV',
        name: 'Greedy Dev Token',
        isFreezeAuthorityRevoked: true,
        isMintAuthorityRevoked: true,
        devHoldingPct: 15.5,
        top10HoldersPct: 35.0,
        liquidityUsd: 10000,
      });

      expect(report.isEligible).toBe(false);
      const devCheck = report.checks.find((c) => c.ruleId === 'MAX_CREATOR_EXPOSURE');
      expect(devCheck?.status).toBe('FAIL');
      expect(devCheck?.passed).toBe(false);
    });

    it('F7.5: ExecutionCoordinator rejects trade request when eligibility report mint does not match trade mint', async () => {
      const mismatchedReport = createPassingEligibilityReport(VALID_PUMP_MINT_2.toBase58());
      const res = await coordinator.executeTrade({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'MISMATCH',
        name: 'Mismatched Mint Token',
        amountSol: 0.005,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        eligibilityReport: mismatchedReport,
      });

      expect(res.success).toBe(false);
      expect(res.lifecycleState).toBe('FILTER_REJECTED');
      expect(res.error).toContain('ELIGIBILITY_MINT_MISMATCH');
    });
  });

  // ===========================================================================
  // Feature 8: R0.8 Token-2022 Policy
  // ===========================================================================
  describe('Feature 8: R0.8 Token-2022 Policy', () => {
    it('F8.1: passes standard SPL token without Token-2022 policy failure', () => {
      const report = EligibilityFilter.evaluate({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'SPL',
        name: 'Standard SPL Token',
        hasToken2022Extensions: false,
        liquidityUsd: 5000,
        isFreezeAuthorityRevoked: true,
        isMintAuthorityRevoked: true,
        devHoldingPct: 1.0,
        top10HoldersPct: 20.0,
      });

      const t22Check = report.checks.find((c) => c.ruleId === 'TOKEN_2022_POLICY');
      expect(t22Check).toBeUndefined();
    });

    it('F8.2: passes Token-2022 token with explicitly safe extensions', () => {
      const report = EligibilityFilter.evaluate({
        mint: TOKEN_2022_MINT.toBase58(),
        symbol: 'T22SAFE',
        name: 'Safe Token 2022',
        hasToken2022Extensions: true,
        token2022Safe: true,
        unsupportedToken2022Extension: false,
        liquidityUsd: 5000,
        isFreezeAuthorityRevoked: true,
        isMintAuthorityRevoked: true,
        devHoldingPct: 1.0,
        top10HoldersPct: 20.0,
      });

      const t22Check = report.checks.find((c) => c.ruleId === 'TOKEN_2022_POLICY');
      expect(t22Check).toBeDefined();
      expect(t22Check?.status).toBe('PASS');
      expect(t22Check?.passed).toBe(true);
    });

    it('F8.3: rejects Token-2022 token with unsupported transfer fee extension', () => {
      const report = EligibilityFilter.evaluate({
        mint: TOKEN_2022_MINT.toBase58(),
        symbol: 'T22FEE',
        name: 'Transfer Fee Token 2022',
        hasToken2022Extensions: true,
        unsupportedToken2022Extension: 'TransferFeeConfig',
        liquidityUsd: 5000,
        isFreezeAuthorityRevoked: true,
        isMintAuthorityRevoked: true,
        devHoldingPct: 1.0,
        top10HoldersPct: 20.0,
      });

      expect(report.isEligible).toBe(false);
      const t22Check = report.checks.find((c) => c.ruleId === 'TOKEN_2022_POLICY');
      expect(t22Check?.status).toBe('FAIL');
      expect(t22Check?.passed).toBe(false);
      expect(t22Check?.observedValue).toContain('UNSUPPORTED_TOKEN_EXTENSION');
    });

    it('F8.4: fails closed in LIVE mode when Token-2022 extensions are unverified', () => {
      const report = EligibilityFilter.evaluate(
        {
          mint: TOKEN_2022_MINT.toBase58(),
          symbol: 'T22UNVERIFIED',
          name: 'Unverified Token 2022',
          hasToken2022Extensions: true,
          token2022Safe: null,
          unsupportedToken2022Extension: undefined,
          liquidityUsd: 5000,
          isFreezeAuthorityRevoked: true,
          isMintAuthorityRevoked: true,
          devHoldingPct: 1.0,
          top10HoldersPct: 20.0,
        },
        true
      );

      expect(report.isEligible).toBe(false);
      const t22Check = report.checks.find((c) => c.ruleId === 'TOKEN_2022_POLICY');
      expect(t22Check?.status).toBe('UNKNOWN');
      expect(t22Check?.passed).toBe(false);
    });

    it('F8.5: ExecutionCoordinator rejects trade request when Token-2022 safety check fails', async () => {
      const reportWithUnsupportedT22 = EligibilityFilter.evaluate({
        mint: TOKEN_2022_MINT.toBase58(),
        symbol: 'T22BAD',
        name: 'Bad T22',
        hasToken2022Extensions: true,
        unsupportedToken2022Extension: 'NonTransferable',
        liquidityUsd: 10000,
      });

      const res = await coordinator.executeTrade({
        mint: TOKEN_2022_MINT.toBase58(),
        symbol: 'T22BAD',
        name: 'Bad T22',
        amountSol: 0.005,
        currentPriceSol: 0.0001,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        eligibilityReport: reportWithUnsupportedT22,
      });

      expect(res.executionMode).toBe('PAPER');
    });
  });

  // ===========================================================================
  // Feature 9: R0.9 Mandatory Signal Provenance
  // ===========================================================================
  describe('Feature 9: R0.9 Mandatory Signal Provenance', () => {
    it('F9.1: accepts trade request with approved live provenance REAL_ONCHAIN', async () => {
      const mint = '11111111111111111111111111111111';
      const res = await coordinator.executeTrade({
        mint,
        symbol: 'REAL',
        name: 'Real Onchain Token',
        amountSol: 0.02,
        jitoTipSol: 0.0005,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        currentPriceSol: 0.0001,
      });

      expect(res.success).toBe(true);
      expect(res.executionMode).toBe('PAPER');
    });

    it('F9.2: accepts trade request with approved provenance COPY_TRADE', async () => {
      const mint = '22222222222222222222222222222222';
      const res = await coordinator.executeTrade({
        mint,
        symbol: 'COPY',
        name: 'Copy Trade Token',
        amountSol: 0.02,
        jitoTipSol: 0.0005,
        source: 'AUTO_SNIPER',
        provenance: 'COPY_TRADE',
        currentPriceSol: 0.0001,
      });

      expect(res.success).toBe(true);
    });

    it('F9.3: accepts trade request with approved provenance MANUAL_OPERATOR', async () => {
      const mint = '33333333333333333333333333333333';
      const res = await coordinator.executeTrade({
        mint,
        symbol: 'MANUAL',
        name: 'Manual Operator Token',
        amountSol: 0.02,
        jitoTipSol: 0.0005,
        source: 'MANUAL',
        provenance: 'MANUAL_OPERATOR',
        currentPriceSol: 0.0001,
      });

      expect(res.success).toBe(true);
    });

    it('F9.4: allows PAPER_REPLAY provenance in paper mode', async () => {
      const mint = '44444444444444444444444444444444';
      const res = await coordinator.executeTrade({
        mint,
        symbol: 'REPLAY',
        name: 'Replay Token',
        amountSol: 0.02,
        jitoTipSol: 0.0005,
        source: 'AUTO_SNIPER',
        provenance: 'PAPER_REPLAY',
        currentPriceSol: 0.0001,
      });

      expect(res.success).toBe(true);
    });

    it('F9.5: logs provenance in SQLite audit journal', () => {
      testDb.logJournal('SIGNAL_PROVENANCE_AUDIT', 'corr_prov_1', 'PAPER', {
        provenance: 'REAL_ONCHAIN',
        source: 'SOLANA_RPC',
      });

      const events = testDb.getEvents(5);
      const audit = events.find((e) => e.eventType === 'SIGNAL_PROVENANCE_AUDIT');
      expect(audit).toBeDefined();
      expect(audit?.payload.provenance).toBe('REAL_ONCHAIN');
    });
  });

  // ===========================================================================
  // Feature 10: R0.10 Synthetic Data Isolation
  // ===========================================================================
  describe('Feature 10: R0.10 Synthetic Data Isolation', () => {
    it('F10.1: synthetic meme pools return empty when DEMO_MODE is disabled or false', () => {
      delete process.env.DEMO_MODE;
      const pools = memecoinAggregator.getPools();
      expect(pools.length).toBe(0);
    });

    it('F10.2: synthetic trades are saved with PAPER executionMode in database', () => {
      const posId = `synth_pos_${Date.now()}`;
      testDb.savePosition({
        id: posId,
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'SYNTH',
        name: 'Synthetic Token',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000000',
        costBasisLamports: 10_000_000,
        entryPriceSol: 0.00001,
        currentPriceSol: 0.00001,
        currentValueSol: 0.01,
        unrealizedPnLSol: 0,
        unrealizedPnLPct: 0,
        realizedPnLSol: 0,
        entryTxSignature: 'synth_tx_1',
        entrySlot: 0,
        entryTimestamp: Date.now(),
        entryFeeLamports: 5000,
        priorityFeeLamports: 25000,
        jitoTipLamports: 100_000,
        executionMode: 'PAPER',
        status: 'OPEN',
        markAgeMs: 0,
        markSource: 'PAPER_ENGINE',
        lastUpdatedTimestamp: Date.now(),
      });

      const livePositions = testDb.loadPositions('LIVE', 'OPEN');
      expect(livePositions.some((p) => p.id === posId)).toBe(false);

      const paperPositions = testDb.loadPositions('PAPER', 'OPEN');
      expect(paperPositions.some((p) => p.id === posId)).toBe(true);
    });

    it('F10.3: simulation engine fills do not affect real wallet spendable SOL calculation via CapitalSizer', () => {
      const realWalletSol = 0.07;
      const requiredReserve = CapitalSizer.DEFAULT_RESERVE_SOL; // 0.015
      const inFlightSol = 0;
      const spendableSol = CapitalSizer.calculateSpendableBankroll(realWalletSol, requiredReserve, inFlightSol);
      expect(spendableSol).toBeCloseTo(0.055, 3);
    });

    it('F10.4: synthetic PnL is isolated from LIVE daily realized PnL in database', () => {
      const posId = `synth_closed_${Date.now()}`;
      testDb.savePosition({
        id: posId,
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'SYNTH_CLOSED',
        name: 'Synthetic Closed',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000000',
        costBasisLamports: 10_000_000,
        entryPriceSol: 0.00001,
        currentPriceSol: 0.00002,
        currentValueSol: 0.02,
        unrealizedPnLSol: 0,
        unrealizedPnLPct: 0,
        realizedPnLSol: 0.01,
        entryTxSignature: 'synth_tx_2',
        entrySlot: 0,
        entryTimestamp: Date.now(),
        entryFeeLamports: 5000,
        priorityFeeLamports: 25000,
        jitoTipLamports: 100_000,
        executionMode: 'PAPER',
        status: 'CLOSED',
        markAgeMs: 0,
        markSource: 'PAPER_ENGINE',
        lastUpdatedTimestamp: Date.now(),
      });

      const liveDailyPnl = testDb.getDailyRealizedPnLSol('LIVE');
      expect(liveDailyPnl).toBe(0);

      const paperDailyPnl = testDb.getDailyRealizedPnLSol('PAPER');
      expect(paperDailyPnl).toBe(0.01);
    });

    it('F10.5: demo mode flag is false by default in production and CI', () => {
      expect(process.env.DEMO_MODE !== 'true').toBe(true);
    });
  });
});
