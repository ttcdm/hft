import { describe, it, expect, afterEach } from 'vitest';
import { replayLaunch, replayLaunches, REPLAY_DEFAULTS, type ReplayOptions } from '../server/backtest/replay';
import { restoreStockEngine, type TradeRow } from '../server/backtest/costModel';
import { toRecordedLaunch, type CorpusLaunch } from '../scripts/hfcorpus/replay';

/**
 * 5C: the replay runs the gates live runs at the buy, and the studies stop looking ahead. Every block fails on the 5A + 5B base (e9fecde)
 * without its commit.
 */

const T0 = 1_760_000_000_000;
const CREATOR = 'creator5C';
/** constant-product buys on the chain's curve maths; `first` puts one buy (e.g. the creator's) before the 60 warm-up buys */
function curve(first?: { user: string; sol: number }, t0 = T0): TradeRow[] {
  let vSol = 30e9, vTok = 1.073e15;
  const rows: TradeRow[] = [];
  const buy = (ts: number, sol: number, user: string, sig: string) => {
    const k = vSol * vTok, newS = vSol + sol * 1e9, newT = k / newS;
    rows.push([ts, true, sol, (vTok - newT) / 1e6, user, Math.round(newS), Math.round(newT), sig]);
    vSol = newS; vTok = newT;
  };
  if (first) buy(t0 + 500, first.sol, first.user, 'first');
  for (let i = 0; i < 60; i++) buy(t0 + 1500 + i * 900, 0.3 + (i % 5) * 0.2, 'w' + (i % 40), `w-${i}`);
  return rows;
}
const launch = (rows: TradeRow[], t0 = T0): CorpusLaunch => ({ mint: 'Mint5C', symbol: 'FC', creator: CREATOR, mayhem: false, t0, graduated: false, trades: rows });
const GATE: ReplayOptions = { minScore: 0, readyGate: false, curveCap: false };
const replay = (rows: TradeRow[], o: ReplayOptions = {}) => replayLaunch(toRecordedLaunch(launch(rows), 150), [], 150, { ...GATE, ...o });

describe('5C (R1-105): the replay applies the dev-holding gate executeSnipe applies', () => {
  afterEach(() => restoreStockEngine());

  // 2.25 SOL into a fresh curve buys about 75M of the 1B tokens: 7.5% of the supply
  const devBuy = { user: CREATOR, sol: 2.25 };

  it('a 7% creator buy gives NO_ENTRY with a dev-holding reason at the default 5% limit', () => {
    const r = replay(curve(devBuy));
    expect(r.verdict === 'HOT' || r.verdict === 'READY').toBe(true);
    expect(r.entered).toBe(false);
    expect(r.outcome).toBe('NO_ENTRY');
    expect(r.noEntryReason).toMatch(/^DEV_HOLDING: creator holds 7\.\d\d% \(limit 5%\)/);
  });

  it('the limit is the setting passed in, and 0 turns it off as in live', () => {
    expect(replay(curve(devBuy), { maxDevHoldingPct: 10 }).entered).toBe(true);
    expect(replay(curve(devBuy), { maxDevHoldingPct: 0 }).entered).toBe(true);
    expect(REPLAY_DEFAULTS.maxDevHoldingPct).toBe(5);
  });

  it('the same buy by someone else is not the creator\'s holding', () => {
    expect(replay(curve({ user: 'stranger', sol: 2.25 })).entered).toBe(true);
  });

  it('the report states the gate', () => {
    const rep = replayLaunches([toRecordedLaunch(launch(curve(devBuy)), 150)], [], 150, GATE);
    expect(rep.rules.join(' ')).toMatch(/hold at most 5% of the supply/);
    expect(rep.notReplayed.join(' ')).not.toMatch(/holder concentration\): not recorded/);
  });
});

// ---- the creator factor ----------------------------------------------------------------------------------------------------------------
import { Keypair } from '@solana/web3.js';
import { creatorRiskScorer } from '../server/signals/creatorRiskScorer';
import { ConfluenceEngine } from '../server/signals/confluenceEngine';

