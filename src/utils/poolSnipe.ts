import type { MemecoinPool } from '../types';

/**
 * The body a pool row's Snipe button sends to /api/memecoins/trade. A row on the aggregator board is a POOL, not a stored signal: it is
 * sniped by its mint. (It used to be wrapped in a made-up `sig-agg-*` signal and sent to /api/social/signals/snipe, which looks the id up
 * and answered "Signal not found" for every row.)
 */
export function buildPoolSnipeRequest(pool: Pick<MemecoinPool, 'contractAddress' | 'platform'>, amountSol: number, cfg: { jitoTipSol?: number; maxSlippagePct?: number }) {
  return {
    contractAddress: pool.contractAddress,
    amountSol,
    platform: pool.platform,
    ...(cfg.jitoTipSol !== undefined ? { jitoTipSol: cfg.jitoTipSol } : {}),
    ...(cfg.maxSlippagePct !== undefined ? { slippagePct: cfg.maxSlippagePct } : {}),
  };
}
