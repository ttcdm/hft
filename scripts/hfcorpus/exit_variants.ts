import '../hermeticEnv';
import fs from 'fs';
import readline from 'readline';
import { replayLaunch, replayCostCase, REPLAY_DEFAULTS } from '../../server/backtest/replay';
import { simulatePath, priceEntryParts, restoreStockEngine, STOCK_VARIANT, type CostCase, type TradeRow, type Variant } from '../../server/backtest/costModel';
import { toRecordedLaunch, type CorpusLaunch } from './replay';

/**
 * S197b: exit-rule variants over the entries the real watch window + confluence gate produce at thresholds 70 / 60 / 50.
 * Entries come from replayLaunch (so the release is the real replay's); 5A: each variant (stop loss, first take-profit, stale timeout) is priced by
 * the shared cost and latency model (server/backtest/costModel.ts) under three cost cases, so fills, latency and costs are the replay's own.
 * Open-at-end positions are marked at the last print with their sell cost and reported apart (openMarkSol).
 *   npx tsx scripts/hfcorpus/exit_variants.ts launches.jsonl [--out result.json] [--sol-usd 150]
 * Validation built in: the stock variant at the replay's costs must reproduce replayLaunch's own net (closed) or open mark (open) for every entry.
 */
export interface SimOut { net: number; open: boolean; exits: string[]; holdMs: number }

/** 5A: the cost cases this study reports; the first is the replay's own (and the validation's). */
export const COSTS: Array<{ name: string; cost: CostCase }> = [
  { name: 'replay defaults (fee each side, impact, base + priority + tip per transaction)', cost: replayCostCase(REPLAY_DEFAULTS) },
  { name: '1% per side, no impact (reading A)', cost: replayCostCase({ ...REPLAY_DEFAULTS, feePct: 1, impact: false }) },
  { name: '2% per side: 1% pump fee + 1% slippage stand-in, no impact (reading B)', cost: replayCostCase({ ...REPLAY_DEFAULTS, feePct: 2, impact: false }) },
];

/** 5A: one entry under one variant and cost case, on the shared model at the replay's latencies. Null: the entry has no priced fill. */
export function simulate(c: CorpusLaunch, releasedAfterMs: number, v: Variant, cost: CostCase): SimOut | null {
  const rows: TradeRow[] = c.trades;
  const path = simulatePath(rows, c.t0 + releasedAfterMs, { entryMs: REPLAY_DEFAULTS.entryDelayMs, exitMs: REPLAY_DEFAULTS.exitDelayMs }, v);
  if (!path) return null;
  const m = priceEntryParts(rows, path, REPLAY_DEFAULTS.orderSol, cost);
  const last = path.sells[path.sells.length - 1];
  const endTs = path.open ? Math.max(rows[rows.length - 1][0], path.entryTs) : (last.fillTs ?? rows[last.fillIdx][0]);
  return { net: m.netSol, open: path.open !== null, exits: path.sells.map((x) => x.reason), holdMs: endTs - path.entryTs };
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
      restoreStockEngine();
      const r = replayLaunch(rec, [], solUsd, { minScore: th });
      if (r.entered && r.releasedAfterMs !== null) entered.get(th)!.push({ c, releasedAfterMs: r.releasedAfterMs, base: (r.outcome === 'CLOSED' ? r.netPnlSol : r.openNetPnlSol) ?? null });
    }
    if (++n % 50000 === 0) console.error(n);
  }
  console.error('entries', THRESH.map((t) => `${t}:${entered.get(t)!.length}`).join(' '));

  // validation: the stock variant at the replay's costs == replayLaunch (closed net, or the open mark)
  let checked = 0, bad = 0;
  for (const th of THRESH) for (const e of entered.get(th)!) {
    const s = simulate(e.c, e.releasedAfterMs, STOCK_VARIANT, COSTS[0].cost);
    checked++; if (s === null || e.base === null || Math.abs(s.net - e.base) > 1e-9) bad++;
  }
  restoreStockEngine();
  console.error(`validation: ${checked} entries compared with replayLaunch, ${bad} differ`);

  const variants: Variant[] = [];
  for (const stop of [10, 15, 20]) for (const tp1 of [15, 30]) for (const staleMin of [5, 10, 30]) variants.push({ stop, tp1, staleMin });
  const rows: any[] = [];
  // S197d: the last 10 days (launches from 2026-07-05 UTC on) are held out: pick variants on 'train', confirm on 'test'
  const CUT = Date.UTC(2026, 6, 5);
  const SPLITS: Array<[string, (t0: number) => boolean]> = [['all', () => true], ['train (to Jul 4)', (t0) => t0 < CUT], ['test (Jul 5 on)', (t0) => t0 >= CUT]];
  for (const [split, inSplit] of SPLITS) for (const th of THRESH) for (const h of COSTS) for (const v of variants) {
    let net = 0, open = 0, wins = 0, closed = 0, openN = 0; const reasons: Record<string, number> = {};
    const list = entered.get(th)!.filter((e) => inSplit(e.c.t0));
    for (const e of list) {
      const s = simulate(e.c, e.releasedAfterMs, v, h.cost);
      if (!s) continue;
      if (!s.open) { net += s.net; closed++; if (s.net > 0) wins++; } else { open += s.net; openN++; }
      for (const r of s.exits) reasons[r] = (reasons[r] ?? 0) + 1;
    }
    const entries = list.length;
    rows.push({ split, threshold: th, haircut: h.name, ...v, entries, closed, openAtEnd: openN, winRate: closed ? wins / closed : null, realizedSol: net, openMarkSol: open, openShareOfTotal: net + open !== 0 ? open / (net + open) : null, totalSol: net + open, perEntrySol: entries ? (net + open) / entries : null, reasons });
  }
  restoreStockEngine();
  fs.writeFileSync(outPath, JSON.stringify({ entriesByThreshold: Object.fromEntries(THRESH.map((t) => [t, entered.get(t)!.length])), validation: { checked, differ: bad }, rows }, null, 1));
}
if (process.argv[1] && /hfcorpus[\\/]exit_variants\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
