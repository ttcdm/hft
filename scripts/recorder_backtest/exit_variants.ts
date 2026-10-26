import '../hermeticEnv';
import fs from 'fs';
import { replayLaunch, REPLAY_DEFAULTS, tradeFromJson, type RecordedLaunch } from '../../server/backtest/replay';
import { ExitEngine } from '../../server/exits/exitEngine';
import { tradePriceSol } from '../../server/market/poolStats';
import { openRecorded, resolveSplit, type RecordedSource } from './recorded';

/**
 * S228: exit-rule variants over the entries the real watch window + confluence gate produce at thresholds 70 / 60 / 50, run on the app's OWN
 * launch recordings. This is a separate copy of the logic in scripts/hfcorpus/exit_variants.ts (which it does not touch); the results are for the
 * recordings only and are never to be merged with the 39-day corpus results.
 *   npx tsx scripts/recorder_backtest/exit_variants.ts --recorded <paper.db | snapshot.jsonl> [--out result.json] [--sol-usd <default: the recorded median>] [--split-ts <unix ms>]
 * --recorded is the paper SQLite database (opened read-only) or a JSONL snapshot of launch_recording ({ts,mint,kind,payload} per line). The recorded funder
 * facts are passed to the replay. Entries come from replayLaunch (so the release and entry fill are the real replay's); the exit loop below is replay.ts's own
 * loop with the ExitEngine constants overridden per variant (stop loss, first take-profit, stale timeout) and a per-side haircut on the P&L.
 * Validation built in: with no haircut and the stock constants the loop must reproduce replayLaunch's own net P&L for every launch.
 * Train/test: --split-ts, else the 70th percentile of create times (a 30% holdout).
 */
type Variant = { stop: number; tp1: number; staleMin: number };
const E = ExitEngine as unknown as Record<string, number>;
const STOCK = { stop: 20, tp1: 30, staleMin: 30 };
const setVariant = (v: Variant) => { E.HARD_STOP_LOSS_PCT = -v.stop; E.TP1_TRIGGER_PCT = v.tp1; E.STALE_POSITION_HOLD_MS = v.staleMin * 60_000; };

interface SimOut { net: number | null; open: number | null; exits: string[]; holdMs: number }

/** One launch as the study needs it: the replay's input and its start time (the recorded CREATE row's timestamp). */
interface Item { rec: RecordedLaunch; t0: number }

