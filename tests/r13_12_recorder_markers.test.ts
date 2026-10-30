import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { Keypair } from '@solana/web3.js';
import { WorkstationDatabase } from '../server/db/database';
import { replayLaunch } from '../server/backtest/replay';
import { eventToJson } from '../server/backtest/launchRecorder';
import { recorderConfig } from '../server/backtest/recorderConfig';
import { openRecorded, cutAtRecordingGap } from '../scripts/recorder_backtest/recorded';
import { summarizeReadyStrength } from '../scripts/recorder_backtest/ready_strength';

/**
 * R13-12 (haiku round 13): the in-app replay cuts a launch at the first recorder MARKER inside it (a restart or a feed gap, R2-2), but the
 * recorder_backtest scripts never loaded MARKER rows: JSONL skipped them as bad lines, SQLite never asked for them, so a launch that a restart
 * cut was studied as if it had been recorded whole. HAND-BUILT recordings; the real adapters, the real replay and the real scripts.
 */
const dirs: string[] = [];
const scratch = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-12-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const wallet = () => Keypair.generate().publicKey.toBase58();
const createEvent = (mint: string, creator: string, t0: number) => ({
  signature: 'c-' + mint.slice(0, 6), slot: 1, mint, creator, user: creator, bondingCurve: wallet(), name: 'Fx', symbol: 'FX', uri: '',
  virtualTokenReserves: 1_073_000_000_000_000n, virtualSolReserves: 30_000_000_000n, realTokenReserves: 793_100_000_000_000n, realSolReserves: 0n,
  tokenTotalSupply: 1_000_000_000_000_000n, initialPriceSol: 30 / 1_073_000_000, initialMarketCapSol: 28, receivedAt: t0, parsedAt: t0, parseLatencyMs: 0, source: 'TEST_FEED' as const,
});
type Row = { ts: number; mint: string; kind: 'CREATE' | 'TRADE' | 'FUNDER' | 'MARKER'; payload: Record<string, unknown> };
/** The S228 organic launch: many distinct buyers, steady buying; the replay enters it at the 50 threshold. */
function organic(t0: number, buyers = 40, count = 60): Row[] {
  let vSol = 30, vTok = 1_073_000_000, rSol = 0, rTok = 793_100_000;
  const mint = wallet(), creator = wallet(); const ws = Array.from({ length: buyers }, wallet);
  const rows: Row[] = [{ ts: t0, mint, kind: 'CREATE', payload: { ...eventToJson(createEvent(mint, creator, t0)), solUsd: 150 } }];
  for (let i = 0; i < count; i++) {
    const isBuy = i < 45 || i % 4 !== 0, sol = 0.3 + (i % 5) * 0.2;
    const k = vSol * vTok; const nv = isBuy ? vSol + sol : Math.max(1, vSol - sol); const nt = k / nv; const tok = Math.abs(vTok - nt);
    vSol = nv; vTok = nt; rSol = Math.max(0, rSol + (isBuy ? sol : -sol)); rTok = Math.max(0, rTok + (isBuy ? -tok : tok));
    rows.push({ ts: t0 + 1500 + i * 900, mint, kind: 'TRADE', payload: eventToJson({ signature: `s-${mint.slice(0, 6)}-${i}`, slot: 100 + i, mint, solAmountLamports: BigInt(Math.round(sol * 1e9)), tokenAmount: BigInt(Math.round(tok * 1e6)), isBuy, user: ws[i % ws.length], timestampSec: 0,
      virtualSolReserves: BigInt(Math.round(vSol * 1e9)), virtualTokenReserves: BigInt(Math.round(vTok * 1e6)), realSolReserves: BigInt(Math.round(rSol * 1e9)), realTokenReserves: BigInt(Math.round(rTok * 1e6)) }) });
  }
  return rows;
}
const T = 1_700_000_000_000;
/** Two launches; a recorder restart 1 s into the first (before its first trade) cut it. The second is whole. */
function recording(): Row[] {
  return [...organic(T), { ts: T + 1_000, mint: '', kind: 'MARKER', payload: { reason: 'RECORDER_START', detail: 'restart' } }, ...organic(T + 600_000)];
}
const writeJsonl = (file: string, rows: Row[]) => fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const tsx = path.resolve('node_modules/.bin/tsx');
const run = (script: string, args: string[]) => execFileSync(tsx, [script, ...args], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '', HOME: os.homedir() }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 110_000 });

