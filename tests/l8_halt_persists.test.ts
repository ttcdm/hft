import { describe, it, expect, afterEach } from 'vitest';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';

/** L8 (report S13): HALT_ALL lived in memory only, so a restart quietly resumed trading after a suspected wallet drain. */
describe('L8: an all-trading halt survives a restart', () => {
  const made: ExecutionCoordinator[] = [];
  const make = (singleton: boolean) => { const c = new ExecutionCoordinator(singleton); made.push(c); return c; };
  afterEach(() => {
    while (made.length) made.pop()!.cleanup();
    new ExecutionCoordinator(true).cleanup();
    workstationDb.logJournal('TRADING_HALT_CLEARED', 'test-cleanup', 'PAPER', {});
  });

  it('a halt is journaled, restored by the next process, and refuses trades until an operator clears it', async () => {
    const first = make(true);
    first.haltAll('wallet changed by an unexplained 0.4 SOL');
    expect(workstationDb.getPersistedHaltReason()).toMatch(/unexplained 0.4 SOL/);

    const restarted = make(true); // what a restart builds: the default singleton
    expect(restarted.getHaltReason()).toMatch(/unexplained 0.4 SOL/);
    const res = await restarted.closePosition('does-not-matter', 100, 'MANUAL');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/TRADING_HALTED/);

    restarted.clearHalt();
    expect(workstationDb.getPersistedHaltReason()).toBeNull();
    expect(make(true).getHaltReason()).toBeNull();
  });

  it('only the default singleton restores a halt (test and script coordinators start clean)', () => {
    make(true).haltAll('persisted halt');
    expect(make(false).getHaltReason()).toBeNull();
  });
});
