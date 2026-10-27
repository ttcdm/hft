import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Keypair, PublicKey } from '@solana/web3.js';
import { startValidator, startLocalnetApp, armLive, waitCanArm, waitForPosition, LocalMarket, scratch, cleanupScratch, signedTxCount, sleep, type ValidatorHandle, type LocalnetApp } from '../helpers/localnetChain';

/**
 * LONG BEHAVIOUR TEST 2: the app dies at the worst moments and comes back on the same database.
 *
 *  (a) a BUY lands on chain but the app is SIGKILLed before it sees the response: on restart the position is rebuilt from the
 *      chain with the same entry price a live buy gets (Q1), and it can be sold;
 *  (b) a SELL lands on chain but the app is SIGKILLed before it records it: on restart the sale is applied with its realized PnL
 *      (Q18), not written off as "wallet holds none";
 *  (c) a halt journaled by one process is enforced by the next: buys are refused, an operator close still runs (Q11), and the
 *      hard stop still protects an open position while halted.
 *
 * Real validator, real server, real signer; the response is withheld by the validator's own test control, the kill is a real SIGKILL.
 */
const dir = scratch('long-recovery-');
let v: ValidatorHandle;
let market: LocalMarket;
let app: LocalnetApp;
let trader: Keypair;
let signerPath: string;
let token: string;
let dbPath: string;

const chainQty = async (mint: PublicKey) => market.tokenBalance(trader.publicKey, mint);
const mark = (m: string) => console.log(`[long test ${new Date().toISOString().slice(11, 19)}] ${m}`);
const positions = async () => ((await app.call('GET', '/api/workstation/positions')).json?.positions ?? []) as any[];
const restart = async (env: Record<string, string> = {}) => {
  app = await startLocalnetApp({ dir, validator: v, signerKeyPath: signerPath, dbPath, token, env, confluenceThreshold: 0 });
  return app;
};
/** Waits until the validator has executed one transaction whose HTTP response it is withholding. */
const waitHeld = async (sinceCount: number, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const held: string[] = (await v.rpc('localnet_stats')).held ?? [];
    if (held.length > sinceCount) return held[held.length - 1];
    await sleep(200);
  }
  throw new Error('no transaction was held by the validator');
};

beforeAll(async () => {
  v = await startValidator(dir);
  market = await LocalMarket.connect(v);
  const signer = await market.signerKeyFile(dir, 5);
  trader = signer.keypair;
  signerPath = signer.path;
  app = await startLocalnetApp({ dir, validator: v, signerKeyPath: signerPath, confluenceThreshold: 0 });
  token = app.token;
  dbPath = app.dbPath;
  await armLive(app);
}, 240_000);

afterAll(async () => {
  if (app && !app.exited()) await app.stop();
  await v?.stop();
  cleanupScratch(dir);
});

