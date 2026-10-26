import { describe, it, expect, afterEach } from 'vitest';
import {
  simulatePath, priceEntry, costByName, COST_CASES, VARIANTS, LATENCIES, STOCK_VARIANT, firstAtOrAfter, restoreStockEngine, TICK_MS, BASE_FEE_SOL, PRIORITY_BUY_SOL, PRIORITY_SELL_SOL,
  type TradeRow, type CostCase, type Variant,
} from '../scripts/hfcorpus/ev_model';
import { newTotals, keyIndex, selectAndReport, bootstrapEv, runStudy, validateLegacy, defaultDims, DAY_MS, type StudyOptions, type StudyLaunch } from '../scripts/hfcorpus/ev_study';
import { toRecordedLaunch, type CorpusLaunch } from '../scripts/hfcorpus/replay';

/** HAND-BUILT trade rows: nothing here reads the corpus or the recordings. */
afterEach(() => restoreStockEngine());
const VT = 1e15;
/** a row whose price (the unit the exit engine sees) is p: price = vS / vT / 1000 */
const row = (ts: number, p: number, vT = VT): TradeRow => [ts, true, 0.1, 1, 'u', p * 1000 * vT, vT, `s${ts}`];
const stop20: Variant = STOCK_VARIANT;
const lat = (entryMs: number, exitMs: number) => ({ entryMs, exitMs });

describe('S229 exit polling and fill latency', () => {
  it('decides on the last price at the 3 s tick and fills at the first trade after decision + exit delay, where the old replay sold at the print', () => {
    const t = [row(1000, 1e-8), row(2000, 1e-8), row(3500, 0.7e-8), row(5000, 0.5e-8), row(9000, 0.4e-8)];
    const p = simulatePath(t, 0, lat(500, 500), stop20)!;
    expect(p.entryIdx).toBe(0);
    expect(p.sells).toHaveLength(1);
    expect(p.sells[0]).toMatchObject({ reason: 'STOP_LOSS', decideTs: 1000 + TICK_MS, frac: 1 });
    expect(p.sells[0].fillIdx).toBe(3); // first row at/after 4000 + 500
    expect(p.open).toBeNull();
    const legacy = simulatePath(t, 0, lat(500, 500), stop20, { legacy: true })!;
    expect(legacy.sells[0].fillIdx).toBe(2); // the print that crossed -20%
  });
  it('the engine never sees a spike that is over before the next poll, and the high-water mark only moves at polls', () => {
    const t = [row(1000, 1e-8), row(2000, 1.5e-8), row(3000, 1e-8), row(20_000, 1e-8)];
    const tick = simulatePath(t, 0, lat(500, 500), stop20)!;
    expect(tick.sells).toHaveLength(0);
    expect(tick.open).toEqual({ lastIdx: 3 });
    const legacy = simulatePath(t, 0, lat(500, 500), stop20, { legacy: true })!;
    expect(legacy.sells[0].reason).toBe('TAKE_PROFIT_1');
  });
  it('a longer exit delay fills later and so at the later price', () => {
    const t = [row(1000, 1e-8), row(3500, 0.7e-8), row(4400, 0.6e-8), row(6000, 0.3e-8)];
    expect(simulatePath(t, 0, lat(500, 300), stop20)!.sells[0].fillIdx).toBe(2); // first row at/after 4000 + 300 is the one at 4400
    expect(simulatePath(t, 0, lat(500, 500), stop20)!.sells[0].fillIdx).toBe(3); // at/after 4500 it is the one at 6000, a lower price
  });
  it('entry fill = first trade at/after release + entry delay; no trade after it means no entry', () => {
    const t = [row(1000, 1e-8), row(2600, 1e-8), row(4000, 1e-8)];
    expect(simulatePath(t, 1000, lat(1500, 500), stop20)!.entryIdx).toBe(1);
    expect(simulatePath(t, 1000, lat(5000, 500), stop20)).toBeNull();
    expect(firstAtOrAfter(t, 4001)).toBe(-1);
  });
  it('the stale exit fires on the tick at the stale time, with the price the engine last saw', () => {
    const t = [row(1000, 1e-8), row(2000, 1.02e-8), row(500_000, 1.02e-8)];
    const v = VARIANTS.find((x) => x.staleMin === 5 && x.stop === 20 && x.tp1 === 30)!;
    const p = simulatePath(t, 0, lat(500, 500), v)!;
    expect(p.sells[0]).toMatchObject({ reason: 'STALE_POSITION', decideTs: 1000 + 300_000 });
    expect(p.sells[0].fillIdx).toBe(2);
  });
  it('a decision with no later trade cannot be filled: the position stays open', () => {
    const t = [row(1000, 1e-8), row(3500, 0.5e-8)];
    const p = simulatePath(t, 0, lat(500, 500), stop20)!;
    expect(p.sells).toHaveLength(0);
    expect(p.open).toEqual({ lastIdx: 1 });
  });
  it('partial take-profits sell a share of what is still held', () => {
    const t = [row(1000, 1e-8), row(2000, 1.35e-8), row(4500, 1.35e-8), row(8000, 1.35e-8), row(12_000, 0.5e-8), row(20_000, 0.5e-8)];
    const p = simulatePath(t, 0, lat(500, 500), stop20)!;
    expect(p.sells[0]).toMatchObject({ reason: 'TAKE_PROFIT_1', frac: 0.33 });
    expect(p.sells.length).toBeGreaterThan(1);
    expect(p.sells[p.sells.length - 1].frac).toBe(1);
  });
});

