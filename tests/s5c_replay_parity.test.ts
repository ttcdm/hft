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
