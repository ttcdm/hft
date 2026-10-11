import fs from 'node:fs';
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { startApp, startRpcStub, scratchDir, LOCALNET_STUB_GENESIS, type AppHandle, type RpcStub } from './helpers/liveServer';

/** The real server and its real HTTP routes: an operator snipe size is refused with a reason, never clamped, and the Auto budget obeys the caps. */
let stub: RpcStub; let app: AppHandle; let dir: string;
beforeAll(async () => {
  stub = await startRpcStub(LOCALNET_STUB_GENESIS);
  dir = scratchDir('s181-');
  app = await startApp(dir, { SOLANA_RPC_URL: stub.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS, MAX_POSITION_SIZE_SOL: '0.02' });
}, 120_000);
afterAll(async () => { await app?.stop(); stub?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('S181 over HTTP', () => {
  it('GET /api/snipe/limits gives the minimum, the configured cap and a default inside it', async () => {
    const j = (await app.call('GET', '/api/snipe/limits')).json;
    expect(j).toMatchObject({ success: true, minSol: 0.001, maxSol: 0.02, defaultSol: 0.01 });
    expect(j.defaultSol).toBeLessThanOrEqual(j.maxSol);
    expect(j.solPriceUsd === null || j.solPriceUsd > 0).toBe(true);
  });

  it('the memecoin trade route refuses a size above the cap or below the minimum, with the reason', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const big = (await app.call('POST', '/api/memecoins/trade', { contractAddress: mint, amountSol: 0.5 })).json;
    expect(big.status).toBe('REJECTED');
    expect(big.result.message).toMatch(/SNIPE_AMOUNT_ABOVE_CAP.*MAX_POSITION_SIZE_SOL/);
    const small = (await app.call('POST', '/api/memecoins/trade', { contractAddress: mint, amountSol: 0.0001 })).json;
    expect(small.result.message).toMatch(/SNIPE_AMOUNT_TOO_SMALL/);
  });

  it('the callout route judges the size before it looks for the callout', async () => {
    const r = (await app.call('POST', '/api/pumpfun/callouts/snipe', { calloutId: 'does-not-exist', amountSol: 5 })).json;
    expect(r.status).toBe('REJECTED');
    expect(r.result.message).toMatch(/SNIPE_AMOUNT_ABOVE_CAP/);
    const missing = (await app.call('POST', '/api/pumpfun/callouts/snipe', { calloutId: 'does-not-exist', amountSol: 0.01 })).json;
    expect(missing.result.message).toMatch(/not found/i); // a fine size gets as far as the lookup
  });

  it('Plug & Play snipe route refuses a size under the minimum with the same reason', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const r = await app.call('POST', '/api/wallet/snipe', { mint, amountSol: 0.0005 });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/SNIPE_AMOUNT_TOO_SMALL/);
  });

  it('POST /api/auto/budget refuses above the cap (3 x MAX_POSITION_SIZE_SOL) and accepts inside it; the status shows the result', async () => {
    const before = (await app.call('GET', '/api/auto/status')).json;
    expect(before.budgetLimits).toMatchObject({ maxSpendSol: 0.06, minSpendSol: 0.005, maxBuys: 50 });
    const over = await app.call('POST', '/api/auto/budget', { maxBuys: 5, maxSpendSol: 0.5 });
    expect(over.status).toBe(422);
    expect(over.json.error).toMatch(/above the 0\.06 SOL session cap/);
    expect((await app.call('GET', '/api/auto/status')).json.budgets.maxSpendSol).toBe(before.budgets.maxSpendSol);
    const ok = await app.call('POST', '/api/auto/budget', { maxBuys: 3, maxSpendSol: 0.04 });
    expect(ok.status).toBe(200);
    expect((await app.call('GET', '/api/auto/status')).json.budgets).toMatchObject({ maxBuys: 3, maxSpendSol: 0.04 });
    expect((await app.call('POST', '/api/auto/budget', { maxBuys: 0, maxSpendSol: 0.04 })).status).toBe(400);
  });
});
