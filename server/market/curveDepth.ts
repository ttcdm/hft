import { PumpCurveService, type PumpMarketState } from '../solana/pumpCurve';
import type { ExecutionMode } from '../core/types';

/**
 * H2: Pump.fun has no order book. The depth ladder is derived from the real reserves, using the SAME quote function
 * the coordinator uses for orders (PumpCurveService.calculateBuyQuote / calculateSellQuote), never separate math.
 */
export const BUY_STEPS_PCT = [1, 5, 10, 25] as const;
export const SELL_STEPS_PCT = [25, 50, 100] as const;
const LAMPORTS = 1e9;

/** Spot price (SOL per human token) from virtual reserves, as calculateBuyQuote reports it. */
export function spotPriceSol(state: PumpMarketState): number {
  return Number(state.virtualSolReserves) / Number(state.virtualTokenReserves) / (LAMPORTS / Math.pow(10, state.tokenDecimals));
}

/** Spot price after a buy quote has been filled: reserves + the SOL that reached the curve, minus the tokens paid out. */
export function postBuySpot(state: PumpMarketState, quote: { tokenAmountRaw: string; expectedSolAmountLamports: number; protocolFeeLamports: number; creatorFeeLamports: number }): number {
  const net = BigInt(quote.expectedSolAmountLamports) - BigInt(quote.protocolFeeLamports) - BigInt(quote.creatorFeeLamports);
  const vSol = state.virtualSolReserves + net;
  const vTok = state.virtualTokenReserves - BigInt(quote.tokenAmountRaw);
  return Number(vSol) / Number(vTok) / (LAMPORTS / Math.pow(10, state.tokenDecimals));
}

export interface BuyRung { upPct: number; solNeeded: number | null; tokensOut: number | null; avgPriceSol: number | null; feesSol: number | null }
export interface SellRung { sellPct: number; solReceived: number | null; avgPriceSol: number | null; impactBps: number | null }

export interface CurveDepth {
  mint: string;
  spotPriceSol: number;
  /** SOL in the curve toward the 85 SOL migration (real reserves); null if the state has none. */
  curveProgressPct: number;
  complete: boolean;
  buy: BuyRung[];
  sell: SellRung[] | null;
  marketDataSource: string;
  marketDataTimestamp: number;
}

/** Smallest input (lamports) whose post-trade spot price reaches `target`, found by bisection on the real quote. */
export function solForPriceMove(state: PumpMarketState, upPct: number, mode: ExecutionMode): { lamports: number; quote: ReturnType<typeof PumpCurveService.calculateBuyQuote> } | null {
  const target = spotPriceSol(state) * (1 + upPct / 100);
  const quoteAt = (lamports: number) => PumpCurveService.calculateBuyQuote({ state, amountSol: lamports / LAMPORTS, executionMode: mode, jitoTipSol: 0, priorityFeeLamports: 0 });
  let lo = 1_000;
  let hi = Math.max(1_000_000, Number(state.realTokenReserves > 0n ? state.virtualSolReserves : 1n)); // up to one full virtual SOL reserve
  try {
    if (postBuySpot(state, quoteAt(hi)) < target) return null; // cannot move that far with the tokens left
  } catch {
    return null;
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    let reached: boolean;
    try { reached = postBuySpot(state, quoteAt(mid)) >= target; } catch { reached = false; }
    if (reached) hi = mid; else lo = mid;
  }
  return { lamports: hi, quote: quoteAt(hi) };
}

export function buildCurveDepth(state: PumpMarketState, opts: { positionTokensRaw?: bigint | null; mode: ExecutionMode }): CurveDepth {
  const spot = spotPriceSol(state);
  const buy: BuyRung[] = BUY_STEPS_PCT.map((upPct) => {
    if (state.complete) return { upPct, solNeeded: null, tokensOut: null, avgPriceSol: null, feesSol: null };
    const r = solForPriceMove(state, upPct, opts.mode);
    if (!r) return { upPct, solNeeded: null, tokensOut: null, avgPriceSol: null, feesSol: null };
    const tokens = Number(r.quote.tokenAmountRaw) / Math.pow(10, state.tokenDecimals);
    return { upPct, solNeeded: r.lamports / LAMPORTS, tokensOut: tokens, avgPriceSol: r.quote.executionPriceSol, feesSol: (r.quote.protocolFeeLamports + r.quote.creatorFeeLamports) / LAMPORTS };
  });

  let sell: SellRung[] | null = null;
  if (opts.positionTokensRaw && opts.positionTokensRaw > 0n && !state.complete) {
    sell = SELL_STEPS_PCT.map((sellPct) => {
      const amount = (opts.positionTokensRaw! * BigInt(sellPct)) / 100n;
      try {
        const q = PumpCurveService.calculateSellQuote({ state, tokenAmountRaw: amount, executionMode: opts.mode, jitoTipSol: 0, priorityFeeLamports: 0 });
        return { sellPct, solReceived: q.expectedSolAmountLamports / LAMPORTS, avgPriceSol: q.executionPriceSol, impactBps: q.estimatedPriceImpactBps };
      } catch {
        return { sellPct, solReceived: null, avgPriceSol: null, impactBps: null };
      }
    });
  }

  return {
    mint: state.mint.toBase58(),
    spotPriceSol: spot,
    curveProgressPct: Math.min(100, (Number(state.realSolReserves) / (85 * LAMPORTS)) * 100),
    complete: state.complete,
    buy,
    sell,
    marketDataSource: state.marketDataSource,
    marketDataTimestamp: state.marketDataTimestamp,
  };
}
