import { WatchWindow, readyGate, READY_MIN_SIGNALS, WATCH_MAX_MS, type WatchState } from '../signals/watchWindow';
import { getConfluenceThreshold } from '../signals/confluenceThreshold';
import { ConfluenceEngine, isConfluencePassed } from '../signals/confluenceEngine';
import { CurveVelocityEvaluator } from '../signals/curveVelocityEvaluator';
import { OnChainPoolStats, tradePriceSol } from '../market/poolStats';
import type { PumpTradeEvent } from '../solana/pumpFeedListener';
import { simulatePath, priceEntryParts, px, BASE_FEE_SOL, PRIORITY_BUY_SOL, PRIORITY_SELL_SOL, PUMP_FEE_SDK_PCT, type CostCase, type TradeRow } from './costModel';

/**
 * Replays the auto trader's own rules over recorded launches: the real WatchWindow (verdict at the same 20 s / 120 s timing), the real
 * ConfluenceEngine (score at or above the buy threshold for a READY release; default 70, replayable at any value), and the real ExitEngine (stop, trailing stop, take-profit ladder, stale exit).
 * 5A: the fill, the exits and the money come from the one cost and latency model the offline studies use (./costModel.ts): the buy lands
 * `entryDelayMs` after the release and fills at the curve state then; the exit engine is polled every 3 s (also between prints, so the stale
 * exit fires on quiet coins) and a sell lands `exitDelayMs` after its decision, at the curve state then; the pump.fun fee is charged on the
 * buy (net into the curve = order / (1 + fee)) and on every sell, the order's own impact on the curve is applied, and every transaction
 * sent pays the network fee, the priority fee and the tip. Closed (realized) results and positions still open at the end are reported apart.
 *
 * Not replayed: see `notReplayed` in the report, split by the direction the gap moves the result.
 */
export const REPLAY_DEFAULTS = {
  orderSol: 0.005,
  /** Delay between the watch window's release and the buy landing. An ASSUMPTION; the curve state at that moment is the fill. */
  entryDelayMs: 1_500,
  /** 5A: delay between an exit decision and the sell landing. An ASSUMPTION until the devnet sell-latency measurement replaces it. */
  exitDelayMs: 1_500,
  /** pump.fun fee, % on each side: the SDK default 0.95% protocol + 0.30% creator (the live quote reads the real tier). */
  feePct: PUMP_FEE_SDK_PCT,
  /** per transaction sent: base fee, priority fee (buy and sell compute limits differ) and tip */
  networkFeeSol: BASE_FEE_SOL,
  priorityBuySol: PRIORITY_BUY_SOL,
  prioritySellSol: PRIORITY_SELL_SOL,
  /** charged on every transaction, the conservative side: a straight-to-RPC send (Jito unset) pays none, so pass 0 to price that path */
  tipSol: 0.0001,
  /** How often the window is ticked while replaying (the live loop ticks every 2 s). */
  tickMs: 2_000,
  /**
   * 5C (R1-105): executeSnipe refuses a launch whose creator and create signer hold more than this % of the supply (0 turns it off, as live).
   * 5 is the sniper config's default (memecoinAggregator.ts `maxDevHoldingPct`); /api/backtest/replay passes the setting in force.
   */
  maxDevHoldingPct: 5,
};
/**
 * `minScore`: the confluence buy threshold to replay at (S187 what-if). Default: the threshold in force.
 * P4.3: `readyGate` (default true) applies the controller's READY rule (concentration and READY_MIN_SIGNALS strong signals); `curveCap` (default true)
 * gives the window the replayed curve progress, so a launch past APEX_MAX_CURVE_PROGRESS_PCT is released DEAD CURVE_TOO_FAR as live. A study turns
 * `readyGate` off to price the READY entries the rule refuses (scripts/recorder_backtest/ready_strength.ts).
 */
export type ReplayOptions = Partial<typeof REPLAY_DEFAULTS> & {
  minScore?: number; readyGate?: boolean; curveCap?: boolean;
  /** 5A: price the order's own impact on the curve (default true); false prices at the recorded spot price */
  impact?: boolean;
  /**
   * 5A: how long after its create each launch was recorded (the recorder window). With it, a sell or a stale decision after the last print is
   * priced at that print (no print: the curve did not move) up to create + this; without it nothing is assumed past the last recorded print.
   */
  recordedForMs?: number;
  /**
   * 5A: the recorder's per-launch trade cap. A launch with this many recorded trades may have been cut off, so `recordedForMs` does not
   * extend its coverage (5B's END rows, as `RecordedLaunch.endTs`, say so exactly).
   */
  recordedMaxTrades?: number;
  /**
   * 5C: when the recording was read (the route passes now). A launch with no END row may still be recording, so `recordedForMs` never extends
   * its coverage past this moment: a launch created 5 minutes ago was not recorded quiet for 35.
   */
  readAtTs?: number;
};

