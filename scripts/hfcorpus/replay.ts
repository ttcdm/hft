import '../hermeticEnv';
import fs from 'fs';
import readline from 'readline';
import { replayLaunch, analysePeaks, PEAK_BUCKETS_MIN, type RecordedLaunch, type ReplayedLaunch } from '../../server/backtest/replay';

/**
 * S197: replays the real auto-trader rules (WatchWindow + ConfluenceEngine + ExitEngine, via server/backtest/replay.ts) over the public
 * Slinky21/Pumpfun_Memecoin_Corpus launches, at several confluence thresholds in one pass.
 *
 *   python3 scripts/hfcorpus/export_launches.py --data-dir DIR --out launches.jsonl
 *   npx tsx scripts/hfcorpus/replay.ts launches.jsonl [--thresholds 70,60,50,40,30] [--sol-usd 150] [--out report.json]
 *
 * What the corpus cannot supply (so the replay is optimistic by that much, on top of replay.ts's own list): per-trade Solana slots (a slot is
 * estimated as unix ms / 400, which only feeds the curve-velocity score), the SOL/USD price (an assumption, --sol-usd; it moves only the
 * liquidity points), real reserves (derived from the virtual ones: vSol - 30 SOL, vTokens - 279.9M), funder history (none: every wallet has no funder fact),
 * and the create event's signer (taken to be the creator).
 */
export const V_SOL_INIT = 30_000_000_000n;
export const V_TOK_REAL_OFFSET = 279_900_000_000_000n; // 1,073,000,000,000,000 virtual - 793,100,000,000,000 real
type Row = [number, boolean, number, number, string, number, number, string];
export interface CorpusLaunch { mint: string; symbol: string; creator: string; mayhem: boolean; t0: number; graduated: boolean; trades: Row[] }

/** One exported line -> the RecordedLaunch the replay takes. */
export function toRecordedLaunch(c: CorpusLaunch, solUsd: number | null): RecordedLaunch {
  const create = {
    signature: 'create-' + c.mint, slot: Math.floor(c.t0 / 400), mint: c.mint, creator: c.creator, user: c.creator, symbol: c.symbol, name: c.symbol,
    solUsd, tokenTotalSupply: c.mayhem ? '2000000000000000' : '1000000000000000', initialPriceSol: Number(V_SOL_INIT) / 1_073_000_000_000_000 / 1000,
    realTokenReserves: '793100000000000', realSolReserves: '0',
  };
  const events: RecordedLaunch['events'] = [{ ts: c.t0, kind: 'CREATE', payload: create }];
  for (const [ts, isBuy, sol, tok, user, vSol, vTok, sig] of c.trades) {
    const realTok = BigInt(vTok) - V_TOK_REAL_OFFSET;
    events.push({
      ts, kind: 'TRADE',
      payload: {
        signature: sig, slot: Math.floor(ts / 400), mint: c.mint, solAmountLamports: String(Math.round(sol * 1e9)), tokenAmount: String(Math.round(tok * 1e6)), isBuy, user,
        timestampSec: Math.floor(ts / 1000), virtualSolReserves: String(vSol), virtualTokenReserves: String(vTok),
        realSolReserves: String(BigInt(vSol) > V_SOL_INIT ? BigInt(vSol) - V_SOL_INIT : 0n), realTokenReserves: String(realTok > 0n ? realTok : 0n),
      },
    });
  }
  return { mint: c.mint, events };
}

const priceOf = (vSol: number, vTok: number) => vSol / vTok / 1000;

/** Launch-referenced peak: first valid trade price against the highest later one, and when (minutes after launch). Independent of the watch window. */
export function launchPeak(c: CorpusLaunch): { multiple: number; atMin: number; lastMin: number } | null {
  if (c.trades.length < 2) return null;
  const ref = priceOf(c.trades[0][5], c.trades[0][6]);
  let peak = ref, at = c.trades[0][0];
  for (const t of c.trades) { const p = priceOf(t[5], t[6]); if (p > peak) { peak = p; at = t[0]; } }
  return { multiple: peak / ref, atMin: (at - c.t0) / 60_000, lastMin: (c.trades[c.trades.length - 1][0] - c.t0) / 60_000 };
}

