import { Keypair } from '@solana/web3.js';
import type { PumpTradeEvent } from '../../server/solana/pumpFeedListener';

/**
 * G2: hand-built replay fixtures (not recorded from mainnet; the sandbox has no network). A script is a list of
 * [seconds since the first trade, wallet, side, SOL]; `replay` turns it into real PumpTradeEvent objects with the
 * time each was "seen", ready to feed WatchWindow.onTrade.
 */
export type Step = [t: number, wallet: string, side: 'buy' | 'sell', sol: number];

export const wallet = () => Keypair.generate().publicKey.toBase58();

export function replay(mint: string, startMs: number, steps: Step[]): Array<{ trade: PumpTradeEvent; at: number }> {
  return steps.map(([t, user, side, sol], i) => ({
    at: startMs + t * 1000,
    trade: {
      signature: `fx-${mint.slice(0, 6)}-${i}`, slot: 1000 + i, mint, solAmountLamports: BigInt(Math.round(sol * 1e9)), tokenAmount: 1_000_000n,
      isBuy: side === 'buy', user, timestampSec: Math.floor((startMs + t * 1000) / 1000),
      virtualSolReserves: 30n * 1_000_000_000n, virtualTokenReserves: 1_000_000_000_000_000n, realSolReserves: 5n * 1_000_000_000n, realTokenReserves: 1n,
    },
  }));
}

/** `n` distinct buyers, 0.1 SOL each, spread over `spanSec` seconds. Returns the script and the buyer wallets. */
export function buyers(n: number, spanSec: number, sol = 0.1): { steps: Step[]; wallets: string[] } {
  const wallets = Array.from({ length: n }, wallet);
  return { wallets, steps: wallets.map((w, i): Step => [(i * spanSec) / Math.max(1, n - 1), w, 'buy', sol]) };
}
