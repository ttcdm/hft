import '../hermeticEnv';
import fs from 'fs';
import readline from 'readline';
import { replayLaunch, REPLAY_DEFAULTS, tradeFromJson } from '../../server/backtest/replay';
import { ExitEngine } from '../../server/exits/exitEngine';
import { tradePriceSol } from '../../server/market/poolStats';
import { toRecordedLaunch, type CorpusLaunch } from './replay';

/**
 * S197b: exit-rule variants over the entries the real watch window + confluence gate produce at thresholds 70 / 60 / 50.
 * Entries come from replayLaunch (so the release and entry fill are the real replay's); the exit loop below is replay.ts's own loop with the
 * ExitEngine constants overridden per variant (stop loss, first take-profit, stale timeout) and a per-side haircut on the P&L.
 *   npx tsx scripts/hfcorpus/exit_variants.ts launches.jsonl [--out result.json] [--sol-usd 150]
 * Validation built in: with no haircut and the stock constants the loop must reproduce replayLaunch's own net P&L for every launch.
 */
type Variant = { stop: number; tp1: number; staleMin: number };
const E = ExitEngine as unknown as Record<string, number>;
const STOCK = { stop: 20, tp1: 30, staleMin: 30 };
const setVariant = (v: Variant) => { E.HARD_STOP_LOSS_PCT = -v.stop; E.TP1_TRIGGER_PCT = v.tp1; E.STALE_POSITION_HOLD_MS = v.staleMin * 60_000; };

interface SimOut { net: number | null; open: number | null; exits: string[]; holdMs: number }

function simulate(c: CorpusLaunch, releasedAfterMs: number, v: Variant, sellFeePct: number, sideHaircut: number): SimOut {
  setVariant(v);
  const rec = toRecordedLaunch(c, null);
  const trades = rec.events.filter((e) => e.kind === 'TRADE');
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
  const file = args[0];
  const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
  const solUsd = Number(opt('sol-usd', '150'));
  const outPath = opt('out', '/tmp/exit_variants.json');
  const THRESH = [70, 60, 50];
  const entered = new Map<number, Array<{ c: CorpusLaunch; releasedAfterMs: number; base: number | null }>>(THRESH.map((t) => [t, []]));
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    if (!line) continue;
    const c: CorpusLaunch = JSON.parse(line);
    const rec = toRecordedLaunch(c, solUsd);
    for (const th of THRESH) {
      setVariant(STOCK);
      const r = replayLaunch(rec, [], solUsd, { minScore: th });
      if (r.entered && r.releasedAfterMs !== null) entered.get(th)!.push({ c, releasedAfterMs: r.releasedAfterMs, base: r.outcome === 'CLOSED' ? r.netPnlSol : null });
    }
    if (++n % 50000 === 0) console.error(n);
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
  // S197d: the last 10 days (launches from 2026-07-05 UTC on) are held out: pick variants on 'train', confirm on 'test'
  const CUT = Date.UTC(2026, 6, 5);
  const SPLITS: Array<[string, (t0: number) => boolean]> = [['all', () => true], ['train (to Jul 4)', (t0) => t0 < CUT], ['test (Jul 5 on)', (t0) => t0 >= CUT]];
  for (const [split, inSplit] of SPLITS) for (const th of THRESH) for (const h of haircuts) for (const v of variants) {
    let net = 0, open = 0, wins = 0, closed = 0, openN = 0; const reasons: Record<string, number> = {};
    const list = entered.get(th)!.filter((e) => inSplit(e.c.t0));
    for (const e of list) {
      const s = simulate(e.c, e.releasedAfterMs, v, h.sellFee, h.side);
      if (s.net !== null) { net += s.net; closed++; if (s.net > 0) wins++; } else { open += (s.open as number) - REPLAY_DEFAULTS.orderSol; openN++; }
      for (const r of s.exits) reasons[r] = (reasons[r] ?? 0) + 1;
    }
    const entries = list.length;
    rows.push({ split, threshold: th, haircut: h.name, ...v, entries, closed, openAtEnd: openN, winRate: closed ? wins / closed : null, realizedSol: net, openMarkSol: open, totalSol: net + open, perEntrySol: entries ? (net + open) / entries : null, reasons });
  }
  fs.writeFileSync(outPath, JSON.stringify({ entriesByThreshold: Object.fromEntries(THRESH.map((t) => [t, entered.get(t)!.length])), validation: { checked, differ: bad }, rows }, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
