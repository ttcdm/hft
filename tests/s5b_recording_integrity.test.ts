import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { Keypair } from '@solana/web3.js';
import { LaunchRecorder } from '../server/backtest/launchRecorder';
import { WorkstationDatabase } from '../server/db/database';
import { WatchWindow } from '../server/signals/watchWindow';
import { tradeFromJson } from '../server/backtest/replay';

afterEach(() => vi.restoreAllMocks());

/**
 * 5B: recordings say when and why they end, pruning keeps the funder facts surviving launches need, and the status and journal reads
 * do not scan whole tables. Every test drives the REAL recorder and the REAL database (a scratch file, read back over a second
 * connection so no private field is touched).
 */
const wallet = () => Keypair.generate().publicKey.toBase58();
const t0 = 1_700_000_000_000;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function scratchDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's5b-'));
  dirs.push(dir);
  const file = path.join(dir, 'rec.db');
  const db = new WorkstationDatabase(file);
  const rows = (sql: string, ...args: any[]) => {
    const r = new DatabaseSync(file, { readOnly: true });
    try { return r.prepare(sql).all(...args) as any[]; } finally { r.close(); }
  };
  return { db, file, rows };
}

const createEvent = (mint: string) => ({ signature: 'c-' + mint.slice(0, 6), slot: 1, mint, creator: wallet(), user: wallet(), name: 'Fx', symbol: 'FX', uri: '' });
const trade = (mint: string, i: number, realTokenReserves = 700_000_000_000_000n) => ({
  signature: `s-${mint.slice(0, 6)}-${i}`, slot: 100 + i, mint, solAmountLamports: 100_000_000n, tokenAmount: 1_000_000n, isBuy: true, user: wallet(), timestampSec: 0,
  virtualSolReserves: 31_000_000_000n, virtualTokenReserves: 1_000_000_000_000_000n, realSolReserves: 1_000_000_000n, realTokenReserves,
});

/** A recorder on a real database, a window that watches everything, and a settable clock. */
function recorder(config: { mintMs: number; maxTradesPerMint: number; retentionDays?: number; maxRows?: number }) {
  const s = scratchDb();
  let now = t0;
  const win: any = Object.assign(new EventEmitter(), { isWatching: () => true });
  const rec = new LaunchRecorder(s.db, win, () => 150, () => now, { retentionDays: 14, maxRows: 1_000_000, ...config });
  const ends = () => s.rows(`SELECT ts, mint, payload_json FROM launch_recording WHERE kind = 'END' ORDER BY id`).map((r) => ({ ts: r.ts, mint: r.mint, ...JSON.parse(r.payload_json) }));
  return { ...s, rec, ends, at: (ms: number) => { now = t0 + ms; } };
}

