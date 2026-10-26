import '../hermeticEnv';
import { replayLaunch, replayCostCase, REPLAY_DEFAULTS, type RecordedLaunch } from '../../server/backtest/replay';
import {
  COST_CASES, LATENCIES, VARIANTS, STOCK_VARIANT, latencyName, variantName, priceEntry, priceEntryParts, simulatePath, restoreStockEngine,
  type TradeRow, type CostCase, type Latency, type Variant,
} from '../../server/backtest/costModel';

/**
 * S229: the study loop behind realistic_ev.ts (39-day corpus) and scripts/recorder_backtest/realistic_ev.ts (own recordings).
 * It only aggregates; where the launches come from, and what the result is called, is the caller's business (`source`).
 *
 * Method, in the order the audit asked for it:
 *   - entries: replayLaunch at every threshold with entryDelayMs 0, which yields the watch-window release for each launch the gate lets in.
 *     The fill, the exits and every cost are then modelled by ev_model.ts, per latency x exit variant (path) and per size x cost case (price).
 *   - selection: for each scenario (latency x cost case) the best (threshold, size, exit variant) by TRAIN EV as % of size, among those with
 *     at least `minTrainEntries` train entries. Nothing on the test side is looked at to choose.
 *   - test: reported once per scenario, for the chosen settings only, with a 90% block-bootstrap interval resampling launch days.
 *   - `combinationsTried` is the size of the selection search (per scenario and in total).
 */
export interface StudyLaunch { rec: RecordedLaunch; t0: number; trades: TradeRow[] }
export interface StudyOptions {
  thresholds: number[];
  sizes: number[];
  splitTs: number;
  solUsd: number | null;
  minTrainEntries: number;
  bootstrapResamples: number;
  seed: number;
  /** the bootstrap's block: launches are resampled in groups that start in the same block. Default one UTC day; the own recordings span under a day, so the wrapper uses hours. */
  blockMs?: number;
}
export const DEFAULT_THRESHOLDS = Array.from({ length: 11 }, (_, i) => 50 + 2 * i);
export const DEFAULT_SIZES = [0.005, 0.01, 0.02, 0.05, 0.1];
export const DAY_MS = 86_400_000;
export const utcDay = (ts: number) => Math.floor(ts / DAY_MS);

export interface Dims { thr: number[]; lat: Latency[]; variants: Variant[]; sizes: number[]; costs: CostCase[] }
export interface Totals {
  dims: Dims;
  /** [split 0 train / 1 test][key] */
  count: Float64Array[]; sum: Float64Array[]; wins: Float64Array[];
  /** test and train per-day sums, keyed [split][key * nDays + day] and counts [split][(thr,lat,var) * nDays + day] */
  daySum: Float64Array[]; dayCount: Float64Array[];
  firstDay: number; nDays: number;
  daysSeen: Array<Set<number>>;
  launches: number; releasedLaunches: number; noFill: number[];
  legacyChecked: number; legacyDiffer: number;
}

export const keyIndex = (d: Dims, ti: number, li: number, vi: number, si: number, ci: number) =>
  (((ti * d.lat.length + li) * d.variants.length + vi) * d.sizes.length + si) * d.costs.length + ci;
const pathIndex = (d: Dims, ti: number, li: number, vi: number) => (ti * d.lat.length + li) * d.variants.length + vi;

export function newTotals(dims: Dims, firstDay: number, lastDay: number): Totals {
  const nKeys = dims.thr.length * dims.lat.length * dims.variants.length * dims.sizes.length * dims.costs.length;
  const nPaths = dims.thr.length * dims.lat.length * dims.variants.length;
  const nDays = lastDay - firstDay + 1;
  const mk = (n: number) => [new Float64Array(n), new Float64Array(n)];
  return {
    dims, count: mk(nKeys), sum: mk(nKeys), wins: mk(nKeys), daySum: mk(nKeys * nDays), dayCount: mk(nPaths * nDays), firstDay, nDays,
    daysSeen: [new Set(), new Set()], launches: 0, releasedLaunches: 0, noFill: dims.lat.map(() => 0), legacyChecked: 0, legacyDiffer: 0,
  };
}

