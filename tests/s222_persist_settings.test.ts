import { describe, it, expect, vi, afterEach } from 'vitest';
import { autoSnipeController } from '../server/auto/controller';
import { executionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';
import { getConfluenceThreshold, resetConfluenceThreshold } from '../server/signals/confluenceThreshold';
import { setAutoMode, resetAuto } from './fixtures/auto';

/** What a restart does to the controller: memory is gone, the database stays. */
function simulateRestart(): void {
  const c = autoSnipeController as any;
  c.mode = 'OFF';
  c.session = null;
  c.downgradeReason = null;
  resetConfluenceThreshold();
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await resetAuto();
  resetConfluenceThreshold();
  workstationDb.setSetting('auto.confluenceThreshold', null);
  workstationDb.setSetting('auto.mode', null);
  workstationDb.setSetting('auto.kill', null); // 3E: a kill is saved too, and keeps auto OFF across the next restore
});

describe('S222: the operator\'s threshold survives a restart; 3E: the auto mode does not (OFF at every start)', () => {
  it('the confluence threshold is saved and comes back', async () => {
    expect(autoSnipeController.setConfluenceThreshold(60).ok).toBe(true);
    expect(workstationDb.getSetting('auto.confluenceThreshold')).toBe(60);
    simulateRestart();
    expect(getConfluenceThreshold()).toBe(70); // the source default, as the Mac saw after its restart
    const r = await autoSnipeController.restorePersisted();
    expect(r.threshold).toBe(60);
    expect(getConfluenceThreshold()).toBe(60);
  });

  it('a rejected threshold is not saved, and a bad saved value is ignored', async () => {
    expect(autoSnipeController.setConfluenceThreshold(150).ok).toBe(false);
    expect(workstationDb.getSetting('auto.confluenceThreshold')).toBeNull();
    workstationDb.setSetting('auto.confluenceThreshold', 'banana');
    const r = await autoSnipeController.restorePersisted();
    expect(r.threshold).toBeNull();
    expect(getConfluenceThreshold()).toBe(70);
  });

  it('3E: a saved PAPER is reported and auto starts OFF; the saved value is set to OFF', async () => {
    await setAutoMode('PAPER');
    expect(workstationDb.getSetting('auto.mode')).toBe('PAPER');
    simulateRestart();
    expect(autoSnipeController.getMode()).toBe('OFF');
    const r = await autoSnipeController.restorePersisted();
    expect(r.mode).toBe('OFF');
    expect(r.note).toMatch(/last run was in PAPER; auto starts OFF/);
    expect(autoSnipeController.getMode()).toBe('OFF');
    expect(workstationDb.getSetting('auto.mode')).toBe('OFF');
  });

  it('3E: a saved SHADOW starts OFF too, and a kill (OFF) comes back OFF', async () => {
    await setAutoMode('SHADOW');
    simulateRestart();
    await autoSnipeController.restorePersisted();
    expect(autoSnipeController.getMode()).toBe('OFF');
    await setAutoMode('SHADOW');
    await autoSnipeController.kill({ reason: 'test' });
    expect(workstationDb.getSetting('auto.mode')).toBe('OFF');
    simulateRestart();
    await autoSnipeController.restorePersisted();
    expect(autoSnipeController.getMode()).toBe('OFF');
  });

  it('3E: a saved DEVNET_LIVE starts OFF, never as live sending, and says why', async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    workstationDb.setSetting('auto.mode', 'DEVNET_LIVE');
    simulateRestart();
    const r = await autoSnipeController.restorePersisted();
    expect(r.mode).toBe('OFF');
    expect(autoSnipeController.getMode()).toBe('OFF');
    expect(executionCoordinator.isLiveArmed()).toBe(false);
    expect(r.note).toMatch(/last run was in DEVNET_LIVE.*confirmation code/);
    expect(workstationDb.getSetting('auto.mode')).toBe('OFF'); // and the saved value no longer says DEVNET_LIVE
  });

  it('without AUTO_SNIPE_ENABLED=true the mode is not restored', async () => {
    workstationDb.setSetting('auto.mode', 'PAPER');
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'false');
    simulateRestart();
    const r = await autoSnipeController.restorePersisted();
    expect(r.mode).toBe('OFF');
    expect(r.note).toMatch(/auto starts OFF/);
  });

  it('a kill trigger that drops PAPER to SHADOW is what comes back', async () => {
    await setAutoMode('PAPER');
    (autoSnipeController as any).slippageBreaches = 2;
    await autoSnipeController.checkTriggers();
    expect(autoSnipeController.getMode()).toBe('SHADOW');
    expect(workstationDb.getSetting('auto.mode')).toBe('SHADOW');
  });
});