describe('crash after a landed BUY (response never seen)', () => {
  let mint: PublicKey;
  let recovered: any;
  let heldSig: string;

  it('the wallet\'s FIRST buy lands, the app is killed before the response, and the restarted app rebuilds the position from the chain', async () => {
    ({ mint } = await market.seedCoin(14, 0.6));
    const heldBefore = ((await v.rpc('localnet_stats')).held ?? []).length;
    mark('hold next response, sending the buy');
    await v.rpc('localnet_holdNextResponse');
    const inFlight = app.call('POST', '/api/execution/trade', { mint: mint.toBase58(), symbol: 'LNG', name: 'LongTest', amountSol: 0.02, confirmLive: true }).catch(() => null);
    heldSig = await waitHeld(heldBefore);
    mark(`held ${heldSig.slice(0, 8)}; killing the app`);
    await app.kill();
    const inFlightResult = await inFlight;
    mark(`app dead (in-flight call: ${inFlightResult ? JSON.stringify(inFlightResult).slice(0, 120) : 'socket closed'})`);
    const onChain = await chainQty(mint);
    expect(onChain).not.toBeNull();
    expect(onChain! > 0n).toBe(true);

    await restart();
    mark('restarted; waiting for can-arm');
    await waitCanArm(app);
    mark('can-arm ok; waiting for the recovered position');
    recovered = await waitForPosition(
      app,
      (ps) => ps.find((p) => p.mint === mint.toBase58() && p.status !== 'CLOSED' && BigInt(p.tokenQuantityRaw) > 0n),
      60_000,
      'recovered position'
    );
    expect(BigInt(recovered.tokenQuantityRaw)).toBe(onChain);
    expect(recovered.executionMode).toBe('LIVE');
    // Recovered from the transaction itself (signature known from the PENDING write-ahead row), not adopted as unknown dust
    expect(recovered.entryTxSignature).toBe(heldSig);
    expect(recovered.costBasisLamports).toBeGreaterThan(20_000_000);
    // and the stop-loss does not fire on a flat market: the row is still open after several exit-loop ticks
    await sleep(10_000);
    expect((await positions()).find((p) => p.id === recovered.id).status).not.toBe('CLOSED');
  }, 240_000);

  it('Q1: a live buy of the same size on an identical fresh curve carries the same entry price; only the all-in cost shows the first-buy account rent', async () => {
    await armLive(app);
    const { mint: twin } = await market.seedCoin(14, 0.6); // every fresh coin seeds to the identical curve
    const r = await app.call('POST', '/api/execution/trade', { mint: twin.toBase58(), symbol: 'LNG', name: 'LongTest', amountSol: 0.02, confirmLive: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const live = (await positions()).find((p) => p.id === r.json.positionId);
    expect(live.status).toBe('OPEN');
    // The crashed buy was this wallet's first ever: the pump program created its per-user volume account (about 0.0013 SOL of
    // rent) in that transaction. The recovered entry price must exclude that rent, like the live reconcile does, or the row
    // starts ~27% under water and the hard stop sells a flat position. Entry prices within 2%; cost bases differ by the rent.
    const ratio = recovered.entryPriceSol / live.entryPriceSol;
    expect(Math.abs(ratio - 1), `recovered ${recovered.entryPriceSol} vs live ${live.entryPriceSol}`).toBeLessThan(0.02);
    expect(recovered.costBasisLamports - live.costBasisLamports).toBeGreaterThan(1_000_000);
    expect(recovered.costBasisLamports - live.costBasisLamports).toBeLessThan(2_000_000);
    // both can be sold through the normal route
    for (const id of [recovered.id, live.id]) {
      const c = await app.call('POST', '/api/execution/close', { positionId: id, sellPct: 100 });
      expect(c.json.success, JSON.stringify(c.json)).toBe(true);
    }
    expect(await chainQty(mint)).toBeNull();
    expect(await chainQty(twin)).toBeNull();
    const closed = (await positions()).find((x) => x.id === recovered.id);
    expect(closed.status).toBe('CLOSED');
    expect(closed.realizedPnLSol).not.toBe(0);
  }, 180_000);
});

describe('crash after a landed SELL (result never recorded)', () => {
  let mint: PublicKey;
  let id: string;

  it('on restart the sale that already happened is applied with its realized PnL, not written off', async () => {
    ({ mint } = await market.seedCoin(14, 0.6));
    const r = await app.call('POST', '/api/execution/trade', { mint: mint.toBase58(), symbol: 'LNG', name: 'LongTest', amountSol: 0.02, confirmLive: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    id = r.json.positionId;
    const heldBefore = ((await v.rpc('localnet_stats')).held ?? []).length;
    await v.rpc('localnet_holdNextResponse');
    const inFlight = app.call('POST', '/api/execution/close', { positionId: id, sellPct: 100 }).catch(() => null);
    await waitHeld(heldBefore);
    mark('sell held; killing the app');
    await app.kill();
    await inFlight;
    expect(await chainQty(mint)).toBeNull(); // the sell landed and the account was closed

    await restart();
    mark('restarted; waiting for can-arm');
    await waitCanArm(app);
    mark('can-arm ok; waiting for the closed row');
    const row = await waitForPosition(app, (ps) => ps.find((p) => p.id === id && p.status === 'CLOSED'), 60_000, 'closed after restart');
    // Q18: realized PnL booked from the landed sell; a write-off would leave 0 and the exit reason RECONCILED_ZERO_BALANCE
    expect(row.realizedPnLSol).not.toBe(0);
    expect(row.exitReason).not.toBe('RECONCILED_ZERO_BALANCE');
    expect(BigInt(row.tokenQuantityRaw)).toBe(0n);
    // the fills ledger (per mode) carries the recovered sell: /api/wallet/state reports the CURRENT mode, so re-arm LIVE first
    await armLive(app);
    const ws = (await app.call('GET', '/api/wallet/state')).json;
    expect(ws.data.executionMode).toBe('LIVE');
    // the ledger is the day's total over every LIVE row (the earlier reference round trip and the recovered buy's sale included)
    const liveRows = (await positions()).filter((p) => p.executionMode === 'LIVE');
    const sumRows = liveRows.reduce((a, p) => a + (p.realizedPnLSol ?? 0), 0);
    expect(liveRows.map((p) => p.id)).toContain(id);
    expect(Math.abs(ws.data.totalRealizedPnLSol - sumRows), `ledger ${ws.data.totalRealizedPnLSol} vs rows ${sumRows}`).toBeLessThan(0.0001 + 1e-9);
  }, 240_000);
});

describe('a halt journaled by one process binds the next', () => {
  let mint: PublicKey;
  let holders: Keypair[];
  let id: string;

  it('setup: an open LIVE position, then a halt written by a separate process on the same database', async () => {
    await armLive(app);
    ({ mint, wallets: holders } = await market.seedCoin(14, 0.6));
    const r = await app.call('POST', '/api/execution/trade', { mint: mint.toBase58(), symbol: 'LNG', name: 'LongTest', amountSol: 0.02, confirmLive: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    id = r.json.positionId;
    await app.stop();
    // the real coordinator in another process writes the halt the way production does (TRADING_HALTED journal row)
    const code = `process.env.APEX_ENV_FILE='';process.env.APEX_DB_PATH=${JSON.stringify(dbPath)};process.env.NODE_ENV='production';` +
      `import('./server/execution/coordinator').then(({ executionCoordinator }) => { executionCoordinator.haltAll('long test: unexplained wallet change'); setTimeout(() => process.exit(0), 300); });`;
    execFileSync(path.resolve('node_modules/.bin/tsx'), ['-e', code], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SOLANA_RPC_URL: 'http://127.0.0.1:9', SOLANA_WS_URL: 'ws://127.0.0.1:9', JITO_BLOCK_ENGINE_URL: 'http://127.0.0.1:9', SIGNER_KEYPAIR_PATH: path.join(dir, 'unused-key.json'), ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: v.genesisHash },
      timeout: 60_000,
    });
    await restart();
  }, 180_000);

  it('after the restart: can-arm names the halt, a buy is refused, nothing is sent', async () => {
    const deadline = Date.now() + 60_000;
    let can: any = null;
    while (Date.now() < deadline) {
      can = (await app.call('GET', '/api/execution/can-arm')).json;
      if (can && can.reasons?.some((x: string) => /halt/i.test(x))) break;
      await sleep(500);
    }
    expect(can.allowed).toBe(false);
    expect(can.reasons.join(' ')).toMatch(/halt/i);
    const before = await signedTxCount(v.conn, trader.publicKey);
    const arm = await app.call('POST', '/api/execution/arm', { arm: true, confirmationCode: 'CONFIRM_LIVE_TRADING_RISK' });
    expect(arm.status).toBe(403);
    const buy = await app.call('POST', '/api/execution/trade', { mint: mint.toBase58(), symbol: 'LNG', name: 'LongTest', amountSol: 0.02, confirmLive: true });
    expect(buy.status).toBe(400);
    expect(String(buy.json.error)).toMatch(/TRADING_HALTED/);
    expect(await signedTxCount(v.conn, trader.publicKey)).toBe(before);
  }, 90_000);

  it('an operator close is a protective exit: it runs while halted (Q11), half the position leaves the wallet', async () => {
    const qty = BigInt((await positions()).find((p) => p.id === id).tokenQuantityRaw);
    const c = await app.call('POST', '/api/execution/close', { positionId: id, sellPct: 50, reason: 'Operator close' });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect(c.json.success).toBe(true);
    const left = await chainQty(mint);
    expect(left! < qty && left! > 0n).toBe(true);
    expect((await positions()).find((p) => p.id === id).status).toBe('PARTIALLY_CLOSED');
  }, 90_000);

  it('the hard stop still protects the rest while halted: a −25% dump closes the position', async () => {
    const entry = (await positions()).find((p) => p.id === id).entryPriceSol;
    const ratio = await market.dumpTo(mint, holders, (entry * 0.75) / (await market.priceSol(mint)));
    expect(ratio).toBeLessThan(0.9);
    const row = await waitForPosition(app, (ps) => ps.find((p) => p.id === id && p.status === 'CLOSED'), 75_000, 'STOP_LOSS under halt');
    expect(row.exitReason).toBe('STOP_LOSS');
    expect(await chainQty(mint)).toBeNull();
    // the halt itself is untouched by the exits
    const can = (await app.call('GET', '/api/execution/can-arm')).json;
    expect(can.reasons.join(' ')).toMatch(/halt/i);
  }, 120_000);

  it('clearing the halt through the operator route makes arming possible again', async () => {
    const r = await app.call('POST', '/api/auto/resume', { clearHalt: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const can = await waitCanArm(app);
    expect(can.allowed).toBe(true);
  }, 90_000);
});