export function addLaunch(t: Totals, l: StudyLaunch, o: StudyOptions): void {
  const d = t.dims;
  t.launches++;
  const split = l.t0 >= o.splitTs ? 1 : 0;
  const day = Math.floor(l.t0 / (o.blockMs ?? DAY_MS)) - t.firstDay; // the bootstrap block (a UTC day unless blockMs says otherwise)
  t.daysSeen[split].add(day);
  // entries per threshold; paths are shared by thresholds that release at the same time
  const byRelease = new Map<number, number[]>();
  restoreStockEngine();
  for (let ti = 0; ti < d.thr.length; ti++) {
    const r = replayLaunch(l.rec, [], o.solUsd, { minScore: d.thr[ti], entryDelayMs: 0 });
    if (!r.entered || r.releasedAfterMs === null) continue;
    const ts = l.t0 + r.releasedAfterMs;
    const list = byRelease.get(ts) ?? []; list.push(ti); byRelease.set(ts, list);
  }
  if (byRelease.size) t.releasedLaunches++;
  for (const [releaseTs, thrIdx] of byRelease) {
    for (let li = 0; li < d.lat.length; li++) {
      for (let vi = 0; vi < d.variants.length; vi++) {
        const path = simulatePath(l.trades, releaseTs, d.lat[li], d.variants[vi]);
        if (!path) { if (vi === 0) t.noFill[li] += thrIdx.length; continue; }
        for (let si = 0; si < d.sizes.length; si++) for (let ci = 0; ci < d.costs.length; ci++) {
          const pnl = priceEntry(l.trades, path, d.sizes[si], d.costs[ci]);
          for (const ti of thrIdx) {
            const k = keyIndex(d, ti, li, vi, si, ci);
            t.count[split][k]++; t.sum[split][k] += pnl; if (pnl > 0) t.wins[split][k]++;
            t.daySum[split][k * t.nDays + day] += pnl;
          }
        }
        for (const ti of thrIdx) t.dayCount[split][pathIndex(d, ti, li, vi) * t.nDays + day]++;
      }
    }
  }
}

/**
 * 5A: the built-in check that the in-app replay and the study price a position with the same model. For up to `limit` entered launches,
 * replayLaunch at its defaults (closed: netPnlSol; open at the end: openNetPnlSol) must equal simulatePath + priceEntryParts with the
 * replay's own latency and cost case. Returns how many were checked / differ.
 */
