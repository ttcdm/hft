import { WatchWindow, type WatchState } from '../signals/watchWindow';
import { getConfluenceThreshold } from '../signals/confluenceThreshold';
import { ConfluenceEngine, isConfluencePassed } from '../signals/confluenceEngine';
import { CurveVelocityEvaluator } from '../signals/curveVelocityEvaluator';
import { OnChainPoolStats, tradePriceSol } from '../market/poolStats';
import { ExitEngine } from '../exits/exitEngine';
import type { PumpTradeEvent } from '../solana/pumpFeedListener';

/**
 * Replays the auto trader's own rules over recorded launches: the real WatchWindow (verdict at the same 20 s / 120 s timing), the real
 * ConfluenceEngine (score at or above the buy threshold for a READY release; default 70, replayable at any value), and the real ExitEngine (stop, trailing stop, take-profit ladder, stale exit).
 * Entry and exit prices are the recorded trades' prices; costs are the pump.fun fee on each side plus the network fee and tip.
 *
 * NOT replayed (the data to do it was not recorded, so the result is optimistic by that much): the eligibility filter (authorities,
 * holder concentration), risk limits and capital sizing, slippage beyond the recorded price, and creator wallet history.
 */
export const REPLAY_DEFAULTS = {
  orderSol: 0.005,
  /** Delay between the watch window's release and the buy landing. An ASSUMPTION; the recorded trade at or after this is the fill price. */
  entryDelayMs: 1_500,
  feePct: 1.0,            // pump.fun protocol fee, each side
  networkFeeSol: 0.000005,
  tipSol: 0.0001,
  /** How often the window is ticked while replaying (the live loop ticks every 2 s). */
  tickMs: 2_000,
};
/** `minScore`: the confluence buy threshold to replay at (S187 what-if). Default: the threshold in force. */
export type ReplayOptions = Partial<typeof REPLAY_DEFAULTS> & { minScore?: number };

export interface RecordedEvent { ts: number; kind: 'CREATE' | 'TRADE'; payload: any }
export interface RecordedLaunch { mint: string; events: RecordedEvent[] }
export interface FunderFact { ts: number; wallet: string; funder: string | null }

export type ReplayOutcome = 'NO_ENTRY' | 'CLOSED' | 'OPEN_AT_END';
export interface ReplayedLaunch {
  mint: string;
  symbol: string;
  trades: number;
  verdict: WatchState | 'NO_TRADES';
  verdictReason: string;
  releasedAfterMs: number | null;
  score: number | null;
  entered: boolean;
  /** why a released launch was not bought (READY below the score gate, no trade after the release, ...) */
  noEntryReason: string | null;
  outcome: ReplayOutcome;
  entryPriceSol: number | null;
  exits: Array<{ reason: string; sellPct: number; priceSol: number; afterMs: number }>;
  holdMs: number | null;
  /** net SOL after fees for the closed part; for OPEN_AT_END the value at the last recorded price is in `openValueSol`, not here */
  netPnlSol: number | null;
  openValueSol: number | null;
  /** S190: after the watch window's release, the highest recorded trade price against the price the window left it at. Null: no released launch / no later trade. */
  peak?: { refPriceSol: number; peakPriceSol: number; peakMultiple: number; timeToPeakMs: number; observedMs: number } | null;
}

/** S190: the release-to-peak buckets, in minutes. A peak at exactly a boundary belongs to the later bucket. */
export const PEAK_BUCKETS_MIN: Array<{ label: string; fromMin: number; toMin: number }> = [
  { label: '< 5 min', fromMin: 0, toMin: 5 },
  { label: '5 to 30 min', fromMin: 5, toMin: 30 },
  { label: '30 to 60 min', fromMin: 30, toMin: 60 },
  { label: '60 to 180 min', fromMin: 60, toMin: 180 },
  { label: 'over 180 min', fromMin: 180, toMin: Infinity },
];

