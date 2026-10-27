import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { Keypair } from '@solana/web3.js';
import { LaunchRecorder, RECORD_SPACE_CHECK_MS } from '../server/backtest/launchRecorder';
import { recorderConfig, recorderConfigProblems, RECORD_DEFAULT_MIN_FREE_MB } from '../server/backtest/recorderConfig';
import { WorkstationDatabase } from '../server/db/database';
import { Logger } from '../server/middleware/enterprise';

/**
 * R4-5: the launch recorder writes into the trading database and had no free-space floor, so it could fill the disk down to zero and
 * make the sell-path and exit-state writes fail. Now it stops below its own floor (256 MiB by default, well above the 32 MiB buy floor),
 * logs once, and resumes when space is back. Real recorder and real database on a scratch file; only the free-space reading (the
 * statfs at the filesystem boundary) is stubbed.
 */
const MiB = 1024 * 1024;
const wallet = () => Keypair.generate().publicKey.toBase58();
const t0 = 1_700_000_000_000;
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const createEvent = (mint: string) => ({ signature: 'c-' + mint.slice(0, 6), slot: 1, mint, creator: wallet(), user: wallet(), name: 'Fx', symbol: 'FX', uri: '' });
const trade = (mint: string, i: number) => ({
  signature: `s-${mint.slice(0, 6)}-${i}`, slot: 100 + i, mint, solAmountLamports: 100_000_000n, tokenAmount: 1_000_000n, isBuy: true, user: wallet(), timestampSec: 0,
  virtualSolReserves: 31_000_000_000n, virtualTokenReserves: 1_000_000_000_000_000n, realSolReserves: 1_000_000_000n, realTokenReserves: 700_000_000_000_000n,
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r45-'));
  dirs.push(dir);
  const file = path.join(dir, 'rec.db');
  const db = new WorkstationDatabase(file);
  let free = 10_000 * MiB;
  vi.spyOn(db, 'getFreeBytes').mockImplementation(() => free);
  let now = t0;
  const win: any = Object.assign(new EventEmitter(), { isWatching: () => true });
  const rec = new LaunchRecorder(db, win, () => 150, () => now, { mintMs: 30 * 60_000, maxTradesPerMint: 2_000, retentionDays: 14, maxRows: 1_000_000, minFreeBytes: 256 * MiB });
  const rows = (mint: string) => {
    const r = new DatabaseSync(file, { readOnly: true });
    try { return r.prepare(`SELECT kind FROM launch_recording WHERE mint = ? ORDER BY id`).all(mint).map((x: any) => x.kind); } finally { r.close(); }
  };
  return { rec, rows, setFree: (b: number) => { free = b; }, advance: (ms: number) => { now += ms; } };
}

describe('R4-5: the recorder stops below its own free-space floor and resumes after', () => {
  it('the default floor is 256 MiB, configurable with APEX_RECORD_MIN_FREE_MB (64 and up); a bad value warns', () => {
    expect(RECORD_DEFAULT_MIN_FREE_MB * MiB).toBeGreaterThan(WorkstationDatabase.LOW_FREE_WARN_BYTES);
    expect(recorderConfig({} as any).minFreeBytes).toBe(256 * MiB);
    expect(recorderConfig({ APEX_RECORD_MIN_FREE_MB: '1024' } as any).minFreeBytes).toBe(1024 * MiB);
    expect(recorderConfigProblems({ APEX_RECORD_MIN_FREE_MB: '10' } as any).join()).toMatch(/APEX_RECORD_MIN_FREE_MB=10 is ignored/);
  });

  it('below the floor nothing is written and it logs once; a launch cut by the stop gets no END row and no later trades; new launches record after resume', () => {
    const h = setup();
    const warn = vi.spyOn(Logger, 'warn');
    const info = vi.spyOn(Logger, 'info');
    const a = wallet();
    h.rec.onCreate(createEvent(a) as any);
    h.rec.onTrade(trade(a, 1) as any);
    expect(h.rows(a)).toEqual(['CREATE', 'TRADE']);

    h.setFree(100 * MiB); // under the 256 MiB floor (and above the 32 MiB buy floor)
    h.advance(RECORD_SPACE_CHECK_MS);
    for (let i = 2; i < 20; i++) { h.advance(1_000); h.rec.onTrade(trade(a, i) as any); }
    h.rec.onFunder({ wallet: wallet(), funder: wallet() });
    const b = wallet();
    h.rec.onCreate(createEvent(b) as any);
    h.rec.onTrade(trade(b, 1) as any);
    expect(h.rows(a)).toEqual(['CREATE', 'TRADE']);
    expect(h.rows(b)).toEqual([]);
    expect(warn.mock.calls.filter((c) => /\[RECORDER\] stopped recording/.test(String(c[0])))).toHaveLength(1);
    expect(h.rec.getRuntime().pausedForSpaceSince).not.toBeNull();
    expect(h.rec.getRuntime().skippedForSpace).toBeGreaterThan(0);

    h.setFree(5_000 * MiB);
    h.advance(RECORD_SPACE_CHECK_MS);
    h.rec.onTrade(trade(a, 50) as any);
    expect(info.mock.calls.filter((c) => /\[RECORDER\] recording resumed/.test(String(c[0])))).toHaveLength(1);
    expect(h.rows(a)).toEqual(['CREATE', 'TRADE']); // a's recording has a gap: it stays unresolved, never patched up
    const c = wallet();
    h.rec.onCreate(createEvent(c) as any);
    h.rec.onTrade(trade(c, 1) as any);
    expect(h.rows(c)).toEqual(['CREATE', 'TRADE']);
    expect(h.rec.getRuntime().pausedForSpaceSince).toBeNull();
  });
});
