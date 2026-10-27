import fs from 'node:fs';
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { startApp, startRpcStub, scratchDir, LOCALNET_STUB_GENESIS, type AppHandle, type RpcStub } from './helpers/liveServer';
import { WorkstationDatabase } from '../server/db/database';
import { toRecordedLaunch, type CorpusLaunch } from '../scripts/hfcorpus/replay';
import type { TradeRow } from '../server/backtest/costModel';
import { replayLaunch } from '../server/backtest/replay';

/**
 * 5A: GET /api/backtest/replay tells the replay how long the recorder follows a launch (APEX_RECORD_MINT_MINUTES), so a quiet coin bought
 * and never traded again is closed by the stale exit at its last price instead of staying "open at end". Real server, local RPC stub.
 */
let stub: RpcStub; let app: AppHandle; let dir: string;
beforeAll(async () => {
  stub = await startRpcStub(LOCALNET_STUB_GENESIS);
  dir = scratchDir('s5a-route-');
  app = await startApp(dir, { SOLANA_RPC_URL: stub.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS, APEX_RECORD_MINT_MINUTES: '40' });
}, 120_000);
afterAll(async () => { await app?.stop(); await stub?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('5A the replay route: a quiet recorded tail closes by the stale exit', () => {
  it('a launch bought and then silent for the rest of a 40-minute recording closes STALE_POSITION', async () => {
    const T0 = 1_760_000_000_000;
    let vSol = 30e9, vTok = 1.073e15;
    const rows: TradeRow[] = [];
    for (let i = 0; i < 60; i++) {
      const sol = 0.3 + (i % 5) * 0.2, k = vSol * vTok, newS = vSol + sol * 1e9, newT = k / newS;
      rows.push([T0 + 1500 + i * 900, true, sol, (vTok - newT) / 1e6, 'w' + (i % 40), Math.round(newS), Math.round(newT), `w-${i}`]);
      vSol = newS; vTok = newT;
    }
    const full: CorpusLaunch = { mint: 'MintRoute5A', symbol: 'RT', creator: 'creatorRoute', mayhem: false, t0: T0, graduated: false, trades: rows };
    // cut the recording at the window's release (as the route will replay it), so nothing trades after the buy
    const rel = replayLaunch(toRecordedLaunch(full, 150), [], 150, { minScore: 0 }).releasedAfterMs as number;
    const c: CorpusLaunch = { ...full, trades: rows.filter((x) => x[0] <= T0 + rel) };
    const db = new WorkstationDatabase(app.dbPath);
    for (const e of toRecordedLaunch(c, 150).events) db.recordLaunchEvent(e.ts, c.mint, e.kind, e.payload);
    // R2-2: the quiet tail is covered by the END/WINDOW row the recorder writes when the window passes (the window alone no longer is)
    db.recordLaunchEvent(T0 + 40 * 60_000, c.mint, 'END', { reason: 'WINDOW', trades: c.trades.length, windowMs: 40 * 60_000 });
    const r = await app.call('GET', '/api/backtest/replay?minScore=0');
    expect(r.status).toBe(200);
    const l = r.json.report.launches.find((x: any) => x.mint === c.mint);
    expect(l.entered).toBe(true);
    expect(l.outcome).toBe('CLOSED');
    expect(l.exits.map((e: any) => e.reason)).toEqual(['STALE_POSITION']);
  }, 60_000);

  it('R2-2: the route passes the recorder markers, so a feed gap inside a recording truncates that launch', async () => {
    const T0 = 1_760_100_000_000;
    let vSol = 30e9, vTok = 1.073e15;
    const rows: TradeRow[] = [];
    for (let i = 0; i < 60; i++) {
      const sol = 0.3 + (i % 5) * 0.2, k = vSol * vTok, newS = vSol + sol * 1e9, newT = k / newS;
      rows.push([T0 + 1500 + i * 900, true, sol, (vTok - newT) / 1e6, 'g' + (i % 40), Math.round(newS), Math.round(newT), `g-${i}`]);
      vSol = newS; vTok = newT;
    }
    const c: CorpusLaunch = { mint: 'MintRouteGap', symbol: 'RG', creator: 'creatorGap', mayhem: false, t0: T0, graduated: false, trades: rows };
    const db = new WorkstationDatabase(app.dbPath);
    for (const e of toRecordedLaunch(c, 150).events) db.recordLaunchEvent(e.ts, c.mint, e.kind, e.payload);
    db.recordLaunchEvent(T0 + 40 * 60_000, c.mint, 'END', { reason: 'WINDOW', trades: rows.length, windowMs: 40 * 60_000 });
    db.recordLaunchEvent(T0 + 10_000, '', 'MARKER', { reason: 'FEED_GAP', detail: 'test' });
    const r = await app.call('GET', '/api/backtest/replay?minScore=0');
    expect(r.status).toBe(200);
    const l = r.json.report.launches.find((x: any) => x.mint === c.mint);
    expect(l.recording).toBe('TRUNCATED');
    expect(l.recordingGap).toMatchObject({ reason: 'FEED_GAP' });
    expect(l.entered).toBe(false);
  }, 60_000);
});
