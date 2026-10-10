import { describe, it, expect, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { RealMarkPriceService } from '../server/execution/reconciliation';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';

describe('N16: a cached PumpSwap mark keeps the time it was really read', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the mark timestamp is the pool state read time, not "now", so staleness checks can see it', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const readAt = Date.now() - 14_000; // served from the 15 s pool cache
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(null as any); // bonding curve gone: migrated
    vi.spyOn(PumpSwapVenueService, 'getPoolState').mockResolvedValue({
      poolAddress: Keypair.generate().publicKey, spotPriceSol: 0.002, marketDataTimestamp: readAt,
    } as any);
    const marks = await RealMarkPriceService.queryOnChainMarkPrices({} as any, [mint], 'LIVE');
    expect(marks[mint].source).toBe('ON_CHAIN_PUMPSWAP_POOL');
    expect(marks[mint].timestamp).toBe(readAt);
    expect(Date.now() - marks[mint].timestamp).toBeGreaterThanOrEqual(14_000);
  });
});
