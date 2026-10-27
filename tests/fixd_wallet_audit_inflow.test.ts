import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { auditWalletChange } from '../server/auto/killSwitch';
import { autoSnipeController, DEVNET_CONFIRMATION_CODE } from '../server/auto/controller';
import { executionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';
import { riskEngine } from '../server/risk/riskEngine';
import { resetAuto } from './fixtures/auto';

/**
 * R8-1: anyone who sent the bot's wallet ~0.0006 SOL halted DEVNET_LIVE with HALT ALL (the audit took the absolute value of any
 * unexplained change). R7-5: proceeds of a sell whose outcome is unknown arrive before their journal row. R5-25: the audit window was
 * stamped before the balance read, so a fill journaled during the read looked unexplained.
 */
describe('R8-1: only unexplained outflows halt (pure rule)', () => {
  it('an inbound deposit is explained as an inflow; a drain still is not', () => {
    const dep = auditWalletChange(1, 1.0006, { delta: 0, gross: 0 });
    expect(dep.explained).toBe(true);
    expect(dep.inflowSol).toBeCloseTo(0.0006, 9);
    const big = auditWalletChange(1, 3, { delta: 0, gross: 0 });
    expect(big.explained).toBe(true);
    expect(big.inflowSol).toBeCloseTo(2, 9);
    const drain = auditWalletChange(1, 0.9994, { delta: 0, gross: 0 });
    expect(drain.explained).toBe(false);
    expect(drain.inflowSol).toBe(0);
    expect(auditWalletChange(1, 0.9998, { delta: 0, gross: 0 }).inflowSol).toBe(0); // inside the tolerance: nothing to log
  });
});

describe('R8-1 / R7-5 / R5-25: the DEVNET_LIVE wallet audit', () => {
  let bal: ReturnType<typeof vi.spyOn>;
  let pendingSells: Array<{ signature: string; mint: string; direction: string; executionMode: string }> = [];
  beforeEach(async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    vi.stubEnv('ALLOWED_CLUSTER', 'devnet');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    vi.spyOn(executionCoordinator, 'isLiveArmed').mockReturnValue(true);
    vi.spyOn(executionCoordinator, 'syncRealWalletBalance').mockResolvedValue(null);
    vi.spyOn(executionCoordinator, 'getUnresolvedLiveBuys').mockReturnValue({ mints: [], reservedSol: 0 });
    pendingSells = [];
    const real = workstationDb.loadTransactionsInStates.bind(workstationDb);
    vi.spyOn(workstationDb, 'loadTransactionsInStates').mockImplementation((states: string[]) => [...real(states), ...(pendingSells as any)]);
    bal = vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol').mockReturnValue(1);
    const ok = await autoSnipeController.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE });
    expect(ok.ok, ok.error).toBe(true);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await resetAuto();
    executionCoordinator.clearHalt();
    riskEngine.setKillSwitch(false);
    workstationDb.setSetting('auto.kill', null);
    vi.unstubAllEnvs();
  });

  it('a deposit does not halt; it is journaled and becomes the new baseline, so a later drain still halts', async () => {
    const t0 = Date.now();
    await autoSnipeController.auditWallet(t0);
    bal.mockReturnValue(1.0006); // the attack: 0.0006 SOL sent to the wallet
    const r = await autoSnipeController.auditWallet(t0 + 5);
    expect(r?.explained).toBe(true);
    expect(executionCoordinator.getHaltReason()).toBeNull();
    expect(autoSnipeController.getMode()).toBe('DEVNET_LIVE');
    const rows = workstationDb.loadDecisions({ outcome: 'WALLET_INFLOW', sinceTs: t0 - 1 });
    expect(rows.length).toBe(1);
    expect(rows[0].solDelta).toBeNull(); // logged, never a journaled fill (it must not explain a later move)

    bal.mockReturnValue(1.0006 - 0.3); // drained from the new baseline
    const bad = await autoSnipeController.auditWallet(t0 + 10);
    expect(bad?.explained).toBe(false);
    expect(executionCoordinator.getHaltReason()).toMatch(/unexplained/);
  });

  it('R7-5: proceeds of a pending sell are held (the mark is kept), so its journal row explains them later and nothing halts', async () => {
    const t0 = Date.now();
    await autoSnipeController.auditWallet(t0);
    pendingSells = [{ signature: 'pending-sell-sig', mint: 'm', direction: 'SELL', executionMode: 'LIVE' }];
    bal.mockReturnValue(1.004); // the take-profit landed; adoption has not journaled it yet
    expect((await autoSnipeController.auditWallet(t0 + 5))?.explained).toBe(true);
    // adoption journals the proceeds; the wallet does not move again
    pendingSells = [];
    workstationDb.logDecision({ ts: t0 + 6, autoMode: 'n/a', mint: 'm', stage: 'exit', outcome: 'EXITED', reason: 'adopted sell', solDelta: 0.004 });
    const after = await autoSnipeController.auditWallet(t0 + 10);
    expect(after?.explained).toBe(true);
    expect(executionCoordinator.getHaltReason()).toBeNull();
  });

  it('R5-25: a fill journaled while the balance is read is inside the window', async () => {
    await autoSnipeController.auditWallet();
    (executionCoordinator.syncRealWalletBalance as any).mockImplementation(async () => {
      // a buy confirms during the read: its row and its balance change both land now
      await new Promise((r) => setTimeout(r, 5));
      workstationDb.logDecision({ autoMode: 'n/a', mint: 'm2', stage: 'fill', outcome: 'LIVE_BUY_FILLED', reason: 'during the read', solDelta: -0.005 });
      bal.mockReturnValue(0.995);
      return null;
    });
    await new Promise((r) => setTimeout(r, 2));
    const r = await autoSnipeController.auditWallet();
    expect(r?.explained).toBe(true);
    expect(executionCoordinator.getHaltReason()).toBeNull();
  });
});
