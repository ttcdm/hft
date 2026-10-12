import fs from 'node:fs';
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { startApp, startRpcStub, scratchDir, LOCALNET_STUB_GENESIS, type AppHandle, type RpcStub } from './helpers/liveServer';

let stub: RpcStub; let app: AppHandle; let dir: string;
beforeAll(async () => {
  stub = await startRpcStub(LOCALNET_STUB_GENESIS);
  dir = scratchDir('s187-');
  // read-only on purpose: this is how the threshold is used on mainnet, so it must work with no signer
  app = await startApp(dir, { SOLANA_RPC_URL: stub.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS, APEX_READ_ONLY: 'true', SIGNER_KEYPAIR_PATH: '', AUTO_SNIPE_ENABLED: 'true', CONFLUENCE_MIN_SCORE: '65' });
}, 120_000);
afterAll(async () => { await app?.stop(); await stub?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('S187 POST /api/auto/threshold over HTTP (read-only server)', () => {
  it('starts at the env default, takes a new value, shows it in the status, warns under 50, and refuses bad values', async () => {
    const before = (await app.call('GET', '/api/auto/status')).json;
    expect(before.confluence).toMatchObject({ value: 65, defaultValue: 65, source: 'env' });
    const set = await app.call('POST', '/api/auto/threshold', { threshold: 45 });
    expect(set.status).toBe(200);
    expect(set.json.status.confluence).toMatchObject({ value: 45, source: 'operator', defaultValue: 65 });
    expect(set.json.status.confluence.warning).toMatch(/more buys of weaker coins/);
    const after = (await app.call('GET', '/api/auto/status')).json;
    expect(after.confluence.value).toBe(45);
    for (const bad of [101, -1, 50.5, 'abc']) {
      const r = await app.call('POST', '/api/auto/threshold', { threshold: bad });
      expect(r.status, String(bad)).toBeGreaterThanOrEqual(400);
    }
    expect((await app.call('POST', '/api/auto/threshold', {})).status).toBe(400);
    expect((await app.call('GET', '/api/auto/status')).json.confluence.value).toBe(45); // refusals changed nothing
    expect(stub.methods.filter((m) => /^send|requestAirdrop/.test(m))).toEqual([]);
  });
  it('the Backtest replay takes ?minScore= and refuses a bad one', async () => {
    const bad = await app.call('GET', '/api/backtest/replay?minScore=500');
    expect(bad.status).toBe(422);
    expect(bad.json.error).toMatch(/THRESHOLD_OUT_OF_RANGE/);
    const ok = await app.call('GET', '/api/backtest/replay?minScore=40');
    expect(ok.status).toBe(200); // nothing recorded in a fresh database: an honest empty answer
    expect(ok.json.report).toBeNull();
  });
});
