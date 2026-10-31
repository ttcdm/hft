import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { AutoSnipeController, DEVNET_CONFIRMATION_CODE } from '../server/auto/controller';
import { executionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';
import { HardenedRiskEngine, DAILY_LOSS_LATCH_SETTING } from '../server/risk/riskEngine';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { resetAuto } from './fixtures/auto';

/**
 * R14-4: getSetting answered null for a failed read too, so a busy or broken app_settings read looked like "nothing saved". The DEVNET_LIVE
 * session then restarted at 0 SOL and was saved over the real spend; the daily-loss latch and the auto kill were dropped at boot.
 * The real controller, risk engine and database; only the SQLite read of one app_settings key is made to throw (the DB boundary).
 */
function failReadOf(key: string): void {
  const db = (workstationDb as any).db;
  const real = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation((...args: unknown[]) => {
    const sql = String(args[0]);
    const stmt = real(sql);
    if (!/^SELECT value_json FROM app_settings WHERE key = \?/.test(sql)) return stmt;
    return new Proxy(stmt, {
      get(target, prop) {
        if (prop === 'get') return (k: string) => { if (k === key) throw new Error('SQLITE_BUSY: database is locked'); return target.get(k); };
        const v = (target as any)[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  });
}

describe('R14-4: a failed settings read is not "nothing saved"', () => {
  beforeEach(() => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    vi.stubEnv('ALLOWED_CLUSTER', 'devnet');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    vi.spyOn(executionCoordinator, 'isLiveArmed').mockReturnValue(true);
    vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol').mockReturnValue(1);
    vi.spyOn(executionCoordinator, 'getUnresolvedLiveBuys').mockReturnValue({ mints: [], reservedSol: 0 });
    vi.spyOn(memecoinAggregator, 'executeSnipe').mockResolvedValue({ success: false, message: 'UNCONFIRMED: no confirmation before timeout', txHash: '' });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await resetAuto();
    workstationDb.setSetting('auto.kill', null);
    workstationDb.setSetting(DAILY_LOSS_LATCH_SETTING, null);
    vi.unstubAllEnvs();
  });

  it('DEVNET_LIVE is refused SESSION_UNREADABLE, and the saved spend is not overwritten', async () => {
    const saved = { startedAt: Date.now() - 60_000, startingBankrollSol: 1, buys: 3, spentSol: 0.0189, positionIds: [] };
    workstationDb.setSetting('auto.liveSession', saved);
    failReadOf('auto.liveSession');
    const r = await new AutoSnipeController().setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/SESSION_UNREADABLE/);
    vi.restoreAllMocks();
    expect(workstationDb.getSetting('auto.liveSession')).toEqual(saved);
  });

  it('a readable but absent session still starts a new one (the guard is for failed reads only)', async () => {
    workstationDb.setSetting('auto.liveSession', null);
    const c = new AutoSnipeController();
    const r = await c.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE });
    expect(r.ok, r.error).toBe(true);
    expect(c.getStatus().session!.spentSol).toBe(0);
    await c.setMode('OFF');
  });

  it('an unreadable auto kill at boot keeps auto killed', async () => {
    workstationDb.setSetting('auto.kill', null);
    failReadOf('auto.kill');
    const c = new AutoSnipeController();
    const r = await c.restorePersisted();
    expect(c.getStatus().killed).toBe(true);
    expect(c.getStatus().killReason).toMatch(/could not be read/);
    expect(r.mode).toBe('OFF');
  });

  it('an unreadable daily-loss latch at boot latches LIVE and PAPER', () => {
    failReadOf(DAILY_LOSS_LATCH_SETTING);
    const engine = new HardenedRiskEngine({ persistent: true });
    expect(engine.getDailyLossLatch('LIVE')?.message).toMatch(/could not be read/);
    expect(engine.getDailyLossLatch('PAPER')).not.toBeNull();
  });
});
