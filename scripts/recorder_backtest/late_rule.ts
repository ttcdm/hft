import '../hermeticEnv';
import fs from 'fs';
import { ExitEngine } from '../../server/exits/exitEngine';
import { openRecorded, recordedToLaunch, resolveSplit, type Launch } from './recorded';

/**
 * S228: prices the rule "buy at the 30-minute mark if the curve is at least X% done" on the app's OWN launch recordings. A separate copy of the logic in
 * scripts/hfcorpus/late_rule.ts (which it does not touch); the results are for the recordings only and are never to be merged with the 39-day corpus results.
 *   npx tsx scripts/recorder_backtest/late_rule.ts --recorded <paper.db | snapshot.jsonl> [--curve 40] [--checkpoint 30] [--side 2] [--out result.json] [--split-ts <unix ms>]
 * Fill: the first recorded trade at or after launch + checkpoint + 1.5 s. Curve progress: the last trade before the checkpoint (share of the curve's 793.1M tokens
 * sold). Two exit sets: STOCK (the real ExitEngine as shipped) and TRAIL (take-profits off, hard stop and trailing stop kept, forced exit at the first trade 6 h
 * after entry). `side` is the all-in cost per side in percent. Recordings carry no graduation list, so the 'graduated before entry' exclusion is not applied
 * (graduationKnown:false in the output). A launch recorded for less than the checkpoint cannot be priced (counts.noTradeAfterCp): recordings made with the old
 * 30-minute window show nothing at a 30-minute mark. A control group (curve below the cut-off) is priced the same way. Train/test: --split-ts, else the 75th percentile of create times.
 */
const E = ExitEngine as unknown as Record<string, number>;
const STOCK = { HARD_STOP_LOSS_PCT: E.HARD_STOP_LOSS_PCT, TP1_TRIGGER_PCT: E.TP1_TRIGGER_PCT, TP2_TRIGGER_PCT: E.TP2_TRIGGER_PCT, STALE_POSITION_HOLD_MS: E.STALE_POSITION_HOLD_MS };
const useStock = () => Object.assign(E, STOCK);
const useTrail = () => Object.assign(E, STOCK, { TP1_TRIGGER_PCT: 1e9, TP2_TRIGGER_PCT: 1e9, STALE_POSITION_HOLD_MS: 1e15 });
const ORDER = 0.005, FIXED = 2 * (0.000005 + 0.0001), ENTRY_DELAY = 1500, MAX_HOLD_MS = 6 * 3_600_000;
const price = (r: Launch['trades'][number]) => r[5] / r[6] / 1000;

interface Out { net: number; open: boolean }
function simulate(c: Launch, i0: number, mode: 'STOCK' | 'TRAIL', side: number): Out {
  (mode === 'STOCK' ? useStock : useTrail)();
  const h = side / 100, t = c.trades;
  const ep = price(t[i0]), ets = t[i0][0];
  let remaining = 1, proceeds = 0, hwm = ep, trail = 0, stage = 0, last = ep;
  for (let i = i0 + 1; i < t.length; i++) {
    const px = price(t[i]); last = px;
    const forced = mode === 'TRAIL' && t[i][0] - ets >= MAX_HOLD_MS;
    const d = ExitEngine.evaluate({ entryPriceSol: ep, currentPriceSol: px, highWaterMarkSol: hwm, trailingStopSol: trail, exitStage: stage, entryTimestamp: ets, currentTimestamp: t[i][0] });
    hwm = d.newHighWaterMarkSol; trail = d.newTrailingStopSol;
    if (!d.shouldExit && !forced) continue;
    const pct = forced && !d.shouldExit ? 100 : d.sellPercentage;
    const f = remaining * Math.min(100, Math.max(1, pct)) / 100;
    proceeds += f * ORDER * (1 - h) * (px / ep) * (1 - h);
    remaining -= f; stage = d.newExitStage;
    if (remaining <= 1e-9 || pct >= 100) { remaining = 0; break; }
  }
  if (remaining > 1e-9) { proceeds += remaining * ORDER * (1 - h) * (last / ep) * (1 - h); return { net: proceeds - ORDER - FIXED, open: true }; }
  return { net: proceeds - ORDER - FIXED, open: false };
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
  const counts = { launches: 0, tradedBeforeCp: 0, noTradeAfterCp: 0 };
  const consider = (c: Launch) => {
    counts.launches++;
    const cp = c.t0 + cpMin * 60_000;
    const iAfter = c.trades.findIndex((r) => r[0] >= cp + ENTRY_DELAY);
    const iBefore = (iAfter < 0 ? c.trades.length : iAfter) - 1;
    let lastBefore: Launch['trades'][number] | undefined;
    for (const r of c.trades) { if (r[0] < cp) lastBefore = r; else break; }
    if (!lastBefore) return;
    counts.tradedBeforeCp++;
    if (iAfter < 0) { counts.noTradeAfterCp++; return; }
        void iBefore;
    const curve = (793_100_000_000_000 - (lastBefore[6] - 279_900_000_000_000)) / 793_100_000_000_000 * 100;
    const grp = curve >= curveMin ? 'RULE' : 'CONTROL';
    const part = c.t0 < CUT ? 'train' : 'test';
    for (const mode of ['STOCK', 'TRAIL'] as const) add(`${grp}|${mode}|${part}`, simulate(c, iAfter, mode, side));
  };
  for (const rec of source.launches()) { const c = recordedToLaunch(rec); if (c) consider(c); }
  source.close();
  useStock();
  const rows = Object.entries(acc).map(([k, a]) => { const [group, exits, part] = k.split('|'); return { group, exits, part, entries: a.entries, winRate: a.wins / a.entries, openAtEnd: a.openAtEnd, perEntrySol: a.net / a.entries, totalSol: a.net }; });
  const res = { source: 'own recordings (not the 39-day corpus)', input: { recorded: recordedPath, kind: source.kind, graduationKnown: false }, split: { cutMs: CUT, cutIso: new Date(CUT).toISOString(), note: split.note }, curveMin, checkpointMin: cpMin, sidePct: side, orderSol: ORDER, counts, rows };
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
