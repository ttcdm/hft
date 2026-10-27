import { describe, it, expect, afterEach } from 'vitest';
import { replayLaunch, type ReplayOptions } from '../server/backtest/replay';
import { simulatePath, restoreStockEngine, type TradeRow } from '../server/backtest/costModel';
import { toRecordedLaunch, type CorpusLaunch } from '../scripts/hfcorpus/replay';

/**
 * R2-2, R6-11, R7-12 (haiku 2026-10-26): the replay's coverage, entry rule and summary must not assume a quiet market the recording did
 * not show, and must not report only the closed positions as the result.
 */
const T0 = 1_760_000_000_000;
/** steady buying by 40 distinct wallets on the chain's curve maths, which the window releases at threshold 0 */
function curve(t0 = T0): TradeRow[] {
  let vSol = 30e9, vTok = 1.073e15;
  const rows: TradeRow[] = [];
  for (let i = 0; i < 60; i++) {
    const sol = 0.3 + (i % 5) * 0.2, k = vSol * vTok, newS = vSol + sol * 1e9, newT = k / newS;
    rows.push([t0 + 1500 + i * 900, true, sol, (vTok - newT) / 1e6, 'w' + (i % 40), Math.round(newS), Math.round(newT), `w-${i}`]);
    vSol = newS; vTok = newT;
  }
  return rows;
}
const launch = (rows: TradeRow[], mint = 'MintR22'): CorpusLaunch => ({ mint, symbol: 'R', creator: 'creatorR22', mayhem: false, t0: T0, graduated: false, trades: rows });
const GATE: ReplayOptions = { minScore: 0, readyGate: false, curveCap: false };
/** the curve cut at its release: nothing trades after the window lets it go */
function quiet(): TradeRow[] {
  const full = curve();
  const r = replayLaunch(toRecordedLaunch(launch(full), 150), [], 150, GATE);
  const rel = T0 + (r.releasedAfterMs as number);
  return full.filter((x) => x[0] <= rel);
}

describe('R7-12: no entry at a print taken before the recording ended', () => {
  afterEach(() => restoreStockEngine());

  it('a TRADE_CAP launch whose buy would land after the cut is not entered', () => {
    const rows = quiet();
    const last = rows[rows.length - 1][0];
    const rec = { ...toRecordedLaunch(launch(rows), 150), endTs: last + 1, endReason: 'TRADE_CAP' };
    const r = replayLaunch(rec, [], 150, GATE);
    expect(r.verdict === 'HOT' || r.verdict === 'READY').toBe(true);
    expect(r.entered).toBe(false);
    expect(r.outcome).toBe('NO_ENTRY');
    expect(r.noEntryReason).toMatch(/^ENTRY_AFTER_RECORDING/);
  });

  it('the same launch recorded quiet to its window end (END WINDOW) is entered at the last print', () => {
    const rows = quiet();
    const rec = { ...toRecordedLaunch(launch(rows), 150), endTs: T0 + 35 * 60_000, endReason: 'WINDOW' };
    expect(replayLaunch(rec, [], 150, GATE).entered).toBe(true);
  });

  it('simulatePath with a coverage end refuses a landing past it; without one (the corpus studies) it still fills at the last print', () => {
    const rows = quiet();
    const last = rows[rows.length - 1][0];
    expect(simulatePath(rows, last, { entryMs: 1_500, exitMs: 1_500 }, null, { coveredUntilTs: last + 1 })).toBeNull();
    expect(simulatePath(rows, last, { entryMs: 1_500, exitMs: 1_500 }, null)).not.toBeNull();
  });
});

// ---- the database side: markers come back, a read error is an error -----------------------------------------------------------------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { WorkstationDatabase } from '../server/db/database';

describe('R2-2 / R6-11: loadLaunchRecording returns the recorder markers and throws on a read error', () => {
  afterEach(() => vi.restoreAllMocks());
  const withDb = (fn: (db: WorkstationDatabase) => void) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r22-'));
    try { fn(new WorkstationDatabase(path.join(dir, 'r.db'))); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };

  it('MARKER rows come back oldest first and are not launch rows', () => {
    withDb((db) => {
      for (const e of toRecordedLaunch(launch(quiet()), 150).events) db.recordLaunchEvent(e.ts, 'MintR22', e.kind, e.payload);
      db.recordLaunchEvent(T0 + 50_000, '', 'MARKER', { reason: 'FEED_GAP', detail: 'reconnect' });
      db.recordLaunchEvent(T0 - 1, '', 'MARKER', { reason: 'RECORDER_START' });
      const { markers, launches } = db.loadLaunchRecording();
      expect(markers).toEqual([{ ts: T0 - 1, reason: 'RECORDER_START' }, { ts: T0 + 50_000, reason: 'FEED_GAP', detail: 'reconnect' }]);
      expect(launches).toHaveLength(1);
      const st = db.getLaunchRecordingStatus();
      expect(st.launchRows).toBe(launches[0].events.length);
      expect(st.oldestTs).toBe(T0);
    });
  });

  it('a read error throws instead of reading as an empty recording', () => {
    withDb((db) => {
      db.recordLaunchEvent(T0, 'MintR22', 'CREATE', { mint: 'MintR22' });
      vi.spyOn((db as any).db, 'prepare').mockImplementation(() => { throw new Error('SQLITE_IOERR: disk I/O error'); });
      expect(() => db.loadLaunchRecording()).toThrow(/could not be read: SQLITE_IOERR/);
    });
  });
});
