import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { curveProgressOf, onChainPoolStats, CURVE_INITIAL_REAL_TOKENS } from '../server/market/poolStats';
import { isCurveTooFar } from '../server/signals/curveProgressCap';
import { WatchWindow } from '../server/signals/watchWindow';
import { replay, wallet } from './fixtures/watch';

/**
 * Review 2026-10-24 (M2): curve progress is never real SOL over 85. With the token reserve unknown, curveProgressOf and the pool stats say
 * null (unknown), where they used to say SOL/85 (about 28% at a real 60%), which the auto controller's cap read as measured. The real
 * curveProgressOf, OnChainPoolStats and WatchWindow; trades are plain values.
 */
const trade = (mint: string, realSolLamports: bigint, realTokenReserves: bigint | undefined, sig: string) => ({
  signature: sig, slot: 1, mint, solAmountLamports: 100_000_000n, tokenAmount: 1_000_000n, isBuy: true, user: wallet(), timestampSec: Math.floor(Date.now() / 1000),
  virtualSolReserves: 60_000_000_000n, virtualTokenReserves: 600_000_000_000_000n, realSolReserves: realSolLamports, realTokenReserves,
}) as any;

describe('M2: no SOL/85 estimate of curve progress', () => {
  it('curveProgressOf: unknown token reserve is null, whatever the SOL (24 SOL used to read about 28%)', () => {
    expect(curveProgressOf({ realSolReserves: 24, realTokenReserves: null })).toBeNull();
    expect(curveProgressOf({ realSolReserves: 24, realTokenReserves: undefined as any })).toBeNull();
    const sixty = CURVE_INITIAL_REAL_TOKENS - (CURVE_INITIAL_REAL_TOKENS * 60n) / 100n;
    expect(curveProgressOf({ realSolReserves: 24, realTokenReserves: sixty })).toBeCloseTo(60, 6);
  });

  it('pool stats: a trade with the token reserve gives the token share, and the controller cap reads it', () => {
    const mint = Keypair.generate().publicKey.toBase58();
    onChainPoolStats.track(mint, { insiders: [], supplyRaw: 1_000_000_000_000_000n, createPriceSol: 3e-8 });
    const sold62 = CURVE_INITIAL_REAL_TOKENS - (CURVE_INITIAL_REAL_TOKENS * 62n) / 100n;
    onChainPoolStats.record(trade(mint, 24_000_000_000n, sold62, 'm2-a'));
    expect(onChainPoolStats.get(mint)!.curveProgressPct).toBeCloseTo(62, 6);
    expect(isCurveTooFar(onChainPoolStats.get(mint)!.curveProgressPct)).toBe(true); // the controller's cap (60%) drops it
  });

  it('pool stats: a trade decoded without the token reserve leaves progress unknown, not a stale-low SOL figure under the cap', () => {
    const mint = Keypair.generate().publicKey.toBase58();
    onChainPoolStats.track(mint, { insiders: [], supplyRaw: 1_000_000_000_000_000n, createPriceSol: 3e-8 });
    onChainPoolStats.record(trade(mint, 24_000_000_000n, undefined, 'm2-b'));
    const p = onChainPoolStats.get(mint)!.curveProgressPct;
    expect(p).toBeNull(); // the old fallback said 28.2: "measured", under the 60% cap
  });

  it('watch window: an unknown progress does not release the launch CURVE_TOO_FAR; a known one above the cap does', () => {
    let progress: number | null = null;
    const ww = new WatchWindow({ scoreOf: () => null, publicFunders: [], progressOf: () => progress });
    const mint = Keypair.generate().publicKey.toBase58();
    const start = Date.now() - 5_000;
    ww.watch(mint, wallet(), start);
    for (const { trade: t, at } of replay(mint, start, [[1, wallet(), 'buy', 0.5]])) ww.onTrade(t, at);
    expect(ww.evaluate(mint, start + 2_000)!.state).toBe('WATCHING');
    progress = 75;
    const v = ww.evaluate(mint, start + 3_000)!;
    expect(v.state).toBe('DEAD');
    expect(v.reason).toMatch(/^CURVE_TOO_FAR: 75\.0%/);
  });
});
