import '../hermeticEnv';
import fs from 'fs';
import { ExitEngine } from '../../server/exits/exitEngine';
import { stateAt } from '../../server/backtest/costModel';
import { cutAtRecordingGap, openRecorded, recordedToLaunch, resolveSplit, type Launch } from './recorded';

/**
 * S228: prices the rule "buy at the 30-minute mark if the curve is at least X% done" on the app's OWN launch recordings. A separate copy of the logic in
 * scripts/hfcorpus/late_rule.ts (which it does not touch); the results are for the recordings only and are never to be merged with the 39-day corpus results.
 *   npx tsx scripts/recorder_backtest/late_rule.ts --recorded <paper.db | snapshot.jsonl> [--curve 40] [--checkpoint 30] [--side 2] [--out result.json] [--split-ts <unix ms>]
 * 5C (R1-109): only what is known at the checkpoint decides. The buy lands at launch + checkpoint + 1.5 s and fills at the curve state then (the
 * last print at or before it), not at the next print. Curve progress: the last trade before the checkpoint (share of the curve's 793.1M tokens
 * sold). Two exit sets: STOCK (the real ExitEngine as shipped) and TRAIL (take-profits off, hard stop and trailing stop kept, forced exit 6 h
 * after entry). The engine runs at each later print and once more where the recording is known to end (its END row, 5B), at the last price,
 * so a coin that went quiet is closed by the stale exit (STOCK) or the 6 h exit (TRAIL) when the recording reaches that far.
 * Which launches are entered: one with a trade before the checkpoint whose recording is known to reach the buy (an END row at or after it, or a
 * trade after it), whether or not it trades again; a quiet one is closed at its entry price, paying both sides and the fixed costs. Counted
 * apart and not priced: recordingTooShort (the END row comes before the buy: recordings made with the old 30-minute window show nothing at a
 * 30-minute mark), curveCompleteBeforeEntry (END/CURVE_COMPLETE before the buy; there is no graduation list, so graduationKnown stays false)
 * and endUnknown (no END row and no trade after the buy: still recording, stopped with the app, or recorded before END rows, so whether it
 * went quiet is not known). `side` is the all-in cost per side in percent. A control group (curve below the cut-off) is priced the same way.
 * Train/test: --split-ts, else the 70th percentile of create times (a 30% holdout).
 */
const E = ExitEngine as unknown as Record<string, number>;
const STOCK = { HARD_STOP_LOSS_PCT: E.HARD_STOP_LOSS_PCT, TP1_TRIGGER_PCT: E.TP1_TRIGGER_PCT, TP2_TRIGGER_PCT: E.TP2_TRIGGER_PCT, STALE_POSITION_HOLD_MS: E.STALE_POSITION_HOLD_MS };
const useStock = () => Object.assign(E, STOCK);
const useTrail = () => Object.assign(E, STOCK, { TP1_TRIGGER_PCT: 1e9, TP2_TRIGGER_PCT: 1e9, STALE_POSITION_HOLD_MS: 1e15 });
export const ORDER = 0.005, FIXED = 2 * (0.000005 + 0.0001), ENTRY_DELAY = 1500, MAX_HOLD_MS = 6 * 3_600_000;
type Row = Launch['trades'][number];
const price = (r: Row) => r[5] / r[6] / 1000;
const curvePctOf = (r: Row) => (793_100_000_000_000 - (r[6] - 279_900_000_000_000)) / 793_100_000_000_000 * 100;

/** 5C: what the rule knows at the checkpoint, and where and at what price the buy lands. */
export interface Entry { ts: number; px: number; next: number; curvePct: number }
export function planEntry(trades: Row[], t0: number, cpMin: number): Entry | null {
  const cp = t0 + cpMin * 60_000, landTs = cp + ENTRY_DELAY;
  const iBefore = stateAt(trades, cp - 1); // the last trade strictly before the checkpoint
  if (iBefore < 0) return null;
  const iFill = stateAt(trades, landTs);
  return { ts: landTs, px: price(trades[iFill]), next: iFill + 1, curvePct: curvePctOf(trades[iBefore]) };
}

export interface Out { net: number; open: boolean }
/** The exits over the recorded prints, then once more at `coveredUntilTs` (where the recording is known to end; null: not known) at the last price. */
export function simulate(t: Row[], e: Entry, mode: 'STOCK' | 'TRAIL', side: number, coveredUntilTs: number | null): Out {
  (mode === 'STOCK' ? useStock : useTrail)();
  const h = side / 100, ep = e.px, ets = e.ts;
  let remaining = 1, proceeds = 0, hwm = ep, trail = 0, stage = 0, last = ep, lastTs = ets;
  const step = (px: number, ts: number): boolean => {
    const forced = mode === 'TRAIL' && ts - ets >= MAX_HOLD_MS;
    const d = ExitEngine.evaluate({ entryPriceSol: ep, currentPriceSol: px, highWaterMarkSol: hwm, trailingStopSol: trail, exitStage: stage, entryTimestamp: ets, currentTimestamp: ts });
    hwm = d.newHighWaterMarkSol; trail = d.newTrailingStopSol;
    if (!d.shouldExit && !forced) return false;
    const pct = forced && !d.shouldExit ? 100 : d.sellPercentage;
    const f = remaining * Math.min(100, Math.max(1, pct)) / 100;
    proceeds += f * ORDER * (1 - h) * (px / ep) * (1 - h);
    remaining -= f; stage = d.newExitStage;
    if (remaining <= 1e-9 || pct >= 100) { remaining = 0; return true; }
    return false;
  };
  let done = false;
  for (let i = e.next; i < t.length && !done; i++) { last = price(t[i]); lastTs = t[i][0]; done = step(last, lastTs); }
  // 5C: after the last print the price stays where it was until the recording ends; a time rule that is due by then closes at that price
  if (!done && coveredUntilTs !== null && coveredUntilTs > lastTs) step(last, coveredUntilTs);
  if (remaining > 1e-9) { proceeds += remaining * ORDER * (1 - h) * (last / ep) * (1 - h); return { net: proceeds - ORDER - FIXED, open: true }; }
  return { net: proceeds - ORDER - FIXED, open: false };
}

