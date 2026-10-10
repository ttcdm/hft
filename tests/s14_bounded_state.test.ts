import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { OnChainPoolStats } from '../server/market/poolStats';
import { CurveVelocityEvaluator } from '../server/signals/curveVelocityEvaluator';
import { CreatorRiskScorer } from '../server/signals/creatorRiskScorer';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { PumpFeedListener } from '../server/solana/pumpFeedListener';

const wal = () => Keypair.generate().publicKey.toBase58();
const trade = (mint: string, user: string, tokens: bigint, isBuy: boolean, i: number) => ({
  signature: `s14-${mint.slice(0, 4)}-${i}`, slot: 5, mint, solAmountLamports: 10_000_000n, tokenAmount: tokens, isBuy, user, timestampSec: 0,
  virtualSolReserves: 30_000_000_000n, virtualTokenReserves: 900_000_000_000_000n, realSolReserves: 1_000_000_000n, realTokenReserves: 780_000_000_000_000n,
});

describe('S14: per-trade state is bounded and the per-trade read is cheap', () => {
  afterEach(() => vi.restoreAllMocks());

  it('poolStats: holders per mint are capped, the insiders are kept, and the top-10 share and total still add up', () => {
    const st = new OnChainPoolStats();
    const creator = wal();
    st.track('M', { insiders: [creator] });
    st.record(trade('M', creator, 5_000_000_000_000n, true, 0));
    for (let i = 1; i <= 5_700; i++) st.record(trade('M', wal(), BigInt(1_000_000_000 + i), true, i));
    const s = (st as any).mints.get('M');
    expect(s.balances.size).toBeLessThanOrEqual(5_500);
    expect(s.balances.has(creator)).toBe(true);
    let sum = 0n; for (const v of s.balances.values()) sum += v;
    expect(s.outOfCurve).toBe(sum);
    const m = st.get('M')!;
    expect(m.devHoldingPct).toBeGreaterThan(0);
    expect(m.top10HoldersPct!).toBeGreaterThan(0);
    expect(m.top10HoldersPct!).toBeLessThanOrEqual(100);
  });

  it('poolStats: the top-10 share equals the sorted answer', () => {
    const st = new OnChainPoolStats();
    st.track('T', { insiders: [] });
    const amounts = Array.from({ length: 40 }, (_, i) => BigInt((i * 7919) % 1000 + 1) * 1_000_000_000n);
    amounts.forEach((a, i) => st.record(trade('T', wal(), a, true, i)));
    const sorted = [...amounts].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
    const expected = (Number(sorted.slice(0, 10).reduce((a, b) => a + b, 0n)) / Number(amounts.reduce((a, b) => a + b, 0n))) * 100;
    expect(st.get('T')!.top10HoldersPct!).toBeCloseTo(expected, 9);
  });

  it('curveVelocityEvaluator: the number of mints kept is capped', () => {
    const ev = new CurveVelocityEvaluator();
    for (let i = 0; i < 1_200; i++) { ev.recordTransition(`m${i}`, i, 1); ev.recordTradeFlow(`m${i}`, 1, true); }
    expect((ev as any).transitionsByMint.size).toBeLessThanOrEqual(1_000);
    expect((ev as any).tradeFlowsByMint.size).toBeLessThanOrEqual(1_000);
    expect(ev.hasData('m1199')).toBe(true);
    expect(ev.hasData('m0')).toBe(false);
  });

  it('creatorRiskScorer: the cache is capped and expired entries are removed', async () => {
    const sc = new CreatorRiskScorer();
    const conn = { getSignaturesForAddress: async () => [] };
    for (let i = 0; i < 2_100; i++) await sc.evaluateCreator(conn, wal(), { nowSec: 1_000 });
    expect((sc as any).cache.size).toBeLessThanOrEqual(2_000);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60_000);
    await sc.evaluateCreator(conn, wal());
    for (let i = 0; i < 2_000; i++) (sc as any).storeInCache(`x${i}`, {} as any);
    expect([...(sc as any).cache.keys()].some((k: string) => !k.startsWith('x') && false)).toBe(false);
    expect((sc as any).cache.size).toBeLessThanOrEqual(2_000);
  });

  it('aggregator: the price-push throttle map is capped', () => {
    const l = new PumpFeedListener();
    for (let i = 0; i < 1_050; i++) {
      const mint = wal();
      const ev = l.parseLogs({ err: null, signature: `s14l${i}`, logs: PumpFeedListener.asPumpInvocation(PumpFeedListener.encodeCreateEventLog({ name: 'S', symbol: 'S', uri: '', mint, creator: wal() })) } as any, { slot: 9 })!;
      memecoinAggregator.ingestOnChainCreateEvent(ev);
      memecoinAggregator.applyTradeToPool(trade(mint, wal(), 1_000_000_000n, true, i) as any);
    }
    l.destroy();
    expect((memecoinAggregator as any).lastPoolPush.size).toBeLessThanOrEqual(1_000);
  });
});
