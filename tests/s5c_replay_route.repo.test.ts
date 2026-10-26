import fs from 'node:fs';
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { startApp, startRpcStub, scratchDir, LOCALNET_STUB_GENESIS, type AppHandle, type RpcStub } from './helpers/liveServer';
import { WorkstationDatabase } from '../server/db/database';
import { toRecordedLaunch, type CorpusLaunch } from '../scripts/hfcorpus/replay';
import type { TradeRow } from '../server/backtest/costModel';

/**
 * 5C (R1-105): GET /api/backtest/replay applies the dev-holding limit in force (POST /api/memecoins/config maxDevHoldingPct), and a changed
 * limit is not served from the cached report. Real server, local RPC stub.
 */
let stub: RpcStub; let app: AppHandle; let dir: string;
beforeAll(async () => {
  stub = await startRpcStub(LOCALNET_STUB_GENESIS);
  dir = scratchDir('s5c-route-');
  app = await startApp(dir, { SOLANA_RPC_URL: stub.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS });
}, 120_000);
afterAll(async () => { await app?.stop(); await stub?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('5C the replay route applies the dev-holding limit in force', () => {
  it('a launch whose creator bought 7.5% is refused at 5% and bought at 10%', async () => {
    const T0 = 1_760_000_000_000, creator = 'creatorRoute5C';
    let vSol = 30e9, vTok = 1.073e15;
    const rows: TradeRow[] = [];
    const buy = (ts: number, sol: number, user: string, sig: string) => {
      const k = vSol * vTok, newS = vSol + sol * 1e9, newT = k / newS;
      rows.push([ts, true, sol, (vTok - newT) / 1e6, user, Math.round(newS), Math.round(newT), sig]);
      vSol = newS; vTok = newT;
    };
    buy(T0 + 500, 2.25, creator, 'dev');
    for (let i = 0; i < 60; i++) buy(T0 + 1500 + i * 900, 0.3 + (i % 5) * 0.2, 'w' + (i % 40), `w-${i}`);
    const c: CorpusLaunch = { mint: 'MintRoute5C', symbol: 'RC', creator, mayhem: false, t0: T0, graduated: false, trades: rows };
    const db = new WorkstationDatabase(app.dbPath);
    for (const e of toRecordedLaunch(c, 150).events) db.recordLaunchEvent(e.ts, c.mint, e.kind, e.payload);

    const at5 = await app.call('GET', '/api/backtest/replay?minScore=0');
    expect(at5.status).toBe(200);
    const refused = at5.json.report.launches.find((x: any) => x.mint === c.mint);
    expect(refused.entered).toBe(false);
    expect(refused.noEntryReason).toMatch(/^DEV_HOLDING: creator holds 7\.\d\d% \(limit 5%\)/);

    const set = await app.call('POST', '/api/memecoins/config', { maxDevHoldingPct: 10 });
    expect(set.status).toBe(200);
    const at10 = await app.call('GET', '/api/backtest/replay?minScore=0');
    expect(at10.json.report.launches.find((x: any) => x.mint === c.mint).entered).toBe(true);
    expect(at10.json.report.assumptions.maxDevHoldingPct).toBe(10);
  }, 60_000);
});