describe('5C (R1-61): the replay scores the creator as live does without a report', () => {
  afterEach(() => { restoreStockEngine(); creatorRiskScorer.clearCache(); });
  const creator = Keypair.generate().publicKey.toBase58();
  const withCreator = (who: string) => toRecordedLaunch({ ...launch(curve()), creator: who }, 150);

  it('a known creator with 0% dev holding and no report gets 0 creator points, not the 5 of the dev-holding fallback', () => {
    const known = replayLaunch(withCreator(creator), [], 150, GATE);
    const unknown = replayLaunch(withCreator(''), [], 150, GATE); // no creator at all: the engine's dev-holding fallback (0% = 5 points)
    expect(known.releasedAfterMs).toBe(unknown.releasedAfterMs);
    expect((unknown.score as number) - (known.score as number)).toBe(5);
  });

  it('the running app\'s creator cache does not leak into the replay', async () => {
    const before = replayLaunch(withCreator(creator), [], 150, GATE).score;
    // an established wallet: 60 signatures over 40 days, which live scores 5 of 5
    const nowSec = Math.floor(Date.now() / 1000);
    const sigs = Array.from({ length: 60 }, (_, i) => ({ signature: `s${i}`, slot: i, err: null, memo: null, blockTime: nowSec - 40 * 86_400 + i * 3_600 }));
    const report = await creatorRiskScorer.evaluateCreator({ getSignaturesForAddress: async () => sigs }, creator);
    expect(report.confluenceScore).toBe(5);
    expect(creatorRiskScorer.getCachedReport(creator)).toBeDefined();
    expect(replayLaunch(withCreator(creator), [], 150, GATE).score).toBe(before);
  });

  it('live reads still use the cache: null is the only way to say "no report"', async () => {
    const base = { priceChange5mPct: 0, liquidityUsd: null, top10HoldersPct: null, bondingCurveProgress: 0, buys5m: 0, sells5m: 0, devHoldingPct: 0, hasVerifiedSocialCall: false, socialCallCount: 0 };
    const nowSec = Math.floor(Date.now() / 1000);
    const sigs = Array.from({ length: 60 }, (_, i) => ({ signature: `s${i}`, slot: i, err: null, memo: null, blockTime: nowSec - 40 * 86_400 + i * 3_600 }));
    await creatorRiskScorer.evaluateCreator({ getSignaturesForAddress: async () => sigs }, creator);
    expect(ConfluenceEngine.calculate({ ...base, creatorAddress: creator }).creatorRiskScore).toBe(5);
    const none = ConfluenceEngine.calculate({ ...base, creatorAddress: creator, creatorRiskReport: null });
    expect(none.creatorRiskScore).toBe(0);
  });
});

// ---- the peak analysis -----------------------------------------------------------------------------------------------------------------
import { analysePeaks, type ReplayedLaunch } from '../server/backtest/replay';

describe('5C (R1-108): the late-spike counts and their "of" are the same launches', () => {
  const MIN = 60_000;
  const row = (timeToPeakMin: number, observedMin: number, multiple: number): ReplayedLaunch => ({
    mint: `m${timeToPeakMin}-${observedMin}`, symbol: 'P', trades: 10, verdict: 'READY', verdictReason: '', releasedAfterMs: 120_000, score: 70, entered: false, noEntryReason: null,
    outcome: 'NO_ENTRY', entryPriceSol: null, exits: [], holdMs: null, netPnlSol: null, openValueSol: null,
    peak: { refPriceSol: 1, peakPriceSol: multiple, peakMultiple: multiple, timeToPeakMs: timeToPeakMin * MIN, observedMs: observedMin * MIN },
  });

  it('a 2x peak at 35 min with 40 min observed counts 0 when no launch has 60+ min of data', () => {
    const a = analysePeaks([row(35, 40, 2.5), row(5, 20, 3)]);
    expect(a.late.ofLaunchesWithAtLeast60MinData).toBe(0);
    expect(a.late.peakAfter30MinAtLeast2x).toBe(0);
  });

  it('a late peak counts only where the recording reaches the denominator\'s length (and likewise for 60 / 180 min)', () => {
    const a = analysePeaks([row(35, 40, 2.5), row(45, 70, 2.5), row(50, 90, 1.5), row(70, 120, 4), row(90, 200, 3)]);
    expect(a.late.ofLaunchesWithAtLeast60MinData).toBe(4);
    expect(a.late.peakAfter30MinAtLeast2x).toBe(3); // 45/70, 70/120, 90/200; not 35/40 (40 min observed), not 50/90 (1.5x)
    expect(a.late.ofLaunchesWithAtLeast180MinData).toBe(1);
    expect(a.late.peakAfter60MinAtLeast2x).toBe(1); // 90/200; not 70/120 (120 min observed)
  });
});

