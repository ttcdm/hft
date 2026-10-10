import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { autoSnipeController, SESSION_BUDGETS, PAPER_SESSION_BUDGETS } from '../server/auto/controller';
import { executionCoordinator } from '../server/execution/coordinator';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { setAutoMode, resetAuto, newPumpPool } from './fixtures/auto';

/** Q28: PAPER auto ran under the 0.02 SOL real-money cap, so a normal ~0.007 SOL paper order ended the session after two or three buys. */
describe('Q28: PAPER sessions have paper-sized budgets', () => {
  beforeEach(() => memecoinAggregator.setConfluenceGating(false));
  afterEach(async () => {
    memecoinAggregator.setConfluenceGating(true);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await resetAuto();
  });

  it('six real PAPER buys (each closed before the next, so the exposure limit is not the one tested) keep the controller in PAPER', async () => {
    await setAutoMode('PAPER');
    let bought = 0;
    for (let i = 0; i < 6; i++) {
      const { mint } = newPumpPool('HOT');
      const d = await autoSnipeController.submitCandidate({ mint, symbol: `P${i}`, source: 'TEST', amountUsd: 5, provenance: 'REAL_ONCHAIN' });
      expect(d.outcome, d.reason).toBe('BOUGHT');
      bought++;
      expect(autoSnipeController.getMode()).toBe('PAPER');
      await executionCoordinator.closePosition(d.positionId!, 100, 'MANUAL');
    }
    expect(bought).toBe(6);
    const s = autoSnipeController.getStatus();
    expect(s.session!.spentSol).toBeGreaterThan(SESSION_BUDGETS.maxSpendSol); // more than the real-SOL cap, which used to end the session
    expect(s.downgradeReason).toBeNull();
    expect(s.budgets.maxBuys).toBe(PAPER_SESSION_BUDGETS.maxBuys);
    expect(s.budgets.maxSpendSol).toBeCloseTo(PAPER_SESSION_BUDGETS.maxSpendBankrollMultiple * s.session!.startingBankrollSol, 9);
  });

  it('DEVNET_LIVE keeps the real-SOL budgets', async () => {
    expect(SESSION_BUDGETS.maxSpendSol).toBe(0.02);
    expect(SESSION_BUDGETS.maxBuys).toBe(5);
  });
});
