import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { AutoSnipeController, DEVNET_CONFIRMATION_CODE } from '../server/auto/controller';
import { executionCoordinator, LIVE_BUY_FILLED } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { resetAuto, newPumpPool } from './fixtures/auto';

/**
 * R14-5: the DEVNET_LIVE spend was saved only after executeSnipe returned, and the worst-case list of unresolved buys lived in memory. A buy
 * that landed just before a crash was never counted, and the restart handed out a full budget on top of it. The real controller and
 * database; executeSnipe (the send) is the stub. A "crash" is a new controller on the same database.
 */
const savedSpend = () => (workstationDb.getSetting<{ spentSol: number }>('auto.liveSession')?.spentSol ?? 0);
const setLive = (c: AutoSnipeController) => c.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE });

describe('R14-5: a DEVNET_LIVE buy is counted and saved before it is sent', () => {
  beforeEach(() => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    vi.stubEnv('ALLOWED_CLUSTER', 'devnet');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    vi.spyOn(executionCoordinator, 'isLiveArmed').mockReturnValue(true);
    vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol').mockReturnValue(1);
    vi.spyOn(executionCoordinator, 'getUnresolvedLiveBuys').mockReturnValue({ mints: [], reservedSol: 0 });
    workstationDb.setSetting('auto.liveSession', null);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await resetAuto();
    vi.unstubAllEnvs();
  });

  it('the spend is on disk while the send is out; a crash then a restart still counts it, and recovery settles it', async () => {
    let atSend = -1;
    let crashNow!: () => void;
    const crashed = new Promise<void>((r) => { crashNow = r; });
    vi.spyOn(memecoinAggregator, 'executeSnipe').mockImplementation(async () => {
      atSend = savedSpend();
      crashNow();
      return new Promise(() => { /* the process dies before the send returns */ });
    });
    const before = new AutoSnipeController();
    expect((await setLive(before)).ok).toBe(true);
    const { mint } = newPumpPool();
    void before.submitCandidate({ mint, source: 'TEST', amountUsd: 1, provenance: 'REAL_ONCHAIN', slippagePct: 6 });
    await crashed;
    expect(atSend).toBeGreaterThan(0.005); // the order plus its worst-case extras, saved before the send

    const restarted = new AutoSnipeController();
    const r = await setLive(restarted);
    expect(r.ok, r.error).toBe(true);
    expect(restarted.getStatus().session!.spentSol).toBeCloseTo(atSend, 12);

    // recovery adopts the landed buy and journals what it took: the worst case is swapped for it
    workstationDb.logDecision({ autoMode: 'DEVNET_LIVE', mint, stage: 'fill', outcome: LIVE_BUY_FILLED, reason: 'recovered', positionId: 'sig-r14-5', solDelta: -0.0074 });
    expect(restarted.getStatus().session!.spentSol).toBeCloseTo(0.0074, 9);
    await restarted.setMode('OFF');
  });

  it('a buy refused before any send gives its reservation back', async () => {
    vi.spyOn(memecoinAggregator, 'executeSnipe').mockResolvedValue({ success: false, message: 'REJECTED: KILL_SWITCH_ACTIVE: the kill switch is on' } as any);
    const c = new AutoSnipeController();
    expect((await setLive(c)).ok).toBe(true);
    await c.submitCandidate({ mint: newPumpPool().mint, source: 'TEST', amountUsd: 1, provenance: 'REAL_ONCHAIN', slippagePct: 6 });
    expect(c.getStatus().session!.spentSol).toBe(0);
    expect(savedSpend()).toBe(0);
    await c.setMode('OFF');
  });
});
