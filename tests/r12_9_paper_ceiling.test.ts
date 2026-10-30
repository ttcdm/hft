import { describe, it, expect, afterEach, vi } from 'vitest';
import { executionCoordinator } from '../server/execution/coordinator';
import { executionConfig } from '../server/solana/executionConfig';

/**
 * R12-9: the PAPER order ceiling is 10% of the spendable paper bankroll (0.0055 SOL at the default 0.07), but every screen said 0.02
 * and the default 0.01 could never pass. The coordinator now gives the ceiling it enforces (paperOrderCeiling), /api/snipe/limits
 * sends it, and the amount box says it and warns when the amount is above it.
 */
describe('R12-9: the real PAPER ceiling is shown', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the coordinator gives the ceiling it enforces: 10% of (0.07 - 0.015) with no wallet read (none is read in this test process)', () => {
    expect(executionCoordinator.getRealWalletBalanceSol()).toBeNull();
    vi.spyOn(executionConfig, 'getConfig').mockReturnValue({ ...executionConfig.getConfig(), paperBankrollSol: 0.07 });
    expect(executionCoordinator.paperOrderCeiling().ceilingSol).toBeCloseTo(0.0055, 9);
  });

});
