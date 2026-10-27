import { describe, it, expect, afterEach, vi } from 'vitest';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';

/** R7-9: the KILL_SWITCH_WAS_ON boot alert must say what happens at boot: auto starts OFF (it never "keeps its persisted mode"). */
describe('R7-9: the KILL_SWITCH_WAS_ON boot alert text', () => {
  afterEach(() => vi.restoreAllMocks());

  it('says auto is OFF, not that it keeps a persisted mode', () => {
    vi.spyOn(workstationDb, 'getPersistedHaltReason').mockReturnValue(null);
    vi.spyOn(workstationDb, 'getKillSwitchTripBeforeRestart').mockReturnValue('operator panic');
    vi.spyOn(workstationDb, 'logJournal').mockReturnValue(true);
    const c = new ExecutionCoordinator(true); // the boot path of the server's singleton; it starts nothing
    const alert = c.getOperatorAlerts().find((a) => a.code === 'KILL_SWITCH_WAS_ON')!;
    expect(alert.message).toMatch(/auto is OFF/);
    expect(alert.message).not.toMatch(/persisted mode/);
    c.cleanup();
  });
});
