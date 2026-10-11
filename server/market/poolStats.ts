import type { PumpTradeEvent } from '../solana/pumpFeedListener';
import { poolStatsMaxMints } from '../signals/capacity';

/** A bonding curve graduates at about 85 SOL of real reserves (the same constant the aggregator uses for curve progress). */
export const CURVE_GRADUATION_SOL = 85;
/** What a fresh pump.fun curve holds: 793.1M tokens at 6 decimals. Progress is the share of these that has been sold. */
export const CURVE_INITIAL_REAL_TOKENS = 793_100_000_000_000n;
export const POOL_STATS_WINDOW_MS = 5 * 60_000;
const MAX_TRADES_KEPT = 2_000;
/** S14: wallets tracked per mint. Above this (plus slack) zero balances go first, then the smallest holders. */
const MAX_HOLDERS_KEPT = 5_000;
const HOLDER_TRIM_SLACK = 500;

export interface MeasuredPoolStats {
  /** SOL per token from the last trade's virtual reserves. */
  priceSol: number;
  realSolReserves: number;
  /** Share of the curve's tokens already sold (what pump.fun shows), 0..100. Falls back to real SOL over the graduation size when the token reserve is unknown. */
  curveProgressPct: number;
  /** Last price against the oldest price inside the 5 minute window (or the create price for a younger token). */
  priceChange5mPct: number;
  buys5m: number;
  sells5m: number;
  volume5mSol: number;
  /** The ten largest wallets' share of the tokens that have left the curve. null when nothing has been bought. */
  top10HoldersPct: number | null;
  /** What the creator (and the create signer) hold, as a share of the total supply. */
  devHoldingPct: number | null;
  tradeCount: number;
}

interface PoolState {
  insiders: Set<string>;
  supplyRaw: bigint;
  /** First price: the create event's, or the first trade's when no create price was given. */
  anchorPriceSol: number | null;
  priceSol: number | null;
  realSolReserves: number;
  realTokenReserves: bigint | null;
  initialRealTokenReserves: bigint | null;
  trades: Array<{ at: number; isBuy: boolean; sol: number; priceSol: number }>;
  /** Token balances built from every trade since creation. Exact when the whole history was seen (the watch starts at the create). */
  balances: Map<string, bigint>;
  /** S14: sum of `balances`, kept incrementally so `get` needs no pass over every holder for it. */
  outOfCurve: bigint;
  seen: Set<string>;
  tradeCount: number;
}

/** SOL per token implied by a trade's virtual reserves (6-decimal tokens). */
export const tradePriceSol = (t: Pick<PumpTradeEvent, 'virtualTokenReserves' | 'virtualSolReserves'>): number | null =>
  t.virtualTokenReserves > 0n ? Number(t.virtualSolReserves) / Number(t.virtualTokenReserves) / 1000 : null;

/**
 * Q6: figures a pump.fun pool gets from the trades themselves. A pool built from a create event carries zeros for everything
 * a trade reveals, which capped its confluence score at 20 of the 70 the auto gate asks for. Everything here is measured from
 * decoded TradeEvents; a figure with nothing behind it is null, never a default.
 */
export class OnChainPoolStats {
  private mints = new Map<string, PoolState>();
  /** S185: mints dropped to make room. A dropped mint loses its measured figures, so a busy feed must show this number, not hide it. */
  private evicted = 0;
  private isPinned: (mint: string) => boolean = () => false;

  /** S4: a mint the watch window is still scoring is never evicted to make room (at feed rate 300 newer mints arrive well inside its 120 s). */
  public setPinned(fn: (mint: string) => boolean): void {
    this.isPinned = fn;
  }

  public track(mint: string, opts: { insiders: Array<string | undefined>; supplyRaw?: bigint; createPriceSol?: number; realTokenReserves?: bigint }): void {
    if (this.mints.has(mint)) return;
    if (this.mints.size >= poolStatsMaxMints()) {
      // Oldest first, skipping pinned mints. The window holds at most 60, so an unpinned victim always exists below 300.
      for (const k of this.mints.keys()) {
        if (!this.isPinned(k)) { this.mints.delete(k); this.evicted++; break; }
      }
    }
    this.mints.set(mint, {
      insiders: new Set(opts.insiders.filter((w): w is string => !!w)),
      supplyRaw: opts.supplyRaw ?? 1_000_000_000_000_000n,
      anchorPriceSol: opts.createPriceSol ?? null,
      priceSol: opts.createPriceSol ?? null,
      realSolReserves: 0,
      realTokenReserves: opts.realTokenReserves ?? null,
      initialRealTokenReserves: opts.realTokenReserves ?? null,
      trades: [], balances: new Map(), outOfCurve: 0n, seen: new Set(), tradeCount: 0,
    });
  }

  public getEvictedCount(): number {
    return this.evicted;
  }

  public getTrackedCount(): number {
    return this.mints.size;
  }

  public isTracking(mint: string): boolean {
    return this.mints.has(mint);
  }