describe('5B: every recorded launch says when and why its recording ended (R1-106)', () => {
  it('maxTradesPerMint 100: the 101st trade writes one END/TRADE_CAP row and no further trade is kept', () => {
    const r = recorder({ mintMs: 30 * 60_000, maxTradesPerMint: 100 });
    const m = wallet();
    r.rec.onCreate(createEvent(m) as any);
    for (let i = 1; i <= 130; i++) { r.at(i * 1000); r.rec.onTrade(trade(m, i) as any); }
    expect(r.rows(`SELECT COUNT(*) AS n FROM launch_recording WHERE mint = ? AND kind = 'TRADE'`, m)[0].n).toBe(100);
    const ends = r.ends();
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ mint: m, reason: 'TRADE_CAP', trades: 100, ts: t0 + 101_000, droppedSignature: `s-${m.slice(0, 6)}-101` });
  });

  it('a trade that empties the curve is kept and writes END/CURVE_COMPLETE; nothing after it is recorded', () => {
    const r = recorder({ mintMs: 30 * 60_000, maxTradesPerMint: 2_000 });
    const m = wallet();
    r.rec.onCreate(createEvent(m) as any);
    r.at(1000); r.rec.onTrade(trade(m, 1) as any);
    r.at(2000); r.rec.onTrade(trade(m, 2, 0n) as any);
    r.at(3000); r.rec.onTrade(trade(m, 3, 0n) as any);
    expect(r.rows(`SELECT COUNT(*) AS n FROM launch_recording WHERE mint = ? AND kind = 'TRADE'`, m)[0].n).toBe(2);
    expect(r.ends()).toEqual([expect.objectContaining({ mint: m, reason: 'CURVE_COMPLETE', ts: t0 + 2000, trades: 2, signature: `s-${m.slice(0, 6)}-2` })]);
  });

  it('a trade after the window writes END/WINDOW at the window end, once', () => {
    const r = recorder({ mintMs: 10 * 60_000, maxTradesPerMint: 2_000 });
    const m = wallet();
    r.rec.onCreate(createEvent(m) as any);
    r.at(1000); r.rec.onTrade(trade(m, 1) as any);
    r.at(11 * 60_000); r.rec.onTrade(trade(m, 2) as any);
    r.at(12 * 60_000); r.rec.onTrade(trade(m, 3) as any);
    expect(r.ends()).toEqual([expect.objectContaining({ mint: m, reason: 'WINDOW', ts: t0 + 10 * 60_000, trades: 1 })]);
  });

  it('a launch that went quiet gets END/WINDOW when another launch trades after its window; one still inside its window has no END (unresolved)', () => {
    const r = recorder({ mintMs: 10 * 60_000, maxTradesPerMint: 2_000 });
    const quiet = wallet(); const busy = wallet();
    r.rec.onCreate(createEvent(quiet) as any);
    r.at(1000); r.rec.onTrade(trade(quiet, 1) as any);
    r.at(5 * 60_000); r.rec.onCreate(createEvent(busy) as any);
    r.at(5 * 60_000 + 1000); r.rec.onTrade(trade(busy, 1) as any);
    r.at(12 * 60_000); r.rec.onTrade(trade(busy, 2) as any);
    expect(r.ends()).toEqual([expect.objectContaining({ mint: quiet, reason: 'WINDOW', ts: t0 + 10 * 60_000 })]);
    // the busy launch is still inside its window: no END row, so a reader sees it as unresolved
    expect(r.ends().some((e) => e.mint === busy)).toBe(false);
  });
});

/** The launch's funder-collapsed buyer count, from what is recorded now: the REAL WatchWindow fed the recorded funder facts and trades. */
function collapsedBuyers(db: WorkstationDatabase, mint: string): number {
  const { launches, funders } = db.loadLaunchRecording();
  const l = launches.find((x) => x.mint === mint)!;
  const create = l.events.find((e) => e.kind === 'CREATE')!;
  const trades = l.events.filter((e) => e.kind === 'TRADE');
  const ww = new WatchWindow({ publicFunders: [] });
  ww.watch(mint, create.payload.creator, create.ts, [create.payload.user]);
  for (const f of funders) { if (f.funder) ww.setFunder(f.wallet, f.funder, f.ts); else ww.setNoFunder(f.wallet); }
  for (const t of trades) ww.onTrade(tradeFromJson(t.payload), t.ts);
  return ww.evaluate(mint, trades[trades.length - 1].ts)!.metrics.uniqueBuyers;
}