describe('S229 price impact, fees and transaction costs', () => {
  const flat = (vS: number, vT: number): TradeRow[] => [[1000, true, 0.1, 1, 'u', vS, vT, 'a'], [2000, true, 0.1, 1, 'u', vS, vT, 'b']];
  const noSell = { entryIdx: 0, entryTs: 1000, sells: [], open: { lastIdx: 1 } };
  it('gross prices a flat position at exactly zero; the buy fee is inside the order and impact makes a round trip lose', () => {
    const t = flat(30e9, 1.073e15);
    expect(priceEntry(t, noSell, 0.1, costByName('gross'))).toBeCloseTo(0, 12);
    const fee = costByName('fees_1.25');
    const net = 0.1 / 1.0125;
    const tokens = (1.073e15 * net * 1e9) / (30e9 + net * 1e9);
    const out = ((30e9 * tokens) / (1.073e15 + tokens)) * 1e-9 * (1 - 0.0125);
    expect(priceEntry(t, noSell, 0.1, fee)).toBeCloseTo(out - 0.1, 12);
  });
  it('impact grows with order size (percentage loss on a flat round trip) and costs nothing at spot', () => {
    const t = flat(30e9, 1.073e15);
    const imp = costByName('impact');
    const pct = (s: number) => priceEntry(t, noSell, s, imp) / s;
    expect(pct(0.005)).toBeGreaterThan(pct(0.1));
    expect(pct(0.1)).toBeLessThan(-0.005);
    expect(pct(0.1)).toBeGreaterThan(-0.01); // 2 x 0.1/30 of price, not more
  });
  it('the live-path fixed cost is base + priority for the buy and for each sell; Jito adds its tip to both', () => {
    const t = flat(30e9, 1.073e15);
    const path = { entryIdx: 0, entryTs: 1000, sells: [{ decideTs: 1500, fillIdx: 1, frac: 1, reason: 'x' }], open: null };
    const base = priceEntry(t, path, 0.05, { ...costByName('rpc_1.25') });
    const feeOnly = priceEntry(t, path, 0.05, costByName('fees_1.25'));
    expect(feeOnly - base).toBeCloseTo(2 * BASE_FEE_SOL + PRIORITY_BUY_SOL + PRIORITY_SELL_SOL, 12);
    expect(PRIORITY_BUY_SOL).toBeCloseTo(6250e-9, 15); expect(PRIORITY_SELL_SOL).toBeCloseTo(5000e-9, 15);
    const jito = priceEntry(t, path, 0.05, costByName('jito_1.25'));
    expect(base - jito).toBeCloseTo(2 * 0.0001, 12);
    expect(costByName('rpc_1.25').fixedBuy).toBe(BASE_FEE_SOL + PRIORITY_BUY_SOL); // Jito unset: no tip
  });
  it('the stock case reproduces the old arithmetic: no buy fee, 1% on the sell, 2 x (0.000005 + 0.0001) once however many sells', () => {
    const t = [row(1000, 1e-8), row(2000, 1.5e-8), row(3000, 1.5e-8)];
    const path = { entryIdx: 0, entryTs: 1000, sells: [{ decideTs: 2000, fillIdx: 1, frac: 0.33, reason: 'a' }, { decideTs: 3000, fillIdx: 2, frac: 1, reason: 'b' }], open: null };
    const expected = (0.33 * 0.005 * 1.5 + 0.67 * 0.005 * 1.5) * 0.99 - 0.005 - 2 * (0.000005 + 0.0001);
    expect(priceEntry(t, path, 0.005, costByName('stock'))).toBeCloseTo(expected, 12);
  });
  it('a failed buy loses base + priority and nothing else (no tip, no position)', () => {
    const t = flat(30e9, 1.073e15);
    const c: CostCase = { ...costByName('jito_1.25'), pFailBuy: 1 };
    expect(priceEntry(t, noSell, 0.1, c)).toBeCloseTo(-(BASE_FEE_SOL + PRIORITY_BUY_SOL), 15);
  });
  it('failed sells: each failed attempt costs base + priority and the retry lands later at the later price', () => {
    const t = [row(1000, 1e-8), row(2000, 1e-8), row(5000, 0.5e-8), row(8000, 0.25e-8), row(11_000, 0.125e-8)];
    const path = { entryIdx: 0, entryTs: 1000, sells: [{ decideTs: 1500, fillIdx: 1, frac: 1, reason: 'x' }], open: null };
    const c = { ...costByName('fees_1.25'), failCostSell: 7e-6, fixedSell: 0, fixedBuy: 0 };
    const clean = priceEntry(t, path, 0.1, c);
    const p = 0.5;
    const failing = priceEntry(t, path, 0.1, { ...c, pFailSell: p, retryDelayMs: 3000 });
    // gross proceeds of a sell at price ratio r (flat curve at the row): value = r x tokens x (1 - fee); here prices at the retry rows are 0.5, 0.25, 0.125 of entry
    const base = clean + 0.1; // proceeds at ratio 1
    const exp = [1 * (1 - p), 0.5 * p * (1 - p), 0.25 * p * p * (1 - p), 0.125 * p * p * p]; // retry rows: 2000 +3000 = 5000, +6000 -> 8000, +9000 -> 11000
    const expProceeds = base * exp.reduce((a, b) => a + b, 0);
    const expFailCost = 7e-6 * (0 * (1 - p) + 1 * p * (1 - p) + 2 * p * p * (1 - p) + 3 * p * p * p);
    expect(failing).toBeCloseTo(expProceeds - 0.1 - expFailCost, 10);
    expect(failing).toBeLessThan(clean);
  });
  it('the cost cases are the ones the audit named, in a fixed order', () => {
    expect(COST_CASES.map((c) => c.name)).toEqual(['gross', 'impact', 'fees_1.25', 'rpc_1.0', 'rpc_1.25', 'rpc_1.25_fail', 'jito_1.25', 'stock']);
    expect(costByName('rpc_1.0').buyFeePct).toBe(1.0);
    expect(costByName('rpc_1.0').sellFeePct).toBe(1.0);
    expect(() => costByName('nope')).toThrow(/unknown cost case/);
  });
  it('18 exit variants, 12 latencies', () => {
    expect(VARIANTS).toHaveLength(18);
    expect(VARIANTS).toContainEqual(STOCK_VARIANT);
    expect(LATENCIES).toHaveLength(12);
  });
});

