import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { walletTrader } from '../server/walletTrader';
import { executionCoordinator } from '../server/execution/coordinator';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { solPriceService } from '../server/market/solPriceService';
import { newPumpPool } from './fixtures/auto';

afterEach(() => { vi.restoreAllMocks(); memecoinAggregator.setConfluenceGating(true); });

/**
 * From the 2026-10-26 click-through (overnight/reports/click-through-2026-10-26). Fails on c47125e without its fix.
 * R5-40: the Plug & Play buy now goes through executeSnipe, which names the order from the pool it trades against; a mint with no real
 * pool is refused (no synthetic pool) instead of being sent under its address prefix.
 */
describe('UI-3: a Plug & Play snipe of a mint on the board keeps the board symbol', () => {
  it('known mint: symbol and name from the board; a mint with no real pool is not traded', async () => {
    solPriceService.setPrice(150, 'TEST_FIXTURE');
    memecoinAggregator.setConfluenceGating(false);
    const trade = vi.spyOn(executionCoordinator, 'executeTrade').mockResolvedValue({ success: false, error: 'stub' } as any);
    const { mint, pool } = newPumpPool('NONE');
    await walletTrader.executeLiveSnipe({ mint, amountSol: 0.01 });
    expect(trade.mock.calls[0][0]).toMatchObject({ symbol: pool.symbol, name: pool.name });
    const unknown = await walletTrader.executeLiveSnipe({ mint: Keypair.generate().publicKey.toBase58(), amountSol: 0.01 });
    expect(unknown.success).toBe(false);
    expect(unknown.error).toMatch(/MARKET_DATA_UNAVAILABLE/);
    expect(trade).toHaveBeenCalledTimes(1);
  });
});