  /** Feed one decoded trade. False when the mint is not tracked or the trade was already counted. */
  public record(t: PumpTradeEvent, at = Date.now()): boolean {
    const s = this.mints.get(t.mint);
    if (!s) return false;
    const key = `${t.signature}:${t.user}:${t.isBuy ? 'b' : 's'}`;
    if (s.seen.has(key)) return false;
    s.seen.add(key);
    if (s.seen.size > MAX_TRADES_KEPT) s.seen.delete(s.seen.values().next().value as string);

    const price = tradePriceSol(t);
    if (price !== null) {
      s.priceSol = price;
      if (s.anchorPriceSol === null) s.anchorPriceSol = price;
    }
    s.realSolReserves = Number(t.realSolReserves) / 1e9;
    s.realTokenReserves = t.realTokenReserves;
    s.tradeCount++;
    s.trades.push({ at, isBuy: t.isBuy, sol: Number(t.solAmountLamports) / 1e9, priceSol: price ?? s.priceSol ?? 0 });
    if (s.trades.length > MAX_TRADES_KEPT) s.trades.shift();
    const prev = s.balances.get(t.user) ?? 0n;
    const next = t.isBuy ? prev + t.tokenAmount : prev - t.tokenAmount;
    const nextBal = next > 0n ? next : 0n;
    s.balances.set(t.user, nextBal);
    s.outOfCurve += nextBal - prev;
    if (s.balances.size > MAX_HOLDERS_KEPT + HOLDER_TRIM_SLACK) this.trimHolders(s);
    return true;
  }

  /** S14: back to MAX_HOLDERS_KEPT wallets: empty ones first, then the smallest. The insiders' balances are never dropped. */
  private trimHolders(s: PoolState): void {
    for (const [w, v] of s.balances) if (v === 0n && !s.insiders.has(w)) s.balances.delete(w);
    if (s.balances.size <= MAX_HOLDERS_KEPT) return;
    const droppable = [...s.balances.entries()].filter(([w]) => !s.insiders.has(w)).sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    for (const [w, v] of droppable) {
      if (s.balances.size <= MAX_HOLDERS_KEPT) break;
      s.balances.delete(w);
      s.outOfCurve -= v;
    }
  }

  public get(mint: string, now = Date.now()): MeasuredPoolStats | null {
    const s = this.mints.get(mint);
    if (!s || s.tradeCount === 0 || s.priceSol === null) return null;
    const recent = s.trades.filter((t) => t.at > now - POOL_STATS_WINDOW_MS);
    // S15: the create price is the 5-minute base only while every trade since launch is still held; once the oldest were shifted out, the
    // first held trade is the base (a shorter window, never change-since-launch).
    const nothingDropped = s.tradeCount === s.trades.length;
    const base = recent.length > 0 && s.trades.length === recent.length && nothingDropped ? (s.anchorPriceSol ?? recent[0].priceSol) : (recent[0]?.priceSol ?? s.anchorPriceSol);
    const priceChange5mPct = base && base > 0 ? (s.priceSol / base - 1) * 100 : 0;

    const supply = Number(s.supplyRaw);
    // S14: this runs on every trade; the total is kept incrementally and the top ten is a single pass, not a sort of every holder.
    const outOfCurve = Number(s.outOfCurve);
    const topTen: bigint[] = [];
    for (const v of s.balances.values()) {
      if (topTen.length === 10 && v <= topTen[9]) continue;
      let i = topTen.length;
      while (i > 0 && topTen[i - 1] < v) i--;
      topTen.splice(i, 0, v);
      if (topTen.length > 10) topTen.pop();
    }
    const top10 = topTen.reduce((a, v) => a + Number(v), 0);
    const dev = [...s.insiders].reduce((a, w) => a + Number(s.balances.get(w) ?? 0n), 0);
    return {
      priceSol: s.priceSol,
      realSolReserves: s.realSolReserves,
      curveProgressPct: curveProgressOf(s),
      priceChange5mPct,
      buys5m: recent.filter((t) => t.isBuy).length,
      sells5m: recent.filter((t) => !t.isBuy).length,
      volume5mSol: recent.reduce((a, t) => a + t.sol, 0),
      top10HoldersPct: outOfCurve > 0 ? (top10 / outOfCurve) * 100 : null,
      devHoldingPct: supply > 0 ? (dev / supply) * 100 : null,
      tradeCount: s.tradeCount,
    };
  }

  public clear(): void {
    this.mints.clear();
  }
}

/** Q-curve: pump.fun's bar is tokens sold, not SOL raised (the curve is constant-product, so SOL lags tokens: at half the tokens sold only a quarter of the SOL is in). */
function curveProgressOf(s: { realSolReserves: number; realTokenReserves: bigint | null }): number {
  if (s.realTokenReserves !== null) {
    const initial = CURVE_INITIAL_REAL_TOKENS; // not the first value seen: a watch that starts mid-curve would see a smaller "initial"
    const sold = Number(initial - s.realTokenReserves) / Number(initial);
    return Math.max(0, Math.min(100, sold * 100));
  }
  return Math.min(100, (s.realSolReserves / CURVE_GRADUATION_SOL) * 100);
}

export const onChainPoolStats = new OnChainPoolStats();
