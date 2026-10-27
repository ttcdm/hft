import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { autoSnipeController, DEVNET_CONFIRMATION_CODE } from '../server/auto/controller';
import { executionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';
import { riskEngine } from '../server/risk/riskEngine';
import { resetAuto } from './fixtures/auto';

/**
 * R3-1 (+R5-17): a wallet-audit HALT ALL left LIVE armed and did not persist the kill, setMode('DEVNET_LIVE') was accepted while halted,
 * and a read-only server accepted "Resume with clearHalt" (its TRADING_HALT_CLEARED row made the next signed boot forget the halt).
 */
describe('R3-1: a wallet-audit halt is a stop that means what it says', () => {
  beforeEach(() => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    vi.stubEnv('ALLOWED_CLUSTER', 'devnet');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    vi.spyOn(executionCoordinator, 'isLiveArmed').mockReturnValue(true);
    vi.spyOn(executionCoordinator, 'syncRealWalletBalance').mockResolvedValue(null);
    vi.spyOn(executionCoordinator, 'getUnresolvedLiveBuys').mockReturnValue({ mints: [], reservedSol: 0 });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await resetAuto();
    executionCoordinator.clearHalt();
    riskEngine.setKillSwitch(false);
    workstationDb.setSetting('auto.kill', null);
    vi.unstubAllEnvs();
  });

  async function haltByAudit(): Promise<ReturnType<typeof vi.spyOn>> {
    const bal = vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol').mockReturnValue(1);
    const ok = await autoSnipeController.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE });
    expect(ok.ok, ok.error).toBe(true);
    const t0 = Date.now();
    await autoSnipeController.auditWallet(t0);
    bal.mockReturnValue(0.6); // 0.4 SOL gone, nothing journaled
    const r = await autoSnipeController.auditWallet(t0 + 5);
    expect(r?.explained).toBe(false);
    return bal;
  }

  it('the audit halt disarms LIVE and persists the kill', async () => {
    const arm = vi.spyOn(executionCoordinator, 'armLiveTrading');
    await haltByAudit();
    expect(executionCoordinator.getHaltReason()).toMatch(/unexplained/);
    expect(arm).toHaveBeenCalledWith(false);
    const saved = workstationDb.getSetting<{ reason: string }>('auto.kill');
    expect(saved?.reason).toMatch(/unexplained/);
    expect(workstationDb.getSetting('auto.mode')).toBe('OFF');
  });

  it('setMode(DEVNET_LIVE) is refused while a halt is set, and works again once it is cleared', async () => {
    await haltByAudit();
    const again = await autoSnipeController.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE });
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/TRADING_HALTED/);
    expect(autoSnipeController.getMode()).toBe('OFF');
    expect(autoSnipeController.getStatus().killed).toBe(true); // the kill is not cleared by the refused attempt
    executionCoordinator.clearHalt();
    const ok = await autoSnipeController.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE });
    expect(ok.ok, ok.error).toBe(true);
  });

  it('R5-17: a read-only server refuses "Resume with clearHalt" and writes no TRADING_HALT_CLEARED row', async () => {
    await haltByAudit();
    vi.stubEnv('APEX_READ_ONLY', 'true');
    const r = autoSnipeController.resume({ clearHalt: true });
    expect(r.halted).toBe(true);
    expect(r.clearHaltRefused).toMatch(/READ_ONLY/);
    expect(executionCoordinator.getHaltReason()).toMatch(/unexplained/);
    expect(workstationDb.getPersistedHaltReason()).toMatch(/unexplained/);
  });
});