export function validateLegacy(launches: Iterable<StudyLaunch>, o: StudyOptions, threshold: number, limit = 200): { checked: number; differ: number } {
  const cost = replayCostCase(REPLAY_DEFAULTS);
  const lat = { entryMs: REPLAY_DEFAULTS.entryDelayMs, exitMs: REPLAY_DEFAULTS.exitDelayMs };
  let checked = 0, differ = 0;
  restoreStockEngine();
  for (const l of launches) {
    const r = replayLaunch(l.rec, [], o.solUsd, { minScore: threshold });
    if (!r.entered || r.releasedAfterMs === null) continue;
    const replayNet = r.outcome === 'CLOSED' ? r.netPnlSol : r.openNetPnlSol;
    checked++;
    const p = simulatePath(l.trades, l.t0 + r.releasedAfterMs, lat, STOCK_VARIANT);
    if (!p || replayNet === null || replayNet === undefined || Math.abs(priceEntryParts(l.trades, p, REPLAY_DEFAULTS.orderSol, cost).netSol - replayNet) >= 1e-9) differ++;
    restoreStockEngine();
    if (checked >= limit) break;
  }
  return { checked, differ };
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export interface Ci { lo: number; hi: number; resamples: number; days: number }
/** 90% interval on EV per entry (SOL), resampling launch blocks (UTC days by default) with replacement within one split. */
export function bootstrapEv(t: Totals, split: number, ti: number, li: number, vi: number, si: number, ci: number, o: StudyOptions): Ci | null {
  const d = t.dims;
  const days = [...t.daysSeen[split]];
  if (!days.length) return null;
  const k = keyIndex(d, ti, li, vi, si, ci);
  const p = pathIndex(d, ti, li, vi);
  const rng = mulberry32(o.seed ^ (k + 1) ^ (split << 20));
  const evs: number[] = [];
  for (let r = 0; r < o.bootstrapResamples; r++) {
    let s = 0, c = 0;
    for (let i = 0; i < days.length; i++) { const dd = days[Math.floor(rng() * days.length)]; s += t.daySum[split][k * t.nDays + dd]; c += t.dayCount[split][p * t.nDays + dd]; }
    if (c > 0) evs.push(s / c);
  }
  if (!evs.length) return null;
  evs.sort((a, b) => a - b);
  const at = (q: number) => evs[Math.min(evs.length - 1, Math.max(0, Math.floor(q * evs.length)))];
  return { lo: at(0.05), hi: at(0.95), resamples: evs.length, days: days.length };
}

export interface Cell { entries: number; evSol: number; evPct: number; winRate: number | null }
export function cell(t: Totals, split: number, ti: number, li: number, vi: number, si: number, ci: number): Cell {
  const k = keyIndex(t.dims, ti, li, vi, si, ci);
  const n = t.count[split][k];
  const ev = n ? t.sum[split][k] / n : 0;
  return { entries: n, evSol: ev, evPct: (ev / t.dims.sizes[si]) * 100, winRate: n ? t.wins[split][k] / n : null };
}

export interface Chosen {
  latency: string; cost: string; threshold: number; sizeSol: number; variant: string;
  train: Cell; test: Cell; testCi90Sol: Ci | null; testCi90Pct: { lo: number; hi: number } | null;
  /** the same settings under every cost case, train and test: the gross-edge breakdown */
  breakdown: Array<{ cost: string; train: Cell; test: Cell }>;
}
export interface Scenario { latency: string; cost: string; combinationsTried: number; chosen: Chosen | null }

export function selectAndReport(t: Totals, o: StudyOptions): { scenarios: Scenario[]; combinationsPerScenario: number; combinationsTotal: number } {
  const d = t.dims;
  const per = d.thr.length * d.sizes.length * d.variants.length;
  const scenarios: Scenario[] = [];
  for (let li = 0; li < d.lat.length; li++) for (let ci = 0; ci < d.costs.length; ci++) {
    let best: { ti: number; vi: number; si: number; evPct: number } | null = null;
    for (let ti = 0; ti < d.thr.length; ti++) for (let vi = 0; vi < d.variants.length; vi++) for (let si = 0; si < d.sizes.length; si++) {
      const c = cell(t, 0, ti, li, vi, si, ci);
      if (c.entries < o.minTrainEntries) continue;
      if (!best || c.evPct > best.evPct) best = { ti, vi, si, evPct: c.evPct };
    }
    if (!best) { scenarios.push({ latency: latencyName(d.lat[li]), cost: d.costs[ci].name, combinationsTried: per, chosen: null }); continue; }
    const { ti, vi, si } = best;
    const ci90 = bootstrapEv(t, 1, ti, li, vi, si, ci, o);
    scenarios.push({
      latency: latencyName(d.lat[li]), cost: d.costs[ci].name, combinationsTried: per,
      chosen: {
        latency: latencyName(d.lat[li]), cost: d.costs[ci].name, threshold: d.thr[ti], sizeSol: d.sizes[si], variant: variantName(d.variants[vi]),
        train: cell(t, 0, ti, li, vi, si, ci), test: cell(t, 1, ti, li, vi, si, ci), testCi90Sol: ci90,
        testCi90Pct: ci90 ? { lo: (ci90.lo / d.sizes[si]) * 100, hi: (ci90.hi / d.sizes[si]) * 100 } : null,
        breakdown: d.costs.map((_, cj) => ({ cost: d.costs[cj].name, train: cell(t, 0, ti, li, vi, si, cj), test: cell(t, 1, ti, li, vi, si, cj) })),
      },
    });
  }
  return { scenarios, combinationsPerScenario: per, combinationsTotal: per * d.lat.length * d.costs.length };
}

export function fmtPct(x: number | null | undefined, digits = 2): string { return x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(digits)}%`; }
export function fmtSol(x: number | null | undefined): string { return x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(6)}`; }

export interface Report {
  source: string; note: string; splitTs: number; splitNote: string; options: StudyOptions;
  launches: number; releasedLaunches: number; noFillByLatency: Record<string, number>;
  validation: { checked: number; differ: number };
  combinationsPerScenario: number; combinationsTotal: number; scenarios: Scenario[];
  costCases: Array<{ name: string; note: string }>;
}

export function buildReport(t: Totals, o: StudyOptions, meta: { source: string; note: string; splitNote: string; validation: { checked: number; differ: number } }): Report {
  const sel = selectAndReport(t, o);
  return {
    source: meta.source, note: meta.note, splitTs: o.splitTs, splitNote: meta.splitNote, options: o,
    launches: t.launches, releasedLaunches: t.releasedLaunches,
    noFillByLatency: Object.fromEntries(t.dims.lat.map((l, i) => [latencyName(l), t.noFill[i]])),
    validation: meta.validation,
    combinationsPerScenario: sel.combinationsPerScenario, combinationsTotal: sel.combinationsTotal, scenarios: sel.scenarios,
    costCases: t.dims.costs.map((c) => ({ name: c.name, note: c.note })),
  };
}