export interface PeakAnalysis {
  basis: string;
  /** launches with a release and at least one later recorded trade price */
  launches: number;
  /** launches whose recorded data reaches at least this long past the release: a late spike can only be seen where the recording is long enough */
  coverage: { atLeast30Min: number; atLeast60Min: number; atLeast180Min: number };
  buckets: Array<{ label: string; launches: number; medianPeakMultiple: number | null; peakAtLeast2x: number; peakAtLeast5x: number }>;
  /** the question behind it: how often does the best price come late, and is it a real move */
  late: { peakAfter30MinAtLeast2x: number; ofLaunchesWithAtLeast60MinData: number; peakAfter60MinAtLeast2x: number; ofLaunchesWithAtLeast180MinData: number };
  caveats: string[];
}

export interface ReplayReport {
  rules: string[];
  notReplayed: string[];
  assumptions: Record<string, number>;
  summary: {
    launches: number; released: Record<string, number>; entries: number; closed: number; openAtEnd: number;
    wins: number; losses: number; winRate: number | null; netPnlSol: number | null; avgHoldMs: number | null; exitReasons: Record<string, number>;
  };
  launches: ReplayedLaunch[];
  /** S190 */
  peakAnalysis: PeakAnalysis;
}

const big = (v: unknown): bigint => BigInt(String(v ?? '0'));
export function tradeFromJson(p: any): PumpTradeEvent {
  return {
    signature: p.signature, slot: Number(p.slot), mint: p.mint, solAmountLamports: big(p.solAmountLamports), tokenAmount: big(p.tokenAmount), isBuy: !!p.isBuy,
    user: p.user, timestampSec: Number(p.timestampSec), virtualSolReserves: big(p.virtualSolReserves), virtualTokenReserves: big(p.virtualTokenReserves),
    realSolReserves: big(p.realSolReserves), realTokenReserves: big(p.realTokenReserves),
  };
}

/** S190: the price the window left the launch at (last trade at or before the release) and the highest trade price after it. */
function peakAfter(trades: RecordedEvent[], releasedAt: number): NonNullable<ReplayedLaunch['peak']> | null {
  let ref: number | null = null;
  let peak = -Infinity, peakAt = 0, lastAt = releasedAt;
  for (const ev of trades) {
    const p = tradePriceSol(tradeFromJson(ev.payload));
    if (p === null || !(p > 0)) continue;
    if (ev.ts <= releasedAt) { ref = p; continue; }
    if (ref === null) ref = p; // no trade before the release: the first one after it is the reference
    lastAt = ev.ts;
    if (p > peak) { peak = p; peakAt = ev.ts; }
  }
  if (ref === null || !(peak > 0) || lastAt <= releasedAt) return null;
  return { refPriceSol: ref, peakPriceSol: peak, peakMultiple: peak / ref, timeToPeakMs: peakAt - releasedAt, observedMs: lastAt - releasedAt };
}

