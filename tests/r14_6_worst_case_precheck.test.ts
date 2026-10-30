import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { AutoSnipeController, DEVNET_CONFIRMATION_CODE, worstCaseAutoBuySol, BUY_FEE_ALLOWANCE_LAMPORTS } from '../server/auto/controller';
import { executionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { CapitalSizer } from '../server/capital/capitalSizer';
import { PUMP_USER_VOLUME_ACCUMULATOR_RENT_LAMPORTS } from '../server/risk/riskEngine';
import { resetAuto, newPumpPool } from './fixtures/auto';

/**
 * R14-6: the DEVNET_LIVE pre-check compared spent + order with the cap, but the spend counted afterwards adds the token-account rent, the
 * accumulator rent, the tip and the fees. A session at 0.014 SOL passed with a 0.005 SOL order and ended near 0.0225 against a 0.02 cap.
 * The real controller; executeSnipe (the send) is the stub.
 */
describe('R14-6: the DEVNET_LIVE pre-check counts the worst case of the next buy', () => {
  beforeEach(() => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    vi.stubEnv('ALLOWED_CLUSTER', 'devnet');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    vi.spyOn(executionCoordinator, 'isLiveArmed').mockReturnValue(true);
    vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol').mockReturnValue(1);
    vi.spyOn(executionCoordinator, 'getUnresolvedLiveBuys').mockReturnValue({ mints: [], reservedSol: 0 });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await resetAuto();
    vi.unstubAllEnvs();
  });

  it('the worst case is order + slippage + fee allowance + both rents (+ the capped tip with Jito on)', () => {
    const rent = (CapitalSizer.SPL_TOKEN_ACCOUNT_RENT_LAMPORTS + PUMP_USER_VOLUME_ACCUMULATOR_RENT_LAMPORTS) / 1e9;
    expect(worstCaseAutoBuySol(0.005, 6, false)).toBeCloseTo(0.0053 + BUY_FEE_ALLOWANCE_LAMPORTS / 1e9 + rent, 12);
    expect(worstCaseAutoBuySol(0.005, 6, true)).toBeCloseTo(0.0053 + 0.00075 + BUY_FEE_ALLOWANCE_LAMPORTS / 1e9 + rent, 12);
  });

  it('a session at 0.014 SOL is not sent a 0.005 SOL order against the 0.02 SOL cap', async () => {
    const snipe = vi.spyOn(memecoinAggregator, 'executeSnipe').mockResolvedValue({ success: false, message: 'UNCONFIRMED: no confirmation before timeout', txHash: '' });
    workstationDb.setSetting('auto.liveSession', null);
    const c = new AutoSnipeController();
    expect((await c.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE })).ok).toBe(true);
    (c as any).session.spentSol = 0.014;
    const d = await c.submitCandidate({ mint: newPumpPool().mint, source: 'TEST', amountUsd: 1, provenance: 'REAL_ONCHAIN', slippagePct: 6 });
    expect(d.outcome).toBe('REJECTED');
    expect(d.stage).toBe('budget');
    expect(d.reason).toMatch(/would exceed the session spend limit/);
    expect(snipe).not.toHaveBeenCalled();
    await c.setMode('OFF');
  });

  it('setting DEVNET_LIVE again on that session is refused SESSION_BUDGET_USED', async () => {
    workstationDb.setSetting('auto.liveSession', { startedAt: Date.now() - 60_000, startingBankrollSol: 1, buys: 2, spentSol: 0.014, positionIds: [] });
    const r = await new AutoSnipeController().setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/SESSION_BUDGET_USED/);
  });
});