const row = (cells: Array<string | number>) => `| ${cells.join(' | ')} |`;

/** The markdown the audit asked for: headline, per-scenario chosen settings with CI, gross-edge breakdown, and the threshold x size grid at the live latency. */
export function renderMarkdown(r: Report, t: Totals, grid: { latency: string; variant: Variant }): string {
  const d = t.dims;
  const L: string[] = [];
  L.push(`# Realistic EV replay - ${r.source}`, '', `> ${r.note}`, '');
  L.push(`Launches replayed: ${r.launches}; launches the gate released at some threshold: ${r.releasedLaunches}. Train/test boundary: ${new Date(r.splitTs).toISOString()} (${r.splitNote}).`);
  L.push(`Selection search: ${r.combinationsPerScenario} combinations per scenario (${d.thr.length} thresholds x ${d.sizes.length} sizes x ${d.variants.length} exit variants), ${r.scenarios.length} scenarios (latency x cost), ${r.combinationsTotal} combinations tried in total. Chosen on TRAIN only (>= ${r.options.minTrainEntries} train entries); the test column is read once, for the chosen settings. Bootstrap: ${r.options.bootstrapResamples} resamples of launch blocks of ${(r.options.blockMs ?? DAY_MS) / 3_600_000} h (seed ${r.options.seed}).`);
  L.push(`Built-in check: this model vs the in-app replayLaunch at its defaults: ${r.validation.checked} entries compared, ${r.validation.differ} differ.`, '');
  L.push('## Cost cases', '', ...r.costCases.map((c) => `- \`${c.name}\`: ${c.note}`), '');
  L.push('## Chosen settings per scenario (entry delay / exit delay x cost case)', '');
  L.push(row(['latency', 'cost', 'thr', 'size SOL', 'exit variant', 'train n', 'train EV %', 'test n', 'test EV SOL', 'test EV %', 'test 90% CI % (block bootstrap)']));
  L.push(row(Array(11).fill('---')));
  for (const s of r.scenarios) {
    const c = s.chosen;
    if (!c) { L.push(row([s.latency, s.cost, '-', '-', '-', '<min', '-', '-', '-', '-', '-'])); continue; }
    L.push(row([s.latency, s.cost, c.threshold, c.sizeSol, c.variant, c.train.entries, fmtPct(c.train.evPct), c.test.entries, fmtSol(c.test.evSol), fmtPct(c.test.evPct), c.testCi90Pct ? `${fmtPct(c.testCi90Pct.lo)} .. ${fmtPct(c.testCi90Pct.hi)}` : 'n/a']));
  }
  L.push('', '## Gross edge before costs, and what each cost takes (chosen settings of the rpc_1.25 scenario at each latency; EV per entry as % of size)', '');
  L.push(row(['latency', 'thr', 'size', 'variant', 'split', ...d.costs.map((c) => c.name)]));
  L.push(row(Array(5 + d.costs.length).fill('---')));
  for (const s of r.scenarios.filter((x) => x.cost === 'rpc_1.25' && x.chosen)) {
    const c = s.chosen as Chosen;
    for (const split of ['train', 'test'] as const) L.push(row([c.latency, c.threshold, c.sizeSol, c.variant, split, ...c.breakdown.map((b) => fmtPct(b[split].evPct))]));
  }
  const li = d.lat.findIndex((l) => latencyName(l) === grid.latency);
  const vi = d.variants.findIndex((v) => variantName(v) === variantName(grid.variant));
  if (li >= 0 && vi >= 0) {
    L.push('', `## Threshold x size grid at ${grid.latency}, exit variant ${variantName(grid.variant)} (EV per entry as % of size; train | test; entries in brackets)`, '');
    for (const ci of d.costs.map((_, i) => i)) {
      L.push(`### cost \`${d.costs[ci].name}\``, '', row(['thr', ...d.sizes.map((s) => `${s} SOL`)]), row(Array(1 + d.sizes.length).fill('---')));
      for (let ti = 0; ti < d.thr.length; ti++) {
        L.push(row([d.thr[ti], ...d.sizes.map((_, si) => { const a = cell(t, 0, ti, li, vi, si, ci), b = cell(t, 1, ti, li, vi, si, ci); return `${fmtPct(a.evPct, 1)} (${a.entries}) \\| ${fmtPct(b.evPct, 1)} (${b.entries})`; })]));
      }
      L.push('');
    }
  }
  return L.join('\n');
}

