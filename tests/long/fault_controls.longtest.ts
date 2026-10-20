import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bs58 from 'bs58';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { SolanaRpcTransport } from '../../server/solana/transports';
import { startValidator, scratch, cleanupScratch, type ValidatorHandle } from '../helpers/localnetChain';

/**
 * LONG TEST (P1.2): the validator's two newer fault controls do what scripts/localnet/README.md says, seen through the app's real
 * `SolanaRpcTransport` and a plain web3.js `Connection` (the only way the app talks to an RPC):
 *
 *  - `localnet_landThenFailNextSend`: the transaction is executed in the bank, the HTTP reply is a 502, so the transport's send
 *    throws while the chain holds the signature; the control is one-shot.
 *  - `localnet_failNextReads(n, method, address?, mode?)`: exactly the next n calls of that method (only those naming the address,
 *    when given) fail; the JSON-RPC mode makes web3.js throw, the 429 mode is absorbed by web3.js's own 429 retry unless that retry
 *    is turned off.
 *
 * The validator runs in its own process (tests/helpers/localnetChain.ts); nothing inside the app is mocked.
 */
const dir = scratch('long-faults-');
let v: ValidatorHandle;
let conn: Connection;
let transport: SolanaRpcTransport;
let payer: Keypair;

async function transfer(to: PublicKey, lamports = 0.01 * LAMPORTS_PER_SOL): Promise<VersionedTransaction> {
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports })] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  return tx;
}
const sigOf = (tx: VersionedTransaction) => bs58.encode(tx.signatures[0]);
const statusOf = async (sig: string) => (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];

beforeAll(async () => {
  v = await startValidator(dir);
  conn = new Connection(v.url, 'confirmed');
  transport = new SolanaRpcTransport(conn);
  payer = Keypair.generate();
  await conn.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
}, 120_000);

afterAll(async () => {
  await v?.stop();
  cleanupScratch(dir);
});

describe('localnet_landThenFailNextSend', () => {
  it('the send lands in the bank, the transport sees a 502, and the next send is answered normally', async () => {
    const to = Keypair.generate().publicKey;
    const tx = await transfer(to);
    const sig = sigOf(tx);
    await v.rpc('localnet_landThenFailNextSend');

    const r = await transport.submit(tx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^502 Bad Gateway/);
    // P1.5: the transport keeps the signature and says the outcome is unknown (it was forwarded), so the coordinator watches it
    expect(r.ambiguous).toBe(true);
    expect(r.signature).toBe(sig);
    // The chain has it: confirmed status, the recipient was credited, and the validator lists it as landed-then-failed.
    expect((await statusOf(sig))?.err).toBeNull();
    expect(await conn.getBalance(to)).toBe(0.01 * LAMPORTS_PER_SOL);
    expect((await transport.confirm(sig, 5_000)).lifecycleState).toBe('TX_CONFIRMED');
    expect((await v.rpc('localnet_stats')).landedThenFailed).toEqual([sig]);

    // One-shot: the next send gets its normal reply with the signature.
    const tx2 = await transfer(Keypair.generate().publicKey);
    const r2 = await transport.submit(tx2);
    expect(r2.success).toBe(true);
    expect(r2.signature).toBe(sigOf(tx2));
    expect((await v.rpc('localnet_stats')).landedThenFailed).toEqual([sig]);
  });

  it('stays armed past a send that is refused before the bank, and fires on the next one that executes', async () => {
    await v.rpc('localnet_failNextSends', [1]);
    await v.rpc('localnet_landThenFailNextSend');
    const refused = await transfer(Keypair.generate().publicKey);
    const r1 = await transport.submit(refused);
    expect(r1.error).toMatch(/injected send failure/);
    expect(await statusOf(sigOf(refused))).toBeNull();

    const tx = await transfer(Keypair.generate().publicKey);
    const r2 = await transport.submit(tx);
    expect(r2.error).toMatch(/^502 Bad Gateway/);
    expect((await statusOf(sigOf(tx)))?.err).toBeNull();
  });
});

describe('localnet_failNextReads', () => {
  it('fails exactly the next n getSignatureStatuses calls: confirm keeps polling past them (P1.5) and only times out while they last', async () => {
    const tx = await transfer(Keypair.generate().publicKey);
    const sig = (await transport.submit(tx)).signature;
    expect(sig).toBe(sigOf(tx));
    // P1.5: a failed status read inside confirm no longer ends it; the poll after the two failures confirms
    await v.rpc('localnet_failNextReads', [2, 'getSignatureStatuses']);
    expect((await transport.confirm(sig, 5_000)).lifecycleState).toBe('TX_CONFIRMED');
    // while every read fails, the confirm times out and says why
    await v.rpc('localnet_failNextReads', [50, 'getSignatureStatuses']);
    const c = await transport.confirm(sig, 700);
    expect(c.lifecycleState).toBe('TIMED_OUT');
    expect(c.error).toMatch(/failed to get signature status: localnet: injected read failure/);
    await v.rpc('localnet_failNextReads', [0, 'getSignatureStatuses']); // a count of 0 clears the rule
    expect((await transport.confirm(sig, 5_000)).lifecycleState).toBe('TX_CONFIRMED');
  });

  it('with an address, only reads naming that address fail; other methods and other addresses are untouched', async () => {
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    await v.rpc('localnet_failNextReads', [1, 'getBalance', a.toBase58()]);

    expect(await conn.getBalance(b)).toBe(0);
    expect(await conn.getAccountInfo(a)).toBeNull(); // another method naming the address
    await expect(conn.getBalance(a)).rejects.toThrow(/injected read failure \(getBalance\)/);
    expect(await conn.getBalance(a)).toBe(0); // consumed
  });

  it('429 mode: web3.js retries the 429 itself, so a single injected 429 is absorbed; with the retry off it throws', async () => {
    const to = Keypair.generate().publicKey;
    const tx = await transfer(to);
    const sig = (await transport.submit(tx)).signature;

    await v.rpc('localnet_failNextReads', [1, 'getSignatureStatuses', sig, 'http429']);
    const before = (await v.methodCounts()).getSignatureStatuses ?? 0;
    expect((await transport.confirm(sig, 10_000)).lifecycleState).toBe('TX_CONFIRMED');
    // the 429'd attempt plus web3.js's retry of it (the confirm's own later poll is not needed: the retry answered confirmed)
    expect(((await v.methodCounts()).getSignatureStatuses ?? 0) - before).toBe(2);

    const noRetry = new Connection(v.url, { commitment: 'confirmed', disableRetryOnRateLimit: true });
    await v.rpc('localnet_failNextReads', [1, 'getBalance', to.toBase58(), 'http429']);
    await expect(noRetry.getBalance(to)).rejects.toThrow(/429 Too Many Requests/);
    expect(await noRetry.getBalance(to)).toBe(0.01 * LAMPORTS_PER_SOL);
  });

  it('refuses to arm a read failure on sendTransaction or on a control method', async () => {
    await expect(v.rpc('localnet_failNextReads', [1, 'sendTransaction'])).rejects.toThrow(/name a read method/);
    await expect(v.rpc('localnet_failNextReads', [1, 'localnet_stats'])).rejects.toThrow(/name a read method/);
    expect((await v.rpc('localnet_stats')).unsupported).toEqual([]);
  });
});
