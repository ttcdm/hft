import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { executionConfig } from '../server/solana/executionConfig';
import { riskEngine } from '../server/risk/riskEngine';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { MockJitoEngine } from './e2e/helpers/mockJito';
import { TOKEN_PROGRAM_ID } from '../server/solana/programs';
import { settleLeftoverLiveBuys } from './helpers/leftoverBuys';

/**
 * R14-7: a signed BUY kept being resent (the Jito retries, the RPC fallback and the RPC watch's rebroadcasts) after LIVE was disarmed, after
 * the start lock was lost and after its send deadline; the stop check (buySendRefusal) knew only the kill switch and the halt. Real
 * ExecutionCoordinator and its send path; the Connection is the mock RPC, and the Jito/RPC submit and confirm calls are spied at the
 * transport edge, as in c2_send_path.test.ts.
 */
function dummyTx(payer: PublicKey): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 5000 })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.signatures = [Uint8Array.from({ length: 64 }, () => Math.floor(Math.random() * 256))];
  return tx;
}

describe('R14-7: a BUY already sent stops resending on disarm, a lost start lock and its send deadline', () => {
  let mockRpc: MockSolanaRpc;
  let mockJito: MockJitoEngine;
  let coordinator: ExecutionCoordinator;
  let jitoSubmit: ReturnType<typeof vi.spyOn>;
  let jitoConfirm: ReturnType<typeof vi.spyOn>;
  let rpcSubmit: ReturnType<typeof vi.spyOn>;
  let rpcConfirm: ReturnType<typeof vi.spyOn>;
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const snap = () => ({ timestamp: Date.now(), walletSolLamports: 1_000_000_000, tokenBalanceRaw: '0', tokenDecimals: 6, slot: 1 } as any);
  const run = (extra: Record<string, unknown> = {}) => coordinator.submitAndConfirmWithRetry({
    tx: dummyTx(owner), orderId: `r147-${Math.random().toString(36).slice(2)}`, correlationId: 'corr-r147', side: 'BUY',
    mint: mint.toBase58(), mintPubkey: mint, owner, tokenProgram: TOKEN_PROGRAM_ID, preSnapshot: snap(), jitoTipLamports: 100_000,
    buyNotAfter: Date.now() + 60_000, ...extra,
  } as any);

  beforeEach(async () => {
    settleLeftoverLiveBuys();
    mockRpc = new MockSolanaRpc();
    mockJito = new MockJitoEngine();
    await mockJito.start();
    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
    await coordinator.getJitoTransport().probe();
    executionConfig.updateConfig({ enableRpcFallback: true, jitoMaxRetries: 2, jitoRetryIntervalMs: 1 });
    (coordinator as any).connection.isBlockhashValid = vi.fn(async () => ({ context: { slot: 1 }, value: true }));
    (coordinator as any).isLiveTradingArmed = true;
    (coordinator as any).executionMode = 'LIVE';
    jitoSubmit = vi.spyOn(coordinator.getJitoTransport(), 'submit').mockImplementation(async () => ({ signature: `j${Math.random()}`, bundleId: 'jb', transport: 'JITO', success: true, submitDurationMs: 1, lifecycleState: 'BUNDLE_PENDING' } as any));
    jitoConfirm = vi.spyOn(coordinator.getJitoTransport(), 'confirm').mockResolvedValue({ confirmed: false, error: 'timed out' } as any);
    rpcSubmit = vi.spyOn((coordinator as any).rpcTransport, 'submit').mockResolvedValue({ signature: 'rsig', transport: 'SOLANA_RPC', success: true, submitDurationMs: 1, lifecycleState: 'BUNDLE_PENDING' } as any);
    rpcConfirm = vi.spyOn((coordinator as any).rpcTransport, 'confirm').mockResolvedValue({ confirmed: true, slot: 9 } as any);
    vi.spyOn(coordinator, 'checkIfTransactionLanded').mockResolvedValue({ landed: false });
  });
  afterEach(async () => {
    riskEngine.setKillSwitch(false);
    coordinator.clearHalt();
    coordinator.cleanup();
    vi.restoreAllMocks();
    await mockJito.stop();
  });

  it('LIVE disarmed (arm:false) after the first Jito send: no resend and no RPC fallback; reported unconfirmed', async () => {
    jitoConfirm.mockImplementationOnce(async () => { coordinator.armLiveTrading(false); return { confirmed: false, error: 'timed out' } as any; });
    const res = await run();
    expect(jitoSubmit).toHaveBeenCalledTimes(1);
    expect(rpcSubmit).not.toHaveBeenCalled();
    expect(res.success).toBe(false);
    expect(res.unconfirmed).toBe(true);
    expect(res.error).toMatch(/^ENTRY_REVOKED_AFTER_SEND: live trading was disarmed/);
  });

  it('the start lock lost after the first Jito send: no resend', async () => {
    jitoConfirm.mockImplementationOnce(async () => {
      vi.spyOn(coordinator as any, 'lostStartLock').mockReturnValue('/tmp/apex-test.db.lock');
      return { confirmed: false, error: 'timed out' } as any;
    });
    const res = await run();
    expect(jitoSubmit).toHaveBeenCalledTimes(1);
    expect(rpcSubmit).not.toHaveBeenCalled();
    expect(res.error).toMatch(/^ENTRY_REVOKED_AFTER_SEND: .*start lock/);
  });

  it('the send deadline passing after the first Jito send: no resend', async () => {
    const realNow = Date.now.bind(Date);
    jitoConfirm.mockImplementationOnce(async () => {
      vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 120_000); // the confirm wait outlasted the deadline
      return { confirmed: false, error: 'timed out' } as any;
    });
    const res = await run();
    expect(jitoSubmit).toHaveBeenCalledTimes(1);
    expect(rpcSubmit).not.toHaveBeenCalled();
    expect(res.error).toMatch(/^ENTRY_REVOKED_AFTER_SEND: the signal or its market data/);
  });

  it('the RPC watch\'s rebroadcast stop answers for a disarm, a lost lock and the deadline (not only kill and halt)', async () => {
    executionConfig.updateConfig({ jitoMaxRetries: 0 });
    const deadline = Date.now() + 60_000;
    await run({ buyNotAfter: deadline });
    expect(rpcSubmit).toHaveBeenCalledTimes(1);
    const stop = (rpcConfirm.mock.calls[0][3] as any).stopResends as () => string | null;
    expect(stop()).toBeNull();

    coordinator.armLiveTrading(false);
    expect(stop()).toMatch(/disarmed/);
    (coordinator as any).isLiveTradingArmed = true; // armed again: the order was still sent under the earlier arming, so it stays stopped
    (coordinator as any).executionMode = 'LIVE';
    expect(stop()).toMatch(/disarmed/);
  });

  it('the RPC watch\'s rebroadcast stop answers for a lost lock and the deadline', async () => {
    executionConfig.updateConfig({ jitoMaxRetries: 0 });
    await run();
    const stop = (rpcConfirm.mock.calls[0][3] as any).stopResends as () => string | null;
    expect(stop()).toBeNull();
    const lost = vi.spyOn(coordinator as any, 'lostStartLock').mockReturnValue('/tmp/apex-test.db.lock');
    expect(stop()).toMatch(/start lock/);
    lost.mockRestore();
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 120_000);
    expect(stop()).toMatch(/send deadline/);
  });
});
