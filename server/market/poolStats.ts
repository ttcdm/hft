import type { PumpTradeEvent } from '../solana/pumpFeedListener';

/** A bonding curve graduates at about 85 SOL of real reserves (the same constant the aggregator uses for curve progress). */
export const CURVE_GRADUATION_SOL = 85;
export const POOL_STATS_WINDOW_MS = 5 * 60_000;
const MAX_TRADES_KEPT = 2_000;
const MAX_MINTS_KEPT = 300;

export interface MeasuredPoolStats {
  /** SOL per token from the last trade's virtual reserves. */
  priceSol: number;
  realSolReserves: number;
  /** Real SOL in the curve over the graduation size, 0..100. */
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
  seen: Set<string>;
  tradeCount: number;
}

const priceOf = (t: PumpTradeEvent): number | null =>
  t.virtualTokenReserves > 0n ? Number(t.virtualSolReserves) / Number(t.virtualTokenReserves) / 1000 : null;

/**
 * Q6: figures a pump.fun pool gets from the trades themselves. A pool built from a create event carries zeros for everything
 * a trade reveals, which capped its confluence score at 20 of the 70 the auto gate asks for. Everything here is measured from
 * decoded TradeEvents; a figure with nothing behind it is null, never a default.
 */
export class OnChainPoolStats {
  private mints = new Map<string, PoolState>();

  public track(mint: string, opts: { insiders: Array<string | undefined>; supplyRaw?: bigint; createPriceSol?: number; realTokenReserves?: bigint }): void {
    if (this.mints.has(mint)) return;
    if (this.mints.size >= MAX_MINTS_KEPT) this.mints.delete(this.mints.keys().next().value as string);
    this.mints.set(mint, {
      insiders: new Set(opts.insiders.filter((w): w is string => !!w)),
      supplyRaw: opts.supplyRaw ?? 1_000_000_000_000_000n,
      anchorPriceSol: opts.createPriceSol ?? null,
      priceSol: opts.createPriceSol ?? null,
      realSolReserves: 0,
      realTokenReserves: opts.realTokenReserves ?? null,
      initialRealTokenReserves: opts.realTokenReserves ?? null,
      trades: [], balances: new Map(), seen: new Set(), tradeCount: 0,
    });
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

    const price = priceOf(t);
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
    s.balances.set(t.user, next > 0n ? next : 0n);
    return true;
  }

  public get(mint: string, now = Date.now()): MeasuredPoolStats | null {
    const s = this.mints.get(mint);
    if (!s || s.tradeCount === 0 || s.priceSol === null) return null;
    const recent = s.trades.filter((t) => t.at > now - POOL_STATS_WINDOW_MS);
    const base = recent.length > 0 && s.trades.length === recent.length ? (s.anchorPriceSol ?? recent[0].priceSol) : (recent[0]?.priceSol ?? s.anchorPriceSol);
    const priceChange5mPct = base && base > 0 ? (s.priceSol / base - 1) * 100 : 0;

    const supply = Number(s.supplyRaw);
    const held = [...s.balances.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
    const outOfCurve = held.reduce((a, [, v]) => a + Number(v), 0);
    const top10 = held.slice(0, 10).reduce((a, [, v]) => a + Number(v), 0);
    const dev = [...s.insiders].reduce((a, w) => a + Number(s.balances.get(w) ?? 0n), 0);
    return {
      priceSol: s.priceSol,
      realSolReserves: s.realSolReserves,
      curveProgressPct: Math.min(100, (s.realSolReserves / CURVE_GRADUATION_SOL) * 100),
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

export const onChainPoolStats = new OnChainPoolStats();
