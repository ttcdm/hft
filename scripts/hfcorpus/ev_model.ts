import { ExitEngine } from '../../server/exits/exitEngine';

/**
 * S229: the realistic-EV model. Pure functions over one launch's trade rows ([ts, isBuy, sol, tokens, user, virtualSol, virtualTokens, signature]),
 * shared by the 39-day corpus study (scripts/hfcorpus/realistic_ev.ts) and the own-recordings study (scripts/recorder_backtest/realistic_ev.ts).
 * It replaces three optimistic habits of server/backtest/replay.ts:
 *   1. exits are DECIDED on the last price at each 3 s engine poll and FILLED at the first trade at or after decision + exit delay
 *      (replay.ts sells at the exact print that crossed the trigger);
 *   2. orders move the curve: buys and sells are priced against the virtual reserves of the fill row (replay.ts prices at spot);
 *   3. both sides pay the pump fee, every transaction pays base + priority (+ optional Jito tip), and a transaction can fail
 *      (replay.ts charges no buy fee and one fixed 2 x (network + tip) per round trip).
 * `legacy` mode and the 'stock' cost case reproduce replay.ts exactly; the study checks that on every run.
 */
export type TradeRow = [number, boolean, number, number, string, number, number, string];

/** The live exit engine polls every 3 s (server/exits). */
export const TICK_MS = 3_000;

export interface Variant { stop: number; tp1: number; staleMin: number }
export const STOCK_VARIANT: Variant = { stop: 20, tp1: 30, staleMin: 30 };
/** The 18 exit variants of scripts/hfcorpus/exit_variants.ts (the stock rules are one of them). */
export const VARIANTS: Variant[] = (() => {
  const out: Variant[] = [];
  for (const stop of [10, 15, 20]) for (const tp1 of [15, 30]) for (const staleMin of [5, 10, 30]) out.push({ stop, tp1, staleMin });
  return out;
})();
export const variantName = (v: Variant) => `stop${v.stop}/tp${v.tp1}/stale${v.staleMin}m`;

const E = ExitEngine as unknown as Record<string, number>;
export const setVariant = (v: Variant) => { E.HARD_STOP_LOSS_PCT = -v.stop; E.TP1_TRIGGER_PCT = v.tp1; E.STALE_POSITION_HOLD_MS = v.staleMin * 60_000; };
export const restoreStockEngine = () => setVariant(STOCK_VARIANT);

export interface Latency { entryMs: number; exitMs: number }
export const ENTRY_DELAYS_MS = [500, 1_500, 3_000, 5_000];
export const EXIT_DELAYS_MS = [500, 1_500, 3_000];
export const LATENCIES: Latency[] = ENTRY_DELAYS_MS.flatMap((entryMs) => EXIT_DELAYS_MS.map((exitMs) => ({ entryMs, exitMs })));
export const latencyName = (l: Latency) => `${l.entryMs / 1000}s/${l.exitMs / 1000}s`;

/** price in SOL per token, the unit the exit engine sees */
export const px = (r: TradeRow) => r[5] / r[6] / 1000;

/** index of the first row with ts >= t, or -1 */
export function firstAtOrAfter(trades: TradeRow[], t: number): number {
  let lo = 0, hi = trades.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (trades[m][0] < t) lo = m + 1; else hi = m; }
  return lo < trades.length ? lo : -1;
}

export interface PathSell { decideTs: number; fillIdx: number; /** share of the CURRENT holding sold (replay.ts: remaining x sellPercentage) */ frac: number; reason: string }
export interface Path { entryIdx: number; entryTs: number; sells: PathSell[]; /** the part still held when the data ends, valued at the last row */ open: { lastIdx: number } | null }

/**
 * One position's life: entry fill, exit decisions, exit fills. The path does not depend on order size (the engine compares prices with the
 * fill row's market price; the order's own impact is applied afterwards by priceEntry - at 0.1 SOL against a 30 SOL virtual reserve that is
 * under 0.7% of price, so a trigger can fire up to that much earlier or later than for a tiny order).
 *   tick mode (default): entry = first row at/after release + entryMs. The engine looks at the last price at entry + k x 3 s (k >= 1) - and
 *     only then updates its high-water mark and trailing stop. A decision at tick T fills at the first row at/after T + exitMs.
 *   legacy mode: replay.ts's loop - every print after the entry is evaluated and fills at that print.
 */