/** 5A: the replay's costs as a costModel cost case. */
export function replayCostCase(o: Pick<typeof REPLAY_DEFAULTS, 'feePct' | 'networkFeeSol' | 'priorityBuySol' | 'prioritySellSol' | 'tipSol'> & { impact?: boolean }): CostCase {
  const buy = o.networkFeeSol + o.priorityBuySol + o.tipSol, sell = o.networkFeeSol + o.prioritySellSol + o.tipSol;
  return {
    name: 'replay', note: 'the in-app replay: fee each side, impact, base + priority + tip per transaction', buyFeePct: o.feePct, sellFeePct: o.feePct, impact: o.impact !== false,
    fixedBuy: buy, fixedSell: sell, fixedOnce: 0, failCostBuy: 0, failCostSell: 0, pFailBuy: 0, pFailSell: 0, retryDelayMs: 3_000,
  };
}

/** 5A: a recorded TRADE as a costModel row ([ts, isBuy, sol, tokens, user, virtualSol, virtualTokens, signature]); null without a price. */
export function tradeRow(ev: RecordedEvent): TradeRow | null {
  const p = ev.payload;
  const vS = Number(p.virtualSolReserves), vT = Number(p.virtualTokenReserves);
  if (!(vS > 0) || !(vT > 0)) return null;
  return [ev.ts, !!p.isBuy, Number(p.solAmountLamports) / 1e9, Number(p.tokenAmount) / 1e6, String(p.user ?? ''), vS, vT, String(p.signature ?? '')];
}

export interface RecordedEvent { ts: number; kind: 'CREATE' | 'TRADE'; payload: any }
/**
 * `endTs` (optional): when the recording of this launch is known to have ended (an END row). When present it decides the coverage, not ReplayOptions.recordedForMs.
 * `endReason` (5B): the END row's reason, TRADE_CAP, WINDOW or CURVE_COMPLETE.
 */
export interface RecordedLaunch { mint: string; events: RecordedEvent[]; endTs?: number; endReason?: string }

/**
 * 5C (R1-106): how the recording of a launch ended, from its END row. COMPLETE: recorded for the whole window. TRUNCATED: the recorder's
 * trade cap cut it (trades after it are missing). GRADUATED: the curve completed (nothing after graduation is recorded). UNRESOLVED: no END
 * row, so still recording, stopped with the process, or recorded before END rows existed; its end is not known.
 */
export type RecordingEnd = 'COMPLETE' | 'TRUNCATED' | 'GRADUATED' | 'UNRESOLVED';
export const RECORDING_ENDS: RecordingEnd[] = ['COMPLETE', 'TRUNCATED', 'GRADUATED', 'UNRESOLVED'];
export function recordingEnd(l: Pick<RecordedLaunch, 'endTs' | 'endReason'>): RecordingEnd {
  if (l.endTs === undefined) return 'UNRESOLVED';
  if (l.endReason === 'WINDOW') return 'COMPLETE';
  if (l.endReason === 'TRADE_CAP') return 'TRUNCATED';
  if (l.endReason === 'CURVE_COMPLETE') return 'GRADUATED';
  return 'UNRESOLVED'; // an END row with a reason this code does not know
}
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
  /** net SOL after every fee and transaction cost, CLOSED positions only (realized); null for OPEN_AT_END */
  netPnlSol: number | null;
  /** OPEN_AT_END: the part still held, valued at the last recorded price after the sell fee and its own sell transaction */
  openValueSol: number | null;
  /** 5A: OPEN_AT_END: what the sells that did land brought in (after the sell fee) */
  realizedProceedsSol?: number | null;
  /** 5A: OPEN_AT_END: the whole position marked at the end: realizedProceedsSol + openValueSol - order - every transaction cost. Never mixed into netPnlSol. */
  openNetPnlSol?: number | null;
  /** 5A: transactions the position sent (1 buy + the sells, + 1 for the open mark) */
  transactions?: number | null;
  /** S190: after the watch window's release, the highest recorded trade price against the price the window left it at. Null: no released launch / no later trade. */
  peak?: { refPriceSol: number; peakPriceSol: number; peakMultiple: number; timeToPeakMs: number; observedMs: number } | null;
  /** P4.3: the release's strong-signal count and whether concentration passed. Null without a release. */
  passingSignals?: number | null;
  concentrationPass?: boolean | null;
  /** 5C (R1-106): how the launch's recording ended (see RecordingEnd) */
  recording?: RecordingEnd;
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
  /** the question behind it: how often does the best price come late, and is it a real move. Each count is out of the launches in its "of" (5C). */
  late: { peakAfter30MinAtLeast2x: number; ofLaunchesWithAtLeast60MinData: number; peakAfter60MinAtLeast2x: number; ofLaunchesWithAtLeast180MinData: number };
  caveats: string[];
}

