import { describe, it, expect, vi, afterEach } from 'vitest';
import { autoSnipeController } from '../server/auto/controller';
import { executionCoordinator } from '../server/execution/coordinator';
import { riskEngine } from '../server/risk/riskEngine';
import { resetAuto } from './fixtures/auto';

/**
 * R12-3 (server half): setMode checked the halt but not the kill switch, so PAPER could be set while the kill switch was ON; its buys were
 * refused by the risk engine and nothing said so. Decision: PAPER and DEVNET_LIVE are refused with KILL_SWITCH_ACTIVE; SHADOW (buys
 * nothing) is allowed, and /api/auto/status says buys are refused by the kill switch. The real controller and risk engine.
 */
describe('R12-3: auto modes under the kill switch', () => {
  afterEach(async () => { riskEngine.setKillSwitch(false); await resetAuto(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('PAPER is refused KILL_SWITCH_ACTIVE while the kill switch is on', async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    riskEngine.setKillSwitch(true, 'r12-3');
    const r = await autoSnipeController.setMode('PAPER');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^KILL_SWITCH_ACTIVE/);
    expect(autoSnipeController.getMode()).toBe('OFF');
  });

  it('SHADOW is allowed, and the status says buys are refused by the kill switch', async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    riskEngine.setKillSwitch(true, 'r12-3');
    expect((await autoSnipeController.setMode('SHADOW')).ok).toBe(true);
    const st = autoSnipeController.getStatus();
    expect(st.killSwitchActive).toBe(true);
    expect(st.buysRefusedBy?.code).toBe('KILL_SWITCH_ACTIVE');
    riskEngine.setKillSwitch(false);
    expect(autoSnipeController.getStatus().buysRefusedBy).toBeNull();
    expect(autoSnipeController.getStatus().killSwitchActive).toBe(false);
  });

  it('a PAPER session that was running when the switch went on reports the refusal too', async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('PAPER');
    expect((await autoSnipeController.setMode('PAPER')).ok).toBe(true);
    riskEngine.setKillSwitch(true, 'r12-3 panic');
    expect(autoSnipeController.getStatus().buysRefusedBy?.message).toMatch(/kill switch is ON/);
  });
});