// ---- how each recording ended (5B's END rows) ------------------------------------------------------------------------------------------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReplayBacktestView, type ReplayResponse } from '../src/components/BacktestModal';
import { WorkstationDatabase } from '../server/db/database';

describe('5C (R1-106): the replay labels truncated, graduated and unresolved launches and reports them apart', () => {
  afterEach(() => restoreStockEngine());
  /** the warm-up cut at its release, so the coin is quiet after the buy */
  const quiet = (): TradeRow[] => { const full = curve(); const rel = T0 + (replay(full).releasedAfterMs as number); return full.filter((x) => x[0] <= rel); };
  const rec = (end?: { endTs: number; endReason: string }, mint = 'Mint5C') => ({ ...toRecordedLaunch({ ...launch(quiet()), mint }, 150), ...(end ?? {}) });
  const lastTs = () => { const q = quiet(); return q[q.length - 1][0]; };

  it('each END reason gives its label; no END row is UNRESOLVED', () => {
    expect(replayLaunch(rec({ endTs: T0 + 35 * 60_000, endReason: 'WINDOW' }), [], 150, GATE).recording).toBe('COMPLETE');
    expect(replayLaunch(rec({ endTs: lastTs() + 1, endReason: 'TRADE_CAP' }), [], 150, GATE).recording).toBe('TRUNCATED');
    expect(replayLaunch(rec({ endTs: lastTs(), endReason: 'CURVE_COMPLETE' }), [], 150, GATE).recording).toBe('GRADUATED');
    expect(replayLaunch(rec(), [], 150, GATE).recording).toBe('UNRESOLVED');
  });

  it('the summary splits launches, entries and money by label', () => {
    const rep = replayLaunches([rec({ endTs: T0 + 35 * 60_000, endReason: 'WINDOW' }), rec({ endTs: lastTs() + 1, endReason: 'TRADE_CAP' }, 'cut'), rec(undefined, 'open')], [], 150, GATE);
    const b = rep.summary.byRecording;
    expect([b.COMPLETE.launches, b.TRUNCATED.launches, b.GRADUATED.launches, b.UNRESOLVED.launches]).toEqual([1, 1, 0, 1]);
    expect(b.COMPLETE.closed).toBe(1); // recorded quiet to the window end: the stale exit closes it
    expect(b.TRUNCATED.openAtEnd).toBe(1); // cut by the cap: nothing assumed past the cut
    expect(b.COMPLETE.closed + b.TRUNCATED.closed + b.UNRESOLVED.closed).toBe(rep.summary.closed);
    expect(b.COMPLETE.netPnlSol).toBeCloseTo(rep.launches[0].netPnlSol as number, 12);
  });

  it('a launch with no END row is never assumed recorded past the moment the recording was read', () => {
    const W = { recordedForMs: 35 * 60_000 };
    expect(replayLaunch(rec(), [], 150, { ...GATE, ...W }).outcome).toBe('CLOSED'); // the window alone: quiet to create + 35 min, stale exit
    // read 5 minutes after the create: the launch may still be recording, so nothing after the read is assumed
    expect(replayLaunch(rec(), [], 150, { ...GATE, ...W, readAtTs: T0 + 5 * 60_000 }).outcome).toBe('OPEN_AT_END');
    // an END row decides on its own
    expect(replayLaunch(rec({ endTs: T0 + 35 * 60_000, endReason: 'WINDOW' }), [], 150, { ...GATE, ...W, readAtTs: T0 + 5 * 60_000 }).outcome).toBe('CLOSED');
  });

  it('the label comes through from the database: an END/TRADE_CAP row read back by loadLaunchRecording', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's5c-'));
    try {
      const db = new WorkstationDatabase(path.join(dir, 'r.db'));
      const rows = quiet();
      for (const e of toRecordedLaunch(launch(rows), 150).events) db.recordLaunchEvent(e.ts, 'Mint5C', e.kind, e.payload);
      db.recordLaunchEvent(rows[rows.length - 1][0] + 1, 'Mint5C', 'END', { reason: 'TRADE_CAP', trades: rows.length });
      const { launches } = db.loadLaunchRecording();
      expect(replayLaunches(launches, [], 150, GATE).summary.byRecording.TRUNCATED.launches).toBe(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('the Backtest screen says how many recordings are unresolved or cut', () => {
    const report = replayLaunches([rec({ endTs: lastTs() + 1, endReason: 'TRADE_CAP' }, 'cut'), rec()], [], 150, GATE);
    const data = { recorded: { launches: 2, events: 10, oldestTs: T0, newestTs: T0 + 1 }, report, message: null, replayedLaunches: 2, replayCap: 5000 } as unknown as ReplayResponse;
    const html = renderToStaticMarkup(React.createElement(ReplayBacktestView, { data }));
    expect(html).toContain('data-testid="replay-by-recording"');
    expect(html).toMatch(/1 cut by the trade cap, 0 graduated, 1 unresolved/);
  });
});

// ---- the recordings reader for the offline studies ------------------------------------------------------------------------------------
import { vi } from 'vitest';
import { openJsonl, openSqlite } from '../scripts/recorder_backtest/recorded';

describe('5C: the own-recordings reader takes END rows (JSONL and SQLite) and gives each launch its end', () => {
  const rows = curve();
  const events = toRecordedLaunch(launch(rows), 150).events;
  const endTs = rows[rows.length - 1][0] + 1;

  it('a JSONL snapshot with END lines skips nothing and sets endTs / endReason', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's5c-jsonl-'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const file = path.join(dir, 'snap.jsonl');
      const lines = [...events.map((e) => ({ ts: e.ts, mint: 'Mint5C', kind: e.kind, payload: e.payload })), { ts: endTs, mint: 'Mint5C', kind: 'END', payload: { reason: 'TRADE_CAP', trades: rows.length } }];
      fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      const src = await openJsonl(file);
      const [l] = [...src.launches()];
      expect(err).not.toHaveBeenCalled();
      expect(l.endTs).toBe(endTs);
      expect(l.endReason).toBe('TRADE_CAP');
      expect(l.events.every((e) => e.kind === 'CREATE' || e.kind === 'TRADE')).toBe(true);
      expect(replayLaunch(l, [], 150, GATE).recording).toBe('TRUNCATED');
    } finally { err.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('the paper database gives the same launch the same end', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's5c-sqlite-'));
    try {
      const file = path.join(dir, 'paper.db');
      const db = new WorkstationDatabase(file);
      for (const e of events) db.recordLaunchEvent(e.ts, 'Mint5C', e.kind, e.payload);
      db.recordLaunchEvent(endTs, 'Mint5C', 'END', { reason: 'WINDOW', trades: rows.length });
      const src = openSqlite(file);
      const [l] = [...src.launches()];
      src.close();
      expect(l.endTs).toBe(endTs);
      expect(l.endReason).toBe('WINDOW');
      expect(l.events.length).toBe(events.length);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