export interface ReplayReport {
  rules: string[];
  /** 5A: what is not replayed, by the direction it moves the result */
  notReplayed: string[];
  notReplayedByDirection: { optimistic: string[]; pessimistic: string[]; unknown: string[] };
  assumptions: Record<string, number>;
  summary: {
    launches: number; released: Record<string, number>; entries: number; closed: number; openAtEnd: number;
    wins: number; losses: number; winRate: number | null; netPnlSol: number | null; avgHoldMs: number | null; exitReasons: Record<string, number>;
    /** 5A: the OPEN_AT_END positions marked at the last recorded price with their exit cost charged; reported apart from the realized netPnlSol */
    openMarkNetPnlSol: number | null;
    /** 5C (R1-106): the same figures for each way a recording ended, so truncated, graduated and unresolved launches can be read apart */
    byRecording: Record<RecordingEnd, { launches: number; entries: number; closed: number; openAtEnd: number; netPnlSol: number | null; openMarkNetPnlSol: number | null }>;
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
      // 5C (R1-108): the count and its "of" are the same launches: only those recorded long enough to be in the denominator
      peakAfter30MinAtLeast2x: peaks.filter((p) => min(p.observedMs) >= 60 && min(p.timeToPeakMs) >= 30 && p.peakMultiple >= 2).length,
      ofLaunchesWithAtLeast60MinData: cover(60),
      peakAfter60MinAtLeast2x: peaks.filter((p) => min(p.observedMs) >= 180 && min(p.timeToPeakMs) >= 60 && p.peakMultiple >= 2).length,
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
    recording: recordingEnd(launch),
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
      // 5C (R1-61): the creator is known, its wallet-history report is not recorded, so it scores as live does without one (0, P4.1).
      // null keeps the running app's creator cache out of the replay.
      creatorAddress: create.payload.creator || undefined, creatorRiskReport: null,
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
  const ww = new WatchWindow({
    scoreOf: () => scoreAt(clock), publicFunders: [], minScore,
    progressOf: optsIn.curveCap === false ? undefined : () => stats.get(launch.mint, clock)?.curveProgressPct ?? null,
  });
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
    // 5A (R1-104): the window's maximum runs from the first trade, so the fallback does too
    // 5C: from the tick after the last one, which ran before the trades recorded since; evaluating that tick again would let it see them
    for (let t = lastTick + o.tickMs; t <= trades[0].ts + WATCH_MAX_MS + o.tickMs && !released; t += o.tickMs) {
      clock = t;
      applyFacts(t);
      const r = ww.evaluate(launch.mint, t);
      if (r && r.state !== 'WATCHING') { released = r; releasedAt = t; }
    }
  }
  if (!released) return { ...base, verdict: 'NO_TRADES', verdictReason: 'no verdict inside the recording', noEntryReason: 'still watching when the recording ended' };

