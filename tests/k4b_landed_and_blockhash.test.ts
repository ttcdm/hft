import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { executionConfig } from '../server/solana/executionConfig';
import { txBuilder } from '../server/solana/transactionBuilder';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { MockJitoEngine } from './e2e/helpers/mockJito';
import { TOKEN_PROGRAM_ID } from '../server/solana/programs';

function dummyTx(payer: PublicKey, blockhash = PublicKey.default.toBase58()): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 5000 })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.signatures = [new Uint8Array(64).fill(7)];
  return tx;
}

describe('K4 #5 and #6: landed inference and blockhash expiry', () => {
  let mockRpc: MockSolanaRpc;
  let mockJito: MockJitoEngine;
  let coordinator: ExecutionCoordinator;
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const snap = () => ({ timestamp: Date.now(), walletSolLamports: 1_000_000_000, tokenBalanceRaw: '0', tokenDecimals: 6, slot: 1 } as any);

  beforeEach(async () => {
    mockRpc = new MockSolanaRpc();
    mockJito = new MockJitoEngine();
    await mockJito.start();
    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
    await coordinator.getJitoTransport().probe();
    executionConfig.updateConfig({ enableRpcFallback: true, jitoMaxRetries: 2, jitoRetryIntervalMs: 1 });
  });
  afterEach(async () => {
    coordinator.cleanup();
    vi.restoreAllMocks();
    await mockJito.stop();
  });

  describe('#5: a wallet SOL drop is not evidence that a transaction landed', () => {
    const check = (side: 'BUY' | 'SELL') => coordinator.checkIfTransactionLanded('sigX', undefined, owner, mint, TOKEN_PROGRAM_ID, snap(), side, undefined);

    beforeEach(() => {
      const conn = (coordinator as any).connection;
      vi.spyOn(conn, 'getSignatureStatuses').mockResolvedValue({ context: { slot: 1 }, value: [null] });
      vi.spyOn(conn, 'getTokenAccountBalance').mockRejectedValue(new Error('no account')); // no ATA, no token delta
    });

    it('a 0.5 SOL wallet drop (a concurrent buy of another mint) does not make a BUY "landed"', async () => {
      vi.spyOn((coordinator as any).connection, 'getBalance').mockResolvedValue(500_000_000);
      expect((await check('BUY')).landed).toBe(false);
    });

    it('a 0.5 SOL wallet gain does not make a SELL "landed"', async () => {
      vi.spyOn((coordinator as any).connection, 'getBalance').mockResolvedValue(1_500_000_000);
      expect((await check('SELL')).landed).toBe(false);
    });

    it('a confirmed signature status still counts', async () => {
      vi.spyOn((coordinator as any).connection, 'getSignatureStatuses').mockResolvedValue({ context: { slot: 1 }, value: [{ slot: 77, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] });
      expect(await check('BUY')).toEqual({ landed: true, slot: 77 });
    });

    it('a rise of THIS mint\'s token balance still counts for a BUY', async () => {
      vi.spyOn((coordinator as any).connection, 'getTokenAccountBalance').mockResolvedValue({ context: { slot: 1 }, value: { amount: '1000', decimals: 6, uiAmount: 0.001 } } as any);
      expect((await check('BUY')).landed).toBe(true);
    });
  });

  describe('#6: expired blockhash', () => {
    let jitoSubmit: ReturnType<typeof vi.spyOn>;
    let rpcSubmit: ReturnType<typeof vi.spyOn>;
    let landedCheck: ReturnType<typeof vi.spyOn>;
    // the mock RPC object is not a full web3 Connection, so install the one method under test on it
    const setValid = (fn: () => Promise<any>) => { (coordinator as any).connection.isBlockhashValid = fn; };

    const run = () => coordinator.submitAndConfirmWithRetry({
      tx: dummyTx(owner), orderId: `k4b-${Math.random().toString(36).slice(2)}`, correlationId: 'corr-k4b', side: 'BUY',
      mint: mint.toBase58(), mintPubkey: mint, owner, tokenProgram: TOKEN_PROGRAM_ID, preSnapshot: snap(), jitoTipLamports: 100_000,
    });

    beforeEach(() => {
      jitoSubmit = vi.spyOn(coordinator.getJitoTransport(), 'submit').mockResolvedValue({ signature: 'jsig', bundleId: 'jb', transport: 'JITO', success: true, submitDurationMs: 1, lifecycleState: 'BUNDLE_PENDING' } as any);
      vi.spyOn(coordinator.getJitoTransport(), 'confirm').mockResolvedValue({ confirmed: false, error: 'timed out' } as any);
      rpcSubmit = vi.spyOn((coordinator as any).rpcTransport, 'submit').mockResolvedValue({ signature: 'rsig', transport: 'SOLANA_RPC', success: true, submitDurationMs: 1, lifecycleState: 'BUNDLE_PENDING' } as any);
      vi.spyOn((coordinator as any).rpcTransport, 'confirm').mockResolvedValue({ confirmed: true, slot: 9 } as any);
      landedCheck = vi.spyOn(coordinator, 'checkIfTransactionLanded').mockResolvedValue({ landed: false });
    });

    it('expired and not landed: stops after the first attempt, sends nothing through RPC, and says BLOCKHASH_EXPIRED', async () => {
      setValid(async () => ({ context: { slot: 1 }, value: false }));
      const res = await run();
      expect(res.success).toBe(false);
      expect(res.lifecycleState).toBe('SUBMIT_FAILED');
      expect(res.error).toMatch(/^BLOCKHASH_EXPIRED/);
      expect(jitoSubmit).toHaveBeenCalledTimes(1); // not maxRetries + 1
      expect(rpcSubmit).not.toHaveBeenCalled();
    });

    it('expired but it DID land: reported as landed, never as an expiry failure', async () => {
      setValid(async () => ({ context: { slot: 1 }, value: false }));
      landedCheck.mockResolvedValue({ landed: true, slot: 55 });
      const res = await run();
      expect(res.success).toBe(true);
      expect(res.slot).toBe(55);
    });

    it('a still-valid blockhash keeps the old behaviour: all Jito attempts, then the RPC fallback', async () => {
      setValid(async () => ({ context: { slot: 1 }, value: true }));
      const res = await run();
      expect(jitoSubmit).toHaveBeenCalledTimes(3);
      expect(rpcSubmit).toHaveBeenCalledTimes(1);
      expect(res.success).toBe(true);
      expect(res.transport).toBe('SOLANA_RPC');
    });

    it('if the validity check itself fails, it is treated as not expired (fallback proceeds)', async () => {
      setValid(async () => { throw new Error('rpc down'); });
      const res = await run();
      expect(rpcSubmit).toHaveBeenCalledTimes(1);
      expect(res.success).toBe(true);
    });
  });

  describe('#6: trades are built with a fresh blockhash', () => {
    it('two builds within the old 25 s cache window each fetch a blockhash', async () => {
      const conn = mockRpc.createConnection();
      const spy = vi.spyOn(conn, 'getLatestBlockhash').mockResolvedValue({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 10 });
      await txBuilder.buildCustomVersionedTransaction(conn, owner, [SystemProgram.transfer({ fromPubkey: owner, toPubkey: mint, lamports: 1 })]);
      await txBuilder.buildCustomVersionedTransaction(conn, owner, [SystemProgram.transfer({ fromPubkey: owner, toPubkey: mint, lamports: 1 })]);
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });
});