/** CSV of the full grid, both splits: one line per threshold x size x latency x cost x exit variant. */
export function gridCsv(t: Totals, source: string): string {
  const d = t.dims;
  const out = ['source,split,threshold,size_sol,entry_delay_s,exit_delay_s,cost,exit_variant,entries,ev_sol,ev_pct,win_rate'];
  for (let split = 0; split < 2; split++) for (let ti = 0; ti < d.thr.length; ti++) for (let li = 0; li < d.lat.length; li++) for (let vi = 0; vi < d.variants.length; vi++) for (let si = 0; si < d.sizes.length; si++) for (let ci = 0; ci < d.costs.length; ci++) {
    const c = cell(t, split, ti, li, vi, si, ci);
    out.push([JSON.stringify(source), split ? 'test' : 'train', d.thr[ti], d.sizes[si], d.lat[li].entryMs / 1000, d.lat[li].exitMs / 1000, d.costs[ci].name, variantName(d.variants[vi]), c.entries, c.evSol.toFixed(8), c.evPct.toFixed(4), c.winRate === null ? '' : c.winRate.toFixed(4)].join(','));
  }
  return out.join('\n') + '\n';
}

export const defaultDims = (thr: number[], sizes: number[]): Dims => ({ thr, lat: LATENCIES, variants: VARIANTS, sizes, costs: COST_CASES });
export { STOCK_VARIANT };

export interface RunInput {
  launches: AsyncIterable<StudyLaunch> | Iterable<StudyLaunch>;
  firstDay: number; lastDay: number;
  options: StudyOptions;
  source: string; note: string; splitNote: string;
  /** progress callback every 1000 launches */
  onProgress?: (n: number) => void;
  /** replay up to this many launches per run */
  limit?: number;
  /** keep a sample of released launches to validate the legacy path against replayLaunch */
  validationThreshold?: number;
}

export async function runStudy(inp: RunInput): Promise<{ report: Report; totals: Totals }> {
  const dims = defaultDims(inp.options.thresholds, inp.options.sizes);
  const totals = newTotals(dims, inp.firstDay, inp.lastDay);
  const sample: StudyLaunch[] = [];
  const vth = inp.validationThreshold ?? Math.min(...inp.options.thresholds);
  let n = 0;
  for await (const l of inp.launches as AsyncIterable<StudyLaunch>) {
    if (inp.limit && n >= inp.limit) break;
    addLaunch(totals, l, inp.options);
    if (sample.length < 4000 && l.trades.length > 20) sample.push(l);
    if (++n % 1000 === 0) inp.onProgress?.(n);
  }
  const validation = validateLegacy(sample, inp.options, vth);
  const report = buildReport(totals, inp.options, { source: inp.source, note: inp.note, splitNote: inp.splitNote, validation });
  return { report, totals };
}

/** <prefix>.json (the report), <prefix>.md (the tables) and <prefix>_grid.csv (every cell). Returns the paths. */
export function writeStudyFiles(prefix: string, report: Report, totals: Totals, fs: { writeFileSync(p: string, s: string): void }): string[] {
  const md = renderMarkdown(report, totals, { latency: '1.5s/1.5s', variant: STOCK_VARIANT });
  fs.writeFileSync(`${prefix}.json`, JSON.stringify(report, null, 1));
  fs.writeFileSync(`${prefix}.md`, md);
  fs.writeFileSync(`${prefix}_grid.csv`, gridCsv(totals, report.source));
  return [`${prefix}.json`, `${prefix}.md`, `${prefix}_grid.csv`];
}

export function parseOptions(args: string[], d: { splitTs: number; blockHours?: number }): { opt: (k: string, def: string) => string; options: StudyOptions } {
  const opt = (k: string, def: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : def; };
  const thresholds = opt('thresholds', DEFAULT_THRESHOLDS.join(',')).split(',').map(Number);
  const sizes = opt('sizes', DEFAULT_SIZES.join(',')).split(',').map(Number);
  if (thresholds.some((x) => !Number.isFinite(x)) || sizes.some((x) => !(x > 0))) throw new Error('--thresholds and --sizes need comma-separated numbers');
  const solUsdArg = opt('sol-usd', '150');
  return {
    opt,
    options: {
      thresholds, sizes, splitTs: Number(opt('split-ts', String(d.splitTs))), solUsd: solUsdArg === 'null' ? null : Number(solUsdArg),
      minTrainEntries: Number(opt('min-train', '30')), bootstrapResamples: Number(opt('bootstrap', '2000')), seed: Number(opt('seed', '229')),
      blockMs: Number(opt('block-hours', String(d.blockHours ?? 24))) * 3_600_000,
    },
  };
}