  const result: ReplayedLaunch = {
    ...base, verdict: released.state, verdictReason: released.reason, releasedAfterMs: releasedAt - startTs, score: released.score ?? null, peak: peakAfter(trades, releasedAt),
    passingSignals: released.metrics.passingSignals, concentrationPass: released.metrics.signals.concentration?.pass ?? null,
  };
  if (released.state === 'DEAD') return { ...result, noEntryReason: `watch verdict DEAD: ${released.reason}` };
  if (released.state === 'READY' && optsIn.readyGate !== false) {
    const g = readyGate(released.metrics);
    if (!g.pass) return { ...result, noEntryReason: g.reason };
  }
  // 5C (R1-105): the gates executeSnipe runs when the controller buys, in its order: dev holding, then the confluence score taken again at
  // that moment against the buy threshold (HOT and READY alike; the running app always enforces it). The replay decides at the release, so
  // the re-score reads the state the release saw; a HOT release already needed that score, a READY one did not.
  const atDecision = stats.get(launch.mint, releasedAt);
  const devPct = atDecision?.devHoldingPct ?? null;
  if (o.maxDevHoldingPct > 0 && devPct !== null && devPct > o.maxDevHoldingPct) {
    return { ...result, noEntryReason: `DEV_HOLDING: creator holds ${devPct.toFixed(2)}% (limit ${o.maxDevHoldingPct}%)` };
  }
  clock = releasedAt;
  const execScore = scoreAt(releasedAt);
  if (!(execScore !== null && isConfluencePassed(execScore, minScore))) {
    return { ...result, noEntryReason: `${released.state} below the confluence gate at the buy (score ${execScore ?? 'n/a'} < ${minScore})` };
  }

