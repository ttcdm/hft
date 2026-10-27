import fs from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Keypair, PublicKey } from '@solana/web3.js';
import { startValidator, startLocalnetApp, armLive, waitForPosition, LocalMarket, scratch, cleanupScratch, signedTxCount, sleep, type ValidatorHandle, type LocalnetApp } from '../helpers/localnetChain';

/**
 * LONG BEHAVIOUR TEST 1: a LIVE position's whole life on a real chain flow.
 *
 * Real server process, real HTTP API and auth, real pump.fun program (LiteSVM), real signer, real reconciler and SQLite, the
 * real 3-second exit loop. The market is moved by other wallets buying and selling on the same curve, so the take-profit,
 * trailing-stop and stop-loss exits are triggered by on-chain prices, not by injected marks.
 *
 * Every assertion is an outcome: a row in the app's book, a balance on the chain, a count of what reached the RPC.
 */
const dir = scratch('long-lifecycle-');
let v: ValidatorHandle;
let market: LocalMarket;
let app: LocalnetApp;
let trader: Keypair;
let coinA: PublicKey;
let holdersA: Keypair[];
let positionId: string;
let entryPrice: number;
let qtyAfterBuy: bigint;

/** Transactions signed by the app's wallet (the market's own buys and sells are signed by other keys). */
const sends = async () => signedTxCount(v.conn, trader.publicKey);
const chainQty = async (mint: PublicKey) => market.tokenBalance(trader.publicKey, mint);
const position = async (id: string) => ((await app.call('GET', '/api/workstation/positions')).json?.positions ?? []).find((p: any) => p.id === id);
/** /api/wallet/state rounds SOL figures to 4 decimals; one rounding step is the tolerance. */
const closeTo = (a: number, b: number) => Math.abs(a - b) <= 0.0001 + 1e-9;
/** Sum of realized PnL over every LIVE row: what the day's ledger must equal. */
const liveRealizedSum = async () => ((await app.call('GET', '/api/workstation/positions')).json?.positions ?? []).filter((x: any) => x.executionMode === 'LIVE').reduce((a: number, x: any) => a + (x.realizedPnLSol ?? 0), 0);

beforeAll(async () => {
  v = await startValidator(dir);
  market = await LocalMarket.connect(v);
  const signer = await market.signerKeyFile(dir, 5);
  trader = signer.keypair;
  ({ mint: coinA, wallets: holdersA } = await market.seedCoin(14, 0.6));
  app = await startLocalnetApp({ dir, validator: v, signerKeyPath: signer.path, confluenceThreshold: 0 });
  await armLive(app);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await v?.stop();
  cleanupScratch(dir);
});

