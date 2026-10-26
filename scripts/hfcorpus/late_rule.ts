import '../hermeticEnv';
import fs from 'fs';
import readline from 'readline';
import { ExitEngine } from '../../server/exits/exitEngine';
import { stateAt } from '../../server/backtest/costModel';
import type { CorpusLaunch } from './replay';

/**
 * S197c: prices the rule "buy at the 30-minute mark if the curve is at least X% done and the coin has not graduated".
 *   npx tsx scripts/hfcorpus/late_rule.ts launches.jsonl grad.csv [--curve 40] [--checkpoint 30] [--side 2] [--out result.json] [--tracked-hours 48]
 * 5C (R1-109): only what is known at the checkpoint decides. Every launch with a trade before the checkpoint that has not graduated by the
 * time the buy lands is entered (or counted in the control group), whether or not it trades again. The buy lands at launch + checkpoint +
 * 1.5 s and fills at the curve state then (the last print at or before it; costModel.stateAt), not at the next print, which can come hours
 * later. Curve progress: the last trade before the checkpoint (share of the curve's 793.1M tokens sold). Two exit sets: STOCK (the real
 * ExitEngine as shipped) and TRAIL (take-profits off, hard stop and trailing stop kept, forced exit 6 h after entry). The engine runs at each
 * later print and once more where the data ends, at the last price, so the stale exit (STOCK) and the 6 h exit (TRAIL) close a coin that
 * went quiet; a launch that never trades again is closed that way at its entry price, paying both sides and the fixed costs. The data for a
 * launch ends at its create + `--tracked-hours` (the corpus's 48 h tracking window) or the last trade in the file, whichever is first.
 * `side` is the all-in cost per side in percent (buy keeps 1 - side, each sale pays 1 - side). Positions still open where the data ends are
 * marked at the last recorded price. A control group (curve below the cut-off) is priced the same way. train = launches before 2026-07-05
 * UTC, test = from then on.
 */
const E = ExitEngine as unknown as Record<string, number>;
const STOCK = { HARD_STOP_LOSS_PCT: E.HARD_STOP_LOSS_PCT, TP1_TRIGGER_PCT: E.TP1_TRIGGER_PCT, TP2_TRIGGER_PCT: E.TP2_TRIGGER_PCT, STALE_POSITION_HOLD_MS: E.STALE_POSITION_HOLD_MS };
const useStock = () => Object.assign(E, STOCK);
const useTrail = () => Object.assign(E, STOCK, { TP1_TRIGGER_PCT: 1e9, TP2_TRIGGER_PCT: 1e9, STALE_POSITION_HOLD_MS: 1e15 });
const CUT = Date.UTC(2026, 6, 5);
export const ORDER = 0.005, FIXED = 2 * (0.000005 + 0.0001), ENTRY_DELAY = 1500, MAX_HOLD_MS = 6 * 3_600_000;
type Row = CorpusLaunch['trades'][number];
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
/** The exits over the recorded prints. `finish(coveredUntilTs)` runs the engine once more where the data ends (null: not known, no time rule fires there). */
export function simulate(t: Row[], e: Entry, mode: 'STOCK' | 'TRAIL', side: number): { finish(coveredUntilTs: number | null): Out } {
  const h = side / 100, ep = e.px, ets = e.ts;
  let remaining = 1, proceeds = 0, hwm = ep, trail = 0, stage = 0, last = ep;
  const step = (px: number, ts: number): boolean => {
    (mode === 'STOCK' ? useStock : useTrail)();
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
  let lastTs = ets;
  for (let i = e.next; i < t.length; i++) {
    last = price(t[i]); lastTs = t[i][0];
    if (step(last, lastTs)) break;
  }
  const done = remaining <= 1e-9;
  return {
    finish(coveredUntilTs: number | null): Out {
      // 5C: after the last print the price stays where it was until the data ends; a time rule that is due by then closes at that price
      if (!done && coveredUntilTs !== null && coveredUntilTs > lastTs) step(last, coveredUntilTs);
      useStock();
      if (remaining > 1e-9) { proceeds += remaining * ORDER * (1 - h) * (last / ep) * (1 - h); return { net: proceeds - ORDER - FIXED, open: true }; }
      return { net: proceeds - ORDER - FIXED, open: false };
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
  const curveMin = Number(opt('curve', '40')), cpMin = Number(opt('checkpoint', '30')), side = Number(opt('side', '2')), outPath = opt('out', '');
  const trackedMs = Number(opt('tracked-hours', '48')) * 3_600_000;
  const grad = new Map<string, number>();
  for (const l of fs.readFileSync(args[1], 'utf8').split('\n').slice(1)) { const [m, g] = l.split(','); if (m) grad.set(m, Number(g)); }
  type Acc = { entries: number; wins: number; openAtEnd: number; net: number };
  const acc: Record<string, Acc> = {};
  const add = (key: string, o: Out) => { const a = (acc[key] ??= { entries: 0, wins: 0, openAtEnd: 0, net: 0 }); a.entries++; a.net += o.net; if (o.net > 0) a.wins++; if (o.open) a.openAtEnd++; };
  // 5C: noTradeAfterEntry launches are entered and priced (they used to be dropped); they are counted so the reader can see how many
  const counts = { launches: 0, tradedBeforeCp: 0, graduatedBeforeEntry: 0, noTradeAfterEntry: 0 };
  // the data ends at create + the tracking window or the file's last trade, which is known only after the whole file is read
  const pending: Array<{ key: string; t0: number; finish: (c: number | null) => Out }> = [];
  let fileEndTs = -Infinity;
  for await (const line of readline.createInterface({ input: fs.createReadStream(args[0]), crlfDelay: Infinity })) {
    if (!line) continue;
    const c: CorpusLaunch = JSON.parse(line);
    counts.launches++;
    if (c.trades.length) fileEndTs = Math.max(fileEndTs, c.trades[c.trades.length - 1][0]);
    const e = planEntry(c.trades, c.t0, cpMin);
    if (!e) continue;
    counts.tradedBeforeCp++;
    const g = grad.get(c.mint);
    if (g !== undefined && g <= e.ts) { counts.graduatedBeforeEntry++; continue; }
    if (e.next >= c.trades.length) counts.noTradeAfterEntry++;
    const grp = e.curvePct >= curveMin ? 'RULE' : 'CONTROL';
    const part = c.t0 < CUT ? 'train' : 'test';
    for (const mode of ['STOCK', 'TRAIL'] as const) pending.push({ key: `${grp}|${mode}|${part}`, t0: c.t0, finish: simulate(c.trades, e, mode, side).finish });
  }
  for (const p of pending) add(p.key, p.finish(Math.min(p.t0 + trackedMs, fileEndTs)));
  useStock();
  const rows = Object.entries(acc).map(([k, a]) => { const [group, exits, part] = k.split('|'); return { group, exits, part, entries: a.entries, winRate: a.wins / a.entries, openAtEnd: a.openAtEnd, perEntrySol: a.net / a.entries, totalSol: a.net }; });
  const res = { curveMin, checkpointMin: cpMin, sidePct: side, orderSol: ORDER, trackedHours: trackedMs / 3_600_000, dataEndsAt: new Date(fileEndTs).toISOString(), counts, rows };
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res, null, 1));
}
if (process.argv[1] && /hfcorpus[\\/]late_rule\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
