import { describe, it, expect, vi, afterEach } from 'vitest';
import { autoSnipeController, DEVNET_CONFIRMATION_CODE } from '../server/auto/controller';
import { executionCoordinator } from '../server/execution/coordinator';
import { resetAuto } from './fixtures/auto';

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await resetAuto();
});

describe('S207: a kill trigger that drops DEVNET_LIVE to SHADOW also disarms the coordinator', () => {
  it('low wallet in DEVNET_LIVE -> SHADOW and armLiveTrading(false) is called', async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    vi.stubEnv('ALLOWED_CLUSTER', 'devnet');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    // P1.4: a DEVNET_LIVE session whose coordinator reports itself disarmed turns OFF before any trigger is judged, so the stand-in
    // for an armed LIVE coordinator must report armed too (until the trigger disarms it)
    let armed = true;
    vi.spyOn(executionCoordinator, 'isLiveArmed').mockImplementation(() => armed);
    vi.spyOn(executionCoordinator, 'syncRealWalletBalance').mockResolvedValue(null);
    const bal = vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol');
    bal.mockReturnValue(1);
    const ok = await autoSnipeController.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE });
    expect(ok.ok, ok.error).toBe(true);

    const realArm = executionCoordinator.armLiveTrading.bind(executionCoordinator);
    const disarm = vi.spyOn(executionCoordinator, 'armLiveTrading').mockImplementation((a, c) => { if (!a) armed = false; return realArm(a, c); });
    bal.mockReturnValue(0.019); // reserve 0.015 + one trade 0.005 -> WALLET_LOW
    const hits = await autoSnipeController.checkTriggers();
    expect(hits.map((h) => h.code)).toContain('WALLET_LOW');
    expect(autoSnipeController.getMode()).toBe('SHADOW');
    expect(disarm).toHaveBeenCalledWith(false);
    expect(executionCoordinator.isLiveArmed()).toBe(false);
  });

  it('a PAPER trip does not touch the coordinator arming', async () => {
    const { setAutoMode } = await import('./fixtures/auto');
    await setAutoMode('PAPER');
    const disarm = vi.spyOn(executionCoordinator, 'armLiveTrading');
    vi.spyOn(executionCoordinator, 'getLiveReadiness');
    (autoSnipeController as any).slippageBreaches = 2;
    const hits = await autoSnipeController.checkTriggers();
    expect(hits.length).toBeGreaterThan(0);
    expect(autoSnipeController.getMode()).toBe('SHADOW');
    expect(disarm).not.toHaveBeenCalled();
  });
});
