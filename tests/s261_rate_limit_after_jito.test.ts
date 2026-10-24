import { describe, it, expect, vi, afterEach } from 'vitest';
import bs58 from 'bs58';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { executionConfig } from '../server/solana/executionConfig';
import { workstationDb } from '../server/db/database';
import { TOKEN_PROGRAM_ID } from '../server/solana/programs';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';

/**
 * S261 (review 2026-10-24, HIGH on S245): a rate-limited RPC send proves only that this send was refused. When the same signed transaction
 * already went to the block engine, that copy may land, so the order must be watched, not booked as never sent (a landed buy marked
 * REVERTED is never sold). With no earlier send, S245's "not accepted" still holds. Real coordinator; transports spied at their methods.
 */
afterEach(() => vi.restoreAllMocks());

function setup() {
  const real = executionConfig.getConfig();
  vi.spyOn(executionConfig, 'getConfig').mockReturnValue({ ...real, jitoBlockEngineUrl: 'http://127.0.0.1:9', enableRpcFallback: true, jitoMaxRetries: 0, jitoRetryIntervalMs: 0 });
  const c = new ExecutionCoordinator(new MockSolanaRpc().createConnection());
  vi.spyOn(c as any, 'getJitoReadiness').mockReturnValue({ ready: true });
  vi.spyOn((c as any).jitoTransport, 'isEnabled').mockReturnValue(true);
  const payer = Keypair.generate().publicKey;
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: payer, recentBlockhash: PublicKey.default.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 5000 })],
  }).compileToV0Message());
  tx.signatures = [new Uint8Array(64).fill(61)];
  const sig = bs58.encode(tx.signatures[0]);
  vi.spyOn(c as any, 'isBlockhashExpired').mockResolvedValue(false);
  vi.spyOn(c, 'checkIfTransactionLanded').mockResolvedValue({ landed: false } as any);
  vi.spyOn((c as any).rpcTransport, 'submitThroughRateLimit').mockResolvedValue({
    signature: sig, transport: 'SOLANA_RPC', success: false, rateLimited: true, ambiguous: false, rateLimitedResends: 0,
    submitDurationMs: 1, lifecycleState: 'SUBMIT_FAILED', error: '429 : {"code":-32007,"message":"15/second request limit reached"}',
  } as any);
  const m = Keypair.generate().publicKey;
  const params = {
    tx, orderId: `s261-${Math.random().toString(36).slice(2)}`, correlationId: 'corr-s261', side: 'BUY' as const, mint: m.toBase58(), mintPubkey: m, owner: payer,
    tokenProgram: TOKEN_PROGRAM_ID, preSnapshot: { timestamp: Date.now(), walletSolLamports: 1e9, tokenBalanceRaw: '0', tokenDecimals: 6, slot: 1 } as any, jitoTipLamports: 0,
  };
  return { c, sig, params, jitoSubmit: vi.spyOn((c as any).jitoTransport, 'submit') };
}

describe('S261: a rate-limited fallback after a block-engine send is watched, not booked as never sent', () => {
  it('the Jito copy went out: the RPC 429 becomes an unknown outcome, the transaction is watched and its landing is reported', async () => {
    const { c, sig, params, jitoSubmit } = setup();
    jitoSubmit.mockResolvedValue({ signature: sig, bundleId: 'b1', transport: 'JITO', success: true, submitDurationMs: 1, lifecycleState: 'BUNDLE_PENDING' } as any);
    const confirm = vi.spyOn((c as any).rpcTransport, 'confirm').mockResolvedValue({ signature: sig, confirmed: true, slot: 9, confirmDurationMs: 1, lifecycleState: 'TX_CONFIRMED' } as any);
    const res = await c.submitAndConfirmWithRetry(params as any);
    expect(confirm).toHaveBeenCalled();
    expect(res).toMatchObject({ success: true, lifecycleState: 'CONFIRMED' });
    expect(workstationDb.loadTransactions(params.orderId).map((t) => t.reconciliationState)).not.toContain('REVERTED');
    c.cleanup();
  });

  it('nothing went out before: the 429 is still "not accepted" (S245), with no watch', async () => {
    const { c, params, jitoSubmit } = setup();
    jitoSubmit.mockResolvedValue({ signature: '', transport: 'JITO', success: false, submitDurationMs: 1, lifecycleState: 'SUBMIT_FAILED', error: 'Failed to submit' } as any);
    const confirm = vi.spyOn((c as any).rpcTransport, 'confirm');
    const res = await c.submitAndConfirmWithRetry(params as any);
    expect(res.error).toMatch(/^RPC_RATE_LIMITED/);
    expect(res.lifecycleState).toBe('SUBMIT_FAILED');
    expect(confirm).not.toHaveBeenCalled();
    c.cleanup();
  });
});
