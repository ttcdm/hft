import { describe, it, expect, vi, afterEach } from 'vitest';
import { walletTrader } from '../server/walletTrader';
import { executionCoordinator } from '../server/execution/coordinator';
import { memecoinAggregator } from '../server/memecoinAggregator';

afterEach(() => vi.restoreAllMocks());

/** From the 2026-10-26 click-through (overnight/reports/click-through-2026-10-26). Fails on c47125e without its fix. */
describe('UI-3: a Plug & Play snipe of a mint on the board keeps the board symbol', () => {
  it('known mint: symbol and name from the board; unknown mint: the prefix as before', async () => {
    const trade = vi.spyOn(executionCoordinator, 'executeTrade').mockResolvedValue({ success: false, error: 'stub' } as any);
    vi.spyOn(memecoinAggregator, 'getPools').mockReturnValue([{ contractAddress: 'CtaMint1111111111111111111111111111111111111', symbol: 'CTA', name: 'Clickthrough CTA' }] as any);
    await walletTrader.executeLiveSnipe({ mint: 'CtaMint1111111111111111111111111111111111111', amountSol: 0.01 });
    expect(trade.mock.calls[0][0]).toMatchObject({ symbol: 'CTA', name: 'Clickthrough CTA' });
    await walletTrader.executeLiveSnipe({ mint: 'Unkn0wnMint111111111111111111111111111111111', amountSol: 0.01 });
    expect(trade.mock.calls[1][0]).toMatchObject({ symbol: 'UNKN0W' });
  });
});
