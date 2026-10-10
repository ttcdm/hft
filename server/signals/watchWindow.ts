import { EventEmitter } from 'events';
import type { PumpTradeEvent } from '../solana/pumpFeedListener';

/**
 * G2: the watch window. A new token is held for 20-120s from its FIRST trade while real TradeEvents build up the
 * evidence a snapshot cannot give: who is buying, how concentrated it is, whether the creator is selling.
 *
 * Pure bookkeeping over TradeEvents with an injected clock, so every metric is replayable from fixtures.
 * Nothing here trades: a release is information for the auto controller and the board.
 *
 * Release states:
 *   DEAD   cumulative net inflow negative once the minimum hold has passed, or ANY creator sell (instant)
 *   HOT    minimum hold passed, >= 3 measured signals strong, and the confluence score is >= 70
 *   READY  the full window elapsed without a dead or hot verdict
 */
export const WATCH_MAX_CANDIDATES = 10;
export const WATCH_MIN_MS = 20_000;
export const WATCH_MAX_MS = 120_000;
export const WATCH_BUCKET_MS = 10_000;
export const HOT_MIN_VELOCITY_SOL_PER_MIN = 1.5;
export const HOT_MIN_UNIQUE_BUYERS = 25;
export const HOT_MAX_LARGEST_BUYER_SHARE = 0.15;
export const HOT_MIN_SIGNALS = 3;
export const HOT_MIN_SCORE = 70;
const CREATOR_CLUSTER = 'cluster:creator';

export type WatchState = 'WATCHING' | 'HOT' | 'READY' | 'DEAD';

export interface WatchSignals {
  /** Net inflow over the last 30s, scaled to SOL/min, and whether it beats the 30s before it. null before 20s of data. */
  velocity: { solPerMin: number; rising: boolean; pass: boolean } | null;
  /** De-clustered unique buyers; only passes when every buyer's funder is known (otherwise the count may be inflated). */
  buyers: { count: number; funderCoverage: number; pass: boolean } | null;
  /** Largest cluster's share of buy volume. */
  concentration: { share: number; pass: boolean } | null;
  /** Buys outnumber sells. */
  flow: { buyCount: number; sellCount: number; pass: boolean } | null;
}

export interface WatchMetrics {
  mint: string;
  creator: string | null;
  firstTradeAt: number | null;
  elapsedMs: number;
  tradeCount: number;
  /** Net SOL inflow (buys - sells) per 10s bucket from the first trade. */
  netInflowPer10s: number[];
  cumulativeNetInflowSol: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  rawUniqueBuyers: number;
  /** Buyers after merging wallets with one funder, and everything the creator funded, into one. */
  uniqueBuyers: number;
  /** Share of distinct buyers whose funder is known (fixtures or lookup). 0 when nothing is known. */
  funderCoverage: number;
  buyCount: number;
  sellCount: number;
  /** buys / sells; null with no sells (never Infinity). */
  buySellRatio: number | null;
  /** Largest cluster's share of buy volume; null with no buys. */
  largestBuyerShare: number | null;
  creatorSold: boolean;
  signals: WatchSignals;
  passingSignals: number;
}

export interface WatchResult {
  state: WatchState;
  reason: string;
  metrics: WatchMetrics;
  score: number | null;
  releasedAt: number | null;
}

interface Candidate {
  mint: string;
  creator: string | null;
  /** Wallets whose sells mean the dev is out: the creator and, when different, the signer of the create (R14). */
  insiders: Set<string>;
  registeredAt: number;
  firstTradeAt: number | null;
  /** Net SOL by 10s bucket index. */
  buckets: number[];
  buyVolumeByWallet: Map<string, number>;
  buyCount: number;
  sellCount: number;
  sellVolumeSol: number;
  tradeCount: number;
  creatorSold: boolean;
  /** Trade times (ms) with signed SOL, for the velocity windows. */
  flow: Array<{ at: number; sol: number }>;
  seen: Set<string>;
}

