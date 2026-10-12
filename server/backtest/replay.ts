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
}

const big = (v: unknown): bigint => BigInt(String(v ?? '0'));
export function tradeFromJson(p: any): PumpTradeEvent {
  return {
    signature: p.signature, slot: Number(p.slot), mint: p.mint, solAmountLamports: big(p.solAmountLamports), tokenAmount: big(p.tokenAmount), isBuy: !!p.isBuy,
    user: p.user, timestampSec: Number(p.timestampSec), virtualSolReserves: big(p.virtualSolReserves), virtualTokenReserves: big(p.virtualTokenReserves),
    realSolReserves: big(p.realSolReserves), realTokenReserves: big(p.realTokenReserves),
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
      if (facts[fi].funder) ww.setFunder(facts[fi].wallet, facts[fi].funder as string); else ww.setNoFunder(facts[fi].wallet);
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

  const result: ReplayedLaunch = { ...base, verdict: released.state, verdictReason: released.reason, releasedAfterMs: releasedAt - startTs, score: released.score ?? null };
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
  };
}
