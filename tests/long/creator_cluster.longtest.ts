import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Keypair, type PublicKey } from '@solana/web3.js';
import { startValidator, startLocalnetApp, LocalMarket, scratch, cleanupScratch, sleep, type ValidatorHandle, type LocalnetApp } from '../helpers/localnetChain';

/**
 * LONG BEHAVIOUR TEST: P4.1 (R1-55, R1-54) on a real chain. The real server runs its pump log stream against the local validator
 * (APEX_PUMP_WS_ONLY on localnet), so create and trade events, the watch window and the funder lookup are the production ones.
 *
 *  (a) the creator launches a coin and funds W; W buys; W sells 25 s later. `/api/watch` must show the launch DEAD with CREATOR_SOLD
 *      (before P4.1 only the creator's own sell counted, and the launch stayed WATCHING).
 *  (b) one funder pays 5 fresh wallets, which buy back to back: the watch window must see one cluster, not 5.
 *
 * Every key is generated here and funded by the local airdrop; the market is moved with the app's own quote and transaction modules.
 */
const dir = scratch('long-creator-cluster-');
let v: ValidatorHandle;
let market: LocalMarket;
let app: LocalnetApp;

type Entry = { state: string; reason?: string; metrics: any };
async function watchEntry(mint: PublicKey): Promise<Entry | undefined> {
  const j = (await app.call('GET', '/api/watch')).json;
  const m = mint.toBase58();
  const w = (j?.watching ?? []).find((x: any) => x.metrics?.mint === m);
  if (w) return w;
  return (j?.released ?? []).find((x: any) => x.metrics?.mint === m);
}
async function waitEntry(mint: PublicKey, pred: (e: Entry) => boolean, timeoutMs: number, label: string): Promise<Entry> {
  const deadline = Date.now() + timeoutMs;
  let last: Entry | undefined;
  while (Date.now() < deadline) {
    last = await watchEntry(mint);
    if (last && pred(last)) return last;
    await sleep(500);
  }
  throw new Error(`${label} not reached in ${timeoutMs} ms; last: ${JSON.stringify(last ? { state: last.state, reason: last.reason, m: { raw: last.metrics.rawUniqueBuyers, unique: last.metrics.uniqueBuyers, cov: last.metrics.funderCoverage } } : null)}`);
}

beforeAll(async () => {
  v = await startValidator(dir);
  market = await LocalMarket.connect(v);
  const signer = await market.signerKeyFile(dir, 2);
  app = await startLocalnetApp({ dir, validator: v, signerKeyPath: signer.path, env: { APEX_PUMP_WS_ONLY: 'true' } });
  // The server subscribes to the log stream after boot: a launch the window picks up shows the subscription is live.
  for (let i = 0; i < 8; i++) {
    const probe = await market.createCoin('PRB');
    try { await waitEntry(probe, () => true, 5_000, 'probe launch in /api/watch'); return; } catch { /* not subscribed yet */ }
  }
  throw new Error('the server never watched a launch: its pump log stream did not subscribe to the validator');
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await v?.stop();
  cleanupScratch(dir);
});

describe('P4.1 on localnet: the creator cluster and the funder lookup', () => {
  it('(a) a wallet the creator funded buys and sells 25 s later: DEAD CREATOR_SOLD', async () => {
    const mint = await market.createCoin('CCS');
    const W = Keypair.generate();
    await market.transfer(market.creator, W.publicKey, 1);
    await market.buy(W, mint, 0.3);
    await market.buy(await market.fresh(1), mint, 0.2); // organic demand, so no other rule releases the launch first
    const watching = await waitEntry(mint, (e) => e.state === 'WATCHING' && e.metrics.tradeCount >= 2, 15_000, 'both buys in the window');
    expect(watching.metrics.creatorClusterBuySol).toBeGreaterThan(0); // W's buy is the creator's, not demand
    await sleep(25_000);
    await market.sell(W, mint, 1);
    const r = await waitEntry(mint, (e) => e.state !== 'WATCHING', 15_000, 'a verdict after W sold');
    expect(r.state).toBe('DEAD');
    expect(r.reason).toMatch(/^CREATOR_SOLD/);
    expect(r.metrics.creatorSold).toBe(true);
  });

  it('(b) five wallets paid by one funder buy back to back: one cluster, not five', async () => {
    const mint = await market.createCoin('ONE');
    const funder = await market.fresh(5);
    const wallets = Array.from({ length: 5 }, () => Keypair.generate());
    for (const w of wallets) await market.transfer(funder, w.publicKey, 0.5);
    await Promise.all(wallets.map((w) => market.buy(w, mint, 0.1)));
    const e = await waitEntry(mint, (x) => x.metrics.rawUniqueBuyers === 5 && x.metrics.funderCoverage === 1, 30_000, 'all 5 funders known');
    expect(e.metrics.uniqueBuyers).toBe(1);
    expect(e.metrics.largestBuyerShare).toBeCloseTo(1, 9);
  });
});
