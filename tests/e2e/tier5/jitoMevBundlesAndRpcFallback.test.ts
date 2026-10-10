import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { JitoTransport, SolanaRpcTransport } from '../../../server/solana/transports';
import { executionConfig, ECONOMIC_TIP_CAP_FRACTION, calculateDynamicJitoTip, calculateDynamicJitoTipSol } from '../../../server/solana/executionConfig';
import { ExecutionCoordinator, PreTradeSnapshot } from '../../../server/execution/coordinator';
import { localSigner } from '../../../server/solana/signer';
import { workstationDb } from '../../../server/db/database';
import { SolanaTransactionBuilder, txBuilder } from '../../../server/solana/transactionBuilder';
import { MockSolanaRpc } from '../helpers/mockRpc';
import { MockJitoEngine } from '../helpers/mockJito';
import { TestDatabase } from '../helpers/testDb';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT, DUMMY_BUYBACK_FEE_RECIPIENT } from '../helpers/simulatedStates';

describe('Tier 5 [mock-level]: Jito MEV Bundles, Tip Policies & Zero-Double-Fill RPC Fallback', () => {
  let mockRpc: MockSolanaRpc;
  let mockJito: MockJitoEngine;
  let testDb: TestDatabase;
  let coordinator: ExecutionCoordinator;
  let testKeypair: Keypair;
  let sampleV0Tx: VersionedTransaction;

  beforeEach(async () => {
    testKeypair = Keypair.generate();
    mockRpc = new MockSolanaRpc();
    mockJito = new MockJitoEngine();
    await mockJito.start();
    testDb = new TestDatabase();

    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(testKeypair.publicKey);

    coordinator = new ExecutionCoordinator(mockRpc.createConnection());

    // Build sample V0 transaction for transport testing
    const [bondingCurve] = SolanaTransactionBuilder.getBondingCurveAddress(VALID_PUMP_MINT_1);
    const associatedBondingCurve = SolanaTransactionBuilder.getAssociatedTokenAddress(VALID_PUMP_MINT_1, bondingCurve);
    const associatedUser = SolanaTransactionBuilder.getAssociatedTokenAddress(VALID_PUMP_MINT_1, testKeypair.publicKey);

    sampleV0Tx = await txBuilder.buildBuyTransaction(mockRpc.createConnection(), {
      buyer: testKeypair.publicKey,
      mint: VALID_PUMP_MINT_1,
      bondingCurve,
      associatedBondingCurve,
      associatedUser,
      creator: testKeypair.publicKey,
      feeRecipient: DUMMY_FEE_RECIPIENT,
      buybackFeeRecipient: DUMMY_BUYBACK_FEE_RECIPIENT,
      amountTokens: 1_000_000_000n,
      maxSolCostLamports: 10_000_000n,
      jitoTipLamports: 180_000n,
      jitoTipAccount: executionConfig.getJitoTipAccountPublicKey(),
    });
    sampleV0Tx.sign([testKeypair]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    executionConfig.updateConfig({
      enableRpcFallback: false,
      jitoMaxRetries: 2,
    });
    await mockJito.stop();
    testDb.close();
    mockRpc.clear();
  });

  // =========================================================================
  // 1. Dynamic Jito Tip Sizing & Economic Sanity Bounds
  // =========================================================================
  describe('Dynamic Jito Tip Sizing & Economic Sanity Bounds', () => {
    it('JMB-1: calculateDynamicJitoTip scales at 3.0% bounded between 150k floor and 1M ceiling', () => {
      // 0.006 SOL trade -> 3% = 0.00018 SOL = 180,000 lamports
      expect(calculateDynamicJitoTip(0.006)).toBe(180_000);
      expect(calculateDynamicJitoTipSol(0.006)).toBeCloseTo(0.00018, 6);

      // Micro trade (0.001 SOL) -> 3% = 30,000 lamports -> clamped to 150,000 floor
      expect(calculateDynamicJitoTip(0.001)).toBe(150_000);

      // Large trade (0.100 SOL) -> 3% = 3,000,000 lamports -> clamped to 1,000,000 ceiling
      expect(calculateDynamicJitoTip(0.100)).toBe(1_000_000);

      // Zero or invalid trade defaults to standard 180,000
      expect(calculateDynamicJitoTip(0)).toBe(180_000);
      expect(calculateDynamicJitoTip(-1)).toBe(180_000);
    });

    // Decision #1 (planning thread): economic cap is 15% of notional (ECONOMIC_TIP_CAP_FRACTION), not 25%.
    it('JMB-2: resolveDynamicJitoTip caps tip at 15% of trade notional for economic sanity', () => {
      // Micro trade of 0.0008 SOL (800,000 lamports): 15% cap = 120,000 lamports, below the 150,000 base -> capped.
      const res = executionConfig.resolveDynamicJitoTip({
        tradeNotionalSol: 0.0008,
      });
      expect(res.tipLamports).toBe(Math.round(0.0008 * ECONOMIC_TIP_CAP_FRACTION * 1e9));
      expect(res.tipLamports).toBe(120_000);

      // Ultra-micro trade of 0.0004 SOL: 15% cap = 60,000 lamports (>= 10,000 so the cap applies even below the floor).
      const resMicro = executionConfig.resolveDynamicJitoTip({
        tradeNotionalSol: 0.0004,
      });
      expect(resMicro.tipLamports).toBe(60_000);
    });

    it('JMB-3: explicit tip override is respected while strictly bounded by operator bounds', () => {
      // Explicit tip within bounds
      const resNormal = executionConfig.resolveDynamicJitoTip({
        explicitTipSol: 0.002,
      });
      expect(resNormal.tipLamports).toBe(2_000_000);
      expect(resNormal.isDynamic).toBe(false);

      // Explicit tip below minimum floor (0.00015 SOL = 150,000 lamports)
      const resSubFloor = executionConfig.resolveDynamicJitoTip({
        explicitTipSol: 0.00005,
      });
      expect(resSubFloor.tipLamports).toBe(150_000);

      // Explicit tip above maximum ceiling (0.05 SOL = 50,000,000 lamports)
      const resAboveMax = executionConfig.resolveDynamicJitoTip({
        explicitTipSol: 0.100,
        operatorMaxSol: 0.05,
      });
      expect(resAboveMax.tipLamports).toBe(50_000_000);
    });

    it('JMB-4: scales live tip floor telemetry with urgency multiplier', () => {
      // Live floor telemetry = 200,000 lamports. Urgency multiplier = 1.25x.
      const res = executionConfig.resolveDynamicJitoTip({
        tipFloorLamports: 200_000,
        urgencyMultiplier: 1.25,
      });
      expect(res.tipLamports).toBe(250_000); // 200k * 1.25
      expect(res.isDynamic).toBe(true);
      expect(res.policyReason).toMatch(/JITO_LIVE_FLOOR/);
    });
  });

  // =========================================================================
  // 2. JitoTransport Submission, Base64 Payload & Telemetry
  // =========================================================================
  describe('JitoTransport Submission, Base64 Payload & Telemetry', () => {
    it('JMB-5: JitoTransport.submit() serializes VersionedTransaction to Base64 and sends sendBundle', async () => {
      const transport = new JitoTransport(mockRpc.createConnection());

      const res = await transport.submit(sampleV0Tx);
      expect(res.success).toBe(true);
      expect(res.bundleId).toBeDefined();
      expect(res.transport).toBe('JITO');
      expect(res.lifecycleState).toBe('SUBMITTED_TO_JITO');

      // Verify bundle was registered in MockJitoEngine
      const registered = mockJito.getBundle(res.bundleId!);
      expect(registered).toBeDefined();
      expect(registered?.transactions.length).toBe(1);

      // Verify the transaction was Base64 encoded
      const b64Tx = registered?.transactions[0];
      expect(typeof b64Tx).toBe('string');
      const rawBuf = Buffer.from(b64Tx!, 'base64');
      expect(rawBuf.length).toBeGreaterThan(0);
    });

    it('JMB-6: JitoTransport records latency and updates health telemetry on successful submission', async () => {
      const transport = new JitoTransport(mockRpc.createConnection());
      await transport.submit(sampleV0Tx);

      const telemetry = transport.getTelemetry();
      expect(telemetry.health).toBe('HEALTHY');
      expect(telemetry.lastLatencyMs).toBeGreaterThanOrEqual(0);
      expect(telemetry.lastResponseMsAgo).toBeLessThan(1000);
      expect(telemetry.lastError).toBeNull();
    });

    it('JMB-7: JitoTransport handles Block Engine HTTP 500 error, marks health DEGRADED and returns SUBMIT_FAILED', async () => {
      const transport = new JitoTransport(mockRpc.createConnection());
      mockJito.setFailSubmissions(true, 'Internal Block Engine Congestion');

      const res = await transport.submit(sampleV0Tx);
      expect(res.success).toBe(false);
      expect(res.lifecycleState).toBe('SUBMIT_FAILED');
      expect(res.error).toMatch(/Internal Block Engine Congestion/);

      const telemetry = transport.getTelemetry();
      expect(telemetry.health).toBe('DEGRADED');
      expect(telemetry.lastError).toMatch(/Internal Block Engine Congestion/);
    });
  });

  // =========================================================================
  // 3. Bounded Idempotent Retry Loop & Fatal Error Fast-Break
  // =========================================================================
  describe('Bounded Idempotent Retry Loop & Fatal Error Fast-Break', () => {
    it('JMB-8: submitWithRetry retries up to jitoMaxRetries on transient errors', async () => {
      const transport = new JitoTransport(mockRpc.createConnection());
      mockJito.setFailSubmissions(true, 'Transient timeout');

      const res = await transport.submitWithRetry(sampleV0Tx, 2, 10);
      expect(res.success).toBe(false);
      expect(res.attempts).toBe(3); // 1 initial + 2 retries = 3 attempts
    });

    it('JMB-9: fatal simulation error (InstructionError) fast-breaks the retry loop without wasting attempts', async () => {
      const transport = new JitoTransport(mockRpc.createConnection());
      mockJito.setFailSubmissions(true, 'Transaction simulation failed: InstructionError 1');

      const res = await transport.submitWithRetry(sampleV0Tx, 5, 10);
      expect(res.success).toBe(false);
      expect(res.attempts).toBe(1); // Fast-break on attempt 1!
    });
  });

  // =========================================================================
  // 4. Inflight & Finalized Bundle Confirmation
  // =========================================================================
  describe('Inflight & Finalized Bundle Confirmation', () => {
    it('JMB-10: confirm() detects landed bundle and returns TX_CONFIRMED with slot', async () => {
      const transport = new JitoTransport(mockRpc.createConnection());
      const submitRes = await transport.submit(sampleV0Tx);

      // Configure mock RPC signature status
      mockRpc.setSignatureStatus(submitRes.signature, {
        confirmationStatus: 'confirmed',
        slot: 280000100,
      });

      const confirmRes = await transport.confirm(submitRes.signature, 5000, submitRes.bundleId);
      expect(confirmRes.confirmed).toBe(true);
      expect(confirmRes.lifecycleState).toBe('TX_CONFIRMED');
      expect(confirmRes.slot).toBe(280000100);
    });

    it('JMB-11: confirm() detects failed inflight status and returns REVERTED', async () => {
      const transport = new JitoTransport(mockRpc.createConnection());
      const submitRes = await transport.submit(sampleV0Tx);

      mockJito.updateBundleStatus(submitRes.bundleId!, {
        inflightStatus: 'Failed',
        err: { InstructionError: [0, 'CustomError'] },
      });

      const confirmRes = await transport.confirm(submitRes.signature, 5000, submitRes.bundleId);
      expect(confirmRes.confirmed).toBe(false);
      expect(confirmRes.lifecycleState).toBe('REVERTED');
      expect(confirmRes.error).toMatch(/InstructionError/);
    });
  });

  // =========================================================================
  // 5. Zero-Double-Fill RPC Fallback & Database Linking
  // =========================================================================
  describe('Zero-Double-Fill RPC Fallback & Database Linking', () => {
    const dummySnapshot: PreTradeSnapshot = {
      walletSolLamports: 1_000_000_000,
      tokenBalanceRaw: '0',
      tokenDecimals: 6,
      timestamp: Date.now(),
    };

    it('JMB-12: pre-retry check halts retry loop if transaction already landed on-chain', async () => {
      const mockJitoTransport = (coordinator as any).jitoTransport;
      vi.spyOn(mockJitoTransport, 'submit').mockResolvedValue({
        signature: 'sig_jito_attempt_1',
        bundleId: 'bundle_1',
        transport: 'JITO',
        success: true,
        submitDurationMs: 50,
        lifecycleState: 'SUBMITTED_TO_JITO',
      });
      // Mock confirm timeout
      vi.spyOn(mockJitoTransport, 'confirm').mockResolvedValue({
        signature: 'sig_jito_attempt_1',
        confirmed: false,
        confirmDurationMs: 1000,
        lifecycleState: 'TIMED_OUT',
        error: 'Confirmation timed out',
      });

      // On-chain check discovers tx actually landed!
      vi.spyOn(coordinator, 'checkIfTransactionLanded').mockResolvedValue({
        landed: true,
        slot: 280000150,
      });

      const res = await coordinator.submitAndConfirmWithRetry({
        tx: sampleV0Tx,
        orderId: 'ord-test-landed-check',
        correlationId: 'corr-1',
        side: 'BUY',
        mint: VALID_PUMP_MINT_1.toBase58(),
        mintPubkey: VALID_PUMP_MINT_1,
        owner: testKeypair.publicKey,
        tokenProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        preSnapshot: dummySnapshot,
        jitoTipLamports: 180_000,
      });

      expect(res.success).toBe(true);
      expect(res.slot).toBe(280000150);
      expect(res.lifecycleState).toBe('CONFIRMED');
    });

    it('JMB-13: executes direct RPC fallback when Jito attempts exhaust and enableRpcFallback is true', async () => {
      executionConfig.updateConfig({ enableRpcFallback: true, jitoMaxRetries: 0 });

      const mockJitoTransport = (coordinator as any).jitoTransport;
      vi.spyOn(mockJitoTransport, 'submit').mockResolvedValue({
        signature: 'sig_jito_timeout',
        bundleId: 'bundle_timeout',
        transport: 'JITO',
        success: true,
        submitDurationMs: 50,
        lifecycleState: 'SUBMITTED_TO_JITO',
      });
      vi.spyOn(mockJitoTransport, 'confirm').mockResolvedValue({
        signature: 'sig_jito_timeout',
        confirmed: false,
        confirmDurationMs: 1000,
        lifecycleState: 'TIMED_OUT',
      });

      // Pre-fallback check: tx has NOT landed
      vi.spyOn(coordinator, 'checkIfTransactionLanded').mockResolvedValue({ landed: false });

      // RPC submit succeeds
      const rpcTransport = (coordinator as any).rpcTransport;
      vi.spyOn(rpcTransport, 'submit').mockResolvedValue({
        signature: 'sig_rpc_fallback_success',
        transport: 'SOLANA_RPC',
        success: true,
        submitDurationMs: 25,
        lifecycleState: 'BUNDLE_PENDING',
      });
      vi.spyOn(rpcTransport, 'confirm').mockResolvedValue({
        signature: 'sig_rpc_fallback_success',
        confirmed: true,
        confirmDurationMs: 500,
        slot: 280000200,
        lifecycleState: 'TX_CONFIRMED',
      });

      const res = await coordinator.submitAndConfirmWithRetry({
        tx: sampleV0Tx,
        orderId: 'ord-test-rpc-fallback',
        correlationId: 'corr-rpc-fallback',
        side: 'BUY',
        mint: VALID_PUMP_MINT_1.toBase58(),
        mintPubkey: VALID_PUMP_MINT_1,
        owner: testKeypair.publicKey,
        tokenProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        preSnapshot: dummySnapshot,
        jitoTipLamports: 180_000,
      });

      expect(res.success).toBe(true);
      expect(res.transport).toBe('SOLANA_RPC');
      expect(res.signature).toBe('sig_rpc_fallback_success');
      expect(res.slot).toBe(280000200);

      // Verify SQLite records both transactions under the SAME logical orderId
      // (the write-ahead PENDING row for the tx's own signature is a third row here only because the mocked transports invent signatures)
      const txs = workstationDb.loadTransactions('ord-test-rpc-fallback').filter((t) => t.signature.startsWith('sig_'));
      expect(txs.length).toBe(2);
      expect(txs[0].submissionTransport).toBe('JITO');
      expect(txs[1].submissionTransport).toBe('SOLANA_RPC');
    });

    it('JMB-14: zero-double-fill guard: aborts RPC fallback if Jito tx landed right before fallback', async () => {
      executionConfig.updateConfig({ enableRpcFallback: true, jitoMaxRetries: 0 });

      const mockJitoTransport = (coordinator as any).jitoTransport;
      vi.spyOn(mockJitoTransport, 'submit').mockResolvedValue({
        signature: 'sig_jito_late_landing',
        bundleId: 'bundle_late',
        transport: 'JITO',
        success: true,
        submitDurationMs: 50,
        lifecycleState: 'SUBMITTED_TO_JITO',
      });
      vi.spyOn(mockJitoTransport, 'confirm').mockResolvedValue({
        signature: 'sig_jito_late_landing',
        confirmed: false,
        confirmDurationMs: 1000,
        lifecycleState: 'TIMED_OUT',
      });

      // First check: landed: false. Second check (pre-fallback): discovered landed: true!
      let callCount = 0;
      vi.spyOn(coordinator, 'checkIfTransactionLanded').mockImplementation(async () => {
        callCount++;
        return callCount >= 2 ? { landed: true, slot: 280000300 } : { landed: false };
      });

      const rpcTransport = (coordinator as any).rpcTransport;
      const rpcSubmitSpy = vi.spyOn(rpcTransport, 'submit');

      const res = await coordinator.submitAndConfirmWithRetry({
        tx: sampleV0Tx,
        orderId: 'ord-test-double-fill-guard',
        correlationId: 'corr-guard',
        side: 'BUY',
        mint: VALID_PUMP_MINT_1.toBase58(),
        mintPubkey: VALID_PUMP_MINT_1,
        owner: testKeypair.publicKey,
        tokenProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        preSnapshot: dummySnapshot,
        jitoTipLamports: 180_000,
      });

      // Invariant: RPC fallback must NEVER be submitted when Jito landed
      expect(rpcSubmitSpy).not.toHaveBeenCalled();
      expect(res.success).toBe(true);
      expect(res.transport).toBe('JITO');
      expect(res.signature).toBe('sig_jito_late_landing');
      expect(res.slot).toBe(280000300);
    });

    it('JMB-15: fails closed and never broadcasts to public mempool when enableRpcFallback is false', async () => {
      executionConfig.updateConfig({ enableRpcFallback: false, jitoMaxRetries: 0 });

      const mockJitoTransport = (coordinator as any).jitoTransport;
      vi.spyOn(mockJitoTransport, 'submit').mockResolvedValue({
        signature: 'sig_jito_dropped',
        bundleId: 'bundle_dropped',
        transport: 'JITO',
        success: true,
        submitDurationMs: 50,
        lifecycleState: 'SUBMITTED_TO_JITO',
      });
      vi.spyOn(mockJitoTransport, 'confirm').mockResolvedValue({
        signature: 'sig_jito_dropped',
        confirmed: false,
        confirmDurationMs: 1000,
        lifecycleState: 'TIMED_OUT',
      });
      vi.spyOn(coordinator, 'checkIfTransactionLanded').mockResolvedValue({ landed: false });

      const rpcTransport = (coordinator as any).rpcTransport;
      const rpcSubmitSpy = vi.spyOn(rpcTransport, 'submit');

      const res = await coordinator.submitAndConfirmWithRetry({
        tx: sampleV0Tx,
        orderId: 'ord-no-fallback',
        correlationId: 'corr-no-fallback',
        side: 'BUY',
        mint: VALID_PUMP_MINT_1.toBase58(),
        mintPubkey: VALID_PUMP_MINT_1,
        owner: testKeypair.publicKey,
        tokenProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        preSnapshot: dummySnapshot,
        jitoTipLamports: 180_000,
      });

      expect(rpcSubmitSpy).not.toHaveBeenCalled();
      expect(res.success).toBe(false);
      expect(res.transport).toBe('JITO');
      expect(res.lifecycleState).toBe('REVERTED');
    });
  });
});
