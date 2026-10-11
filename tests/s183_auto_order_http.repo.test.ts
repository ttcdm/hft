import fs from 'node:fs';
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { startApp, startRpcStub, scratchDir, LOCALNET_STUB_GENESIS, type AppHandle, type RpcStub } from './helpers/liveServer';

let stub: RpcStub; let app: AppHandle; let dir: string;
beforeAll(async () => {
  stub = await startRpcStub(LOCALNET_STUB_GENESIS);
  dir = scratchDir('s183-');
  app = await startApp(dir, { SOLANA_RPC_URL: stub.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS, MAX_POSITION_SIZE_SOL: '0.02' });
}, 120_000);
afterAll(async () => { await app?.stop(); stub?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('S183 over HTTP', () => {
  it('POST /api/auto/order-size obeys the same bounds as the manual snipe amount and the status reflects the result', async () => {
    const before = (await app.call('GET', '/api/auto/status')).json;
    expect(before.orderSol).toBe(0.005);
    expect(before.orderLimits).toEqual({ minSol: 0.001, maxSol: 0.02 });
    const big = await app.call('POST', '/api/auto/order-size', { orderSol: 0.5 });
    expect(big.status).toBe(422);
    expect(big.json.error).toMatch(/SNIPE_AMOUNT_ABOVE_CAP.*MAX_POSITION_SIZE_SOL/);
    const small = await app.call('POST', '/api/auto/order-size', { orderSol: 0.0001 });
    expect(small.status).toBe(422);
    expect(small.json.error).toMatch(/SNIPE_AMOUNT_TOO_SMALL/);
    expect((await app.call('GET', '/api/auto/status')).json.orderSol).toBe(0.005); // refused: unchanged
    const ok = await app.call('POST', '/api/auto/order-size', { orderSol: 0.012 });
    expect(ok.status).toBe(200);
    const after = (await app.call('GET', '/api/auto/status')).json;
    expect(after.orderSol).toBe(0.012);
    expect(after.budgetLimits.minSpendSol).toBe(0.012);
    expect((await app.call('POST', '/api/auto/order-size', { orderSol: -1 })).status).toBe(400);
    // the budget can no longer go under one order
    const low = await app.call('POST', '/api/auto/budget', { maxBuys: 5, maxSpendSol: 0.01 });
    expect(low.status).toBe(422);
    expect(low.json.error).toMatch(/at least one order \(0\.012 SOL\)/);
  });
});