describe('5B: pruning keeps the funder facts surviving launches need (R1-92)', () => {
  /** Two launches bought by the same four wallets, all funded by one funder. The window learns the funders during the first launch only. */
  function twoLaunches(firstAt: number, secondAt: number) {
    const s = scratchDb();
    let now = firstAt;
    const win: any = Object.assign(new EventEmitter(), { isWatching: () => true });
    const rec = new LaunchRecorder(s.db, win, () => 150, () => now, { mintMs: 30 * 60_000, maxTradesPerMint: 2_000, retentionDays: 14, maxRows: 1_000_000 });
    vi.spyOn(s.db, 'pruneLaunchRecording').mockReturnValue(0); // the recorder's own hourly prune is driven by hand below
    const buyers = Array.from({ length: 4 }, wallet); const funder = wallet();
    const first = wallet(); const second = wallet();
    rec.onCreate(createEvent(first) as any);
    buyers.forEach((b, i) => { now = firstAt + 1000 * (i + 1); rec.onTrade({ ...trade(first, i), user: b } as any); rec.onFunder({ wallet: b, funder }); });
    now = secondAt;
    rec.onCreate(createEvent(second) as any);
    buyers.forEach((b, i) => { now = secondAt + 1000 * (i + 1); rec.onTrade({ ...trade(second, 10 + i), user: b } as any); });
    vi.mocked(s.db.pruneLaunchRecording).mockRestore();
    return { ...s, first, second };
  }

  it('pruning the first launch by the row limit leaves the second launch\'s funder-collapsed buyer count unchanged', () => {
    const r = twoLaunches(t0, t0 + 3_600_000);
    expect(collapsedBuyers(r.db, r.second)).toBe(1);
    // the first launch has 6 launch rows (CREATE, 4 TRADE, its END/WINDOW), the second 5, plus 4 FUNDER rows; a limit of 5 launch rows drops the first launch
    expect(r.db.pruneLaunchRecording(14, 5, t0 + 3_700_000)).toBe(6);
    expect(r.rows(`SELECT COUNT(*) AS n FROM launch_recording WHERE mint = ?`, r.first)[0].n).toBe(0);
    expect(r.rows(`SELECT COUNT(*) AS n FROM launch_recording WHERE kind = 'FUNDER'`)[0].n).toBe(4);
    expect(collapsedBuyers(r.db, r.second)).toBe(1);
  });

  it('pruning the first launch by age keeps its funder facts too', () => {
    const now = t0 + 20 * 86_400_000;
    const r = twoLaunches(t0, now - 3_600_000);
    expect(r.db.pruneLaunchRecording(14, 1_000_000, now)).toBe(6);
    expect(r.rows(`SELECT COUNT(*) AS n FROM launch_recording WHERE kind = 'FUNDER'`)[0].n).toBe(4);
    expect(collapsedBuyers(r.db, r.second)).toBe(1);
  });
});

/** Every SQL text prepared while `fn` runs, with SQLite's query plan for it (EXPLAIN QUERY PLAN on the same connection). */
function plansWhile(fn: () => void): Array<{ sql: string; plan: string[] }> {
  const orig = DatabaseSync.prototype.prepare;
  const seen: Array<{ sql: string; plan: string[] }> = [];
  const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (!/^\s*EXPLAIN/i.test(sql)) seen.push({ sql, plan: (orig.call(this, `EXPLAIN QUERY PLAN ${sql}`).all() as any[]).map((r) => String(r.detail)) });
    return orig.call(this, sql);
  } as any);
  try { fn(); } finally { spy.mockRestore(); }
  return seen;
}
/** A plan step that reads a whole table or a whole index of one of the big tables. */
const fullScans = (plans: Array<{ plan: string[] }>) => plans.flatMap((p) => p.plan).filter((d) => /^SCAN (launch_recording|system_journal)\b/.test(d));