describe('LIVE lifecycle on a real curve: buy, partial sell, take-profit, trailing stop, stop-loss, kill switch, PAPER', () => {
  it('arms LIVE only on the validator genesis and reports the mode truthfully', async () => {
    const mode = (await app.call('GET', '/api/execution/mode')).json;
    expect(mode.mode).toBe('LIVE');
    expect(mode.isLiveArmed).toBe(true);
    const diag = (await app.call('GET', '/api/diagnostics/system')).json;
    expect(diag.systemAudit.allowedCluster).toBe('localnet');
    expect(diag.systemAudit.walletPubkey).toBe(trader.publicKey.toBase58());
  });

  it('a 0.02 SOL buy lands: exactly one transaction sent, the book equals the chain, entry price is the curve price', async () => {
    const before = await sends();
    const spot = await market.priceSol(coinA);
    const r = await app.call('POST', '/api/execution/trade', { mint: coinA.toBase58(), symbol: 'LNG', name: 'LongTest', amountSol: 0.02, confirmLive: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.success).toBe(true);
    expect(r.json.executionMode).toBe('LIVE');
    expect(r.json.lifecycleState).toBe('CONFIRMED');
    positionId = r.json.positionId;
    expect((await sends()) - before).toBe(1);

    const p = await position(positionId);
    expect(p.status).toBe('OPEN');
    expect(p.executionMode).toBe('LIVE');
    qtyAfterBuy = BigInt(p.tokenQuantityRaw);
    expect(qtyAfterBuy > 0n).toBe(true);
    expect(await chainQty(coinA)).toBe(qtyAfterBuy);
    // Entry = SOL that went into the curve / tokens received: at most the ~1.3% curve fee plus the order's own impact above spot,
    // never the rent or the network fee (P2/F1/Q1).
    entryPrice = p.entryPriceSol;
    expect(entryPrice).toBeGreaterThan(spot * 0.995);
    expect(entryPrice).toBeLessThan(spot * 1.03);
    expect(p.costBasisLamports).toBeGreaterThan(20_000_000); // the all-in wallet delta includes rent and fee
  });

  it('a 50% manual close sells half on chain, books realized PnL once, and the daily ledger agrees with the row', async () => {
    const before = await sends();
    const r = await app.call('POST', '/api/execution/close', { positionId, sellPct: 50, reason: 'Operator close' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.success).toBe(true);
    expect((await sends()) - before).toBe(1);
    const p = await position(positionId);
    expect(p.status).toBe('PARTIALLY_CLOSED');
    const onChain = await chainQty(coinA);
    expect(onChain).toBe(BigInt(p.tokenQuantityRaw));
    // half the tokens left, to within rounding of one base unit
    expect(onChain! * 2n - qtyAfterBuy <= 1n && qtyAfterBuy - onChain! * 2n <= 1n).toBe(true);
    expect(typeof p.realizedPnLSol).toBe('number');
    expect(p.realizedPnLSol).not.toBe(0);
    // Q3b: realized-today comes from the fills ledger, not from row rewrites
    const ws = (await app.call('GET', '/api/wallet/state')).json;
    expect(ws.success ?? true).not.toBe(false);
    expect(ws.data.totalRealizedPnLSol, `ledger ${ws.data.totalRealizedPnLSol} vs rows ${await liveRealizedSum()}`).toSatisfy((x: number) => closeTo(x, p.realizedPnLSol));
  });

  it('when other wallets pump the curve above +30%, the exit loop takes TAKE_PROFIT_1 (33%) on its own within a minute', async () => {
    const qtyBefore = BigInt((await position(positionId)).tokenQuantityRaw);
    const before = await sends(); // counted BEFORE the pump: the 3 s exit loop may act while the crowd is still buying
    const ratio = await market.pumpTo(coinA, (entryPrice * 1.45) / (await market.priceSol(coinA)), 1.0);
    expect(ratio).toBeGreaterThan(1.2);
    const p = await waitForPosition(app, (ps) => ps.find((x) => x.id === positionId && x.exitStage === 1), 75_000, 'TAKE_PROFIT_1');
    expect(p.exitReason).toBe('TAKE_PROFIT_1');
    expect(p.status).toBe('PARTIALLY_CLOSED');
    const left = BigInt(p.tokenQuantityRaw);
    // 33% sold, within 1% of the quantity
    const soldPct = Number((qtyBefore - left) * 10_000n / qtyBefore) / 100;
    expect(soldPct).toBeGreaterThan(32);
    expect(soldPct).toBeLessThan(34);
    expect(await chainQty(coinA)).toBe(left);
    expect((await sends()) - before).toBe(1);
    expect(p.highWaterMarkSol).toBeGreaterThan(entryPrice * 1.3);
    expect(p.trailingStopSol).toBeGreaterThan(0);
    // and it stays put while the price holds: three more loop ticks, no new send
    await sleep(10_000);
    expect((await sends()) - before).toBe(1);
    expect((await position(positionId)).exitStage).toBe(1);
  });

  it('when the crowd then dumps the curve below the ratcheted stop, the trailing stop closes the rest and the token account is reclaimed', async () => {
    const p0 = await position(positionId);
    const target = p0.trailingStopSol * 0.97;
    const before = await sends();
    const ratio = await market.dumpTo(coinA, holdersA, target / (await market.priceSol(coinA)));
    expect(ratio).toBeLessThan(1);
    const p = await waitForPosition(app, (ps) => ps.find((x) => x.id === positionId && x.status === 'CLOSED'), 75_000, 'TRAILING_STOP close');
    expect(p.exitReason).toBe('TRAILING_STOP');
    expect(BigInt(p.tokenQuantityRaw)).toBe(0n);
    expect(await chainQty(coinA)).toBeNull(); // ATA closed, rent back
    expect((await sends()) - before).toBe(1);
    // the fills ledger carries every leg: realized today == the row's realized, and it is net of the losing last leg
    const ws = (await app.call('GET', '/api/wallet/state')).json;
    expect(ws.data.totalRealizedPnLSol, `ledger ${ws.data.totalRealizedPnLSol} vs row ${p.realizedPnLSol}`).toSatisfy((x: number) => closeTo(x, p.realizedPnLSol));
    expect(p.exitTxSignature).toBeTruthy();
  });

  it('a second coin: a −25% move triggers the hard STOP_LOSS, a full exit, from the live curve price', async () => {
    const { mint: coinB, wallets: holdersB } = await market.seedCoin(14, 0.6);
    const r = await app.call('POST', '/api/execution/trade', { mint: coinB.toBase58(), symbol: 'LNG', name: 'LongTest', amountSol: 0.02, confirmLive: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const id = r.json.positionId;
    const entry = (await position(id)).entryPriceSol;
    const ratio = await market.dumpTo(coinB, holdersB, (entry * 0.75) / (await market.priceSol(coinB)));
    expect(ratio).toBeLessThan(0.9);
    const p = await waitForPosition(app, (ps) => ps.find((x) => x.id === id && x.status === 'CLOSED'), 75_000, 'STOP_LOSS close');
    expect(p.exitReason).toBe('STOP_LOSS');
    expect(p.realizedPnLSol).toBeLessThan(0);
    expect(await chainQty(coinB)).toBeNull();
  }, 240_000);

  it('the kill switch refuses a new buy and nothing reaches the chain; resetting it lifts the refusal', async () => {
    const before = await sends();
    expect((await app.call('POST', '/api/execution/kill-switch', { activate: true })).json.killSwitchActive).toBe(true);
    const refused = await app.call('POST', '/api/execution/trade', { mint: coinA.toBase58(), symbol: 'LNG', name: 'LongTest', amountSol: 0.02, confirmLive: true });
    expect(refused.status).toBe(400);
    expect(String(refused.json.error)).toMatch(/KILL_SWITCH_ACTIVE/);
    expect(await sends()).toBe(before);
    expect((await app.call('POST', '/api/execution/kill-switch', { activate: false })).json.killSwitchActive).toBe(false);
    // the kill switch also disarmed LIVE (that is its contract)
    expect((await app.call('GET', '/api/execution/mode')).json.isLiveArmed).toBe(false);
  });

  it('back in PAPER the same route fills from the real curve and sends nothing', async () => {
    const { mint: coinC } = await market.seedCoin(14, 0.6); // a mint the app has not traded in the last 30 s (DUPLICATE_MINT cooldown); 14 buyers so the liquidity gate passes
    const before = await sends();
    const spot = await market.priceSol(coinC);
    const r = await app.call('POST', '/api/execution/trade', { mint: coinC.toBase58(), symbol: 'LNG', name: 'LongTest', amountSol: 0.02, confirmLive: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.executionMode).toBe('PAPER');
    expect(r.json.success).toBe(true);
    expect(await sends()).toBe(before);
    // Q7: paper is priced from the curve, not from a caller's number or a flat model
    expect(r.json.gates?.pricing).toBe('CURVE_QUOTE');
    expect(r.json.gates?.pricing).not.toBe('MODEL');
    expect(r.json.quotePriceSol).toBeGreaterThan(spot * 0.995);
    expect(r.json.quotePriceSol).toBeLessThan(spot * 1.03);
    const p = await position(r.json.positionId);
    expect(p.executionMode).toBe('PAPER');
    expect(await chainQty(coinC)).toBeNull(); // the wallet holds nothing: no real buy happened
  }, 120_000);

  it('the app used only RPC methods the validator implements (no silent fallbacks)', async () => {
    const stats = await v.rpc('localnet_stats');
    expect(stats.unsupported).toEqual([]);
  });
});
