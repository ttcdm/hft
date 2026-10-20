import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Keypair, PublicKey } from '@solana/web3.js';
import { startValidator, startLocalnetApp, armLive, waitForPosition, LocalMarket, scratch, cleanupScratch, signedTxCount, sleep, type ValidatorHandle, type LocalnetApp } from '../helpers/localnetChain';

/**
 * LONG BEHAVIOUR TEST (R1-1 / N-27): the RPC behind the app's URL starts answering for another chain.
 *
 * The app is armed on validator A and holds a LIVE position bought there. A is stopped and validator B (a new ledger with its own genesis
 * hash) is started on the same port, so the app's Connection object, URL and cached genesis pass are unchanged. After the heartbeat has
 * seen B's genesis, a LIVE trade and a close of the open position must both be refused (the position stays open: P1.6), and B must
 * receive no transaction at all.
 */
const dir = scratch('long-cluster-switch-');
let a: ValidatorHandle;
let b: ValidatorHandle | undefined;
let app: LocalnetApp;
let trader: Keypair;
let mint: PublicKey;
let mintB: PublicKey;

beforeAll(async () => {
  a = await startValidator(dir);
  const market = await LocalMarket.connect(a);
  const signer = await market.signerKeyFile(dir, 5);
  trader = signer.keypair;
  ({ mint } = await market.seedCoin(14, 0.6));
  app = await startLocalnetApp({ dir, validator: a, signerKeyPath: signer.path });
  await armLive(app);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await b?.stop();
  await a?.stop();
  cleanupScratch(dir);
});

describe('cluster switch behind one URL', () => {
  let positionId: string;
  it('buys on chain A (the app is armed and sends there)', async () => {
    const r = await app.call('POST', '/api/execution/trade', { mint: mint.toBase58(), symbol: 'CSW', name: 'ClusterSwitch', amountSol: 0.02, confirmLive: true });
    expect(r.json.success, JSON.stringify(r.json)).toBe(true);
    const pos = await waitForPosition(app, (ps) => ps.find((p) => p.mint === mint.toBase58() && p.status !== 'CLOSED' && p.executionMode === 'LIVE'), 30_000, 'LIVE position');
    positionId = pos.id;
    expect(await signedTxCount(a.conn, trader.publicKey)).toBeGreaterThan(0);
  }, 60_000);

  it('after a new ledger takes the same port and one heartbeat sees it, a trade and a close are refused and nothing reaches the new ledger', async () => {
    const port = Number(new URL(a.url).port);
    await a.stop();
    b = await startValidator(dir, {}, port);
    expect(b.url).toBe(a.url);
    expect(b.genesisHash).not.toBe(a.genesisHash);
    // A market on B too, and SOL for the app's wallet there, so a buy on B would get as far as the send if nothing refused it.
    const marketB = await LocalMarket.connect(b);
    await marketB.fund(trader.publicKey, 5);
    ({ mint: mintB } = await marketB.seedCoin(14, 0.6));
    // wait for the 10 s heartbeat to read B's genesis (a condition, not a timing assertion)
    let cluster: any;
    for (let i = 0; i < 60; i++) {
      cluster = ((await app.call('GET', '/api/system/checks')).json?.checks ?? []).find((c: any) => c.id === 'cluster');
      if (cluster?.status === 'FAIL') break;
      await sleep(500);
    }
    expect(cluster?.status, JSON.stringify(cluster)).toBe('FAIL');
    expect(cluster.detail).toMatch(/CLUSTER_GUARD: genesis hash/);

    const t = await app.call('POST', '/api/execution/trade', { mint: mintB.toBase58(), symbol: 'CSB', name: 'ClusterSwitchB', amountSol: 0.02, confirmLive: true });
    expect(t.json.success).toBe(false);
    expect(t.json.error).toMatch(/CLUSTER_GUARD/);
    const c = await app.call('POST', '/api/execution/close', { positionId, sellPct: 100 });
    // P1.6: the close used to read the wallet's token balance from the new ledger, find none and book the position CLOSED with 0 SOL
    // moved, although the tokens are still on chain A. Now it is refused before any balance read, and the position stays open.
    expect(c.json.success).toBe(false);
    expect(c.json.error).toMatch(/^CLUSTER_GUARD/);
    expect(c.json.solMoved ?? 0).toBe(0);
    const still = ((await app.call('GET', '/api/workstation/positions')).json?.positions ?? []).find((p: any) => p.id === positionId);
    expect(still?.status, JSON.stringify(still)).toBe('OPEN');
    expect(BigInt(still.tokenQuantityRaw)).toBeGreaterThan(0n);
    // B has transactions of its own (the market seeding above); none of them is signed by the app's wallet
    expect(await signedTxCount(b.conn, trader.publicKey)).toBe(0);
    console.log(`[cluster switch] trade: ${t.json.error ?? t.json.message}; close: ${JSON.stringify(c.json)}`);
  }, 90_000);
});
