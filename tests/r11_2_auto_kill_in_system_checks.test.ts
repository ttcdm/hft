import { describe, it, expect, afterEach, vi } from 'vitest';
import { autoSnipeController } from '../server/auto/controller';
import { buildSystemChecks } from '../server/system/systemChecks';
import { riskEngine } from '../server/risk/riskEngine';
import { workstationDb } from '../server/db/database';
import { resetAuto } from './fixtures/auto';

/**
 * R11-2: after KILL AUTO, /api/auto/status said killed:true but the System checks kill-switch row said OK "no auto kill trigger set": it
 * read only the risk kill switch and the breaker. The real controller and System checks.
 */
describe('R11-2: System checks shows the auto kill latch', () => {
  afterEach(async () => {
    await resetAuto();
    workstationDb.setSetting('auto.kill', null);
    riskEngine.setKillSwitch(false);
    vi.unstubAllEnvs();
  });

  it('after KILL AUTO the kill-switch row is not OK and names the auto kill', async () => {
    riskEngine.setKillSwitch(false);
    await autoSnipeController.kill({ reason: 'r11-2 operator kill' });
    const row = buildSystemChecks().checks.find((c) => c.id === 'killswitch')!;
    expect(row.status).toBe('WARN');
    expect(row.value).toMatch(/auto KILLED/);
    expect(row.detail).toMatch(/AUTO KILLED: r11-2 operator kill/);
  });

  it('with no kill at all the row stays OK', async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    await autoSnipeController.setMode('SHADOW'); // an operator setting a mode clears the auto kill
    await autoSnipeController.setMode('OFF');
    const row = buildSystemChecks().checks.find((c) => c.id === 'killswitch')!;
    expect(row.status).toBe('OK');
    expect(row.detail).not.toMatch(/AUTO KILLED/);
  });
});