  // 5A: entry, exits and money from the shared cost and latency model
  const rows = trades.map(tradeRow).filter((r): r is TradeRow => r !== null);
  if (rows.length === 0) return { ...result, noEntryReason: 'no recorded trade carries a price, so no price to buy at' };
  const lastEventTs = launch.events[launch.events.length - 1]?.ts ?? rows[rows.length - 1][0];
  const capped = o.recordedMaxTrades !== undefined && trades.length >= o.recordedMaxTrades;
  const window = launch.endTs !== undefined ? launch.endTs : (o.recordedForMs !== undefined && !capped ? Math.min(startTs + o.recordedForMs, o.readAtTs ?? Infinity) : -Infinity);
  const coveredUntilTs = Math.max(lastEventTs, window);
  const path = simulatePath(rows, releasedAt, { entryMs: o.entryDelayMs, exitMs: o.exitDelayMs }, null, { coveredUntilTs });
  if (!path) return { ...result, noEntryReason: 'the entry trade carries no price' };
  const money = priceEntryParts(rows, path, o.orderSol, replayCostCase({ ...o, impact: optsIn.impact }));
  const exits: ReplayedLaunch['exits'] = path.sells.map((x) => ({ reason: x.reason, sellPct: Math.round(x.frac * 100), priceSol: px(rows[x.fillIdx]), afterMs: (x.fillTs ?? rows[x.fillIdx][0]) - path.entryTs }));
  const entered = { ...result, entered: true, entryPriceSol: px(rows[path.entryIdx]), exits, noEntryReason: null, transactions: money.transactions };
  if (path.open) {
    const lastTs = Math.max(rows[rows.length - 1][0], path.entryTs);
    return { ...entered, outcome: 'OPEN_AT_END', holdMs: lastTs - path.entryTs, netPnlSol: null, openValueSol: money.openMarkSol, realizedProceedsSol: money.realizedProceedsSol, openNetPnlSol: money.netSol };
  }
  return { ...entered, outcome: 'CLOSED', holdMs: exits[exits.length - 1].afterMs, netPnlSol: money.netSol, openValueSol: null, realizedProceedsSol: null, openNetPnlSol: null };
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

/** 5A (R1-111): the gaps, by the direction each one moves the replayed result. */
export const NOT_REPLAYED = {
  optimistic: [
    'Failed or reverted transactions: every buy and sell lands (no revert on slippage, no failed send)',
    'Risk limits, capital sizing and the one-position cap: every release is bought',
    'Mint and freeze authority: not recorded (live reads them from the curve at the buy)',
    'The coordinator\'s eligibility filter reads holder concentration from an RPC holder query; the replay applies only the dev-holding gate, from the recorded trades',
  ],
  pessimistic: [
    'The tip is charged on every transaction; a straight-to-RPC send (Jito unset) pays none',
    'The order\'s impact is priced against recorded reserves that do not include the replayed buy, so a sell is priced as if the buy had not moved the curve',
  ],
  unknown: [
    'Funder facts the live window would learn but the recording lacks (corpus replays have none); the direction was not measured',
    'Entry and exit latency are fixed assumptions (entry and exit delay), not the measured distribution',
    'The fee rate is the SDK default (0.95% + 0.30%); the live quote reads the real tier',
    'Creator wallet history is not recorded: every creator scores 0 of its 5 points, as live does without a report; live adds up to 5 for an established wallet, so the replay can refuse a launch live buys',
    'Positions still open when the data ends are marked at the last recorded price, which may be the graduation top or a dead curve',
  ],
};

function buildReplayReport(rows: ReplayedLaunch[], opts: ReplayOptions, minScore: number): ReplayReport {
  const closed = rows.filter((r) => r.outcome === 'CLOSED');
  const open = rows.filter((r) => r.outcome === 'OPEN_AT_END');
  const wins = closed.filter((r) => (r.netPnlSol ?? 0) > 0).length;
  const released: Record<string, number> = {};
  const exitReasons: Record<string, number> = {};
  const devLimit = opts.maxDevHoldingPct ?? REPLAY_DEFAULTS.maxDevHoldingPct;
  for (const r of rows) {
    released[r.verdict] = (released[r.verdict] ?? 0) + 1;
    for (const e of r.exits) exitReasons[e.reason] = (exitReasons[e.reason] ?? 0) + 1;
  }
  return {
    rules: [
      'Watch window verdict (real WatchWindow: 20 s minimum, 120 s maximum, HOT / READY / DEAD)',
      `READY needs a confluence score of at least ${minScore} (real ConfluenceEngine over the replayed pool stats)`,
      `At the buy, as executeSnipe: ${devLimit > 0 ? `the creator and create signer hold at most ${devLimit}% of the supply, and ` : ''}the confluence score is taken again against the threshold (HOT and READY)`,
      `READY also needs concentration passing and at least ${READY_MIN_SIGNALS} strong signals, as the auto controller asks (P4.3); a curve past the progress cap (default 60% of the tokens sold) is DEAD CURVE_TOO_FAR`,
      'Exits: real ExitEngine polled every 3 s, also between prints (hard stop -20%, trailing stop, take-profit ladder: sell 33% of the holding at +30%, then 33% of what is left at +60%, stale exit at 30 min)',
      'Fills: the buy lands the entry delay after the release and each sell the exit delay after its decision, at the curve state then, with the order\'s own impact on the curve',
      'Costs: the pump.fun fee on the buy and on every sell, and base + priority fee + tip on every transaction sent; positions still open at the end are marked at the last price with their sell cost and reported apart',
    ],
    notReplayed: [...NOT_REPLAYED.optimistic, ...NOT_REPLAYED.pessimistic, ...NOT_REPLAYED.unknown],
    notReplayedByDirection: NOT_REPLAYED,
    assumptions: (({ readyGate: _g, curveCap: _c, impact: _i, ...numeric }) => ({ ...REPLAY_DEFAULTS, ...numeric, minScore, impact: opts.impact === false ? 0 : 1 }))(opts) as Record<string, number>,
    summary: {
      launches: rows.length, released, entries: rows.filter((r) => r.entered).length, closed: closed.length, openAtEnd: open.length,
      wins, losses: closed.length - wins, winRate: closed.length ? wins / closed.length : null,
      netPnlSol: closed.length ? closed.reduce((a, r) => a + (r.netPnlSol ?? 0), 0) : null,
      avgHoldMs: closed.length ? closed.reduce((a, r) => a + (r.holdMs ?? 0), 0) / closed.length : null,
      exitReasons,
      openMarkNetPnlSol: open.length ? open.reduce((a, r) => a + (r.openNetPnlSol ?? 0), 0) : null,
      byRecording: Object.fromEntries(RECORDING_ENDS.map((k) => {
        const of = rows.filter((r) => (r.recording ?? 'UNRESOLVED') === k);
        const c = of.filter((r) => r.outcome === 'CLOSED'), op = of.filter((r) => r.outcome === 'OPEN_AT_END');
        return [k, {
          launches: of.length, entries: of.filter((r) => r.entered).length, closed: c.length, openAtEnd: op.length,
          netPnlSol: c.length ? c.reduce((a, r) => a + (r.netPnlSol ?? 0), 0) : null,
          openMarkNetPnlSol: op.length ? op.reduce((a, r) => a + (r.openNetPnlSol ?? 0), 0) : null,
        }];
      })) as ReplayReport['summary']['byRecording'],
    },
    launches: rows,
    peakAnalysis: analysePeaks(rows),
  };
}
