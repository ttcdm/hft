/**
 * How much the devnet harness can do with the balance it found. Pure, so a test can check it.
 * The buy is about 8% of the balance (the 10% spendable ceiling), capped at 0.01 SOL; under 0.03 SOL the harness does not trade.
 */
import type { ExecuteTradeRequest } from "../server/execution/coordinator";

export interface FundingPlan {
  buySol: number;
  funded: boolean;
  /** exactly zero: the faucet request failed or was not made */
  unfunded: boolean;
  message: string;
}

export function planFunding(balSol: number, address: string): FundingPlan {
  const safe = Number.isFinite(balSol) && balSol > 0 ? balSol : 0;
  const buySol = Math.min(0.01, Number((safe * 0.08).toFixed(5)));
  if (safe === 0) {
    return {
      buySol: 0, funded: false, unfunded: true,
      message: `wallet unfunded: 0 SOL at ${address}. The faucet request failed or was not made (DEVNET_AIRDROP_ONCE=1 sends one). Send devnet SOL to this address (for example from https://faucet.solana.com) and re-run. Nothing was simulated or sent.`,
    };
  }
  const funded = safe >= 0.03;
  return {
    buySol, funded, unfunded: false,
    message: `${safe} SOL at ${address}; buy size ${buySol} SOL${funded ? '' : ' (too low to trade: fund this devnet address and re-run; only the simulate stage runs)'}`,
  };
}

/** The SOL/USD price source the harness needs before a LIVE buy (only the price, so a test can pass a fake). */
export interface PriceSource {
  refresh(): Promise<unknown>;
  getPrice(): { usd: number | null; stale: boolean };
}

/**
 * server.ts starts the SOL/USD price service at boot; a script that imports the coordinator directly does not, and a LIVE buy then answers
 * SOL_PRICE_UNAVAILABLE. Reads a real price (never a made-up one), trying a few times; returns what it found.
 */
export async function awaitSolPrice(svc: PriceSource, attempts = 4, pauseMs = 1500): Promise<{ ok: boolean; usd: number | null }> {
  for (let i = 0; i < attempts; i++) {
    await svc.refresh();
    const r = svc.getPrice();
    if (r.usd !== null && !r.stale) return { ok: true, usd: r.usd };
    if (i < attempts - 1) await new Promise((res) => setTimeout(res, pauseMs));
  }
  return { ok: false, usd: null };
}

/**
 * The executeTrade request the harness sends for its LIVE buy. Typed, so a field the coordinator renames fails tsc here instead of on the
 * next devnet run. `signalTimestamp` is taken when the request is made: LIVE refuses a trade with no signal time (MISSING_SIGNAL_TIMESTAMP),
 * and an operator command is its own signal.
 */
export function liveBuyRequest(mint: string, amountSol: number, now: number = Date.now()): ExecuteTradeRequest {
  return {
    mint, symbol: 'E2E', name: 'E2E', amountSol,
    source: 'MANUAL', provenance: 'MANUAL_OPERATOR', executionMode: 'LIVE',
    signalTimestamp: now,
  };
}
