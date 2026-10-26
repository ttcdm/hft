import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import bs58 from 'bs58';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { SolanaRpcTransport, confirmPacing } from '../server/solana/transports';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { executionConfig } from '../server/solana/executionConfig';
import { txBuilder } from '../server/solana/transactionBuilder';
import { workstationDb } from '../server/db/database';
import { TOKEN_PROGRAM_ID } from '../server/solana/programs';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';

/**
 * S252 (P2.1, R1-20/R1-69/R1-77): on devnet each order used to be sent once and watched for a fixed 15 s, though its blockhash stays valid
 * for longer. Run 4 (2026-10-24) lost a buy that way, unconfirmed at 15 s. `SolanaRpcTransport.confirm` now resends the same signed bytes
 * (`maxRetries: 0`, same signature) and watches until the confirmed block height passes the blockhash's lastValidBlockHeight. Past it, with
 * no status even in history, the answer is EXPIRED_BLOCKHASH: a definite "never landed", which the coordinator books as TIMED_OUT.
 * Real SolanaRpcTransport and coordinator; the Connection is scripted, and the confirm clock (confirmPacing) is virtual, so nothing waits.
 */
let clock = 0;
beforeEach(() => {
  clock = 1_000_000;
  vi.spyOn(confirmPacing, 'now').mockImplementation(() => clock);
  vi.spyOn(confirmPacing, 'sleep').mockImplementation(async (ms: number) => { clock += ms; });
});
afterEach(() => vi.restoreAllMocks());

const RAW = Uint8Array.from([1, 2, 3, 4]);
/** The signed transaction as submit sees it: its bytes and (unused here) signatures. */
const TX = { serialize: () => RAW, signatures: [] } as any;
const confirmed = { slot: 77, confirmations: 1, err: null, confirmationStatus: 'confirmed' };

/** A scripted Connection: `statuses` answers each status poll in turn (an Error is thrown); the last entry repeats. */
function conn(statuses: Array<unknown>, height: () => number = () => 100) {
  let i = 0;
  return {
    getSignatureStatuses: vi.fn(async (_sigs?: string[], _o?: any) => {
      const v = statuses[Math.min(i++, statuses.length - 1)];
      if (v instanceof Error) throw v;
      return { context: { slot: 1 }, value: [v] };
    }),
    sendRawTransaction: vi.fn(async () => 'sig'),
    getBlockHeight: vi.fn(async () => height()),
    getTransaction: vi.fn(async () => null),
  };
}