function simulate(c: Item, releasedAfterMs: number, v: Variant, sellFeePct: number, sideHaircut: number): SimOut {
  setVariant(v);
  const trades = c.rec.events.filter((e) => e.kind === 'TRADE');
  const entryAt = c.t0 + releasedAfterMs + REPLAY_DEFAULTS.entryDelayMs;
  const after = trades.filter((e) => e.ts >= entryAt);
  const entryPrice = tradePriceSol(tradeFromJson(after[0].payload)) as number;
  const entryTs = after[0].ts;
  const order = REPLAY_DEFAULTS.orderSol;
  const fixed = 2 * (REPLAY_DEFAULTS.networkFeeSol + REPLAY_DEFAULTS.tipSol);
  const buyKeep = 1 - sideHaircut; // the share of the order that becomes position value
  let remaining = 1, proceeds = 0, hwm = entryPrice, trail = 0, stage = 0, lastPrice = entryPrice, lastTs = entryTs;
  const exits: string[] = [];
  for (const ev of after.slice(1)) {
    const p = tradePriceSol(tradeFromJson(ev.payload));
    if (p === null || !(p > 0)) continue;
    lastPrice = p; lastTs = ev.ts;
    const d = ExitEngine.evaluate({ entryPriceSol: entryPrice, currentPriceSol: p, highWaterMarkSol: hwm, trailingStopSol: trail, exitStage: stage, entryTimestamp: entryTs, currentTimestamp: ev.ts });
    hwm = d.newHighWaterMarkSol; trail = d.newTrailingStopSol;
    if (!d.shouldExit) continue;
    const sellFrac = remaining * Math.min(100, Math.max(1, d.sellPercentage)) / 100;
    proceeds += sellFrac * order * buyKeep * (p / entryPrice) * (1 - sellFeePct / 100) * (1 - sideHaircut);
    remaining -= sellFrac; stage = d.newExitStage; exits.push(d.reason);
    if (remaining <= 1e-9 || d.sellPercentage >= 100) { remaining = 0; break; }
  }
  if (remaining > 1e-9) return { net: null, open: remaining * order * buyKeep * (lastPrice / entryPrice) * (1 - sellFeePct / 100) * (1 - sideHaircut) + proceeds, exits, holdMs: lastTs - entryTs };
  return { net: proceeds - order - fixed, open: null, exits, holdMs: lastTs - entryTs };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
  const recordedPath = opt('recorded', '');
  if (!recordedPath) throw new Error('usage: exit_variants.ts --recorded <paper.db|snapshot.jsonl> [--out f] [--sol-usd n] [--split-ts ms]');
  const source: RecordedSource = await openRecorded(recordedPath);
  const solUsdArg = opt('sol-usd', '');
  const solUsd = solUsdArg !== '' ? Number(solUsdArg) : (source.medianSolUsd() ?? 150);
  const outPath = opt('out', '/tmp/recorded_exit_variants.json');
  const THRESH = [70, 60, 50];
  const entered = new Map<number, Array<{ c: Item; releasedAfterMs: number; base: number | null }>>(THRESH.map((t) => [t, []]));
  let n = 0;
  const funders = source.funders();
  for (const rec of source.launches()) {
    const create = rec.events.find((e) => e.kind === 'CREATE');
    if (!create) continue;
    const item: Item = { rec, t0: create.ts };
    for (const th of THRESH) {
      setVariant(STOCK);
      const r = replayLaunch(rec, funders, solUsd, { minScore: th });
      if (r.entered && r.releasedAfterMs !== null) entered.get(th)!.push({ c: item, releasedAfterMs: r.releasedAfterMs, base: r.outcome === 'CLOSED' ? r.netPnlSol : null });
    }
    if (++n % 2000 === 0) console.error(n);
  }
  console.error('entries', THRESH.map((t) => `${t}:${entered.get(t)!.length}`).join(' '));

  // validation: stock constants, no haircut, 1% sell fee == replayLaunch
  let checked = 0, bad = 0;
  for (const th of THRESH) for (const e of entered.get(th)!) {
    const s = simulate(e.c, e.releasedAfterMs, STOCK, 1.0, 0);
    if (e.base !== null) { checked++; if (s.net === null || Math.abs(s.net - e.base) > 1e-9) bad++; }
  }
  console.error(`validation: ${checked} closed entries compared with replayLaunch, ${bad} differ`);

  const variants: Variant[] = [];
  for (const stop of [10, 15, 20]) for (const tp1 of [15, 30]) for (const staleMin of [5, 10, 30]) variants.push({ stop, tp1, staleMin });
  const haircuts: Array<{ name: string; sellFee: number; side: number }> = [
    { name: 'stock fees (1% on sells only, no slippage)', sellFee: 1.0, side: 0 },
    { name: '1% per side all-in (reading A)', sellFee: 0, side: 0.01 },
    { name: '2% per side: 1% pump fee + 1% slippage (reading B)', sellFee: 0, side: 0.02 },
  ];
  const rows: any[] = [];
  // pick variants on 'train', confirm on 'test'
  const split = resolveSplit(opt('split-ts', ''), source);
  const CUT = split.cut;
  const iso = new Date(CUT).toISOString().slice(0, 16) + 'Z';
  const SPLITS: Array<[string, (t0: number) => boolean]> = [['all', () => true], [`train (before ${iso})`, (t0) => t0 < CUT], [`test (from ${iso})`, (t0) => t0 >= CUT]];
  for (const [splitName, inSplit] of SPLITS) for (const th of THRESH) for (const h of haircuts) for (const v of variants) {
    let net = 0, open = 0, wins = 0, closed = 0, openN = 0; const reasons: Record<string, number> = {};
    const list = entered.get(th)!.filter((e) => inSplit(e.c.t0));
    for (const e of list) {
      const s = simulate(e.c, e.releasedAfterMs, v, h.sellFee, h.side);
      if (s.net !== null) { net += s.net; closed++; if (s.net > 0) wins++; } else { open += (s.open as number) - REPLAY_DEFAULTS.orderSol; openN++; }
      for (const r of s.exits) reasons[r] = (reasons[r] ?? 0) + 1;
    }
    const entries = list.length;
    rows.push({ split: splitName, threshold: th, haircut: h.name, ...v, entries, closed, openAtEnd: openN, winRate: closed ? wins / closed : null, realizedSol: net, openMarkSol: open, totalSol: net + open, perEntrySol: entries ? (net + open) / entries : null, reasons });
  }
  const funderFacts = funders.length;
  source.close();
  fs.writeFileSync(outPath, JSON.stringify({ source: 'own recordings (not the 39-day corpus)', input: { recorded: recordedPath, kind: source.kind, launches: n, funderFacts, solUsd }, split: { cutMs: CUT, cutIso: iso, note: split.note }, entriesByThreshold: Object.fromEntries(THRESH.map((t) => [t, entered.get(t)!.length])), validation: { checked, differ: bad }, rows }, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
