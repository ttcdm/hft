import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bs58 from 'bs58';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { SolanaRpcTransport } from '../../server/solana/transports';
import { createTradingConnection } from '../../server/solana/rpcConnection';
import { startValidator, startLocalnetApp, armLive, LocalMarket, scratch, cleanupScratch, signedTxCount, type ValidatorHandle, type LocalnetApp } from '../helpers/localnetChain';

/**
 * LONG TEST (S245): a send the RPC refuses with a rate limit, as the public devnet RPC does (HTTP 429, JSON-RPC -32007, "15/second request
 * limit reached"), was not accepted. Real server process, real pump.fun program (LiteSVM), real signer, trading Connection and transports;
 * the fault is the validator's `localnet_failNextSends(count, message, 'http429')`, which refuses before the bank (nothing lands).
 *
 *  - the transport, through the app's own trading Connection, reports it rateLimited and not ambiguous;
 *  - a LIVE close rate-limited twice is resent and lands: one sell on chain, the position CLOSED;
 *  - a close rate-limited past every resend fails RPC_RATE_LIMITED with nothing on chain, and the next close (no SELL_PENDING_VERIFICATION)
 *    sells it;
 *  - the panic (POST /api/wallet/panic-liquidate) with a rate-limited first send still closes the position.
 */
const dir = scratch('long-ratelimit-');
let v: ValidatorHandle;
let market: LocalMarket;
let app: LocalnetApp;
let trader: Keypair;
/** One coin per sell test: the risk engine's per-mint cooldown refuses a second buy of the same mint. */
const coins: PublicKey[] = [];
const sends = async () => signedTxCount(v.conn, trader.publicKey);

async function buy(coin: PublicKey): Promise<string> {
  const r = await app.call('POST', '/api/execution/trade', { mint: coin.toBase58(), symbol: 'RLS', name: 'RateLimited', amountSol: 0.02, confirmLive: true });
  expect(r.json?.success, JSON.stringify(r.json)).toBe(true);
  return r.json.positionId;
}
async function position(id: string): Promise<any> {
  const list = (await app.call('GET', '/api/workstation/positions')).json?.positions ?? [];
  return list.find((p: any) => p.id === id);
}

beforeAll(async () => {
  v = await startValidator(dir);
  market = await LocalMarket.connect(v);
  const signer = await market.signerKeyFile(dir, 5);
  trader = signer.keypair;
  for (let i = 0; i < 3; i++) coins.push((await market.seedCoin(14, 0.6)).mint);
  app = await startLocalnetApp({ dir, validator: v, signerKeyPath: signer.path });
  await armLive(app);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await v?.stop();
  cleanupScratch(dir);
});

describe('S245: rate-limited sends on localnet', () => {
  it('the trading Connection sees a definite, rate-limited refusal (HTTP 429 and the -32007 body alike); nothing lands', async () => {
    const conn = createTradingConnection(v.url);
    const transport = new SolanaRpcTransport(conn);
    const payer = Keypair.generate();
    await v.conn.requestAirdrop(payer.publicKey, LAMPORTS_PER_SOL);
    for (const mode of ['http429', 'rpc32007']) {
      const { blockhash } = await conn.getLatestBlockhash();
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1_000_000 })] }).compileToV0Message());
      tx.sign([payer]);
      await v.rpc('localnet_failNextSends', [1, null, mode]);
      const r = await transport.submit(tx);
      expect(r.success, mode).toBe(false);
      expect(r.rateLimited, mode).toBe(true);
      expect(r.ambiguous, mode).toBe(false);
      expect(r.error).toMatch(mode === 'http429' ? /^429 / : /request limit reached/);
      expect((await v.conn.getSignatureStatuses([bs58.encode(tx.signatures[0])], { searchTransactionHistory: true })).value[0]).toBeNull();
      const again = await transport.submit(tx); // the same signed bytes, resent: accepted once
      expect(again.success).toBe(true);
    }
  });

  it('a close rate-limited twice is resent and lands: one sell on chain, the position CLOSED', async () => {
    const coin = coins[0];
    const id = await buy(coin);
    const before = await sends();
    await v.rpc('localnet_failNextSends', [2, null, 'http429']);
    const c = await app.call('POST', '/api/execution/close', { positionId: id, sellPct: 100 });
    expect(c.json?.success, JSON.stringify(c.json)).toBe(true);
    expect((await sends()) - before).toBe(1);
    expect((await position(id))?.status).toBe('CLOSED');
    expect([0n, null]).toContain(await market.tokenBalance(trader.publicKey, coin));
  });

  it('rate-limited past every resend: RPC_RATE_LIMITED and nothing on chain; the next close is not blocked as pending and sells', async () => {
    const id = await buy(coins[1]);
    const before = await sends();
    await v.rpc('localnet_failNextSends', [4, null, 'http429']); // the first send and its three resends
    const c1 = await app.call('POST', '/api/execution/close', { positionId: id, sellPct: 100 });
    expect(c1.json?.success).toBe(false);
    expect(String(c1.json?.error)).toMatch(/RPC_RATE_LIMITED/);
    expect((await sends()) - before).toBe(0);
    const c2 = await app.call('POST', '/api/execution/close', { positionId: id, sellPct: 100 });
    expect(String(c2.json?.error ?? '')).not.toMatch(/SELL_PENDING_VERIFICATION/);
    expect(c2.json?.success, JSON.stringify(c2.json)).toBe(true);
    expect((await sends()) - before).toBe(1);
    expect((await position(id))?.status).toBe('CLOSED');
  });

  it('the panic with a rate-limited first send still closes the position', async () => {
    const coin = coins[2];
    const id = await buy(coin);
    const before = await sends();
    await v.rpc('localnet_failNextSends', [1, null, 'http429']);
    const p = await app.call('POST', '/api/wallet/panic-liquidate');
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect((await sends()) - before).toBe(1);
    expect((await position(id))?.status).toBe('CLOSED');
    expect([0n, null]).toContain(await market.tokenBalance(trader.publicKey, coin));
  });
});
