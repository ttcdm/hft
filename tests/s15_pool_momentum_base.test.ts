import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { OnChainPoolStats } from '../server/market/poolStats';

const wal = () => Keypair.generate().publicKey.toBase58();
const trade = (mint: string, i: number, vSol: bigint) => ({
  signature: `s15-${i}`, slot: 5, mint, solAmountLamports: 10_000_000n, tokenAmount: 1_000_000n, isBuy: true, user: wal(), timestampSec: 0,
  virtualSolReserves: vSol, virtualTokenReserves: 900_000_000_000_000n, realSolReserves: 1_000_000_000n, realTokenReserves: 780_000_000_000_000n,
});

describe('S15: the 5-minute change is not change since launch on a busy token', () => {
  it('before any trade is dropped the create price is the base; after the oldest are shifted out the first held trade is', () => {
    const now = 1_000_000_000;
    const st = new OnChainPoolStats();
    st.track('B', { insiders: [], createPriceSol: 0.00000003 });
    // price rises steadily; the token has had 2,500 trades inside the last minute, so 500 were shifted out
    for (let i = 0; i < 2_500; i++) st.record(trade('B', i, 30_000_000_000n + BigInt(i) * 4_000_000n), now - 60_000 + i);
    const m = st.get('B', now)!;
    const s = (st as any).mints.get('B');
    const firstHeld = s.trades[0].priceSol;
    const expected = (s.priceSol / firstHeld - 1) * 100;
    expect(m.priceChange5mPct).toBeCloseTo(expected, 6);
    const sinceLaunch = (s.priceSol / 0.00000003 - 1) * 100;
    expect(Math.abs(m.priceChange5mPct - sinceLaunch)).toBeGreaterThan(1);
  });

  it('with every trade still held, the create price remains the base', () => {
    const now = 1_000_000_000;
    const st = new OnChainPoolStats();
    st.track('C', { insiders: [], createPriceSol: 0.00000003 });
    for (let i = 0; i < 50; i++) st.record(trade('C', i, 30_000_000_000n + BigInt(i) * 4_000_000n), now - 60_000 + i);
    const s = (st as any).mints.get('C');
    expect(st.get('C', now)!.priceChange5mPct).toBeCloseTo((s.priceSol / 0.00000003 - 1) * 100, 6);
  });
});