function median(v: number[]): number | null {
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function analysePeaks(rows: ReplayedLaunch[]): PeakAnalysis {
  const peaks = rows.map((r) => r.peak).filter((p): p is NonNullable<ReplayedLaunch['peak']> => !!p);
  const min = (ms: number) => ms / 60_000;
  const buckets = PEAK_BUCKETS_MIN.map((b) => {
    const inB = peaks.filter((p) => min(p.timeToPeakMs) >= b.fromMin && min(p.timeToPeakMs) < b.toMin);
    return { label: b.label, launches: inB.length, medianPeakMultiple: median(inB.map((p) => p.peakMultiple)), peakAtLeast2x: inB.filter((p) => p.peakMultiple >= 2).length, peakAtLeast5x: inB.filter((p) => p.peakMultiple >= 5).length };
  });
  const cover = (m: number) => peaks.filter((p) => min(p.observedMs) >= m).length;
  return {
    basis: 'Reference price: the last recorded trade at or before the watch window release (about 2 minutes after launch at most). Peak: the highest recorded trade price after it, and when.',
    launches: peaks.length,
    coverage: { atLeast30Min: cover(30), atLeast60Min: cover(60), atLeast180Min: cover(180) },
    buckets,
    late: {
      peakAfter30MinAtLeast2x: peaks.filter((p) => min(p.timeToPeakMs) >= 30 && p.peakMultiple >= 2).length,
      ofLaunchesWithAtLeast60MinData: cover(60),
      peakAfter60MinAtLeast2x: peaks.filter((p) => min(p.timeToPeakMs) >= 60 && p.peakMultiple >= 2).length,
      ofLaunchesWithAtLeast180MinData: cover(180),
    },
    caveats: [
      'Descriptive only: it shows how often the best price came late, not that anyone could have bought and sold it.',
      'A launch can only show a peak inside the time it was recorded for (see the coverage counts); recordings made with the old 30-minute window cannot show a late spike at all.',
      'The peak is the single highest trade print, which one thin trade can set; slippage, liquidity and exits are not applied.',
    ],
  };
}

export function replayLaunch(launch: RecordedLaunch, funders: FunderFact[], solUsdFallback: number | null, optsIn: ReplayOptions = {}): ReplayedLaunch {
  const o = { ...REPLAY_DEFAULTS, ...optsIn };
  const minScore = optsIn.minScore ?? getConfluenceThreshold();
  const create = launch.events.find((e) => e.kind === 'CREATE');
  const trades = launch.events.filter((e) => e.kind === 'TRADE');
  const base: ReplayedLaunch = {
    mint: launch.mint, symbol: create?.payload?.symbol ?? '?', trades: trades.length, verdict: 'NO_TRADES', verdictReason: 'no trade recorded', releasedAfterMs: null, score: null,
    entered: false, noEntryReason: null, outcome: 'NO_ENTRY', entryPriceSol: null, exits: [], holdMs: null, netPnlSol: null, openValueSol: null,
  };
  if (!create || trades.length === 0) return { ...base, noEntryReason: 'nothing to replay' };

  const startTs = create.ts;
  const solUsd = Number(create.payload.solUsd) > 0 ? Number(create.payload.solUsd) : solUsdFallback;
  const stats = new OnChainPoolStats();
  const velocity = new CurveVelocityEvaluator();
  stats.track(launch.mint, {
    insiders: [create.payload.creator, create.payload.user],
    supplyRaw: create.payload.tokenTotalSupply !== undefined ? big(create.payload.tokenTotalSupply) : undefined,
    createPriceSol: Number(create.payload.initialPriceSol),
    realTokenReserves: create.payload.realTokenReserves !== undefined ? big(create.payload.realTokenReserves) : undefined,
  });

  let clock = startTs;
  const scoreAt = (now: number): number | null => {
    const m = stats.get(launch.mint, now);
    if (!m) return null;
    const metrics = velocity.getMetrics(launch.mint, now);
    const b = ConfluenceEngine.calculate({
      mint: launch.mint,
      priceChange5mPct: m.priceChange5mPct,
      liquidityUsd: solUsd === null ? null : m.realSolReserves * solUsd * 2,
      top10HoldersPct: m.top10HoldersPct,
      bondingCurveProgress: m.curveProgressPct,
      buys5m: m.buys5m, sells5m: m.sells5m,
      devHoldingPct: m.devHoldingPct,
      hasVerifiedSocialCall: false, socialCallCount: 0,
      curveVelocityMetrics: velocity.hasData(launch.mint) ? metrics : undefined,
    });
    return b.compositeScore;
  };
  const ww = new WatchWindow({ scoreOf: () => scoreAt(clock), publicFunders: [], minScore });
  ww.watch(launch.mint, create.payload.creator ?? null, startTs, [create.payload.user]);

  // funder facts the window had learned by the end of the launch, applied at their recorded time (earlier ones at the start)
  const endTs = trades[trades.length - 1].ts;
  const facts = funders.filter((f) => f.ts <= endTs).sort((a, b) => a.ts - b.ts);
  let fi = 0;
  const applyFacts = (upTo: number) => {
    while (fi < facts.length && facts[fi].ts <= upTo) {
      if (facts[fi].funder) ww.setFunder(facts[fi].wallet, facts[fi].funder as string, upTo); else ww.setNoFunder(facts[fi].wallet);
      fi++;
    }
  };

  let released: ReturnType<WatchWindow['evaluate']> = null;
  let releasedAt = 0;
  let lastTick = startTs;
  for (let idx = 0; idx < trades.length && !released; idx++) {
    const ev = trades[idx];
    // tick the window on its own schedule up to this trade
    while (lastTick + o.tickMs <= ev.ts && !released) {
      lastTick += o.tickMs;
      clock = lastTick;
      applyFacts(lastTick);
      const r = ww.evaluate(launch.mint, lastTick);
      if (r && r.state !== 'WATCHING') { released = r; releasedAt = lastTick; }
    }
    if (released) break;
    clock = ev.ts;
    applyFacts(ev.ts);
    const t = tradeFromJson(ev.payload);
    stats.record(t, ev.ts);
    velocity.recordTradeFlow(t.mint, Number(t.solAmountLamports) / 1e9, t.isBuy, ev.ts, t.slot);
    velocity.recordTransition(t.mint, t.slot, Number(t.realSolReserves) / 1e9, ev.ts);
    ww.onTrade(t, ev.ts);
    const v = ww.getVerdict(launch.mint);
    if (v && v.state !== 'WATCHING') { released = ww.evaluate(launch.mint, ev.ts); releasedAt = ev.ts; }
  }
  if (!released) {
    // the recording ended before the window gave a verdict: let it run to its own maximum on the data it has
    for (let t = lastTick; t <= startTs + 125_000 && !released; t += o.tickMs) {
      clock = t;
      applyFacts(t);
      const r = ww.evaluate(launch.mint, t);
      if (r && r.state !== 'WATCHING') { released = r; releasedAt = t; }
    }
  }
  if (!released) return { ...base, verdict: 'NO_TRADES', verdictReason: 'no verdict inside the recording', noEntryReason: 'still watching when the recording ended' };

  const result: ReplayedLaunch = { ...base, verdict: released.state, verdictReason: released.reason, releasedAfterMs: releasedAt - startTs, score: released.score ?? null, peak: peakAfter(trades, releasedAt) };
  if (released.state === 'DEAD') return { ...result, noEntryReason: `watch verdict DEAD: ${released.reason}` };
  if (released.state === 'READY' && !(released.score !== null && released.score !== undefined && isConfluencePassed(released.score, minScore))) {
    return { ...result, noEntryReason: `READY below the confluence gate (score ${released.score ?? 'n/a'} < ${minScore})` };
  }

  // entry: the first recorded trade at or after release + delay
  const entryAt = releasedAt + o.entryDelayMs;
  const after = trades.filter((e) => e.ts >= entryAt);
  if (after.length === 0) return { ...result, noEntryReason: 'no trade recorded after the release, so no price to buy at' };
  const entryTrade = tradeFromJson(after[0].payload);
  const entryPrice = tradePriceSol(entryTrade);
  if (entryPrice === null || !(entryPrice > 0)) return { ...result, noEntryReason: 'the entry trade carries no price' };
  const entryTs = after[0].ts;

  const fixed = 2 * (o.networkFeeSol + o.tipSol);
  const costBasis = o.orderSol; // SOL put in (the fee is inside it, as on the curve)
  let remaining = 1; // fraction of the position still held
  let proceeds = 0;
  let hwm = entryPrice, trail = 0, stage = 0;
  const exits: ReplayedLaunch['exits'] = [];
  let lastPrice = entryPrice, lastTs = entryTs;
  for (const ev of after.slice(1)) {
    const p = tradePriceSol(tradeFromJson(ev.payload));
    if (p === null || !(p > 0)) continue;
    lastPrice = p; lastTs = ev.ts;
    const d = ExitEngine.evaluate({ entryPriceSol: entryPrice, currentPriceSol: p, highWaterMarkSol: hwm, trailingStopSol: trail, exitStage: stage, entryTimestamp: entryTs, currentTimestamp: ev.ts });
    hwm = d.newHighWaterMarkSol; trail = d.newTrailingStopSol;
    if (!d.shouldExit) continue;
    // like closePosition: the percentage is of what is still held (33% of all at the first step, 33% of the remaining at the second)
    const sellFrac = remaining * Math.min(100, Math.max(1, d.sellPercentage)) / 100;
    const gross = sellFrac * costBasis * (p / entryPrice);
    proceeds += gross * (1 - o.feePct / 100);
    remaining -= sellFrac;
    stage = d.newExitStage;
    exits.push({ reason: d.reason, sellPct: d.sellPercentage, priceSol: p, afterMs: ev.ts - entryTs });
    if (remaining <= 1e-9 || d.sellPercentage >= 100) { remaining = 0; break; }
  }
  const entered = { ...result, entered: true, entryPriceSol: entryPrice, exits, noEntryReason: null };
  if (remaining > 1e-9) {
    const openValue = remaining * costBasis * (lastPrice / entryPrice) * (1 - o.feePct / 100);
    return { ...entered, outcome: 'OPEN_AT_END', holdMs: lastTs - entryTs, openValueSol: openValue, netPnlSol: null };
  }
  return { ...entered, outcome: 'CLOSED', holdMs: lastTs - entryTs, netPnlSol: proceeds - costBasis - fixed, openValueSol: null };
}

export function replayLaunches(launches: RecordedLaunch[], funders: FunderFact[], solUsdFallback: number | null, opts: ReplayOptions = {}): ReplayReport {
  const minScore = opts.minScore ?? getConfluenceThreshold();
  const rows = launches.map((l) => replayLaunch(l, funders, solUsdFallback, { ...opts, minScore }));
  return buildReplayReport(rows, opts, minScore);
}

/**
 * S189: the same replay, time-sliced. The sync version holds the event loop for the whole run (about 7 s for 3,250 launches), which would
 * stall the live feed, the watch window and the auto controller while the Backtest screen is open. This one hands the event loop back after
 * every `sliceMs` of work, and returns exactly the report replayLaunches would.
 */
export async function replayLaunchesAsync(launches: RecordedLaunch[], funders: FunderFact[], solUsdFallback: number | null, opts: ReplayOptions = {}, sliceMs = 20): Promise<ReplayReport> {
  const minScore = opts.minScore ?? getConfluenceThreshold();
  const rows: ReplayedLaunch[] = [];
  let sliceStart = Date.now();
  for (const l of launches) {
    rows.push(replayLaunch(l, funders, solUsdFallback, { ...opts, minScore }));
    if (Date.now() - sliceStart >= sliceMs) {
      await new Promise<void>((r) => setImmediate(r));
      sliceStart = Date.now();
    }
  }
  return buildReplayReport(rows, opts, minScore);
}

function buildReplayReport(rows: ReplayedLaunch[], opts: ReplayOptions, minScore: number): ReplayReport {
  const closed = rows.filter((r) => r.outcome === 'CLOSED');
  const wins = closed.filter((r) => (r.netPnlSol ?? 0) > 0).length;
  const released: Record<string, number> = {};
  const exitReasons: Record<string, number> = {};
  for (const r of rows) {
    released[r.verdict] = (released[r.verdict] ?? 0) + 1;
    for (const e of r.exits) exitReasons[e.reason] = (exitReasons[e.reason] ?? 0) + 1;
  }
  return {
    rules: [
      'Watch window verdict (real WatchWindow: 20 s minimum, 120 s maximum, HOT / READY / DEAD)',
      `READY needs a confluence score of at least ${minScore} (real ConfluenceEngine over the replayed pool stats)`,
      'Exits: real ExitEngine (hard stop -20%, trailing stop, take-profit ladder: sell 33% of the holding at +30%, then 33% of what is left at +60%, stale exit at 30 min)',
    ],
    notReplayed: [
      'Eligibility filter (mint / freeze authority, holder concentration): not recorded',
      'Risk limits, capital sizing and the one-position cap',
      'Slippage and price impact beyond the recorded trade price',
      'Creator wallet history (the live score may add points a replay cannot)',
    ],
    assumptions: { ...REPLAY_DEFAULTS, ...opts, minScore },
    summary: {
      launches: rows.length, released, entries: rows.filter((r) => r.entered).length, closed: closed.length, openAtEnd: rows.filter((r) => r.outcome === 'OPEN_AT_END').length,
      wins, losses: closed.length - wins, winRate: closed.length ? wins / closed.length : null,
      netPnlSol: closed.length ? closed.reduce((a, r) => a + (r.netPnlSol ?? 0), 0) : null,
      avgHoldMs: closed.length ? closed.reduce((a, r) => a + (r.holdMs ?? 0), 0) / closed.length : null,
      exitReasons,
    },
    launches: rows,
    peakAnalysis: analysePeaks(rows),
  };
}
