import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { executionConfig } from '../server/solana/executionConfig';
import { txBuilder } from '../server/solana/transactionBuilder';
import { SolanaRpcTransport, confirmPacing } from '../server/solana/transports';
import { riskEngine } from '../server/risk/riskEngine';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { MockJitoEngine } from './e2e/helpers/mockJito';
import { TOKEN_PROGRAM_ID } from '../server/solana/programs';
import { settleLeftoverLiveBuys } from './helpers/leftoverBuys';

/**
 * The send path (submitAndConfirmWithRetry / submitAndConfirmInner): R3-2 (expiry decided at confirmed), R1 #8 (kill and halt re-checked
 * before the first send of a BUY and before each resend; never for a SELL), R3-28 (the BUY send deadline). Real ExecutionCoordinator,
 * JitoTransport (on the mock block engine) and SolanaRpcTransport; the Connection is the mock RPC, and the Jito/RPC submit and confirm
 * calls are spied at the transport edge.
 */
function dummyTx(payer: PublicKey, blockhash = PublicKey.default.toBase58()): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 5000 })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.signatures = [Uint8Array.from({ length: 64 }, () => Math.floor(Math.random() * 256))];
  return tx;
}

describe('C2 send path', () => {
  let mockRpc: MockSolanaRpc;
  let mockJito: MockJitoEngine;
  let coordinator: ExecutionCoordinator;
  let jitoSubmit: ReturnType<typeof vi.spyOn>;
  let jitoConfirm: ReturnType<typeof vi.spyOn>;
  let rpcSubmit: ReturnType<typeof vi.spyOn>;
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const snap = () => ({ timestamp: Date.now(), walletSolLamports: 1_000_000_000, tokenBalanceRaw: '0', tokenDecimals: 6, slot: 1 } as any);
  const run = (side: 'BUY' | 'SELL' = 'BUY', extra: Record<string, unknown> = {}) => coordinator.submitAndConfirmWithRetry({
    tx: dummyTx(owner), orderId: `c2s-${Math.random().toString(36).slice(2)}`, correlationId: 'corr-c2s', side,
    mint: mint.toBase58(), mintPubkey: mint, owner, tokenProgram: TOKEN_PROGRAM_ID, preSnapshot: snap(), jitoTipLamports: 100_000, ...extra,
  } as any);

  beforeEach(async () => {
    settleLeftoverLiveBuys();
    mockRpc = new MockSolanaRpc();
    mockJito = new MockJitoEngine();
    await mockJito.start();
    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
    await coordinator.getJitoTransport().probe();
    executionConfig.updateConfig({ enableRpcFallback: true, jitoMaxRetries: 2, jitoRetryIntervalMs: 1 });
    jitoSubmit = vi.spyOn(coordinator.getJitoTransport(), 'submit').mockImplementation(async (tx: any) => ({ signature: `j${Math.random()}`, bundleId: 'jb', transport: 'JITO', success: true, submitDurationMs: 1, lifecycleState: 'BUNDLE_PENDING' } as any));
    jitoConfirm = vi.spyOn(coordinator.getJitoTransport(), 'confirm').mockResolvedValue({ confirmed: false, error: 'timed out' } as any);
    rpcSubmit = vi.spyOn((coordinator as any).rpcTransport, 'submit').mockResolvedValue({ signature: 'rsig', transport: 'SOLANA_RPC', success: true, submitDurationMs: 1, lifecycleState: 'BUNDLE_PENDING' } as any);
    vi.spyOn((coordinator as any).rpcTransport, 'confirm').mockResolvedValue({ confirmed: true, slot: 9 } as any);
    vi.spyOn(coordinator, 'checkIfTransactionLanded').mockResolvedValue({ landed: false });
  });
  afterEach(async () => {
    riskEngine.setKillSwitch(false);
    coordinator.clearHalt();
    coordinator.cleanup();
    vi.restoreAllMocks();
    await mockJito.stop();
  });

  describe('R3-2: blockhash expiry is decided at confirmed', () => {
    it('valid at confirmed but not at processed: the retries and the RPC fallback go on (no BLOCKHASH_EXPIRED)', async () => {
      const conn = (coordinator as any).connection;
      conn.isBlockhashValid = vi.fn(async (_bh: string, cfg?: { commitment?: string }) => ({ context: { slot: 1 }, value: cfg?.commitment !== 'processed' }));
      const res = await run();
      expect(res.error ?? '').not.toMatch(/BLOCKHASH_EXPIRED/);
      expect(jitoSubmit).toHaveBeenCalledTimes(3);
      expect(rpcSubmit).toHaveBeenCalledTimes(1);
    });

    it('with a known lastValidBlockHeight, the confirmed block height decides; a processed status is not "expired"', async () => {
      const conn = (coordinator as any).connection;
      vi.spyOn(txBuilder, 'lastValidBlockHeightOf').mockReturnValue(500);
      conn.isBlockhashValid = vi.fn(async () => ({ context: { slot: 1 }, value: false })); // what processed would say
      conn.getBlockHeight = vi.fn(async () => 501);
      conn.getSignatureStatuses = vi.fn(async () => ({ context: { slot: 1 }, value: [{ slot: 9, confirmations: 0, err: null, confirmationStatus: 'processed' }] }));
      const res = await run();
      expect(res.error ?? '').not.toMatch(/BLOCKHASH_EXPIRED/);
      expect(conn.getBlockHeight).toHaveBeenCalledWith('confirmed');
    });

    it('past lastValidBlockHeight at confirmed with no signature status: BLOCKHASH_EXPIRED after the first attempt, no RPC send', async () => {
      const conn = (coordinator as any).connection;
      vi.spyOn(txBuilder, 'lastValidBlockHeightOf').mockReturnValue(500);
      conn.getBlockHeight = vi.fn(async () => 501);
      conn.getSignatureStatuses = vi.fn(async () => ({ context: { slot: 1 }, value: [null] }));
      const res = await run();
      expect(res.error).toMatch(/^BLOCKHASH_EXPIRED/);
      expect(jitoSubmit).toHaveBeenCalledTimes(1);
      expect(rpcSubmit).not.toHaveBeenCalled();
    });
  });

  describe('R1 #8: kill switch and halt between signing and the send', () => {
    beforeEach(() => {
      (coordinator as any).connection.isBlockhashValid = vi.fn(async () => ({ context: { slot: 1 }, value: true }));
    });

    it('a kill before the first send: a BUY sends nothing', async () => {
      riskEngine.setKillSwitch(true, 'c2 test');
      const res = await run('BUY');
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/^ENTRY_REVOKED/);
      expect(jitoSubmit).not.toHaveBeenCalled();
      expect(rpcSubmit).not.toHaveBeenCalled();
    });

    it('a kill after the first Jito send: no resend and no RPC fallback; the BUY is reported unconfirmed (it may land)', async () => {
      jitoConfirm.mockImplementationOnce(async () => { riskEngine.setKillSwitch(true, 'c2 panic mid-send'); return { confirmed: false, error: 'timed out' } as any; });
      const res = await run('BUY');
      expect(jitoSubmit).toHaveBeenCalledTimes(1);
      expect(rpcSubmit).not.toHaveBeenCalled();
      expect(res.success).toBe(false);
      expect(res.unconfirmed).toBe(true);
      expect(res.error).toMatch(/^ENTRY_REVOKED_AFTER_SEND/);
    });

    it('a halt during the Jito attempts stops the BUY before the RPC fallback', async () => {
      jitoConfirm.mockImplementation(async () => { coordinator.haltAll('c2 halt'); return { confirmed: false, error: 'timed out' } as any; });
      executionConfig.updateConfig({ jitoMaxRetries: 0 });
      const res = await run('BUY');
      expect(jitoSubmit).toHaveBeenCalledTimes(1);
      expect(rpcSubmit).not.toHaveBeenCalled();
      expect(res.unconfirmed).toBe(true);
    });

    it('a SELL is never held by the kill switch', async () => {
      riskEngine.setKillSwitch(true, 'c2 test');
      const res = await run('SELL');
      expect(jitoSubmit).toHaveBeenCalled();
      expect(res.error ?? '').not.toMatch(/ENTRY_REVOKED/);
    });

    it('R3-28: a BUY past its send deadline sends nothing', async () => {
      const res = await run('BUY', { buyNotAfter: Date.now() - 1 });
      expect(res.error).toMatch(/^ENTRY_REVOKED: the signal or its market data/);
      expect(jitoSubmit).not.toHaveBeenCalled();
    });
  });
});

