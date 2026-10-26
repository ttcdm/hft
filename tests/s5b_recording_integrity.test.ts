import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { Keypair } from '@solana/web3.js';
import { LaunchRecorder } from '../server/backtest/launchRecorder';
import { WorkstationDatabase } from '../server/db/database';

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
