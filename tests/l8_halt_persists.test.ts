import { describe, it, expect, afterEach } from 'vitest';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';
import { auditWalletChange, WALLET_AUDIT_RENT_ALLOWANCE_SOL } from '../server/auto/killSwitch';
import { vi } from 'vitest';

/** L8 (report S13): HALT_ALL lived in memory only, so a restart quietly resumed trading after a suspected wallet drain. */
describe('L8: an all-trading halt survives a restart', () => {
  const made: ExecutionCoordinator[] = [];
  const make = (singleton: boolean) => { const c = new ExecutionCoordinator(singleton); made.push(c); return c; };
  afterEach(() => {
    vi.restoreAllMocks();
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
    const res = await restarted.closePosition('does-not-matter', 100, 'TAKE_PROFIT_1');
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

  it('R9: a halt raised by a script or test coordinator is not journaled, so it cannot halt the next real boot', () => {
    make(false).haltAll('script halt');
    expect(workstationDb.getPersistedHaltReason()).toBeNull();
    expect(make(true).getHaltReason()).toBeNull();
  });

  it('R12: a halt is visible: readiness lists it, and a restored halt raises an operator alert', () => {
    make(true).haltAll('wallet changed by an unexplained 0.4 SOL');
    const restarted = make(true);
    expect(restarted.canExecuteLive().reasons.join(' ')).toMatch(/All trading is halted: wallet changed by an unexplained 0.4 SOL/);
    expect(restarted.getOperatorAlerts().some((a) => a.code === 'TRADING_HALTED' && !a.cleared)).toBe(true);
  });

  it('a halt never blocks the exits that protect the wallet, and still blocks the discretionary ones', async () => {
    const c = make(false);
    c.haltAll('test halt');
    const impl = vi.spyOn(c as any, 'closePositionImpl').mockResolvedValue({ success: true, pnlSol: 0, status: 'CLOSED' });
    for (const reason of ['STOP_LOSS', 'TRAILING_STOP', 'MANUAL', 'Manual Close', 'EMERGENCY_PANIC_LIQUIDATION']) {
      const r = await c.closePosition('p1', 100, reason);
      expect(r.success, reason).toBe(true);
    }
    expect(impl).toHaveBeenCalledTimes(5);
    for (const reason of ['TAKE_PROFIT_1', 'TAKE_PROFIT_2', 'STALE_POSITION', 'Aggregator Close']) {
      const r = await c.closePosition('p1', 100, reason);
      expect(r.success, reason).toBe(false);
      expect(r.error, reason).toMatch(/TRADING_HALTED/);
    }
    expect(impl).toHaveBeenCalledTimes(5);
  });

  it('S2: the rent of the token account a buy opens does not read as an unexplained loss, but a real drain still does', () => {
    // the DEVNET_LIVE order is 0.005 SOL: the journal says the buy moved -0.005; the wallet also paid ~0.00204 SOL ATA rent
    const buy = { delta: -0.005, gross: 0.005, count: 1 };
    const after = 1.0 - 0.005 - 0.00204;
    expect(auditWalletChange(1.0, after, { delta: -0.005, gross: 0.005 }).explained).toBe(false); // the old accounting: this halted the first real buy
    expect(WALLET_AUDIT_RENT_ALLOWANCE_SOL).toBeGreaterThan(0.00204);
    expect(auditWalletChange(1.0, after, buy).explained).toBe(true);
    expect(auditWalletChange(1.0, after - 0.05, buy).explained).toBe(false); // a real 0.05 SOL drain on top still halts
  });
});