const median = (v: number[]) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

interface Agg { rows: ReplayedLaunch[]; }

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--') && !/^\d/.test(a)) as string;
  const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
  const thresholds = opt('thresholds', '70,60,50,40,30').split(',').map(Number);
  const solUsdArg = opt('sol-usd', '150');
  const solUsd = solUsdArg === 'null' ? null : Number(solUsdArg);
  const outPath = opt('out', '');
  const limit = Number(opt('limit', '0'));
  const aggs = new Map<number, Agg>(thresholds.map((t) => [t, { rows: [] }]));
  const peaks: Array<{ multiple: number; atMin: number; lastMin: number }> = [];
  let n = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const started = Date.now();
  for await (const line of rl) {
    if (!line) continue;
    const c: CorpusLaunch = JSON.parse(line);
    const pk = launchPeak(c); if (pk) peaks.push(pk);
    const rec = toRecordedLaunch(c, solUsd);
    for (const th of thresholds) {
      const r = replayLaunch(rec, [], solUsd, { minScore: th });
      // the big per-trade structures are not kept
      aggs.get(th)!.rows.push(r);
    }
    if (++n % 5000 === 0) console.error(`${n} launches, ${((Date.now() - started) / 1000).toFixed(0)}s`);
    if (limit && n >= limit) break;
  }

  const report: any = { launches: n, solUsd, thresholds: {}, launchPeak: null };
  for (const th of thresholds) {
    const rows = aggs.get(th)!.rows;
    const entered = rows.filter((r) => r.entered);
    const closed = entered.filter((r) => r.outcome === 'CLOSED');
    const open = entered.filter((r) => r.outcome === 'OPEN_AT_END');
    const realized = closed.reduce((a, r) => a + (r.netPnlSol ?? 0), 0);
    const openMark = open.reduce((a, r) => a + ((r.openValueSol ?? 0) - 0.005), 0);
    const verdicts: Record<string, number> = {}; for (const r of rows) verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
    const exits: Record<string, number> = {}; for (const r of entered) for (const e of r.exits) exits[e.reason] = (exits[e.reason] ?? 0) + 1;
    const wins = closed.filter((r) => (r.netPnlSol ?? 0) > 0).length;
    const pnl = closed.map((r) => r.netPnlSol ?? 0).sort((a, b) => a - b);
    report.thresholds[th] = {
      verdicts, entries: entered.length, closed: closed.length, openAtEnd: open.length, winRate: closed.length ? wins / closed.length : null,
      realizedNetSol: realized, openMarkSol: openMark, totalSol: realized + openMark, avgPerEntrySol: entered.length ? (realized + openMark) / entered.length : null,
      medianClosedPnlSol: median(pnl), bestSol: pnl[pnl.length - 1] ?? null, worstSol: pnl[0] ?? null, exits,
      // concentration: how much of the realized profit the top 1% / 10 closed trades supply
      top10ClosedSol: pnl.slice(-10).reduce((a, b) => a + b, 0),
      peakAnalysis: analysePeaks(rows),
    };
  }
  const bucket = (b: { fromMin: number; toMin: number }) => peaks.filter((p) => p.atMin >= b.fromMin && p.atMin < b.toMin);
  report.launchPeak = {
    basis: 'first valid trade price vs the highest later valid trade price, time measured from launch (not from the watch window release)',
    launches: peaks.length,
    buckets: PEAK_BUCKETS_MIN.map((b) => { const x = bucket(b); return { label: b.label, launches: x.length, medianPeakMultiple: median(x.map((p) => p.multiple)), peakAtLeast2x: x.filter((p) => p.multiple >= 2).length, peakAtLeast5x: x.filter((p) => p.multiple >= 5).length }; }),
  };
  const json = JSON.stringify(report, null, 2);
  if (outPath) fs.writeFileSync(outPath, json); else console.log(json);
}

if (process.argv[1] && /replay\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
