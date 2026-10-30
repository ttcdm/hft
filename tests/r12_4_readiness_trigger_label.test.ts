import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { autoSnipeController } from '../server/auto/controller';
import { executionCoordinator } from '../server/execution/coordinator';
import { buildSystemChecks } from '../server/system/systemChecks';
import { riskEngine } from '../server/risk/riskEngine';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { setAutoMode, resetAuto } from './fixtures/auto';

/**
 * R12-4: a readiness drop was labelled "Dropped to SHADOW: kill switch: READINESS_RED" while the kill switch was off, and setting auto OFF
 * kept READINESS_RED in the triggers, so System checks went on showing it. The real controller and System checks; readiness is the stub.
 */
const readiness = (rpcHealthy: boolean) => ({
  ready: rpcHealthy, reasons: rpcHealthy ? [] : ['rpc'], checkedAt: 0,
  components: {
    rpc: { healthy: rpcHealthy, latencyMs: 0, status: rpcHealthy ? 'HEALTHY' : 'DISCONNECTED' }, pumpFeed: { healthy: true, lastEventAgeMs: 0, status: 'HEALTHY' },
    markFeed: { healthy: true, lastMarkAgeMs: 0, status: 'HEALTHY' }, jito: { healthy: true, status: 'HEALTHY' },
    db: { healthy: true, status: 'HEALTHY' }, signer: { healthy: true, status: 'READY' },
  },
}) as any;

describe('R12-4: a readiness drop is an auto trigger, and OFF clears it', () => {
  beforeEach(() => { memecoinAggregator.setConfluenceGating(false); });
  afterEach(async () => { await resetAuto(); riskEngine.setKillSwitch(false); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('labels the drop "auto trigger", not "kill switch", and OFF empties the triggers', async () => {
    riskEngine.setKillSwitch(false);
    await setAutoMode('PAPER');
    vi.spyOn(executionCoordinator, 'getLiveReadiness').mockReturnValue(readiness(false));
    const t0 = Date.now();
    await autoSnipeController.checkTriggers(t0);
    await autoSnipeController.checkTriggers(t0 + 11_000);
    const st = autoSnipeController.getStatus();
    expect(st.mode).toBe('SHADOW');
    expect(st.downgradeReason).toMatch(/^auto trigger: READINESS_RED/);
    expect(st.downgradeReason).not.toMatch(/kill switch/);

    await autoSnipeController.setMode('OFF');
    expect(autoSnipeController.getStatus().triggers).toEqual([]);
    const row = buildSystemChecks().checks.find((c) => c.id === 'killswitch')!;
    expect(row.detail).not.toMatch(/READINESS_RED/);
  });
});