describe('S252: SolanaRpcTransport.confirm resends the same bytes until the blockhash expires', () => {
  it('two rounds unseen, then confirmed: the same raw bytes were resent through submit with maxRetries 0, and no getTransaction was made', async () => {
    const c = conn([null, null, null, null, null, null, null, null, confirmed]);
    const r = await new SolanaRpcTransport(c as any).confirm('sig', 15_000, undefined, { rebroadcast: TX, lastValidBlockHeight: 500, resendEveryMs: 1_200 });
    expect(r).toMatchObject({ confirmed: true, lifecycleState: 'TX_CONFIRMED', slot: 77 });
    expect(c.sendRawTransaction.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of c.sendRawTransaction.mock.calls as any[]) {
      expect(call[0]).toBe(RAW);
      expect(call[1]).toMatchObject({ skipPreflight: true, maxRetries: 0 });
    }
    expect(c.getTransaction).not.toHaveBeenCalled();
  });

  it('a status read that throws once does not end the watch', async () => {
    const c = conn([new Error('fetch failed'), confirmed]);
    const r = await new SolanaRpcTransport(c as any).confirm('sig', 15_000, undefined, { rebroadcast: TX, lastValidBlockHeight: 500 });
    expect(r.confirmed).toBe(true);
  });

  it('a failing resend does not end the watch', async () => {
    const c = conn([null, null, null, null, null, confirmed]);
    c.sendRawTransaction.mockRejectedValue(new Error('socket hang up'));
    const r = await new SolanaRpcTransport(c as any).confirm('sig', 15_000, undefined, { rebroadcast: TX, lastValidBlockHeight: 500, resendEveryMs: 400 });
    expect(r.confirmed).toBe(true);
  });

  it('still valid at 15 s: the watch goes on; past lastValidBlockHeight with no status anywhere: EXPIRED_BLOCKHASH', async () => {
    const c = conn([null], () => (clock - 1_000_000 < 30_000 ? 500 : 501));
    const r = await new SolanaRpcTransport(c as any).confirm('sig', 15_000, undefined, { rebroadcast: TX, lastValidBlockHeight: 500 });
    expect(r.lifecycleState).toBe('EXPIRED_BLOCKHASH');
    expect(r.confirmed).toBe(false);
    expect(r.error).toMatch(/^BLOCKHASH_EXPIRED/);
    expect(c.getBlockHeight).toHaveBeenCalledWith('confirmed');
    expect(c.getSignatureStatuses.mock.calls.at(-1)).toEqual([['sig'], { searchTransactionHistory: true }]);
    expect(c.getSignatureStatuses.mock.calls[0]).toEqual([['sig'], { searchTransactionHistory: false }]);
  });

  it('the history search finds it on the last look: confirmed, not expired', async () => {
    const c = conn([null], () => 501);
    c.getSignatureStatuses.mockImplementation(async (_s?: string[], o?: any) => ({ context: { slot: 1 }, value: [o?.searchTransactionHistory ? confirmed : null] }) as any);
    const r = await new SolanaRpcTransport(c as any).confirm('sig', 15_000, undefined, { lastValidBlockHeight: 500 });
    expect(r.confirmed).toBe(true);
  });

  it('a block height that cannot be read is not expiry: TIMED_OUT at the hard stop', async () => {
    const c = conn([null]);
    c.getBlockHeight.mockRejectedValue(new Error('503'));
    const r = await new SolanaRpcTransport(c as any).confirm('sig', 15_000, undefined, { lastValidBlockHeight: 500, maxExtendMs: 10_000 });
    expect(r.lifecycleState).toBe('TIMED_OUT');
  });

  it('without a lastValidBlockHeight it stops at maxWaitMs as before, TIMED_OUT, and reads no block height', async () => {
    const c = conn([null]);
    const r = await new SolanaRpcTransport(c as any).confirm('sig', 15_000);
    expect(r.lifecycleState).toBe('TIMED_OUT');
    expect(c.getBlockHeight).not.toHaveBeenCalled();
    expect(c.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('a status with an error is REVERTED at once', async () => {
    const c = conn([{ slot: 9, confirmations: 1, err: { InstructionError: [3, { Custom: 6002 }] }, confirmationStatus: 'confirmed' }]);
    const r = await new SolanaRpcTransport(c as any).confirm('sig', 15_000, undefined, { rebroadcast: TX, lastValidBlockHeight: 500 });
    expect(r.lifecycleState).toBe('REVERTED');
  });
});

describe('S252: the coordinator books an expired, unlanded RPC send as TIMED_OUT, not unconfirmed', () => {
  it('a BUY whose confirm says EXPIRED_BLOCKHASH and that did not land: SUBMIT_FAILED, row TIMED_OUT, the mint is not held, and the confirm got the bytes and height', async () => {
    const real = executionConfig.getConfig();
    vi.spyOn(executionConfig, 'getConfig').mockReturnValue({ ...real, jitoBlockEngineUrl: '' });
    const c = new ExecutionCoordinator(new MockSolanaRpc().createConnection());
    const payer = Keypair.generate().publicKey;
    const blockhash = Keypair.generate().publicKey.toBase58();
    await txBuilder.getRecentBlockhash({ getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 4_321 }) } as any, true);
    const tx = new VersionedTransaction(new TransactionMessage({
      payerKey: payer, recentBlockhash: blockhash,
      instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 5000 })],
    }).compileToV0Message());
    tx.signatures = [new Uint8Array(64).fill(52)];
    const sig = bs58.encode(tx.signatures[0]);
    vi.spyOn((c as any).rpcTransport, 'submit').mockResolvedValue({ signature: sig, transport: 'SOLANA_RPC', success: true, submitDurationMs: 1, lifecycleState: 'BUNDLE_PENDING' } as any);
    const confirm = vi.spyOn((c as any).rpcTransport, 'confirm').mockResolvedValue({
      signature: sig, confirmed: false, confirmDurationMs: 1, lifecycleState: 'EXPIRED_BLOCKHASH',
      error: 'BLOCKHASH_EXPIRED: the transaction did not land and its blockhash is no longer valid; safe to retry with a new transaction',
    } as any);
    vi.spyOn(c, 'checkIfTransactionLanded').mockResolvedValue({ landed: false } as any);
    const m = Keypair.generate().publicKey;
    const orderId = `s252-${Math.random().toString(36).slice(2)}`;
    const res = await c.submitAndConfirmWithRetry({
      tx, orderId, correlationId: 'corr-s252', side: 'BUY', mint: m.toBase58(), mintPubkey: m, owner: payer, tokenProgram: TOKEN_PROGRAM_ID,
      preSnapshot: { timestamp: Date.now(), walletSolLamports: 1e9, tokenBalanceRaw: '0', tokenDecimals: 6, slot: 1 } as any, jitoTipLamports: 0,
    } as any);
    expect(res).toMatchObject({ success: false, lifecycleState: 'SUBMIT_FAILED' });
    expect(res.unconfirmed).toBeFalsy();
    expect(res.error).toMatch(/^BLOCKHASH_EXPIRED/);
    const opts = confirm.mock.calls[0][3] as any;
    expect(opts.rebroadcast).toBe(tx);
    expect(opts.lastValidBlockHeight).toBe(4_321);
    expect(workstationDb.loadTransactions(orderId).map((t) => t.reconciliationState)).toEqual(['TIMED_OUT']);
    expect(workstationDb.hasUnresolvedLiveBuy(m.toBase58())).toBe(false);
    c.cleanup();
  });
});
