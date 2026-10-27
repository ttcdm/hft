import { describe, it, expect, afterEach, vi } from 'vitest';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { executionCoordinator } from '../server/execution/coordinator';

afterEach(() => { vi.restoreAllMocks(); memecoinAggregator.setConfluenceGating(true); });

/**
 * R10-8: in PAPER, a mistyped mint in Instant Snipe got an invented pool (price, MC, curve 45%, mint and freeze revoked, SAFE) that showed
 * in the Aggregator as a real, safe token with a live Snipe button. An unknown mint is now refused, and no pool is added.
 */
describe('R10-8: an unknown mint is refused in PAPER, with no invented pool', () => {
  it('manual snipe of an unknown mint: MARKET_DATA_UNAVAILABLE, nothing traded, nothing added to the pool list', async () => {
    memecoinAggregator.setConfluenceGating(false);
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('PAPER');
    const trade = vi.spyOn(executionCoordinator, 'executeTrade').mockResolvedValue({ success: false, error: 'stub' } as any);
    const mint = 'R108UnknownMint11111111111111111111111111111';
    const r = await memecoinAggregator.executeSnipe({ contractAddress: mint, amountUsd: 5 });
    expect(r.success).toBe(false);
    expect(r.message).toContain('MARKET_DATA_UNAVAILABLE');
    expect(trade).not.toHaveBeenCalled();
    const pools = (memecoinAggregator as any).pools as Array<{ contractAddress: string; id: string }>;
    expect(pools.some((p) => p.contractAddress === mint)).toBe(false);
    expect(pools.some((p) => p.id.startsWith('pool-simulated-'))).toBe(false);
  });
});