export function simulatePath(trades: TradeRow[], releaseTs: number, lat: Latency, v: Variant, opts: { legacy?: boolean } = {}): Path | null {
  setVariant(v);
  const entryIdx = firstAtOrAfter(trades, releaseTs + lat.entryMs);
  if (entryIdx < 0) return null;
  const entryTs = trades[entryIdx][0];
  const entryPrice = px(trades[entryIdx]);
  if (!(entryPrice > 0)) return null;
  const n = trades.length;
  let hwm = entryPrice, trail = 0, stage = 0, remaining = 1;
  const sells: PathSell[] = [];
  const decide = (price: number, ts: number): { exit: boolean; full: boolean } => {
    const d = ExitEngine.evaluate({ entryPriceSol: entryPrice, currentPriceSol: price, highWaterMarkSol: hwm, trailingStopSol: trail, exitStage: stage, entryTimestamp: entryTs, currentTimestamp: ts });
    hwm = d.newHighWaterMarkSol; trail = d.newTrailingStopSol;
    if (!d.shouldExit) return { exit: false, full: false };
    const frac = Math.min(100, Math.max(1, d.sellPercentage)) / 100;
    stage = d.newExitStage;
    remaining *= 1 - frac;
    sells.push({ decideTs: ts, fillIdx: -1, frac, reason: d.reason });
    return { exit: true, full: remaining <= 1e-9 || d.sellPercentage >= 100 };
  };

  if (opts.legacy) {
    let lastIdx = entryIdx;
    for (let j = entryIdx + 1; j < n; j++) {
      const p = px(trades[j]);
      if (!(p > 0)) continue;
      lastIdx = j;
      const r = decide(p, trades[j][0]);
      if (!r.exit) continue;
      sells[sells.length - 1].fillIdx = j;
      if (r.full) return { entryIdx, entryTs, sells, open: null };
    }
    return { entryIdx, entryTs, sells, open: { lastIdx } };
  }

  const staleTick = Math.ceil((v.staleMin * 60_000) / TICK_MS);
  let j = entryIdx; // last row with ts <= the tick being evaluated
  let k = 0;
  for (;;) {
    const kTrade = j + 1 < n ? Math.max(k + 1, Math.ceil((trades[j + 1][0] - entryTs) / TICK_MS)) : Infinity;
    const kStale = staleTick > k ? staleTick : Infinity;
    const next = Math.min(kTrade, kStale);
    if (next === Infinity) break;
    k = next;
    const T = entryTs + k * TICK_MS;
    while (j + 1 < n && trades[j + 1][0] <= T) j++;
    const p = px(trades[j]);
    if (!(p > 0)) continue;
    const r = decide(p, T);
    if (!r.exit) continue;
    const fill = firstAtOrAfter(trades, T + lat.exitMs);
    if (fill < 0) { sells.pop(); break; } // nothing trades after the decision: the sell cannot be priced, the position stays open
    sells[sells.length - 1].fillIdx = fill;
    if (r.full) return { entryIdx, entryTs, sells, open: null };
  }
  return { entryIdx, entryTs, sells, open: { lastIdx: n - 1 } };
}

/** All amounts in SOL unless named otherwise. */
export interface CostCase {
  name: string;
  note: string;
  /** pump fee, % of the order (buy: inside the order, net = order / (1 + f)) and of the proceeds (sell) */
  buyFeePct: number;
  sellFeePct: number;
  /** price the order against the fill row's virtual reserves (false: spot price) */
  impact: boolean;
  /** per transaction: network base + priority + Jito tip */
  fixedBuy: number;
  fixedSell: number;
  /** replay.ts's 2 x (network + tip), charged once per round trip whatever the number of sells */
  fixedOnce: number;
  /** what a FAILED buy / sell attempt costs (base + priority; a tip is not paid when the transaction does not land) */
  failCostBuy: number;
  failCostSell: number;
  pFailBuy: number;
  pFailSell: number;
  /** a failed sell is retried after this long, at the then-current price */
  retryDelayMs: number;
}

export const LAMPORT = 1e-9;
/** live builder: PRIORITY_FEE_MICROLAMPORTS 25000 x CU limit (buy 250000, sell 200000) / 1e6, plus the 5000 lamport base fee per signature */
export const BASE_FEE_SOL = 5_000 * LAMPORT;
export const PRIORITY_BUY_SOL = Math.round((25_000 * 250_000) / 1e6) * LAMPORT;  // 6,250 lamports
export const PRIORITY_SELL_SOL = Math.round((25_000 * 200_000) / 1e6) * LAMPORT; // 5,000 lamports
export const JITO_TIP_SOL = 0.0001;
/** pump.fun's total fee, protocol 0.95% + creator 0.30% (SDK default; NOT verified against the on-chain config from this container) */
export const PUMP_FEE_SDK_PCT = 1.25;
export const PUMP_FEE_CODE_PCT = 1.0;

