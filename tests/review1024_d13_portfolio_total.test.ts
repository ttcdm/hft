import { describe, it, expect, afterEach, vi } from 'vitest';
import { walletTrader } from '../server/walletTrader';
import { executionCoordinator } from '../server/execution/coordinator';
import { solPriceService } from '../server/market/solPriceService';

/**
 * Review 2026-10-24, finding 13: the portfolio total counted an open position with no mark as 0 (`currentValueSol ?? 0`) and still
 * showed a real number, and a NaN mark made the whole total NaN. Now the total is null while any open position has no finite mark.
 */
afterEach(() => {
  vi.restoreAllMocks();
  solPriceService.reset();
});

const withBalanceAndPositions = (walletSolBalance: number | null, active: Array<{ currentValueSol?: number }>) => {
  const real = executionCoordinator.getDiagnostics.bind(executionCoordinator);
  vi.spyOn(executionCoordinator, 'getDiagnostics').mockImplementation(() => ({ ...real(), walletSolBalance }));
  vi.spyOn(executionCoordinator, 'getPositions').mockImplementation((_mode?: any, status?: any) => (status === 'ACTIVE' ? (active as any) : []));
};

describe('review 2026-10-24 #13: the portfolio total is null while an open position is unpriced', () => {
  it.each([
    ['no mark yet (undefined)', undefined],
    ['a NaN mark', NaN],
    ['an infinite mark', Infinity],
  ])('one priced and one position with %s: the total is null, not the priced part alone', (_label, bad) => {
    solPriceService.setPrice(150, 'TEST_FIXTURE');
    withBalanceAndPositions(2, [{ currentValueSol: 0.5 }, { currentValueSol: bad }]);
    const s = walletTrader.getState();
    expect(s.solBalance).toBe(2); // the balance itself is still shown
    expect(s.totalPortfolioValueUsd).toBeNull();
  });

  it('every open position marked (recovered dust at 0 included): the total is the balance plus the marks', () => {
    solPriceService.setPrice(150, 'TEST_FIXTURE');
    withBalanceAndPositions(2, [{ currentValueSol: 0.5 }, { currentValueSol: 0 }]);
    expect(walletTrader.getState().totalPortfolioValueUsd).toBe(375); // (2 + 0.5 + 0) * 150
  });

  it('no open positions: the total is the balance alone', () => {
    solPriceService.setPrice(150, 'TEST_FIXTURE');
    withBalanceAndPositions(2, []);
    expect(walletTrader.getState().totalPortfolioValueUsd).toBe(300);
  });
});