/** A CorpusLaunch: steady distinct-buyer buying that the watch window releases, then a dump. Same curve maths as the chain's reserves. */
function corpusLaunch(t0: number, mintSuffix: string, dump: boolean): CorpusLaunch {
  let vSol = 30e9, vTok = 1.073e15;
  const rows: TradeRow[] = [];
  const mint = 'Mint' + mintSuffix;
  const step = (isBuy: boolean, sol: number, user: string, ts: number, i: number) => {
    const k = vSol * vTok; const lam = sol * 1e9;
    const newS = isBuy ? vSol + lam : Math.max(1e9, vSol - lam); const newT = k / newS; const tok = Math.abs(vTok - newT);
    vSol = newS; vTok = newT;
    rows.push([ts, isBuy, sol, tok / 1e6, user, Math.round(vSol), Math.round(vTok), `sig-${mintSuffix}-${i}`]);
  };
  for (let i = 0; i < 60; i++) step(i < 45 || i % 4 !== 0, 0.3 + (i % 5) * 0.2, 'w' + (i % 40), t0 + 1500 + i * 900, i);
  const end = t0 + 1500 + 60 * 900;
  for (let i = 0; i < 40; i++) step(dump ? false : true, dump ? 2 : 0.4, 'x' + (i % 10), end + 3000 + i * 1000, 100 + i);
  return { mint, symbol: 'T', creator: 'creator' + mintSuffix, mayhem: false, t0, graduated: false, trades: rows };
}
const asStudy = (c: CorpusLaunch): StudyLaunch => ({ rec: toRecordedLaunch(c, 150), t0: c.t0, trades: c.trades });
const OPTS: StudyOptions = { thresholds: [50], sizes: [0.01], splitTs: 0, solUsd: 150, minTrainEntries: 1, bootstrapResamples: 100, seed: 7 };

