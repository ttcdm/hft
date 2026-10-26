import { describe, it, expect, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { executionCoordinator } from '../server/execution/coordinator';
import { pumpFunService } from '../server/pumpfunService';

afterEach(() => { vi.restoreAllMocks(); memecoinAggregator.setConfluenceGating(true); });

describe('Q32: a pool built from a callout is a placeholder, not real evidence', () => {
  it('is labelled unverified with no invented volume or momentum, and its provenance is not REAL_*', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    memecoinAggregator.setConfluenceGating(false);
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('PAPER');
    vi.spyOn(pumpFunService, 'getHotCallouts').mockReturnValue([{ token: { mint, symbol: 'Q32', name: 'Q32', complete: false, currentPriceUsd: 0.00005 } }] as any);
    const trade = vi.spyOn(executionCoordinator, 'executeTrade').mockResolvedValue({ success: false, error: 'stub' } as any);
    await memecoinAggregator.executeSnipe({ contractAddress: mint, amountUsd: 5, provenance: 'REAL_ONCHAIN' });
    expect(trade.mock.calls[0][0].provenance).toBe('SYNTHETIC_TEST');
    const pool = memecoinAggregator.getPools().find((p) => p.contractAddress === mint)!;
    expect(pool.unverified).toBe(true);
    expect(pool.volume24hUsd).toBe(0);
    expect(pool.priceChange1hPct).toBe(0);
    expect(pool.buys5m).toBe(0);
  });
});