/** 5C: which launches are entered; see the header. `rec` carries the END row (endTs / endReason) when the recording has one. */
export type Considered = { entry: Entry; coveredUntilTs: number | null } | { skip: 'NO_TRADE_BEFORE_CP' | 'RECORDING_TOO_SHORT' | 'CURVE_COMPLETE_BEFORE_ENTRY' | 'END_UNKNOWN' };
export function considerLaunch(c: Launch, rec: { endTs?: number; endReason?: string }, cpMin: number): Considered {
  const e = planEntry(c.trades, c.t0, cpMin);
  if (!e) return { skip: 'NO_TRADE_BEFORE_CP' };
  if (rec.endTs !== undefined && rec.endTs < e.ts) return { skip: rec.endReason === 'CURVE_COMPLETE' ? 'CURVE_COMPLETE_BEFORE_ENTRY' : 'RECORDING_TOO_SHORT' };
  if (rec.endTs === undefined && e.next >= c.trades.length) return { skip: 'END_UNKNOWN' };
  return { entry: e, coveredUntilTs: rec.endTs ?? null };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
  const curveMin = Number(opt('curve', '40')), cpMin = Number(opt('checkpoint', '30')), side = Number(opt('side', '2')), outPath = opt('out', '');
  const recordedPath = opt('recorded', '');
  if (!recordedPath) throw new Error('usage: late_rule.ts --recorded <paper.db|snapshot.jsonl> [--curve n] [--checkpoint min] [--side pct] [--out f] [--split-ts ms]');
  const source = await openRecorded(recordedPath);
  const split = resolveSplit(opt('split-ts', ''), source);
  const CUT = split.cut;
  type Acc = { entries: number; wins: number; openAtEnd: number; net: number };
  const acc: Record<string, Acc> = {};
  const add = (key: string, o: Out) => { const a = (acc[key] ??= { entries: 0, wins: 0, openAtEnd: 0, net: 0 }); a.entries++; a.net += o.net; if (o.net > 0) a.wins++; if (o.open) a.openAtEnd++; };
  // 5C: noTradeAfterEntry launches are entered and priced; the three skip counts are the launches that cannot be
  const counts = { launches: 0, recordingGap: 0, tradedBeforeCp: 0, noTradeAfterEntry: 0, recordingTooShort: 0, curveCompleteBeforeEntry: 0, endUnknown: 0 };
  // R13-12: a recorder restart or feed gap inside a launch cuts it, as the in-app replay does (covered only to its last row before the marker)
  const markers = source.markers();
  for (const raw of source.launches()) {
    const { rec, gap } = cutAtRecordingGap(raw, markers);
    const c = recordedToLaunch(rec);
    if (!c) continue;
    counts.launches++;
    if (gap) counts.recordingGap++;
    const k = considerLaunch(c, rec, cpMin);
    if ('skip' in k) {
      if (k.skip !== 'NO_TRADE_BEFORE_CP') counts.tradedBeforeCp++;
      if (k.skip === 'RECORDING_TOO_SHORT') counts.recordingTooShort++;
      if (k.skip === 'CURVE_COMPLETE_BEFORE_ENTRY') counts.curveCompleteBeforeEntry++;
      if (k.skip === 'END_UNKNOWN') counts.endUnknown++;
      continue;
    }
    counts.tradedBeforeCp++;
    if (k.entry.next >= c.trades.length) counts.noTradeAfterEntry++;
    const grp = k.entry.curvePct >= curveMin ? 'RULE' : 'CONTROL';
    const part = c.t0 < CUT ? 'train' : 'test';
    for (const mode of ['STOCK', 'TRAIL'] as const) add(`${grp}|${mode}|${part}`, simulate(c.trades, k.entry, mode, side, k.coveredUntilTs));
  }
  source.close();
  useStock();
  const rows = Object.entries(acc).map(([k, a]) => { const [group, exits, part] = k.split('|'); return { group, exits, part, entries: a.entries, winRate: a.wins / a.entries, openAtEnd: a.openAtEnd, perEntrySol: a.net / a.entries, totalSol: a.net }; });
  const res = { source: 'own recordings (not the 39-day corpus)', input: { recorded: recordedPath, kind: source.kind, graduationKnown: false, curveCompleteFromEndRows: true }, split: { cutMs: CUT, cutIso: new Date(CUT).toISOString(), note: split.note }, curveMin, checkpointMin: cpMin, sidePct: side, orderSol: ORDER, counts, rows };
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res, null, 1));
}
if (process.argv[1] && /recorder_backtest[\\/]late_rule\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