describe('S229 the study loop', () => {
  it('legacy path + stock cost equals replayLaunch exactly on closed entries (the built-in check)', () => {
    const ls = [asStudy(corpusLaunch(1_000_000, 'A', true)), asStudy(corpusLaunch(5_000_000, 'B', true))];
    const v = validateLegacy(ls, OPTS, 50);
    expect(v.checked).toBeGreaterThan(0);
    expect(v.differ).toBe(0);
  });
  it('counts the search, labels the source, picks on train only and is repeatable', async () => {
    const day = 20_000 * DAY_MS;
    const ls = [asStudy(corpusLaunch(day + 1_000, 'A', true)), asStudy(corpusLaunch(day + 2_000, 'B', false)), asStudy(corpusLaunch(day + 3 * DAY_MS, 'C', true)), asStudy(corpusLaunch(day + 3 * DAY_MS + 5_000, 'D', false))];
    const o = { ...OPTS, splitTs: day + 2 * DAY_MS };
    const run = () => runStudy({ launches: ls, firstDay: 20_000, lastDay: 20_004, options: o, source: 'unit test fixture', note: 'n', splitNote: 's' });
    const a = await run(), b = await run();
    expect(a.report.source).toBe('unit test fixture');
    expect(a.report.combinationsPerScenario).toBe(1 * 1 * 18);
    expect(a.report.scenarios).toHaveLength(12 * 8);
    expect(a.report.combinationsTotal).toBe(18 * 12 * 8);
    expect(a.report.validation.differ).toBe(0);
    const c = a.report.scenarios.find((s) => s.latency === '1.5s/1.5s' && s.cost === 'rpc_1.25')!.chosen!;
    expect(c.train.entries).toBeGreaterThan(0);
    expect(c.test.entries).toBeGreaterThan(0);
    // chosen by train: no other variant has a higher train EV% at this scenario
    const d = a.totals.dims; const li = d.lat.findIndex((l) => l.entryMs === 1500 && l.exitMs === 1500); const ci = d.costs.findIndex((x) => x.name === 'rpc_1.25');
    const best = Math.max(...d.variants.map((_, vi) => a.totals.sum[0][keyIndex(d, 0, li, vi, 0, ci)] / Math.max(1, a.totals.count[0][keyIndex(d, 0, li, vi, 0, ci)]) / 0.01 * 100));
    expect(c.train.evPct).toBeCloseTo(best, 9);
    expect(JSON.stringify(a.report)).toEqual(JSON.stringify(b.report));
  });
  it('the bootstrap block is configurable: launches two hours apart are two blocks with hour blocks and one with day blocks', async () => {
    const day = 20_000 * DAY_MS;
    const ls = [asStudy(corpusLaunch(day + 1_000, 'A', true)), asStudy(corpusLaunch(day + 2 * 3_600_000, 'B', true))];
    const hourly = await runStudy({ launches: ls, firstDay: 20_000 * 24, lastDay: 20_000 * 24 + 5, options: { ...OPTS, splitTs: day + 10 * DAY_MS, blockMs: 3_600_000 }, source: 's', note: 'n', splitNote: 'x' });
    const daily = await runStudy({ launches: ls, firstDay: 20_000, lastDay: 20_000, options: { ...OPTS, splitTs: day + 10 * DAY_MS }, source: 's', note: 'n', splitNote: 'x' });
    expect(hourly.totals.daysSeen[0].size).toBe(2);
    expect(daily.totals.daysSeen[0].size).toBe(1);
  });
  it('selection ignores the test split: moving test P&L around does not change the chosen settings', () => {
    const dims = defaultDims([50, 52], [0.01]);
    const mk = () => {
      const t = newTotals(dims, 100, 105);
      const li = 0, ci = 0;
      const a = keyIndex(dims, 0, li, 0, 0, ci), b = keyIndex(dims, 1, li, 3, 0, ci);
      t.count[0][a] = 50; t.sum[0][a] = 0.5; // train +100%
      t.count[0][b] = 50; t.sum[0][b] = 0.1; // train +20%
      t.count[1][a] = 40; t.sum[1][a] = -0.4;
      t.count[1][b] = 40; t.sum[1][b] = 4;   // test looks much better for b
      for (const s of [0, 1]) for (let dd = 100; dd <= 105; dd++) t.daysSeen[s].add(dd - 100);
      return { t, a, b };
    };
    const o = { ...OPTS, thresholds: [50, 52], minTrainEntries: 30 };
    const { t } = mk();
    const sel = selectAndReport(t, o).scenarios.find((s) => s.latency === '0.5s/0.5s' && s.cost === 'gross')!;
    expect(sel.chosen).toMatchObject({ threshold: 50, sizeSol: 0.01 });
    expect(sel.chosen!.train.entries).toBe(50);
    const { t: t2 } = mk();
    t2.sum[1][keyIndex(dims, 1, 0, 3, 0, 0)] = -9;
    expect(selectAndReport(t2, o).scenarios.find((s) => s.latency === '0.5s/0.5s' && s.cost === 'gross')!.chosen!.threshold).toBe(50);
  });
  it('the minimum train entries keeps a lucky handful from being chosen', () => {
    const dims = defaultDims([50], [0.01]);
    const t = newTotals(dims, 100, 101);
    const k = keyIndex(dims, 0, 0, 0, 0, 0);
    t.count[0][k] = 3; t.sum[0][k] = 3;
    expect(selectAndReport(t, { ...OPTS, minTrainEntries: 30 }).scenarios[0].chosen).toBeNull();
    expect(selectAndReport(t, { ...OPTS, minTrainEntries: 3 }).scenarios[0].chosen).not.toBeNull();
  });
});

