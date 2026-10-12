import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { DatabaseSync } from 'node:sqlite';
import { Keypair } from '@solana/web3.js';
import { WorkstationDatabase } from '../server/db/database';
import { replayLaunch } from '../server/backtest/replay';
import { eventToJson } from '../server/backtest/launchRecorder';
import { toRecordedLaunch, type CorpusLaunch } from '../scripts/hfcorpus/replay';
import { openRecorded, openSqlite, openJsonl, recordedToCorpus, resolveSplit } from '../scripts/hfcorpus/recorded';

/** HAND-BUILT recordings (no real data is read): they drive the real adapters, the real replay and the two real scripts. */
const dirs: string[] = [];
const scratch = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 's228-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const wallet = () => Keypair.generate().publicKey.toBase58();
const SUPPLY = 1_000_000_000_000_000n;
const createEvent = (mint: string, creator: string, t0: number) => ({
  signature: 'c-' + mint.slice(0, 6), slot: 1, mint, creator, user: creator, bondingCurve: wallet(), name: 'Fx', symbol: 'FX', uri: '',
  virtualTokenReserves: 1_073_000_000_000_000n, virtualSolReserves: 30_000_000_000n, realTokenReserves: 793_100_000_000_000n, realSolReserves: 0n,
  tokenTotalSupply: SUPPLY, initialPriceSol: 30 / 1_073_000_000, initialMarketCapSol: 28, receivedAt: t0, parsedAt: t0, parseLatencyMs: 0, source: 'TEST_FEED' as const,
});
function curve() {
  let vSol = 30, vTok = 1_073_000_000, rSol = 0, rTok = 793_100_000;
  return (user: string, isBuy: boolean, sol: number, i: number, mint: string) => {
    const k = vSol * vTok; const newVSol = isBuy ? vSol + sol : Math.max(1, vSol - sol); const newVTok = k / newVSol; const tok = Math.abs(vTok - newVTok);
    vSol = newVSol; vTok = newVTok; rSol = Math.max(0, rSol + (isBuy ? sol : -sol)); rTok = Math.max(0, rTok + (isBuy ? -tok : tok));
    return { signature: `s-${mint.slice(0, 6)}-${i}`, slot: 100 + i, mint, solAmountLamports: BigInt(Math.round(sol * 1e9)), tokenAmount: BigInt(Math.round(tok * 1e6)), isBuy, user, timestampSec: 0,
      virtualSolReserves: BigInt(Math.round(vSol * 1e9)), virtualTokenReserves: BigInt(Math.round(vTok * 1e6)), realSolReserves: BigInt(Math.round(rSol * 1e9)), realTokenReserves: BigInt(Math.round(rTok * 1e6)) };
  };
}
type Row = { ts: number; mint: string; kind: 'CREATE' | 'TRADE' | 'FUNDER'; payload: Record<string, unknown> };
/** An organic-looking launch: many distinct buyers, steady buying (the watch window releases it at the 50 threshold). */
function organic(t0: number, buyers = 40, count = 60): Row[] {
  const mint = wallet(), creator = wallet(); const next = curve(); const ws = Array.from({ length: buyers }, wallet);
  const rows: Row[] = [{ ts: t0, mint, kind: 'CREATE', payload: { ...eventToJson(createEvent(mint, creator, t0)), solUsd: 150 } }];
  for (let i = 0; i < count; i++) rows.push({ ts: t0 + 1500 + i * 900, mint, kind: 'TRADE', payload: eventToJson(next(ws[i % ws.length], i < 45 || i % 4 !== 0, 0.3 + (i % 5) * 0.2, i, mint)) });
  return rows;
}
const writeJsonl = (file: string, rows: unknown[]) => fs.writeFileSync(file, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');

describe('S228 the recorded-launch adapters', () => {
  it('JSONL: groups by mint, keeps FUNDER rows, drops a mint with no CREATE, skips a bad line, and orders launches by create time', async () => {
    const d = scratch(); const f = path.join(d, 'snap.jsonl');
    const late = organic(2_000_000, 3, 4), early = organic(1_000_000, 3, 4);
    const orphan: Row = { ts: 1_500_000, mint: 'NoCreate', kind: 'TRADE', payload: { signature: 'x' } };
    const funder: Row = { ts: 1_200_000, mint: '', kind: 'FUNDER', payload: { wallet: 'W1', funder: 'F1' } };
    const unknown: Row = { ts: 1_300_000, mint: '', kind: 'FUNDER', payload: { wallet: 'W2', funder: null } };
    writeJsonl(f, [...late, orphan, ...early.slice(0, 2), funder, 'not json at all', unknown, ...early.slice(2)]);
    const src = await openRecorded(f);
    expect(src.kind).toBe('jsonl');
    const ls = [...src.launches()];
    expect(ls.map((l) => l.events[0].ts)).toEqual([1_000_000, 2_000_000]);
    expect(ls[0].events).toHaveLength(5); expect(ls[0].events[0].kind).toBe('CREATE');
    expect(ls.find((l) => l.mint === 'NoCreate')).toBeUndefined();
    expect(src.funders()).toEqual([{ ts: 1_200_000, wallet: 'W1', funder: 'F1' }, { ts: 1_300_000, wallet: 'W2', funder: null }]);
    expect(src.createTimes()).toEqual([1_000_000, 2_000_000]);
    expect(src.medianSolUsd()).toBe(150);
  });

  it('SQLite: reads the same launches loadLaunchRecording does, read-only, and a missing file is an error, not an empty database', async () => {
    const d = scratch(); const f = path.join(d, 'paper.db');
    const db = new WorkstationDatabase(f);
    const a = organic(1_000_000, 3, 6), b = organic(3_000_000, 3, 6);
    for (const r of [...b, ...a]) db.recordLaunchEvent(r.ts, r.mint, r.kind, r.payload);
    db.recordLaunchEvent(1_100_000, '', 'FUNDER', { wallet: 'W1', funder: 'F1' });
    const expected = db.loadLaunchRecording(10);
    const src = await openRecorded(f);
    expect(src.kind).toBe('sqlite');
    const got = [...src.launches()];
    expect(got.map((l) => l.mint)).toEqual(expected.launches.map((l) => l.mint));
    expect(got.map((l) => l.events.length)).toEqual(expected.launches.map((l) => l.events.length));
    expect(got[0].events.map((e) => e.ts)).toEqual(expected.launches[0].events.map((e) => e.ts));
    expect(src.funders()).toEqual(expected.funders);
    expect(src.createTimes()).toEqual([1_000_000, 3_000_000]);
    src.close();
    await expect(openRecorded(path.join(d, 'nope.db'))).rejects.toThrow(/not found/);
    expect(fs.existsSync(path.join(d, 'nope.db'))).toBe(false);
    const other = path.join(d, 'other.db'); const o = new DatabaseSync(other); o.exec('CREATE TABLE unrelated (a INTEGER)'); o.close();
    expect(() => openSqlite(other)).toThrow(/no launch_recording table/);
  });

  it('JSONL and SQLite give the same launches for the same rows', async () => {
    const d = scratch(); const rows = [...organic(1_000_000, 3, 5), ...organic(2_000_000, 3, 5)];
    writeJsonl(path.join(d, 's.jsonl'), rows);
    const db = new WorkstationDatabase(path.join(d, 'p.db')); for (const r of rows) db.recordLaunchEvent(r.ts, r.mint, r.kind, r.payload);
    const j = await openJsonl(path.join(d, 's.jsonl')), s = openSqlite(path.join(d, 'p.db'));
    expect([...j.launches()]).toEqual([...s.launches()]);
    s.close();
  });

  it('recordedToCorpus is the inverse of toRecordedLaunch for the fields the late-rule script reads', () => {
    const t0 = 1_780_000_000_000;
    const c: CorpusLaunch = { mint: 'MintX', symbol: 'FX', creator: 'Creator', mayhem: false, t0, graduated: false, trades: [
      [t0 + 1000, true, 0.5, 1_000_000, 'W1', 31_500_000_000, 1_020_000_000_000_000, 'sig1'],
      [t0 + 2000, false, 0.25, 500_000, 'W2', 31_250_000_000, 1_027_000_000_000_000, 'sig2'],
    ] };
    const back = recordedToCorpus(toRecordedLaunch(c, 150))!;
    expect(back.t0).toBe(t0); expect(back.mint).toBe('MintX'); expect(back.symbol).toBe('FX'); expect(back.creator).toBe('Creator'); expect(back.mayhem).toBe(false);
    expect(back.trades).toEqual(c.trades);
    expect(recordedToCorpus({ mint: 'm', events: [{ ts: 1, kind: 'TRADE', payload: {} }] })).toBeNull();
  });

  it('a launch read through the JSONL adapter replays exactly as the in-memory launch does', async () => {
    const d = scratch(); const rows = organic(1_700_000_000_000, 40, 60); const f = path.join(d, 's.jsonl'); writeJsonl(f, rows);
    const direct = replayLaunch({ mint: rows[0].mint, events: rows.map((r) => ({ ts: r.ts, kind: r.kind as 'CREATE' | 'TRADE', payload: r.payload })) }, [], 150, { minScore: 50 });
    const via = replayLaunch([...(await openJsonl(f)).launches()][0], [], 150, { minScore: 50 });
    expect(direct.entered).toBe(true);
    expect(via).toEqual(direct);
  });
});

describe('S228 the train/test split', () => {
  const src = { createTimes: () => Array.from({ length: 100 }, (_, i) => 1000 + i) } as any;
  it('--split-ts wins; the corpus keeps its fixed cut; recorded data cuts at the 75th percentile of create times', () => {
    expect(resolveSplit('1234567', src, 99)).toMatchObject({ cut: 1234567, isDefaultCorpus: false });
    expect(resolveSplit(undefined, null, 99)).toMatchObject({ cut: 99, isDefaultCorpus: true });
    expect(resolveSplit('', src, 99)).toMatchObject({ cut: 1075, isDefaultCorpus: false });
    expect(resolveSplit(undefined, { createTimes: () => [] } as any, 99).cut).toBe(99);
  });
  it('refuses a split that is not a time in milliseconds', () => {
    for (const bad of ['abc', '-5', '0', 'NaN']) expect(() => resolveSplit(bad, src, 99)).toThrow(/--split-ts/);
  });
});

describe('S228 the two scripts run on a recorded snapshot', () => {
  const tsx = path.resolve('node_modules/.bin/tsx');
  const run = (script: string, args: string[]) => execFileSync(tsx, [script, ...args], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '', HOME: os.homedir() }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 110_000 });

  it('exit_variants --recorded: finds entries, its own loop matches replayLaunch (0 differ), carries the funder count and honours --split-ts', () => {
    const d = scratch(); const f = path.join(d, 's.jsonl'); const out = path.join(d, 'o.json');
    const t = 1_700_000_000_000; const rows = [...organic(t, 40, 60), ...organic(t + 600_000, 40, 60), ...organic(t + 1_200_000, 40, 60), { ts: t + 5, mint: '', kind: 'FUNDER', payload: { wallet: wallet(), funder: wallet() } } as Row];
    writeJsonl(f, rows);
    run('scripts/hfcorpus/exit_variants.ts', ['--recorded', f, '--out', out, '--split-ts', String(t + 900_000)]);
    const res = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(res.input).toMatchObject({ recorded: f, kind: 'jsonl', launches: 3, funderFacts: 1 });
    expect(res.split.cutMs).toBe(t + 900_000);
    expect(res.entriesByThreshold['50']).toBeGreaterThan(0);
    expect(res.validation.differ).toBe(0);
    const splits = new Set(res.rows.map((r: any) => r.split));
    expect([...splits].some((s) => String(s).startsWith('train'))).toBe(true);
    const all50 = res.rows.find((r: any) => r.split === 'all' && r.threshold === 50);
    const tr = res.rows.find((r: any) => String(r.split).startsWith('train') && r.threshold === 50 && r.haircut === all50.haircut && r.stop === all50.stop && r.tp1 === all50.tp1 && r.staleMin === all50.staleMin);
    const te = res.rows.find((r: any) => String(r.split).startsWith('test') && r.threshold === 50 && r.haircut === all50.haircut && r.stop === all50.stop && r.tp1 === all50.tp1 && r.staleMin === all50.staleMin);
    expect(tr.entries + te.entries).toBe(all50.entries);
  }, 120_000);

  it('exit_variants --recorded on a SQLite file gives the same entries as the JSONL snapshot of the same rows, and leaves the database untouched', () => {
    const d = scratch(); const t = 1_700_000_000_000; const rows = [...organic(t, 40, 60), ...organic(t + 600_000, 40, 60)];
    writeJsonl(path.join(d, 's.jsonl'), rows);
    const dbFile = path.join(d, 'p.db'); const db = new WorkstationDatabase(dbFile); for (const r of rows) db.recordLaunchEvent(r.ts, r.mint, r.kind, r.payload);
    const before = fs.readFileSync(dbFile); const mtime = fs.statSync(dbFile).mtimeMs;
    run('scripts/hfcorpus/exit_variants.ts', ['--recorded', path.join(d, 's.jsonl'), '--out', path.join(d, 'j.json'), '--split-ts', String(t + 300_000)]);
    run('scripts/hfcorpus/exit_variants.ts', ['--recorded', dbFile, '--out', path.join(d, 'q.json'), '--split-ts', String(t + 300_000)]);
    const j = JSON.parse(fs.readFileSync(path.join(d, 'j.json'), 'utf8')), q = JSON.parse(fs.readFileSync(path.join(d, 'q.json'), 'utf8'));
    expect(q.input.kind).toBe('sqlite');
    expect(q.entriesByThreshold).toEqual(j.entriesByThreshold);
    expect(q.rows).toEqual(j.rows);
    expect(fs.statSync(dbFile).mtimeMs).toBe(mtime);
    expect(fs.readFileSync(dbFile).equals(before)).toBe(true);
  }, 120_000);

  it('late_rule --recorded: needs no graduation file, says so, counts the launches and splits at --split-ts', () => {
    const d = scratch(); const f = path.join(d, 's.jsonl'); const out = path.join(d, 'o.json');
    const t = 1_700_000_000_000; writeJsonl(f, [...organic(t, 40, 60), ...organic(t + 600_000, 40, 60)]);
    run('scripts/hfcorpus/late_rule.ts', ['--recorded', f, '--checkpoint', '0.5', '--curve', '0.01', '--out', out, '--split-ts', String(t + 300_000)]);
    const res = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(res.input).toMatchObject({ recorded: f, kind: 'jsonl', graduationKnown: false });
    expect(res.counts.launches).toBe(2);
    expect(res.counts.graduatedBeforeEntry).toBe(0);
    expect(res.split.cutMs).toBe(t + 300_000);
    const parts = new Set(res.rows.map((r: any) => r.part));
    expect(parts).toEqual(new Set(['train', 'test']));
  }, 120_000);

  it('both scripts refuse to start with no input', () => {
    for (const s of ['exit_variants', 'late_rule']) expect(() => run(`scripts/hfcorpus/${s}.ts`, ['--out', '/tmp/none.json'])).toThrow();
  }, 120_000);
});
