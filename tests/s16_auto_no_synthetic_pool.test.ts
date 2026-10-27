import { describe, it, expect, afterEach, vi } from 'vitest';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { executionCoordinator } from '../server/execution/coordinator';

afterEach(() => { vi.restoreAllMocks(); memecoinAggregator.setConfluenceGating(true); });

describe('S16: the auto trader never trades against an invented pool', () => {
  it('an unknown mint with noSyntheticPool is refused before the coordinator is called; R10-8: a manual paper snipe of an unknown mint is refused too (no invented pool any more)', async () => {
    memecoinAggregator.setConfluenceGating(false); // this test is about the pool, not the score
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('PAPER');
    const trade = vi.spyOn(executionCoordinator, 'executeTrade').mockResolvedValue({ success: false, error: 'stub' } as any);
    const refused = await memecoinAggregator.executeSnipe({ contractAddress: 'S16UnknownMint111111111111111111111111111111', amountUsd: 5, noSyntheticPool: true });
    expect(refused.success).toBe(false);
    expect(refused.message).toContain('MARKET_DATA_UNAVAILABLE');
    expect(trade).not.toHaveBeenCalled();

    const manual = await memecoinAggregator.executeSnipe({ contractAddress: 'S16UnknownMint111111111111111111111111111112', amountUsd: 5 });
    expect(manual.message).toContain('MARKET_DATA_UNAVAILABLE');
    expect(trade).not.toHaveBeenCalled();
  });
});