describe('R1 #8: the RPC watch stops resending when told to, and keeps watching', () => {
  let clock = 0;
  beforeEach(() => {
    clock = 1_000_000;
    vi.spyOn(confirmPacing, 'now').mockImplementation(() => clock);
    vi.spyOn(confirmPacing, 'sleep').mockImplementation(async (ms: number) => { clock += ms; });
  });
  afterEach(() => vi.restoreAllMocks());

  it('stopResends answering a reason: no resend goes out, and a later confirmation is still seen', async () => {
    const confirmed = { slot: 77, confirmations: 1, err: null, confirmationStatus: 'confirmed' };
    let i = 0;
    const statuses = [null, null, null, null, null, null, null, null, confirmed];
    const c = {
      getSignatureStatuses: vi.fn(async () => ({ context: { slot: 1 }, value: [statuses[Math.min(i++, statuses.length - 1)]] })),
      sendRawTransaction: vi.fn(async () => 'sig'),
      getBlockHeight: vi.fn(async () => 100),
    };
    const TX = { serialize: () => Uint8Array.from([1, 2, 3, 4]), signatures: [] } as any;
    const r = await new SolanaRpcTransport(c as any).confirm('sig', 15_000, undefined, { rebroadcast: TX, lastValidBlockHeight: 500, resendEveryMs: 400, stopResends: () => 'the kill switch was activated' });
    expect(r).toMatchObject({ confirmed: true, slot: 77 });
    expect(c.sendRawTransaction).not.toHaveBeenCalled();
  });
});
