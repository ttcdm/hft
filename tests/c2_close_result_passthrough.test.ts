import { describe, it, expect, afterEach, vi } from 'vitest';
import { executionCoordinator, isAdoptedPartialClose, type ClosePositionResult } from '../server/execution/coordinator';
import { walletTrader } from '../server/walletTrader';
import { memecoinAggregator } from '../server/memecoinAggregator';

/** R6-9: a close that only adopted an earlier partial says so through the routes' wrappers. closePosition is the stubbed boundary. */
describe('R6-9: the close wrappers pass on that a close only adopted a partial', () => {
  afterEach(() => vi.restoreAllMocks());
  const adopted: ClosePositionResult = { success: true, pnlSol: 0.01, status: 'PARTIALLY_CLOSED', outcome: 'ADOPTED_EARLIER_SELL', remainingTokensRaw: '670000000' };

  it('walletTrader.closePosition (POST /api/wallet/close) keeps the adopted outcome, the status and the remaining quantity', async () => {
    vi.spyOn(executionCoordinator, 'closePosition').mockResolvedValue(adopted);
    const r = await walletTrader.closePosition('pos-x', 100, 'Manual user order');
    expect(r).toMatchObject({ success: true, outcome: 'ADOPTED_EARLIER_SELL', status: 'PARTIALLY_CLOSED', remainingTokensRaw: '670000000' });
    expect(isAdoptedPartialClose(r)).toBe(true);
  });

  it('the aggregator close does not say "Closed 100%" for an adoption', async () => {
    vi.spyOn(executionCoordinator, 'closePosition').mockResolvedValue(adopted);
    const r = await memecoinAggregator.closePosition('pos-x', 100);
    expect(isAdoptedPartialClose(r)).toBe(true);
    expect(r.message).not.toMatch(/^Closed 100%/);
    expect(r.message).toMatch(/Tokens are still held \(PARTIALLY_CLOSED, 670000000 raw token units left\)/);
  });
});