const live = (name: string, note: string, fee: number, over: Partial<CostCase> = {}): CostCase => ({
  name, note, buyFeePct: fee, sellFeePct: fee, impact: true,
  fixedBuy: BASE_FEE_SOL + PRIORITY_BUY_SOL, fixedSell: BASE_FEE_SOL + PRIORITY_SELL_SOL, fixedOnce: 0,
  failCostBuy: BASE_FEE_SOL + PRIORITY_BUY_SOL, failCostSell: BASE_FEE_SOL + PRIORITY_SELL_SOL,
  pFailBuy: 0, pFailSell: 0, retryDelayMs: 3_000, ...over,
});
export const FAIL_P = 0.10;
const none: Partial<CostCase> = { fixedBuy: 0, fixedSell: 0, failCostBuy: 0, failCostSell: 0 };
export const COST_CASES: CostCase[] = [
  live('gross', 'price ratio only: no fee, no impact, no transaction cost', 0, { impact: false, ...none }),
  live('impact', 'gross + own-order impact on the curve', 0, none),
  live('fees_1.25', 'impact + pump fee 1.25% each side', PUMP_FEE_SDK_PCT, none),
  live('rpc_1.0', 'live path, Jito unset (straight to RPC): impact + 1.0% fee + base & priority fee per transaction', PUMP_FEE_CODE_PCT),
  live('rpc_1.25', 'live path, Jito unset: impact + 1.25% fee + base & priority fee per transaction', PUMP_FEE_SDK_PCT),
  live('rpc_1.25_fail', `rpc_1.25 + ${FAIL_P * 100}% of buys and ${FAIL_P * 100}% of sells fail (an ASSUMPTION - no measured rate)`, PUMP_FEE_SDK_PCT, { pFailBuy: FAIL_P, pFailSell: FAIL_P }),
  live('jito_1.25', 'rpc_1.25 + a 0.0001 SOL Jito tip on each transaction', PUMP_FEE_SDK_PCT, { fixedBuy: BASE_FEE_SOL + PRIORITY_BUY_SOL + JITO_TIP_SOL, fixedSell: BASE_FEE_SOL + PRIORITY_SELL_SOL + JITO_TIP_SOL }),
  {
    name: 'stock', note: "replay.ts's own costs: no impact, no buy fee, 1% sell fee, 2 x (0.000005 + 0.0001) once per round trip",
    buyFeePct: 0, sellFeePct: 1.0, impact: false, fixedBuy: 0, fixedSell: 0, fixedOnce: 2 * (0.000005 + 0.0001), failCostBuy: 0, failCostSell: 0, pFailBuy: 0, pFailSell: 0, retryDelayMs: 3_000,
  },
];
export const costByName = (n: string): CostCase => { const c = COST_CASES.find((x) => x.name === n); if (!c) throw new Error(`unknown cost case ${n}`); return c; };

/** SOL received for selling `tokens` (raw units) against row r's virtual reserves, after the sell fee */
function sellProceeds(r: TradeRow, tokens: number, c: CostCase): number {
  const vS = r[5], vT = r[6];
  const lamports = c.impact ? (vS * tokens) / (vT + tokens) : (tokens * vS) / vT;
  return lamports * 1e-9 * (1 - c.sellFeePct / 100);
}

/**
 * Expected net P&L (SOL) of one position of `sizeSol` along `path`, under cost case `c`.
 * Buy: net of the fee = size / (1 + f); tokens = vT x net / (vS + net) at the fill row (spot: net x vT / vS).
 * Each sell: its share of the current token holding at the fill row's reserves. A failed sell attempt costs `failCostSell` and the retry
 * lands at the first row at/after fill + k x retryDelay; the expected value mixes k = 0, 1, 2 failures and "3 or more" (then forced to land).
 * A failed buy costs `failCostBuy` and the position never opens (no retry). A part still open when the data ends is valued as if sold at
 * the last row (one more sell transaction, except under the stock case, which charges nothing for it).
 */
export function priceEntry(trades: TradeRow[], path: Path, sizeSol: number, c: CostCase): number {
  const e = trades[path.entryIdx];
  const net = sizeSol / (1 + c.buyFeePct / 100);
  const lam = net * 1e9;
  let held = c.impact ? (e[6] * lam) / (e[5] + lam) : (lam * e[6]) / e[5];
  let proceeds = 0;
  let fixed = c.fixedOnce + c.fixedBuy;
  const pF = c.pFailSell;
  for (const s of path.sells) {
    const tokens = held * s.frac;
    held -= tokens;
    fixed += c.fixedSell;
    if (pF <= 0) { proceeds += sellProceeds(trades[s.fillIdx], tokens, c); continue; }
    const baseTs = trades[s.fillIdx][0];
    let expProceeds = 0, expFailCost = 0;
    for (let kf = 0; kf <= 3; kf++) {
      const prob = kf < 3 ? Math.pow(pF, kf) * (1 - pF) : Math.pow(pF, 3);
      let idx = kf === 0 ? s.fillIdx : firstAtOrAfter(trades, baseTs + kf * c.retryDelayMs);
      if (idx < 0) idx = trades.length - 1;
      expProceeds += prob * sellProceeds(trades[idx], tokens, c);
      expFailCost += prob * kf * c.failCostSell;
    }
    proceeds += expProceeds;
    fixed += expFailCost;
  }
  if (path.open && held > 0) {
    proceeds += sellProceeds(trades[path.open.lastIdx], held, c);
    if (c.fixedOnce === 0) fixed += c.fixedSell;
  }
  const success = proceeds - sizeSol - fixed;
  return (1 - c.pFailBuy) * success + c.pFailBuy * -c.failCostBuy;
}
