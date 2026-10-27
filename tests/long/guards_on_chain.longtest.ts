import fs from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Keypair, PublicKey } from '@solana/web3.js';
import { startValidator, startLocalnetApp, armLive, waitForPosition, LocalMarket, scratch, cleanupScratch, signedTxCount, sleep, type ValidatorHandle, type LocalnetApp } from '../helpers/localnetChain';

/**
 * LONG BEHAVIOUR TEST 3: the guards, exercised against a real chain with real failures.
 *
 *  (a) a server whose allowed cluster does not match the chain's genesis can neither arm nor send, however it is asked;
 *  (b) a competing buy that lands between the app's quote and its send makes the app's transaction REVERT on chain: the app
 *      reports the failure, books no position, and the cooldown blocks the next buy;
 *  (c) a send that fails at the RPC leaves no position and causes no second buy;
 *  (d) a second LIVE buy of a mint that is already open is refused (Q16);
 *  (e) a PAPER position is never sold on chain.
 *
 * Failures are injected by the validator's own test controls (front-run, failed send); nothing is mocked inside the app.
 */
const dir = scratch('long-guards-');
let v: ValidatorHandle;
let market: LocalMarket;
let trader: Keypair;
let signerPath: string;

const positionsOf = async (app: LocalnetApp) => ((await app.call('GET', '/api/workstation/positions')).json?.positions ?? []) as any[];
/** Transactions signed by the app's wallet (seeding and the rival's buy are signed by other keys). */
const sendsOf = async () => signedTxCount(v.conn, trader.publicKey);

beforeAll(async () => {
  v = await startValidator(dir);
  market = await LocalMarket.connect(v);
  const signer = await market.signerKeyFile(dir, 5);
  trader = signer.keypair;
  signerPath = signer.path;
}, 180_000);

afterAll(async () => {
  await v?.stop();
  cleanupScratch(dir);
});

describe('(a) wrong cluster: the chain answers with a genesis the server does not allow', () => {
  let app: LocalnetApp;
  let mint: PublicKey;
  beforeAll(async () => {
    ({ mint } = await market.seedCoin(6, 0.6));
    // The server is told devnet; the validator's genesis is its own random hash, so every check must fail closed.
    app = await startLocalnetApp({ dir: scratch('long-guards-devnet-'), validator: v, signerKeyPath: signerPath, env: { ALLOWED_CLUSTER: 'devnet', LOCALNET_GENESIS_HASH: '' }, confluenceThreshold: 0 });
  }, 120_000);
  afterAll(() => app?.stop());

  it('can-arm says no with the cluster reason, arming is 403, and the mode stays PAPER', async () => {
    await sleep(3_000);
    const can = (await app.call('GET', '/api/execution/can-arm')).json;
    expect(can.allowed).toBe(false);
    expect(can.reasons.join(' ')).toMatch(/RPC health is DISCONNECTED|cluster|genesis/i);
    expect(app.logs()).toMatch(/CLUSTER_GUARD: genesis hash .* does not match allowed cluster devnet/);
    const arm = await app.call('POST', '/api/execution/arm', { arm: true, confirmationCode: 'CONFIRM_LIVE_TRADING_RISK' });
    expect(arm.status).toBe(403);
    expect((await app.call('GET', '/api/execution/mode')).json.mode).toBe('PAPER');
  });

  it('a trade is never LIVE: it is refused, no transaction reaches the chain, and the wallet holds nothing', async () => {
    const before = await sendsOf();
    const r = await app.call('POST', '/api/execution/trade', { mint: mint.toBase58(), symbol: 'LNG', name: 'LongTest', amountSol: 0.02, confirmLive: true });
    // R5-40: the route runs executeSnipe's gates, and a PAPER buy needs a SOL/USD reading (C3). This server is told devnet with external
    // feeds off, so it has none (LOCALNET_FIXED is read on localnet only): it is refused before any read. It used to fill as PAPER at the
    // caller's price, which the route no longer takes.
    expect(r.json.success, JSON.stringify(r.json)).toBe(false);
    expect(r.json.executionMode).not.toBe('LIVE');
    expect(r.json.error).toMatch(/SOL_PRICE_UNAVAILABLE/);
    expect(await sendsOf()).toBe(before);
    expect(await market.tokenBalance(trader.publicKey, mint)).toBeNull();
  });

  it('switching the RPC through the config route to the same chain (under another host name) is refused by the genesis check', async () => {
    // The same validator reached as "localhost" is a new endpoint for the app, so the switch runs the cluster check: its genesis is
    // not devnet's, so the switch must be refused and nothing may change.
    const alias = v.url.replace('127.0.0.1', 'localhost');
    const r = await app.call('POST', '/api/wallet/config', { walletAddress: trader.publicKey.toBase58(), rpcEndpoint: alias, riskLimits: {} });
    expect(r.status, JSON.stringify(r.json)).toBe(400);
    expect(JSON.stringify(r.json)).toMatch(/CLUSTER_GUARD/);
    expect((await app.call('GET', '/api/execution/can-arm')).json.allowed).toBe(false);
    expect((await app.call('GET', '/api/wallet/state')).json?.data?.config?.rpcEndpoint ?? v.url).not.toBe(alias);
  });
});