describe('R13-12: the recorder-backtest scripts load MARKER rows and cut launches at them, as the in-app replay does', () => {
  it('both adapters return the MARKER rows the app reads (WorkstationDatabase.loadLaunchRecording), and the cut matches the replay\'s', async () => {
    const d = scratch(); const rows = recording();
    const jsonl = path.join(d, 's.jsonl'); writeJsonl(jsonl, rows);
    const dbFile = path.join(d, 'p.db'); const db = new WorkstationDatabase(dbFile); for (const r of rows) db.recordLaunchEvent(r.ts, r.mint, r.kind, r.payload);
    const app = db.loadLaunchRecording(500);
    expect(app.markers).toEqual([{ ts: T + 1_000, reason: 'RECORDER_START', detail: 'restart' }]);
    for (const file of [jsonl, dbFile]) {
      const src = await openRecorded(file);
      expect(src.markers()).toEqual(app.markers); // was: no markers() at all, and the JSONL MARKER line was skipped as a bad row
      const [a, b] = [...src.launches()];
      const ca = cutAtRecordingGap(a, src.markers(), recorderConfig({}).mintMs), cb = cutAtRecordingGap(b, src.markers(), recorderConfig({}).mintMs);
      expect(ca.gap?.reason).toBe('RECORDER_START');
      expect(ca.rec.events.map((e) => e.kind)).toEqual(['CREATE']); // nothing at or after the restart is kept
      expect(cb.gap).toBeNull(); expect(cb.rec).toBe(b);
      src.close();
    }
  });

  it('exit_variants, ready_strength and late_rule no longer enter the launch the restart cut', () => {
    const d = scratch(); const f = path.join(d, 's.jsonl'); const rows = recording(); writeJsonl(f, rows);
    // what the in-app replay says (server.ts passes the markers, the recorder window and the trade cap), and what it said with no markers
    const rc = recorderConfig({});
    const markers = rows.filter((r) => r.kind === 'MARKER').map((r) => ({ ts: r.ts, reason: String(r.payload.reason), detail: String(r.payload.detail) }));
    const byMint = new Map<string, Row[]>(); for (const r of rows) if (r.kind !== 'MARKER') byMint.set(r.mint, [...(byMint.get(r.mint) ?? []), r]);
    const recs = [...byMint.entries()].map(([mint, ev]) => ({ mint, events: ev.map((e) => ({ ts: e.ts, kind: e.kind as 'CREATE' | 'TRADE', payload: e.payload as any })) }));
    const cut = { markers, recordedForMs: rc.mintMs, recordedMaxTrades: rc.maxTradesPerMint };
    const inApp = recs.map((r) => replayLaunch(r, [], 150, { minScore: 50, ...cut }));
    const whole = recs.map((r) => replayLaunch(r, [], 150, { minScore: 50 }));
    expect(whole.filter((r) => r.entered)).toHaveLength(2);
    expect(inApp.filter((r) => r.entered)).toHaveLength(1);

    const ev = path.join(d, 'ev.json');
    run('scripts/recorder_backtest/exit_variants.ts', ['--recorded', f, '--out', ev]);
    const e = JSON.parse(fs.readFileSync(ev, 'utf8'));
    expect(e.entriesByThreshold['50']).toBe(1); // was 2: the cut launch was studied whole
    expect(e.validation.differ).toBe(0);

    const rs = path.join(d, 'rs.json');
    run('scripts/recorder_backtest/ready_strength.ts', ['--recorded', f, '--threshold', '50', '--out', rs]);
    const s = JSON.parse(fs.readFileSync(rs, 'utf8'));
    const want = summarizeReadyStrength(recs.map((r) => replayLaunch(r, [], 150, { minScore: 50, readyGate: false, ...cut })));
    expect(s.groups).toEqual(want.groups);
    expect(s.readyEntries).toBe(want.readyEntries);

    const lr = path.join(d, 'lr.json');
    run('scripts/recorder_backtest/late_rule.ts', ['--recorded', f, '--checkpoint', '0.5', '--curve', '0.01', '--out', lr, '--split-ts', String(T + 300_000)]);
    const l = JSON.parse(fs.readFileSync(lr, 'utf8'));
    expect(l.counts.launches).toBe(2);
    expect(l.counts.recordingGap).toBe(1);
    expect(l.counts.tradedBeforeCp).toBe(1); // was 2
    expect(l.rows.every((r: any) => r.part === 'test')).toBe(true); // only the second launch (after the split) is entered
  }, 300_000);
});
