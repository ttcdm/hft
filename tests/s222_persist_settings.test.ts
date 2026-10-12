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
});

describe('S222: the operator\'s threshold and auto mode survive a restart', () => {
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

  it('PAPER comes back as PAPER', async () => {
    await setAutoMode('PAPER');
    expect(workstationDb.getSetting('auto.mode')).toBe('PAPER');
    simulateRestart();
    expect(autoSnipeController.getMode()).toBe('OFF');
    const r = await autoSnipeController.restorePersisted();
    expect(r.mode).toBe('PAPER');
    expect(autoSnipeController.getMode()).toBe('PAPER');
  });

  it('SHADOW comes back as SHADOW, and a kill (OFF) comes back OFF', async () => {
    await setAutoMode('SHADOW');
    simulateRestart();
    await autoSnipeController.restorePersisted();
    expect(autoSnipeController.getMode()).toBe('SHADOW');
    await autoSnipeController.kill({ reason: 'test' });
    expect(workstationDb.getSetting('auto.mode')).toBe('OFF');
    simulateRestart();
    await autoSnipeController.restorePersisted();
    expect(autoSnipeController.getMode()).toBe('OFF');
  });

  it('a saved DEVNET_LIVE comes back as SHADOW, never as live sending, and says why', async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    workstationDb.setSetting('auto.mode', 'DEVNET_LIVE');
    simulateRestart();
    const r = await autoSnipeController.restorePersisted();
    expect(r.mode).toBe('SHADOW');
    expect(autoSnipeController.getMode()).toBe('SHADOW');
    expect(executionCoordinator.isLiveArmed()).toBe(false);
    expect(autoSnipeController.getStatus().downgradeReason).toMatch(/DEVNET_LIVE.*SHADOW/);
    expect(workstationDb.getSetting('auto.mode')).toBe('SHADOW'); // and the saved value no longer says DEVNET_LIVE
  });

  it('without AUTO_SNIPE_ENABLED=true the mode is not restored', async () => {
    workstationDb.setSetting('auto.mode', 'PAPER');
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'false');
    simulateRestart();
    const r = await autoSnipeController.restorePersisted();
    expect(r.mode).toBe('OFF');
    expect(r.note).toMatch(/could not restore/);
  });

  it('a kill trigger that drops PAPER to SHADOW is what comes back', async () => {
    await setAutoMode('PAPER');
    (autoSnipeController as any).slippageBreaches = 2;
    await autoSnipeController.checkTriggers();
    expect(autoSnipeController.getMode()).toBe('SHADOW');
    expect(workstationDb.getSetting('auto.mode')).toBe('SHADOW');
  });
});
