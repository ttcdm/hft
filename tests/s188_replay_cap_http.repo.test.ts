import fs from 'node:fs';
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { startApp, startRpcStub, scratchDir, LOCALNET_STUB_GENESIS, type AppHandle, type RpcStub } from './helpers/liveServer';
import { WorkstationDatabase } from '../server/db/database';

let stub: RpcStub; let app: AppHandle; let dir: string;
beforeAll(async () => {
  stub = await startRpcStub(LOCALNET_STUB_GENESIS);
  dir = scratchDir('s188-');
  app = await startApp(dir, { SOLANA_RPC_URL: stub.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS });
}, 120_000);
afterAll(async () => { await app?.stop(); await stub?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('S188 the replay reports its cap', () => {
  it('with 305 recorded launches it replays the newest 300 and says so; the recorder status still shows all 305', async () => {
    const db = new WorkstationDatabase(app.dbPath);
    for (let i = 0; i < 305; i++) db.recordLaunchEvent(1_700_000_000_000 + i, `M${i}`, 'CREATE', { mint: `M${i}`, symbol: 'X' });
    const r = await app.call('GET', '/api/backtest/replay');
    expect(r.status).toBe(200);
    expect(r.json.recorded.launches).toBe(305);
    expect(r.json.replayedLaunches).toBe(300);
    expect(r.json.replayCap).toBe(300);
    expect(r.json.report.summary.launches).toBe(300);
  }, 60_000);
});
