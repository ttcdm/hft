import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { autoSnipeController, AUTO_CANDIDATE_FAILED } from '../server/auto/controller';
import { workstationDb } from '../server/db/database';
import { buildSystemChecks } from '../server/system/systemChecks';
import { setAutoMode, resetAuto, newPumpPool } from './fixtures/auto';

/**
 * R14-9: a throw inside submitCandidate (a DB read failing, say) was dropped by `.catch(() => undefined)` at every caller: no log, no
 * decision row, no alert, so the operator never saw why a HOT launch was not bought. The real controller, database and System checks; only
 * the positions read throws (the DB boundary).
 */
describe('R14-9: a failed auto candidate is journaled and raised', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    autoSnipeController.detachWatchWindow();
    await resetAuto();
    if (autoSnipeController.getOperatorAlerts().length) autoSnipeController.acknowledgeOperatorAlert(AUTO_CANDIDATE_FAILED);
    vi.unstubAllEnvs();
  });

  it('a watch release whose handling throws leaves a CANDIDATE_ERROR row and an AUTO_CANDIDATE_FAILED alert', async () => {
    await setAutoMode('PAPER');
    const { mint } = newPumpPool();
    vi.spyOn(workstationDb, 'loadPositions').mockImplementation(() => { throw new Error('SQLITE_IOERR: disk I/O error'); });
    const ww = new EventEmitter();
    autoSnipeController.attachWatchWindow(ww);
    ww.emit('release', { state: 'HOT', metrics: { mint } });
    await vi.waitFor(() => {
      const rows = workstationDb.loadDecisions({ mint, outcome: 'REJECTED', limit: 10 });
      expect(rows.some((r) => /^CANDIDATE_ERROR: SQLITE_IOERR/.test(r.reason))).toBe(true);
    });
    vi.mocked(workstationDb.loadPositions).mockRestore();
    const checks = buildSystemChecks();
    const alert = checks.operatorAlerts.find((a) => a.code === AUTO_CANDIDATE_FAILED);
    expect(alert?.message).toMatch(/1 auto candidate\(s\) failed/);
    expect(alert?.acknowledgeable).toBe(true);
    expect(autoSnipeController.acknowledgeOperatorAlert(AUTO_CANDIDATE_FAILED).acknowledged).toBe(true);
    expect(buildSystemChecks().operatorAlerts.some((a) => a.code === AUTO_CANDIDATE_FAILED)).toBe(false);
  });

  it('submitCandidate resolves with the REJECTED decision instead of rejecting', async () => {
    await setAutoMode('PAPER');
    const { mint } = newPumpPool();
    vi.spyOn(workstationDb, 'loadPositions').mockImplementation(() => { throw new Error('SQLITE_BUSY: database is locked'); });
    const d = await autoSnipeController.submitCandidate({ mint, source: 'TEST', amountUsd: 1, provenance: 'REAL_ONCHAIN' });
    expect(d.outcome).toBe('REJECTED');
    expect(d.reason).toMatch(/^CANDIDATE_ERROR: SQLITE_BUSY/);
  });
});