describe('S229 block bootstrap by launch day', () => {
  const dims = defaultDims([50], [0.01]);
  const setup = (perDay: number[]) => {
    const t = newTotals(dims, 100, 100 + perDay.length - 1);
    const k = keyIndex(dims, 0, 0, 0, 0, 0);
    perDay.forEach((ev, i) => { t.daySum[1][k * t.nDays + i] = ev * 10; t.dayCount[1][i] = 10; t.daysSeen[1].add(i); });
    return t;
  };
  it('days that all earn the same give a zero-width interval at that EV', () => {
    const ci = bootstrapEv(setup([1, 1, 1, 1]), 1, 0, 0, 0, 0, 0, OPTS)!;
    expect(ci.lo).toBeCloseTo(1, 12); expect(ci.hi).toBeCloseTo(1, 12); expect(ci.days).toBe(4);
  });
  it('mixed days give a wide interval inside the range of the days, and more days narrow it', () => {
    const few = bootstrapEv(setup([1, -1, 1, -1]), 1, 0, 0, 0, 0, 0, { ...OPTS, bootstrapResamples: 500 })!;
    const many = bootstrapEv(setup(Array.from({ length: 40 }, (_, i) => (i % 2 ? 1 : -1))), 1, 0, 0, 0, 0, 0, { ...OPTS, bootstrapResamples: 500 })!;
    expect(few.lo).toBeLessThan(0); expect(few.hi).toBeGreaterThan(0);
    expect(few.lo).toBeGreaterThanOrEqual(-1); expect(few.hi).toBeLessThanOrEqual(1);
    expect(many.hi - many.lo).toBeLessThan(few.hi - few.lo);
  });
  it('no launch days in the split: no interval', () => {
    const t = newTotals(dims, 100, 101);
    expect(bootstrapEv(t, 1, 0, 0, 0, 0, 0, OPTS)).toBeNull();
  });
});