describe('(b)-(e) failures on the right cluster', () => {
  let app: LocalnetApp;
  beforeAll(async () => {
    app = await startLocalnetApp({ dir, validator: v, signerKeyPath: signerPath, confluenceThreshold: 0 });
    await armLive(app);
  }, 180_000);
  afterAll(() => app?.stop());

  it('(b) a front-run moves the price past the slippage limit: the app\'s buy reverts on chain, no position, no tokens, then the cooldown', async () => {
    const { mint } = await market.seedCoin(14, 0.6);
    // A rival buy of 1.5 SOL lands immediately before the app's own transaction (validator control). With slippageBps 1 the app's
    // max-cost is exceeded and the program rejects it: a REAL on-chain revert, not a simulated one.
    const rival = await market.fresh(3);
    const state = await market.state(mint);
    const curve = (await import('../../server/solana/pumpCurve')).PumpCurveService;
    const builder = (await import('../../server/solana/transactionBuilder')).txBuilder;
    const q = curve.calculateBuyQuote({ state, amountSol: 1.5, slippageBps: 3000, jitoTipSol: 0, priorityFeeLamports: 0, executionMode: 'LIVE' });
    const rivalTx = await builder.buildBuyTransaction(v.conn, {
      buyer: rival.publicKey, mint, bondingCurve: state.bondingCurve, associatedBondingCurve: state.associatedBondingCurve,
      associatedUser: curve.getAssociatedTokenAddress(mint, rival.publicKey, state.tokenProgram), creator: state.creator,
      feeRecipient: state.feeRecipient, buybackFeeRecipient: state.buybackFeeRecipient, quoteMint: state.quoteMint,
      tokenProgram: state.tokenProgram, quoteTokenProgram: state.quoteTokenProgram, amountTokens: BigInt(q.tokenAmountRaw),
      maxSolCostLamports: BigInt(q.maxInputLamports), computeUnits: 300_000, priorityFeeMicroLamports: 1000, jitoTipLamports: 0n,
    });
    rivalTx.sign([rival]);
    await v.rpc('localnet_frontrunNext', [Buffer.from(rivalTx.serialize()).toString('base64')]);

    const before = await sendsOf();
    const r = await app.call('POST', '/api/execution/trade', { mint: mint.toBase58(), symbol: 'LNG', name: 'LongTest', amountSol: 0.02, slippageBps: 1, confirmLive: true });
    expect(r.json.success).toBe(false);
    expect(r.json.lifecycleState).toBe('REVERTED');
    expect(await sendsOf()).toBe(before + 1); // it was sent once and rejected by the program; never resent
    const open = (await positionsOf(app)).filter((p) => p.mint === mint.toBase58() && p.status !== 'CLOSED');
    expect(open).toEqual([]);
    const bal = await market.tokenBalance(trader.publicKey, mint);
    expect(bal === null || bal === 0n).toBe(true);
    // the revert is on the book as a REVERTED transaction, and the app cools down before the next buy
    const next = await app.call('POST', '/api/execution/trade', { mint: mint.toBase58(), symbol: 'LNG', name: 'LongTest', amountSol: 0.02, confirmLive: true });
    expect(next.json.success).toBe(false);
    expect(String(next.json.error)).toMatch(/Cooling down|EXECUTION_DISABLED/);
    expect(await sendsOf()).toBe(before + 1);
  }, 180_000);

  it('(c) a send the RPC refuses leaves no position and is not retried into a double buy', async () => {
    await sleep(16_000); // past the failure cooldown
    const { mint } = await market.seedCoin(14, 0.6);
    await v.rpc('localnet_failNextSends', [1]);
    const r = await app.call('POST', '/api/execution/trade', { mint: mint.toBase58(), symbol: 'LNG', name: 'LongTest', amountSol: 0.02, confirmLive: true });
    expect(r.json.success).toBe(false);
    expect(r.json.lifecycleState).toBe('SUBMIT_FAILED');
    const open = (await positionsOf(app)).filter((p) => p.mint === mint.toBase58() && p.status !== 'CLOSED');
    expect(open).toEqual([]);
    const bal = await market.tokenBalance(trader.publicKey, mint);
    expect(bal === null || bal === 0n).toBe(true);
    // the write-ahead row of a send that definitely did not go out is REVERTED, so it does not block the mint forever;
    // after the cooldowns (15 s failure pause, 30 s per-mint) the same mint can be bought and lands exactly once
    await sleep(31_000);
    const again = await app.call('POST', '/api/execution/trade', { mint: mint.toBase58(), symbol: 'LNG', name: 'LongTest', amountSol: 0.02, confirmLive: true });
    expect(again.json.success, JSON.stringify(again.json)).toBe(true);
    const rows = (await positionsOf(app)).filter((p) => p.mint === mint.toBase58() && p.status !== 'CLOSED');
    expect(rows.length).toBe(1);
    expect(await market.tokenBalance(trader.publicKey, mint)).toBe(BigInt(rows[0].tokenQuantityRaw));
  }, 180_000);

  it('(d) a second LIVE buy of a mint that is already open is refused and sends nothing (Q16)', async () => {
    const open = (await positionsOf(app)).filter((p) => p.executionMode === 'LIVE' && p.status !== 'CLOSED');
    expect(open.length).toBeGreaterThan(0);
    await sleep(31_000); // past the 30 s per-mint cooldown, so the refusal we see is the open-row guard, not the cooldown
    const before = await sendsOf();
    const r = await app.call('POST', '/api/execution/trade', { mint: open[0].mint, symbol: 'LNG', name: 'LongTest', amountSol: 0.02, confirmLive: true });
    expect(r.json.success).toBe(false);
    expect(String(r.json.error)).toMatch(/POSITION_ALREADY_OPEN/);
    expect(await sendsOf()).toBe(before);
    expect((await positionsOf(app)).filter((p) => p.mint === open[0].mint && p.status !== 'CLOSED').length).toBe(1);
  }, 60_000);

  it('(e) a PAPER position is closed in the book only: no chain transaction, the wallet unchanged', async () => {
    // disarm -> PAPER, open a paper position on a fresh coin, close it
    const dis = await app.call('POST', '/api/execution/arm', { arm: false });
    expect(dis.status, JSON.stringify(dis.json)).toBe(200);
    const { mint } = await market.seedCoin(14, 0.6); // enough liquidity for the eligibility gate
    const before = await sendsOf();
    const r = await app.call('POST', '/api/execution/trade', { mint: mint.toBase58(), symbol: 'LNG', name: 'LongTest', amountSol: 0.02, confirmLive: true });
    expect(r.json.success, JSON.stringify(r.json)).toBe(true);
    expect(r.json.executionMode).toBe('PAPER');
    const c = await app.call('POST', '/api/execution/close', { positionId: r.json.positionId, sellPct: 100 });
    expect(c.json.success, JSON.stringify(c.json)).toBe(true);
    const row = await waitForPosition(app, (ps) => ps.find((p) => p.id === r.json.positionId && p.status === 'CLOSED'), 10_000, 'paper close');
    expect(row.executionMode).toBe('PAPER');
    expect(await sendsOf()).toBe(before);
    expect(await market.tokenBalance(trader.publicKey, mint)).toBeNull();
  }, 90_000);

  it('the validator saw no RPC method it does not implement', async () => {
    expect((await v.rpc('localnet_stats')).unsupported).toEqual([]);
  });
});