describe('5B: status counters live in memory; the journal is read by index (R1-93, R1-107)', () => {
  it('the recording status reads no table, and its counts match a fresh read of the table after writes and prunes', () => {
    const r = recorder({ mintMs: 10 * 60_000, maxTradesPerMint: 3 });
    const a = wallet(); const b = wallet();
    r.rec.onCreate(createEvent(a) as any);
    for (let i = 1; i <= 5; i++) { r.at(i * 1000); r.rec.onTrade(trade(a, i) as any); } // 3 trades and END/TRADE_CAP
    r.rec.onFunder({ wallet: wallet(), funder: wallet() });
    r.at(60_000); r.rec.onCreate(createEvent(b) as any);
    r.at(61_000); r.rec.onTrade(trade(b, 1) as any);
    expect(plansWhile(() => r.db.getLaunchRecordingStatus()).filter((p) => /launch_recording/i.test(p.sql))).toEqual([]);
    const reopened = () => new WorkstationDatabase(r.file).getLaunchRecordingStatus();
    expect(r.db.getLaunchRecordingStatus()).toEqual(reopened());
    expect(r.db.getLaunchRecordingStatus()).toMatchObject({ launches: 2, events: 8, launchRows: 7, funderRows: 1, endedLaunches: 1, oldestTs: t0, newestTs: t0 + 61_000, newestCreateTs: t0 + 60_000 });
    // a prune by row count drops the oldest launch rows; the counts follow it without a COUNT(*)
    const pruned = plansWhile(() => r.db.pruneLaunchRecording(14, 2, t0 + 62_000));
    expect(pruned.some((p) => /COUNT\(\*\)/i.test(p.sql))).toBe(false);
    expect(r.db.getLaunchRecordingStatus()).toEqual(reopened());
    expect(r.db.getLaunchRecordingStatus()).toMatchObject({ launches: 1, launchRows: 2, funderRows: 1, endedLaunches: 0, newestCreateTs: t0 + 60_000 });
  });

  it('rows another connection writes to the file are counted at the next status read', () => {
    const r = recorder({ mintMs: 10 * 60_000, maxTradesPerMint: 100 });
    expect(r.db.getLaunchRecordingStatus().launches).toBe(0);
    const other = new WorkstationDatabase(r.file);
    for (let i = 0; i < 3; i++) other.recordLaunchEvent(t0 + i, `M${i}`, 'CREATE', {});
    expect(r.db.getLaunchRecordingStatus()).toMatchObject({ launches: 3, newestCreateTs: t0 + 2 });
  });

  it('EXPLAIN QUERY PLAN: the 5-second unverified-fill read uses the system_journal(event_type) index', () => {
    const { db } = scratchDb();
    db.logJournal('PAPER_FILL_GATES', 'c1', 'PAPER', { positionId: 'p1' });
    const plans = plansWhile(() => db.getUnverifiedFillIds());
    expect(plans.length).toBeGreaterThan(0);
    for (const p of plans) expect(p.plan.join(' | ')).toMatch(/USING (COVERING )?INDEX idx_journal_event_type \(event_type=\?\)/);
  });

  it('System checks\' recorder row reads no whole table (seeded recording and journal)', async () => {
    const { workstationDb } = await import('../server/db/database');
    const { recorderCheck } = await import('../server/system/systemChecks');
    const win: any = Object.assign(new EventEmitter(), { isWatching: () => true });
    let now = Date.now();
    const rec = new LaunchRecorder(workstationDb, win, () => 150, () => now, { mintMs: 10 * 60_000, maxTradesPerMint: 50, retentionDays: 14, maxRows: 1_000_000 });
    vi.spyOn(workstationDb, 'pruneLaunchRecording').mockReturnValue(0);
    for (let l = 0; l < 20; l++) {
      const m = wallet();
      rec.onCreate(createEvent(m) as any);
      for (let i = 0; i < 30; i++) { now += 100; rec.onTrade(trade(m, i) as any); }
    }
    const plans = plansWhile(() => recorderCheck(now + 3_600_000));
    expect(fullScans(plans)).toEqual([]);
    rec.detach();
  });
});

describe('5B: the replay cache key is the newest CREATE per minute (R1-107)', () => {
  it('more trades on recorded launches keep the key; a launch created in a later minute, another threshold or cap change it', async () => {
    const { replayCacheKey } = await import('../server/backtest/recorderConfig');
    const r = recorder({ mintMs: 30 * 60_000, maxTradesPerMint: 2_000 });
    const a = wallet();
    r.rec.onCreate(createEvent(a) as any);
    r.at(1000); r.rec.onTrade(trade(a, 1) as any);
    const k1 = replayCacheKey(r.db.getLaunchRecordingStatus(), 70, 5_000);
    for (let i = 2; i <= 20; i++) { r.at(i * 1000); r.rec.onTrade(trade(a, i) as any); }
    expect(replayCacheKey(r.db.getLaunchRecordingStatus(), 70, 5_000)).toBe(k1);
    const b = wallet();
    r.at(2 * 60_000); r.rec.onCreate(createEvent(b) as any);
    r.at(2 * 60_000 + 500); r.rec.onTrade(trade(b, 1) as any);
    const k2 = replayCacheKey(r.db.getLaunchRecordingStatus(), 70, 5_000);
    expect(k2).not.toBe(k1);
    expect(replayCacheKey(r.db.getLaunchRecordingStatus(), 60, 5_000)).not.toBe(k2);
    expect(replayCacheKey(r.db.getLaunchRecordingStatus(), 70, 1_000)).not.toBe(k2);
  });
});
