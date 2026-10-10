import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { PumpFeedListener, pumpFeedListener } from '../server/solana/pumpFeedListener';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { onChainPoolStats, OnChainPoolStats } from '../server/market/poolStats';
import { curveVelocityEvaluator } from '../server/signals/curveVelocityEvaluator';
import { creatorRiskScorer } from '../server/signals/creatorRiskScorer';
import { solPriceService } from '../server/market/solPriceService';

const SUPPLY = 1_000_000_000_000_000n;
const tradeFor = (mint: string, user: string, sol: number, tokens: bigint, isBuy: boolean, vSol: number, rSol: number, sig: string) => ({
  signature: sig, slot: 5, mint, solAmountLamports: BigInt(Math.round(sol * 1e9)), tokenAmount: tokens, isBuy, user, timestampSec: 0,
  virtualSolReserves: BigInt(Math.round(vSol * 1e9)), virtualTokenReserves: 1_000_000_000_000_000n - tokens,
  realSolReserves: BigInt(Math.round(rSol * 1e9)), realTokenReserves: 780_000_000_000_000n,
});

describe('Q6: a WS-created pool is filled in from its trades', () => {
  beforeEach(() => {
    vi.spyOn(solPriceService, 'lastKnownPrice').mockReturnValue(150);
    curveVelocityEvaluator.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    onChainPoolStats.clear();
    curveVelocityEvaluator.clear();
    creatorRiskScorer.clearCache();
  });

  const createPool = (mint: string, creator: string) =>
    memecoinAggregator.ingestOnChainCreateEvent({
      signature: 'c', slot: 1, mint, creator, user: creator, bondingCurve: Keypair.generate().publicKey.toBase58(), name: 'Q6', symbol: 'Q6', uri: '',
      virtualTokenReserves: 1_073_000_000_000_000n, virtualSolReserves: 30_000_000_000n, realTokenReserves: 793_100_000_000_000n, realSolReserves: 0n,
      tokenTotalSupply: SUPPLY, initialPriceSol: 30 / 1_073_000_000 , initialMarketCapSol: 28, receivedAt: Date.now(), parsedAt: Date.now(), parseLatencyMs: 0, source: 'TEST_FEED',
    });

  it('with no trades the pool scores at most 20 (the baseline this fixes)', () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const pool = createPool(mint, Keypair.generate().publicKey.toBase58());
    expect(memecoinAggregator.evaluateTokenConfluence(pool).score).toBeLessThanOrEqual(20);
  });

  it('trades set price, liquidity, curve progress, order flow and holder shares on the pool, and the score reflects them', () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const creator = Keypair.generate().publicKey.toBase58();
    const pool = createPool(mint, creator);
    const now = Date.now();
    // 40 distinct buyers, each 1 SOL, the price climbing as the real reserves go from 5 to 45 SOL
    for (let i = 0; i < 40; i++) {
      const w = Keypair.generate().publicKey.toBase58();
      const vSol = 30 + (i + 1) * 0.5;
      const t = tradeFor(mint, w, 1, 12_000_000_000_000n, true, vSol, 5 + i, `s${i}`);
      pumpFeedListener.ingestTradeEvent(t);
    }
    expect(pool.buys5m).toBe(40);
    expect(pool.sells5m).toBe(0);
    expect(pool.liquidityUsd).toBeCloseTo(44 * 150 * 2, 6);
    expect(pool.bondingCurveProgress).toBeCloseTo((44 / 85) * 100, 1);
    expect(pool.priceChange5mPct).toBeGreaterThan(30);
    expect(pool.top10HoldersPct).toBeGreaterThan(0);
    expect(pool.top10HoldersPct).toBeLessThan(30); // 40 equal wallets: the top ten hold a quarter
    expect(pool.devHoldingPct).toBe(0); // the creator never bought
    const r = memecoinAggregator.evaluateTokenConfluence(pool);
    expect(r.breakdown.holderDistributionScore).toBeGreaterThanOrEqual(10);
    expect(r.breakdown.buySellImbalanceScore).toBe(20);
    expect(r.breakdown.momentumScore).toBeGreaterThan(10);
    expect(r.score).toBeGreaterThan(20);
  });

  it('a creator buy shows as dev holding, and a sell lowers a wallet\'s balance', () => {
    const stats = new OnChainPoolStats();
    stats.track('M', { insiders: ['dev'], supplyRaw: SUPPLY, createPriceSol: 3e-8 });
    stats.record(tradeFor('M', 'dev', 0.5, 20_000_000_000_000n, true, 30.5, 0.5, 'a'));
    stats.record(tradeFor('M', 'w1', 1, 30_000_000_000_000n, true, 31.5, 1.5, 'b'));
    let m = stats.get('M')!;
    expect(m.devHoldingPct).toBeCloseTo(2, 9);
    expect(m.top10HoldersPct).toBeCloseTo(100, 9);
    stats.record(tradeFor('M', 'dev', 0.2, 20_000_000_000_000n, false, 31, 1.3, 'c'));
    m = stats.get('M')!;
    expect(m.devHoldingPct).toBe(0);
    expect(m.sells5m).toBe(1);
    expect(stats.record(tradeFor('M', 'dev', 0.2, 20_000_000_000_000n, false, 31, 1.3, 'c'))).toBe(false); // duplicate signature
  });

  it('an untracked mint is ignored and nothing is invented for a mint with no trades', () => {
    const stats = new OnChainPoolStats();
    expect(stats.record(tradeFor('X', 'w', 1, 1n, true, 30, 1, 'z'))).toBe(false);
    stats.track('Y', { insiders: [] });
    expect(stats.get('Y')).toBeNull();
  });
});