export interface WatchWindowOptions {
  maxCandidates?: number;
  minMs?: number;
  maxMs?: number;
  /** Funder of a wallet (first incoming transfer), or null when unknown. Fixtures in tests; no network lookup is built in. */
  funderOf?: (wallet: string) => string | null | undefined;
  /** Confluence score for a mint, or null when it cannot be scored. HOT needs a score of at least 70. */
  scoreOf?: (mint: string) => number | null | undefined;
}

export class WatchWindow extends EventEmitter {
  private active = new Map<string, Candidate>();
  private released = new Map<string, WatchResult>();
  private opts: Required<Pick<WatchWindowOptions, 'maxCandidates' | 'minMs' | 'maxMs'>> & Pick<WatchWindowOptions, 'funderOf' | 'scoreOf'>;
  private funders = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: WatchWindowOptions = {}) {
    super();
    this.opts = {
      maxCandidates: opts.maxCandidates ?? WATCH_MAX_CANDIDATES,
      minMs: opts.minMs ?? WATCH_MIN_MS,
      maxMs: opts.maxMs ?? WATCH_MAX_MS,
      funderOf: opts.funderOf,
      scoreOf: opts.scoreOf,
    };
  }

  /** Record a wallet's funder (the sender of its earliest incoming transfer). */
  public setFunder(wallet: string, funder: string): void {
    this.funders.set(wallet, funder);
  }

  public setScoreFn(fn: WatchWindowOptions['scoreOf']): void {
    this.opts.scoreOf = fn;
  }

  private funderFor(wallet: string): string | null {
    return this.funders.get(wallet) ?? this.opts.funderOf?.(wallet) ?? null;
  }

  /** Start watching a mint. False when the window is full or the mint is already watched/released. */
  public watch(mint: string, creator: string | null, now = Date.now(), alsoInsiders: Array<string | undefined> = []): boolean {
    if (this.active.has(mint) || this.released.has(mint)) return false;
    if (this.active.size >= this.opts.maxCandidates) return false;
    this.active.set(mint, {
      mint, creator, insiders: new Set([creator, ...alsoInsiders].filter((w): w is string => !!w)), registeredAt: now, firstTradeAt: null, buckets: [], buyVolumeByWallet: new Map(),
      buyCount: 0, sellCount: 0, sellVolumeSol: 0, tradeCount: 0, creatorSold: false, flow: [], seen: new Set(),
    });
    return true;
  }

  public isWatching(mint: string): boolean {
    return this.active.has(mint);
  }

  /** Feed one decoded TradeEvent. `at` is when it was seen (ms). Duplicate signatures are ignored. */
  public onTrade(trade: PumpTradeEvent, at = Date.now()): void {
    const c = this.active.get(trade.mint);
    if (!c) return;
    const key = `${trade.signature}:${trade.user}:${trade.isBuy ? 'b' : 's'}`;
    if (c.seen.has(key)) return;
    c.seen.add(key);

    const sol = Number(trade.solAmountLamports) / 1e9;
    if (c.firstTradeAt === null) c.firstTradeAt = at;
    c.tradeCount++;
    const idx = Math.max(0, Math.floor((at - c.firstTradeAt) / WATCH_BUCKET_MS));
    while (c.buckets.length <= idx) c.buckets.push(0);
    c.buckets[idx] += trade.isBuy ? sol : -sol;
    c.flow.push({ at, sol: trade.isBuy ? sol : -sol });

    if (trade.isBuy) {
      c.buyCount++;
      c.buyVolumeByWallet.set(trade.user, (c.buyVolumeByWallet.get(trade.user) ?? 0) + sol);
    } else {
      c.sellCount++;
      c.sellVolumeSol += sol;
      if (c.insiders.has(trade.user) && !c.creatorSold) {
        c.creatorSold = true;
        this.release(c, 'DEAD', 'CREATOR_SOLD: the creator sold, instant reject', at);
      }
    }
  }

  private clusterOf(c: Candidate, wallet: string): string {
    if (c.insiders.has(wallet)) return CREATOR_CLUSTER;
    const f = this.funderFor(wallet);
    if (!f) return `wallet:${wallet}`;
    if (f && c.insiders.has(f)) return CREATOR_CLUSTER;
    return `funder:${f}`;
  }

  public computeMetrics(c: Candidate, now: number): WatchMetrics {
    const first = c.firstTradeAt;
    const elapsedMs = first === null ? 0 : Math.max(0, now - first);
    const buyVolume = [...c.buyVolumeByWallet.values()].reduce((a, b) => a + b, 0);
    const cumulative = c.buckets.reduce((a, b) => a + b, 0);

    // A funder that is itself a buyer shares its cluster with the wallets it funded.
    const clusters = new Map<string, number>();
    let known = 0;
    for (const [wallet, vol] of c.buyVolumeByWallet) {
      const k = this.clusterOf(c, wallet);
      clusters.set(k, (clusters.get(k) ?? 0) + vol);
      if (this.funderFor(wallet) || c.insiders.has(wallet)) known++;
    }
    // Merge a buyer's own cluster into the cluster of wallets it funded
    for (const wallet of c.buyVolumeByWallet.keys()) {
      const own = `wallet:${wallet}`;
      const funded = `funder:${wallet}`;
      if (clusters.has(own) && clusters.has(funded)) {
        clusters.set(funded, clusters.get(funded)! + clusters.get(own)!);
        clusters.delete(own);
      }
    }
    const rawUnique = c.buyVolumeByWallet.size;
    const funderCoverage = rawUnique === 0 ? 0 : known / rawUnique;
    const largestShare = buyVolume > 0 ? Math.max(...clusters.values()) / buyVolume : null;

    let velocity: WatchSignals['velocity'] = null;
    if (first !== null && elapsedMs >= this.opts.minMs) {
      const now30 = c.flow.filter((f) => f.at > now - 30_000 && f.at <= now).reduce((a, f) => a + f.sol, 0);
      const prev30 = c.flow.filter((f) => f.at > now - 60_000 && f.at <= now - 30_000).reduce((a, f) => a + f.sol, 0);
      const solPerMin = now30 * 2;
      const rising = now30 > prev30;
      velocity = { solPerMin, rising, pass: solPerMin >= HOT_MIN_VELOCITY_SOL_PER_MIN && rising };
    }
    const uniqueBuyers = clusters.size;
    const signals: WatchSignals = {
      velocity,
      buyers: rawUnique === 0 ? null : { count: uniqueBuyers, funderCoverage, pass: uniqueBuyers >= HOT_MIN_UNIQUE_BUYERS && funderCoverage === 1 },
      concentration: largestShare === null ? null : { share: largestShare, pass: largestShare < HOT_MAX_LARGEST_BUYER_SHARE },
      flow: c.tradeCount === 0 ? null : { buyCount: c.buyCount, sellCount: c.sellCount, pass: c.buyCount > c.sellCount },
    };
    const passingSignals = Object.values(signals).filter((s) => s && s.pass).length;

    return {
      mint: c.mint, creator: c.creator, firstTradeAt: first, elapsedMs, tradeCount: c.tradeCount,
      netInflowPer10s: [...c.buckets], cumulativeNetInflowSol: cumulative,
      buyVolumeSol: buyVolume, sellVolumeSol: c.sellVolumeSol,
      rawUniqueBuyers: rawUnique, uniqueBuyers, funderCoverage,
      buyCount: c.buyCount, sellCount: c.sellCount, buySellRatio: c.sellCount > 0 ? c.buyCount / c.sellCount : null,
      largestBuyerShare: largestShare, creatorSold: c.creatorSold, signals, passingSignals,
    };
  }

  private release(c: Candidate, state: Exclude<WatchState, 'WATCHING'>, reason: string, now: number, score: number | null = null): WatchResult {
    const result: WatchResult = { state, reason, metrics: this.computeMetrics(c, now), score, releasedAt: now };
    this.active.delete(c.mint);
    this.released.set(c.mint, result);
    if (this.released.size > 200) this.released.delete(this.released.keys().next().value as string);
    this.emit('release', result);
    return result;
  }

  /** What the window has decided about a mint: its verdict if released, WATCHING if still held, null if never watched. */
  public getVerdict(mint: string): { state: WatchState; reason: string; releasedAt?: number } | null {
    const done = this.released.get(mint);
    if (done) return { state: done.state, reason: done.reason, releasedAt: done.releasedAt ?? undefined };
    if (this.active.has(mint)) return { state: 'WATCHING', reason: 'still in the watch window' };
    return null;
  }

  /** Judge one candidate at `now`; releases it when a verdict is due. */
  public evaluate(mint: string, now = Date.now()): WatchResult | null {
    const done = this.released.get(mint);
    if (done) return done;
    const c = this.active.get(mint);
    if (!c) return null;

    const m = this.computeMetrics(c, now);
    const hold = (reason: string): WatchResult => ({ state: 'WATCHING', reason, metrics: m, score: null, releasedAt: null });

    if (c.firstTradeAt === null) {
      if (now - c.registeredAt >= this.opts.maxMs) return this.release(c, 'DEAD', 'NO_TRADES: no trade seen within the window', now);
      return hold('waiting for the first trade');
    }
    if (m.elapsedMs < this.opts.minMs) return hold(`holding: ${Math.ceil((this.opts.minMs - m.elapsedMs) / 1000)}s of the minimum left`);

    if (m.cumulativeNetInflowSol < 0) {
      return this.release(c, 'DEAD', `NET_OUTFLOW: cumulative net inflow ${m.cumulativeNetInflowSol.toFixed(4)} SOL is negative`, now);
    }
    const score = this.opts.scoreOf?.(mint) ?? null;
    if (m.passingSignals >= HOT_MIN_SIGNALS && score !== null && score >= HOT_MIN_SCORE) {
      return this.release(c, 'HOT', `${m.passingSignals} strong signals and score ${score}`, now, score);
    }
    if (m.elapsedMs >= this.opts.maxMs) {
      return this.release(c, 'READY', `window elapsed with ${m.passingSignals} strong signal(s)${score === null ? ', no score' : `, score ${score}`}`, now, score);
    }
    return hold(`watching: ${m.passingSignals}/${HOT_MIN_SIGNALS} strong signals`);
  }

  /** Evaluate every active candidate. */
  public tick(now = Date.now()): WatchResult[] {
    const out: WatchResult[] = [];
    for (const mint of [...this.active.keys()]) {
      const r = this.evaluate(mint, now);
      if (r && r.state !== 'WATCHING') out.push(r);
    }
    return out;
  }

  /** Everything the board needs: live metrics for watched mints and the verdicts already given. */
  public getSnapshot(now = Date.now()): { watching: Array<{ metrics: WatchMetrics; state: 'WATCHING' }>; released: WatchResult[] } {
    return {
      watching: [...this.active.values()].map((c) => ({ metrics: this.computeMetrics(c, now), state: 'WATCHING' as const })),
      released: [...this.released.values()].slice(-50),
    };
  }

  /** Subscribe to a PumpFeedListener: create events start a watch, trade events feed it. */
  public attach(listener: EventEmitter): void {
    listener.on('create_event', (e: { mint: string; creator: string; user?: string }) => {
      this.watch(e.mint, e.creator, Date.now(), [e.user]);
    });
    listener.on('trade_event', (t: PumpTradeEvent) => this.onTrade(t));
  }

  public start(intervalMs = 2_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const watchWindow = new WatchWindow();
