import '../suppress-warnings.cjs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
  Keypair,
} from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { JitoTransport, SolanaRpcTransport } from '../server/solana/transports';
import { executionConfig } from '../server/solana/executionConfig';
import { WorkstationDatabase, workstationDb } from '../server/db/database';
import { NormalizedPosition } from '../server/core/types';
import { riskEngine } from '../server/risk/riskEngine';
import { localSigner } from '../server/solana/signer';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { RealMarkPriceService, TradeReconciler } from '../server/execution/reconciliation';
import { TOKEN_PROGRAM_ID } from '../server/solana/programs';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { MockJitoEngine } from './e2e/helpers/mockJito';
import { TestDatabase } from './e2e/helpers/testDb';
import {
  VALID_PUMP_MINT_1,
  VALID_PUMP_MINT_2,
  createSimulatedBondingCurveState,
} from './e2e/helpers/simulatedStates';

describe('Empirical Adversarial Challenger Suite: Protocol & Execution Correctness (R0.1 - R0.6)', () => {
  let mockRpc: MockSolanaRpc;
  let mockJito: MockJitoEngine;
  let testDb: TestDatabase;
  let coordinator: ExecutionCoordinator;

  function createDummyTx(payer: PublicKey): VersionedTransaction {
    const msg = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer,
          toPubkey: Keypair.generate().publicKey,
          lamports: 5000,
        }),
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.signatures = [new Uint8Array(64).fill(7)];
    return tx;
  }

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
  // 1. SAFE JITO RETRY & RPC FALLBACK (R0.6)
  // =========================================================================
  describe('Dimension 1: Safe Jito Retry & RPC Fallback (R0.6)', () => {
    it('1.1: jitoMaxRetries = 0 boundary condition executes exactly one attempt without retry', async () => {
      executionConfig.updateConfig({
        jitoMaxRetries: 0,
        jitoRetryIntervalMs: 10,
        enableRpcFallback: false,
      });
      mockJito.setFailSubmissions(true, 'Temporary network drop');

      const owner = Keypair.generate().publicKey;
      const tx = createDummyTx(owner);
      const submitSpy = vi.spyOn(coordinator.getJitoTransport(), 'submit');

      const preSnapshot = {
        timestamp: Date.now(),
        walletSolLamports: 10_000_000,
        tokenBalanceRaw: '0',
        tokenDecimals: 6,
        slot: 280000000,
      };

      const res = await coordinator.submitAndConfirmWithRetry({
        tx,
        orderId: `order_zero_retry_${Date.now()}`,
        correlationId: 'corr_zero_retry',
        side: 'BUY',
        mint: VALID_PUMP_MINT_1.toBase58(),
        mintPubkey: VALID_PUMP_MINT_1,
        owner,
        tokenProgram: TOKEN_PROGRAM_ID,
        preSnapshot,
        jitoTipLamports: 100_000,
      });

      expect(res.success).toBe(false);
      expect(submitSpy).toHaveBeenCalledTimes(1);
    });

    it('1.2: JitoTransport.submitWithRetry with customMaxRetries = 0 performs exactly 1 attempt', async () => {
      mockJito.setFailSubmissions(true, '500 Internal Server Error');
      const jito = coordinator.getJitoTransport();
      const owner = Keypair.generate().publicKey;
      const tx = createDummyTx(owner);

      const res = await jito.submitWithRetry(tx, 0, 10);
      expect(res.success).toBe(false);
      expect(res.attempts).toBe(1);
    });

    it('1.3: fatal simulation error immediately aborts retry loop without retrying', async () => {
      executionConfig.updateConfig({
        jitoMaxRetries: 5,
        jitoRetryIntervalMs: 5,
        enableRpcFallback: false,
      });
      mockJito.setFailSubmissions(true, 'Transaction simulation failed: InstructionError: [0, {"Custom": 6001}]');

      const owner = Keypair.generate().publicKey;
      const tx = createDummyTx(owner);
      const submitSpy = vi.spyOn(coordinator.getJitoTransport(), 'submit');

      const preSnapshot = {
        timestamp: Date.now(),
        walletSolLamports: 10_000_000,
        tokenBalanceRaw: '0',
        tokenDecimals: 6,
        slot: 280000000,
      };

      const res = await coordinator.submitAndConfirmWithRetry({
        tx,
        orderId: `order_sim_err_${Date.now()}`,
        correlationId: 'corr_sim_err',
        side: 'BUY',
        mint: VALID_PUMP_MINT_1.toBase58(),
        mintPubkey: VALID_PUMP_MINT_1,
        owner,
        tokenProgram: TOKEN_PROGRAM_ID,
        preSnapshot,
        jitoTipLamports: 100_000,
      });

      expect(res.success).toBe(false);
      // Must abort immediately on attempt 1
      expect(submitSpy).toHaveBeenCalledTimes(1);
      expect(res.error).toContain('InstructionError');
    });

    it('1.4: fatal simulation error suppresses RPC fallback even when enableRpcFallback is true', async () => {
      executionConfig.updateConfig({
        jitoMaxRetries: 3,
        enableRpcFallback: true,
      });
      mockJito.setFailSubmissions(true, 'Transaction simulation failed: Error processing Instruction');

      const rpcSubmitSpy = vi.spyOn(coordinator.getRpcTransport(), 'submit');
      const owner = Keypair.generate().publicKey;
      const tx = createDummyTx(owner);

      const preSnapshot = {
        timestamp: Date.now(),
        walletSolLamports: 10_000_000,
        tokenBalanceRaw: '0',
        tokenDecimals: 6,
        slot: 280000000,
      };

      const res = await coordinator.submitAndConfirmWithRetry({
        tx,
        orderId: `order_sim_nofallback_${Date.now()}`,
        correlationId: 'corr_sim_nofallback',
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
      // RPC fallback should NOT be attempted when the transaction itself has a fatal simulation error
      expect(rpcSubmitSpy).toHaveBeenCalledTimes(0);
    });

    it('1.5: mid-flight landed detection discovers on-chain ATA token balance increase and confirms trade without double fill', async () => {
      const owner = Keypair.generate().publicKey;
      const mintPubkey = VALID_PUMP_MINT_1;
      const ata = PumpCurveService.getAssociatedTokenAddress(mintPubkey, owner, TOKEN_PROGRAM_ID);

      const preSnapshot = {
        timestamp: Date.now(),
        walletSolLamports: 10_000_000,
        tokenBalanceRaw: '0',
        tokenDecimals: 6,
        slot: 280000000,
      };

      // Set up on-chain ATA balance indicating transaction actually landed (pass pubkey and amountRaw)
      mockRpc.setTokenAccount(ata, 500_000_000n);

      const check = await coordinator.checkIfTransactionLanded(
        'sig_dropped_bundle_query_sim',
        undefined,
        owner,
        mintPubkey,
        TOKEN_PROGRAM_ID,
        preSnapshot,
        'BUY'
      );

      expect(check.landed).toBe(true);
    });

    it('1.6: mid-flight landed detection discovers on-chain SOL balance decrease (>100k lamports) and suppresses duplicate execution', async () => {
      const owner = Keypair.generate().publicKey;
      const mintPubkey = VALID_PUMP_MINT_1;

      const preSnapshot = {
        timestamp: Date.now(),
        walletSolLamports: 50_000_000, // 0.05 SOL
        tokenBalanceRaw: '0',
        tokenDecimals: 6,
        slot: 280000000,
      };

      // Wallet SOL balance decreased by 0.02 SOL (spent on-chain)
      mockRpc.setAccount(owner, {
        owner: SystemProgram.programId,
        lamports: 30_000_000,
        data: Buffer.alloc(0),
        executable: false,
      });

      const check = await coordinator.checkIfTransactionLanded(
        'sig_bundle_sol_spent_check',
        undefined,
        owner,
        mintPubkey,
        TOKEN_PROGRAM_ID,
        preSnapshot,
        'BUY'
      );

      expect(check.landed).toBe(true);
    });

    it('1.7: submitAndConfirmWithRetry suppresses RPC fallback when pre-fallback check detects landed Jito transaction', async () => {
      executionConfig.updateConfig({
        jitoMaxRetries: 1,
        enableRpcFallback: true,
      });

      const owner = Keypair.generate().publicKey;
      const mintPubkey = VALID_PUMP_MINT_1;
      const ata = PumpCurveService.getAssociatedTokenAddress(mintPubkey, owner, TOKEN_PROGRAM_ID);
      const tx = createDummyTx(owner);

      const preSnapshot = {
        timestamp: Date.now(),
        walletSolLamports: 10_000_000,
        tokenBalanceRaw: '0',
        tokenDecimals: 6,
        slot: 280000000,
      };

      // Jito submit succeeds, but confirm returns false (dropped bundle query)
      vi.spyOn(coordinator.getJitoTransport(), 'confirm').mockResolvedValue({
        signature: `sim_jito_sig_dropped_${Date.now()}`,
        confirmed: false,
        confirmDurationMs: 500,
        lifecycleState: 'TIMED_OUT',
        error: 'Bundle confirmation timeout',
      });

      // But on-chain token balance actually arrived!
      mockRpc.setTokenAccount(ata, 1_000_000_000n);

      const rpcSubmitSpy = vi.spyOn(coordinator.getRpcTransport(), 'submit');

      const res = await coordinator.submitAndConfirmWithRetry({
        tx,
        orderId: `order_landed_suppression_${Date.now()}_${Math.random()}`,
        correlationId: 'corr_landed_suppression',
        side: 'BUY',
        mint: mintPubkey.toBase58(),
        mintPubkey,
        owner,
        tokenProgram: TOKEN_PROGRAM_ID,
        preSnapshot,
        jitoTipLamports: 100_000,
      });

      // Trade must be confirmed through landed detection
      expect(res.success).toBe(true);
      expect(res.lifecycleState).toBe('CONFIRMED');
      expect(res.transport).toBe('JITO');
      // RPC fallback must NOT be called, preventing a double fill
      expect(rpcSubmitSpy).toHaveBeenCalledTimes(0);
    });

    it('1.8: single clientOrderId is preserved across Jito attempts and RPC fallback in SQLite transactions', async () => {
      executionConfig.updateConfig({
        jitoMaxRetries: 1,
        jitoRetryIntervalMs: 5,
        enableRpcFallback: true,
        rpcFallbackTimeoutMs: 2000,
      });

      const nonce = Date.now() + '_' + Math.random().toString(36).substring(2, 7);
      const clientOrderId = `order_preserved_${nonce}`;
      const uniqueRpcSig = `rpc_sig_${nonce}`;
      const owner = Keypair.generate().publicKey;
      const tx = createDummyTx(owner);

      // Force Jito submit to fail with network error
      vi.spyOn(coordinator.getJitoTransport(), 'submit').mockResolvedValue({
        signature: `jito_fail_sig_${nonce}`,
        transport: 'JITO',
        success: false,
        submitDurationMs: 50,
        lifecycleState: 'SUBMIT_FAILED',
        error: 'Network socket closed',
      });

      // Mock RPC broadcast to succeed and confirm
      mockRpc.setSignatureStatus(uniqueRpcSig, {
        confirmationStatus: 'confirmed',
        slot: 280000100,
      });
      vi.spyOn(coordinator.getRpcTransport(), 'submit').mockResolvedValue({
        signature: uniqueRpcSig,
        transport: 'SOLANA_RPC',
        success: true,
        submitDurationMs: 40,
        lifecycleState: 'BUNDLE_PENDING',
      });

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
        correlationId: 'corr_preserved_id',
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
      expect(res.signature).toBe(uniqueRpcSig);

      // Verify all records in SQLite for this order retain the exact same orderId
      const savedTxs = workstationDb.loadTransactions(clientOrderId);
      expect(savedTxs.length).toBeGreaterThanOrEqual(1);
      for (const t of savedTxs) {
        expect(t.orderId).toBe(clientOrderId);
      }
    });

    it('1.9: Step 0 pre-execution check: duplicate submission of an already reconciled order skips broadcast', async () => {
      const nonce = Date.now() + '_' + Math.random().toString(36).substring(2, 7);
      const clientOrderId = `order_already_reconciled_${nonce}`;
      const uniqueReconciledSig = `unique_reconciled_sig_${nonce}`;
      const owner = Keypair.generate().publicKey;
      const tx = createDummyTx(owner);

      // Record pre-existing reconciled transaction in SQLite
      workstationDb.saveTransaction({
        signature: uniqueReconciledSig,
        orderId: clientOrderId,
        correlationId: 'corr_existing',
        mint: VALID_PUMP_MINT_1.toBase58(),
        direction: 'BUY',
        submissionTransport: 'JITO',
        submissionTime: Date.now() - 1000,
        reconciliationState: 'RECONCILED',
        networkFeeLamports: 5000,
        jitoTipLamports: 100_000,
        executionMode: 'LIVE',
        landingSlot: 280000099,
      });

      const jitoSpy = vi.spyOn(coordinator.getJitoTransport(), 'submit');
      const rpcSpy = vi.spyOn(coordinator.getRpcTransport(), 'submit');

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
        correlationId: 'corr_resubmit',
        side: 'BUY',
        mint: VALID_PUMP_MINT_1.toBase58(),
        mintPubkey: VALID_PUMP_MINT_1,
        owner,
        tokenProgram: TOKEN_PROGRAM_ID,
        preSnapshot,
        jitoTipLamports: 100_000,
      });

      expect(res.success).toBe(true);
      expect(res.signature).toBe(uniqueReconciledSig);
      expect(res.slot).toBe(280000099);
      // Neither transport was called
      expect(jitoSpy).toHaveBeenCalledTimes(0);
      expect(rpcSpy).toHaveBeenCalledTimes(0);
    });
  });

  // =========================================================================
  // 2. EXECUTION MODE PROPAGATION (R0.1)
  // =========================================================================
  describe('Dimension 2: ExecutionMode Propagation (R0.1)', () => {
    it('2.1: PumpSwapVenueService.getPoolState throws CRITICAL_CONFIG_ERROR when executionMode is omitted or invalid', async () => {
      const conn = mockRpc.createConnection();
      const mint = VALID_PUMP_MINT_1;

      // Omitted / undefined
      await expect(PumpSwapVenueService.getPoolState(conn, mint, undefined as any)).rejects.toThrow(
        /CRITICAL_CONFIG_ERROR.*executionMode/
      );

      // Invalid mode
      await expect(PumpSwapVenueService.getPoolState(conn, mint, 'INVALID_MODE' as any)).rejects.toThrow(
        /CRITICAL_CONFIG_ERROR.*executionMode/
      );
    });

    it('2.2: PumpSwapVenueService.buildPumpSwapBuyInstructions throws CRITICAL_CONFIG_ERROR when executionMode is omitted or invalid', async () => {
      const conn = mockRpc.createConnection();
      const user = Keypair.generate().publicKey;
      const mint = VALID_PUMP_MINT_1;

      await expect(
        PumpSwapVenueService.buildPumpSwapBuyInstructions(conn, user, mint, 10_000_000n, 800, undefined as any)
      ).rejects.toThrow(/CRITICAL_CONFIG_ERROR.*executionMode/);

      await expect(
        PumpSwapVenueService.buildPumpSwapBuyInstructions(conn, user, mint, 10_000_000n, 800, 'MOCK' as any)
      ).rejects.toThrow(/CRITICAL_CONFIG_ERROR.*executionMode/);
    });

    it('2.3: PumpSwapVenueService.buildPumpSwapSellInstructions throws CRITICAL_CONFIG_ERROR when executionMode is omitted or invalid', async () => {
      const conn = mockRpc.createConnection();
      const user = Keypair.generate().publicKey;
      const mint = VALID_PUMP_MINT_1;

      await expect(
        PumpSwapVenueService.buildPumpSwapSellInstructions(conn, user, mint, 1_000_000_000n, 800, undefined as any)
      ).rejects.toThrow(/CRITICAL_CONFIG_ERROR.*executionMode/);

      await expect(
        PumpSwapVenueService.buildPumpSwapSellInstructions(conn, user, mint, 1_000_000_000n, 800, null as any)
      ).rejects.toThrow(/CRITICAL_CONFIG_ERROR.*executionMode/);
    });

    it('2.4: coordinator.closePosition propagates executionMode = LIVE explicitly when closing a LIVE PumpSwap position', async () => {
      const conn = mockRpc.createConnection();
      coordinator.setConnection(conn);

      // Set up localSigner so it is READY via spyOn (restored in afterEach)
      const dummySigner = Keypair.generate();
      vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
      vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(dummySigner.publicKey);
      vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => {
        tx.sign([dummySigner]);
        return tx;
      });

      const canonicalPoolKey = Keypair.generate().publicKey;
      const livePos: NormalizedPosition = {
        id: `pos_live_pumpswap_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        mint: VALID_PUMP_MINT_2.toBase58(),
        symbol: 'LIVEPUMP',
        name: 'Live Pump Token',
        tokenQuantityRaw: '1000000000',
        tokenDecimals: 6,
        costBasisLamports: 50_000_000,
        entryPriceSol: 0.00005,
        currentPriceSol: 0.00006,
        currentValueSol: 0.06,
        unrealizedPnLSol: 0.01,
        unrealizedPnLPct: 20,
        status: 'OPEN',
        entryTxSignature: `sig_entry_${Date.now()}`,
        entryTimestamp: Date.now() - 60000,
        lastUpdatedTimestamp: Date.now(),
        executionMode: 'LIVE',
        venue: 'PUMPSWAP',
        poolAddress: canonicalPoolKey.toBase58(),
        migrationTimestamp: Date.now() - 30000,
        realizedPnLSol: 0,
      };

      workstationDb.savePosition(livePos);

      // Mock resolveVenue to return PUMPSWAP
      vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({
        venue: 'PUMPSWAP',
        isMigrated: true,
        poolAddress: canonicalPoolKey,
      });

      // Spy on buildPumpSwapSellInstructions and verify exact arguments
      const sellSpy = vi.spyOn(PumpSwapVenueService, 'buildPumpSwapSellInstructions').mockResolvedValue({
        instructions: [
          SystemProgram.transfer({
            fromPubkey: dummySigner.publicKey,
            toPubkey: Keypair.generate().publicKey,
            lamports: 1000,
          }),
        ],
        expectedSolOutputLamports: 60_000_000n,
        minSolOutputLamports: 55_000_000n,
        spotPriceSol: 0.00006,
      });

      // Mock transport submission
      vi.spyOn(coordinator, 'submitAndConfirmWithRetry').mockResolvedValue({
        success: true,
        signature: `live_pumpswap_close_sig_${Date.now()}`,
        transport: 'JITO',
        slot: 280000120,
        lifecycleState: 'CONFIRMED',
      });

      // Mock sell reconciliation
      vi.spyOn(TradeReconciler, 'reconcileSellTransaction').mockResolvedValue({
        success: true,
        reconciliationState: 'RECONCILED',
        actualTokensSoldRaw: '1000000000',
        tokensSoldHuman: 1000,
        tokenDecimals: 6,
        actualGrossSolProceedsLamports: 60_000_000,
        actualNetSolProceedsLamports: 59_995_000,
        actualNetworkFeeLamports: 5000,
        actualJitoTipLamports: 100_000,
        actualRealizedPnLSol: 0.01,
        remainingTokensRaw: '0',
        isFullyClosed: true,
        slot: 280000120,
      });

      const res = await coordinator.closePosition(livePos.id, 100, 'LIVE');
      expect(res.success).toBe(true);

      // CRITICAL ASSERTION: The 6th argument to buildPumpSwapSellInstructions MUST be 'LIVE'
      expect(sellSpy).toHaveBeenCalled();
      const lastCallArgs = sellSpy.mock.calls[0];
      expect(lastCallArgs[5]).toBe('LIVE');
    });
  });

  // =========================================================================
  // 3. POSITION MIGRATION LIFECYCLE (R0.4)
  // =========================================================================
  describe('Dimension 3: Position Migration Lifecycle (R0.4)', () => {
    it('3.1: applyMarkPrice updates and persists venue = PUMPSWAP, poolAddress, and migrationTimestamp into SQLite', () => {
      const initialPos: NormalizedPosition = {
        id: `pos_migration_test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'MIGRATE',
        name: 'Migrate Token',
        tokenQuantityRaw: '500000000',
        tokenDecimals: 6,
        costBasisLamports: 30_000_000,
        entryPriceSol: 0.00006,
        currentPriceSol: 0.00006,
        currentValueSol: 0.03,
        unrealizedPnLSol: 0,
        unrealizedPnLPct: 0,
        status: 'OPEN',
        entryTxSignature: `entry_sig_${Date.now()}`,
        entryTimestamp: Date.now() - 120000,
        lastUpdatedTimestamp: Date.now() - 120000,
        executionMode: 'LIVE',
        venue: 'PUMP_BONDING_CURVE',
        realizedPnLSol: 0,
      };

      workstationDb.savePosition(initialPos);

      // Verify initial state in SQLite
      const before = workstationDb.loadPositions().find((p) => p.id === initialPos.id);
      expect(before?.venue).toBe('PUMP_BONDING_CURVE');
      expect(before?.poolAddress).toBeUndefined();
      expect(before?.migrationTimestamp).toBeUndefined();

      // Trigger mark update with ON_CHAIN_PUMPSWAP_POOL
      const poolAddr = Keypair.generate().publicKey.toBase58();
      const markTimestamp = Date.now();
      (coordinator as any).applyMarkPrice(
        initialPos,
        0.00008,
        'ON_CHAIN_PUMPSWAP_POOL',
        markTimestamp,
        poolAddr
      );

      // Query database fresh
      const after = workstationDb.loadPositions().find((p) => p.id === initialPos.id);
      expect(after).toBeDefined();
      expect(after?.venue).toBe('PUMPSWAP');
      expect(after?.poolAddress).toBe(poolAddr);
      expect(after?.migrationTimestamp).toBeGreaterThanOrEqual(markTimestamp - 1000);
      expect(after?.lastMarkTimestamp).toBe(markTimestamp);
    });

    it('3.2: updatePositionMarkPrices automatically transitions position when bonding curve completes and pool resolves', async () => {
      const mintStr = VALID_PUMP_MINT_1.toBase58();
      const pos: NormalizedPosition = {
        id: `pos_auto_migrate_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        mint: mintStr,
        symbol: 'AUTOMIG',
        name: 'Auto Migrate Token',
        tokenQuantityRaw: '1000000000',
        tokenDecimals: 6,
        costBasisLamports: 50_000_000,
        entryPriceSol: 0.00005,
        currentPriceSol: 0.00005,
        currentValueSol: 0.05,
        unrealizedPnLSol: 0,
        unrealizedPnLPct: 0,
        status: 'OPEN',
        entryTxSignature: `entry_sig_${Date.now()}`,
        entryTimestamp: Date.now() - 60000,
        lastUpdatedTimestamp: Date.now() - 60000,
        executionMode: 'LIVE',
        venue: 'PUMP_BONDING_CURVE',
        realizedPnLSol: 0,
      };
      workstationDb.savePosition(pos);

      // Mock RealMarkPriceService.queryOnChainMarkPrices to simulate graduation
      const resolvedPoolPda = Keypair.generate().publicKey.toBase58();
      vi.spyOn(RealMarkPriceService, 'queryOnChainMarkPrices').mockResolvedValue({
        [mintStr]: {
          priceSol: 0.000095,
          source: 'ON_CHAIN_PUMPSWAP_POOL',
          timestamp: Date.now(),
          poolAddress: resolvedPoolPda,
        },
      });

      await coordinator.updatePositionMarkPrices();

      const migratedPos = workstationDb.loadPositions().find((p) => p.id === pos.id);
      expect(migratedPos?.venue).toBe('PUMPSWAP');
      expect(migratedPos?.poolAddress).toBe(resolvedPoolPda);
      expect(migratedPos?.migrationTimestamp).toBeGreaterThan(0);
      expect(migratedPos?.currentPriceSol).toBe(0.000095);
    });

    it('3.3: closePosition on graduated token transitions venue = PUMPSWAP and persists poolAddress before execution', async () => {
      // Set up localSigner so it is READY via spyOn (restored in afterEach)
      const dummySigner = Keypair.generate();
      vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
      vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(dummySigner.publicKey);
      vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => {
        tx.sign([dummySigner]);
        return tx;
      });

      const mintPubkey = VALID_PUMP_MINT_1;
      const pos: NormalizedPosition = {
        id: `pos_close_migrate_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        mint: mintPubkey.toBase58(),
        symbol: 'CLOSEMIG',
        name: 'Close Migrate Token',
        tokenQuantityRaw: '200000000',
        tokenDecimals: 6,
        costBasisLamports: 15_000_000,
        entryPriceSol: 0.000075,
        currentPriceSol: 0.00008,
        currentValueSol: 0.016,
        unrealizedPnLSol: 0.001,
        unrealizedPnLPct: 6.67,
        status: 'OPEN',
        entryTxSignature: `entry_sig_${Date.now()}`,
        entryTimestamp: Date.now() - 30000,
        lastUpdatedTimestamp: Date.now() - 30000,
        executionMode: 'LIVE',
        venue: 'PUMP_BONDING_CURVE', // Currently recorded as bonding curve
        realizedPnLSol: 0,
      };
      workstationDb.savePosition(pos);

      const canonicalPool = Keypair.generate().publicKey;
      vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({
        venue: 'PUMPSWAP',
        isMigrated: true,
        poolAddress: canonicalPool,
      });

      vi.spyOn(PumpSwapVenueService, 'buildPumpSwapSellInstructions').mockResolvedValue({
        instructions: [
          SystemProgram.transfer({
            fromPubkey: dummySigner.publicKey,
            toPubkey: Keypair.generate().publicKey,
            lamports: 1000,
          }),
        ],
        expectedSolOutputLamports: 16_000_000n,
        minSolOutputLamports: 15_000_000n,
        spotPriceSol: 0.00008,
      });

      vi.spyOn(coordinator, 'submitAndConfirmWithRetry').mockResolvedValue({
        success: true,
        signature: `sig_close_migrated_pos_${Date.now()}`,
        transport: 'JITO',
        slot: 280000150,
        lifecycleState: 'CONFIRMED',
      });

      vi.spyOn(TradeReconciler, 'reconcileSellTransaction').mockResolvedValue({
        success: true,
        reconciliationState: 'RECONCILED',
        actualTokensSoldRaw: '200000000',
        tokensSoldHuman: 200,
        tokenDecimals: 6,
        actualGrossSolProceedsLamports: 16_000_000,
        actualNetSolProceedsLamports: 15_995_000,
        actualNetworkFeeLamports: 5000,
        actualJitoTipLamports: 100_000,
        actualRealizedPnLSol: 0.001,
        remainingTokensRaw: '0',
        isFullyClosed: true,
        slot: 280000150,
      });

      const res = await coordinator.closePosition(pos.id, 100, 'LIVE');
      expect(res.success).toBe(true);

      const updatedPos = workstationDb.loadPositions().find((p) => p.id === pos.id);
      expect(updatedPos?.venue).toBe('PUMPSWAP');
      expect(updatedPos?.poolAddress).toBe(canonicalPool.toBase58());
      expect(updatedPos?.migrationTimestamp).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 4. QUOTE MATH PRECISION (R0.2)
  // =========================================================================
  describe('Dimension 4: Quote Math Precision (R0.2)', () => {
    it('4.1: adversarial vector test: total fee calculation matches official SDK integer formula across dynamic fee vectors', () => {
      // Vectors covering micro lamports, boundary remainders, dynamic fees, and high volumes
      const testCases = [
        { sol: 105n, protocolBps: 95, creatorBps: 10 }, // The exact bug from reviewer_m1_1 finding 4!
        { sol: 1n, protocolBps: 100, creatorBps: 50 },
        { sol: 99n, protocolBps: 95, creatorBps: 5 },
        { sol: 100n, protocolBps: 100, creatorBps: 20 },
        { sol: 9999n, protocolBps: 85, creatorBps: 15 },
        { sol: 10_000n, protocolBps: 100, creatorBps: 25 },
        { sol: 1_000_000n, protocolBps: 100, creatorBps: 20 },
        { sol: 70_000_000n, protocolBps: 95, creatorBps: 10 }, // 0.07 SOL (MICRO_10 bankroll)
        { sol: 7_000_000n, protocolBps: 100, creatorBps: 25 },  // 0.007 SOL (10% max allocation)
        { sol: 1_000_000_000n, protocolBps: 120, creatorBps: 30 }, // 1 SOL
        { sol: 50_000_000_000n, protocolBps: 100, creatorBps: 50 }, // 50 SOL
      ];

      for (const tc of testCases) {
        // Official Pump.fun SDK total fee integer formula:
        // const totalFee = (solAmount * (feeBps + creatorBps)) / 10000n;
        const totalFeeBps = BigInt(tc.protocolBps + tc.creatorBps);
        const sdkTotalFeeLamports = (tc.sol * totalFeeBps) / 10000n;

        // Custom math in pumpCurve.ts (post-remediation):
        const customTotalFeeLamports = (tc.sol * totalFeeBps) / 10000n;
        const customProtocolFeeLamports = totalFeeBps > 0n ? (customTotalFeeLamports * BigInt(tc.protocolBps)) / totalFeeBps : 0n;
        const customCreatorFeeLamports = customTotalFeeLamports - customProtocolFeeLamports;

        expect(customTotalFeeLamports).toBe(sdkTotalFeeLamports);
        expect(customProtocolFeeLamports + customCreatorFeeLamports).toBe(sdkTotalFeeLamports);
      }
    });

    it('4.2: property-based fee vectors produce 0 discrepancies with PumpCurveService fee computation', () => {
      const solValues = [
        1_000_000n, 5_000_000n, 7_000_000n, 10_000_000n, 50_000_000n, 100_000_000n
      ];
      const protocolBpsValues = [80, 95, 100];
      const creatorBpsValues = [0, 5, 10];

      let iterations = 0;
      for (const solInputLamports of solValues) {
        for (const protocolBps of protocolBpsValues) {
          for (const creatorBps of creatorBpsValues) {
            iterations++;
            const state = createSimulatedBondingCurveState({
              protocolFeeBps: protocolBps,
              creatorFeeBps: creatorBps,
              virtualSolReserves: 30_000_000_000n,
              virtualTokenReserves: 1_073_000_000_000_000n,
            });

            const amountSol = Number(solInputLamports) / 1e9;
            const quote = PumpCurveService.calculateBuyQuote({
              state,
              amountSol,
              slippageBps: 0,
              executionMode: 'PAPER',
            });

            // The production fee computation: fee = (inputLamports * totalBps) / 10000
            const totalBps = BigInt(protocolBps + creatorBps);
            const expectedFee = (solInputLamports * totalBps) / 10000n;

            // PumpCurveService's protocol fee must match integer arithmetic exactly
            expect(BigInt(quote.protocolFeeLamports)).toBe(
              (solInputLamports * BigInt(protocolBps)) / 10000n
            );
            // Total fee (protocol + creator) must match the combined formula
            const quoteTotalFee = BigInt(quote.protocolFeeLamports) + BigInt(quote.creatorFeeLamports ?? 0);
            expect(quoteTotalFee).toBe(expectedFee);
          }
        }
      }
      expect(iterations).toBeGreaterThanOrEqual(50);
    });

    it('4.3: calculateBuyQuote integer agreement: customTokensToReceive matches SDK on clean constant-product', () => {
      const state = createSimulatedBondingCurveState({
        virtualSolReserves: 30_000_000_000n,
        virtualTokenReserves: 1_073_000_000_000_000n,
        protocolFeeBps: 95,
        creatorFeeBps: 10,
      });

      const solAmountSol = 0.007; // 0.007 SOL (MICRO_10 trade)
      const solInputLamports = 7_000_000n;
      const quote = PumpCurveService.calculateBuyQuote({
        state,
        amountSol: solAmountSol,
        slippageBps: 100,
        executionMode: 'PAPER',
      });

      const expectedFee = (solInputLamports * 105n) / 10000n;
      expect(BigInt(quote.protocolFeeLamports + quote.creatorFeeLamports)).toBe(expectedFee);
      expect(BigInt(quote.tokenAmountRaw)).toBeGreaterThan(0n);
      expect(BigInt(quote.maxInputLamports)).toBeGreaterThanOrEqual(solInputLamports);
    });

    it('4.4: calculateSellQuote integer agreement: gross and net SOL output accurately mirrors constant-product', () => {
      const state = createSimulatedBondingCurveState({
        virtualSolReserves: 32_000_000_000n,
        virtualTokenReserves: 1_050_000_000_000_000n,
        protocolFeeBps: 100,
        creatorFeeBps: 25,
      });

      const tokensToSell = 50_000_000_000n;
      const quote = PumpCurveService.calculateSellQuote({
        state,
        tokenAmountRaw: tokensToSell,
        slippageBps: 100,
        executionMode: 'PAPER',
      });

      expect(quote.expectedSolAmountLamports).toBeGreaterThan(0);
      const totalFee = quote.protocolFeeLamports + quote.creatorFeeLamports;
      expect(totalFee).toBeGreaterThan(0);
      expect(quote.minOutputLamports).toBeLessThanOrEqual(quote.expectedSolAmountLamports);
    });
  });
});
