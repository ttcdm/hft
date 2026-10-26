import { describe, it, expect, vi, afterEach } from 'vitest';
import { PumpFunService } from '../server/pumpfunService';

/**
 * Placeholder inventory B4 (patch set F): "Force Live Sync" (POST /api/pumpfun/refresh) fetched the mainnet pump.fun and DexScreener feeds on any cluster, skipping the P4.2 check the pollers have. Fails on the code before the fix.
 */
afterEach(() => vi.restoreAllMocks());

describe('B4: a manual live sync fetches the mainnet feeds only on mainnet-beta', () => {
  const offline = () => vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));

  it('on devnet (and localnet) nothing is fetched and the reason is returned', async () => {
    const svc = new PumpFunService();
    const fetchSpy = offline();
    for (const cluster of ['devnet', 'localnet']) {
      const res = await svc.syncRealWorldData({ evaluateTriggers: false, env: { ALLOWED_CLUSTER: cluster } });
      expect(res.skipped).toMatch(/HTTP_FEEDS_MAINNET_ONLY/);
    }
    // the process env of the test run is devnet: the default call is refused too
    expect((await svc.syncRealWorldData({ evaluateTriggers: false })).skipped).toMatch(/devnet/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('on mainnet-beta it still fetches', async () => {
    const svc = new PumpFunService();
    const fetchSpy = offline();
    const res = await svc.syncRealWorldData({ evaluateTriggers: false, env: { ALLOWED_CLUSTER: 'mainnet-beta' } });
    expect(res.skipped).toBeUndefined();
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes('frontend-api-v3.pump.fun'))).toBe(true);
  });
});
