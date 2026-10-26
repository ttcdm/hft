import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExecutionCoordinator } from '../server/execution/coordinator';

/**
 * F3: seen twice on devnet on 2026-10-10. When the first RPC connect at boot fails, startup reconciliation never ran, and
 * can-arm said "Startup reconciliation is in progress" until someone called POST /api/execution/reconcile by hand.
 * The test RPC is the closed loopback port from vitest.config.ts, so the real boot connect fails here.
 */
describe('F3: startup reconciliation runs once the RPC comes back after a failed boot connect', () => {
  const made: ExecutionCoordinator[] = [];
  const make = () => { const c = new ExecutionCoordinator(); made.push(c); return c; };
  afterEach(() => { vi.restoreAllMocks(); while (made.length) made.pop()!.cleanup(); });

  async function bootFailedThenRecover() {
    const coord = make();
    await vi.waitFor(() => expect((coord as any).bootConnectFailed).toBe(true), { timeout: 10_000 });
    expect((coord as any).lastStartupReconciliation).toBeNull();
    // The RPC is back and on the allowed cluster.
    vi.spyOn((coord as any).connection, 'getSlot').mockResolvedValue(1000);
    vi.spyOn(coord as any, 'verifyCluster').mockResolvedValue(true);
    const sync = vi.spyOn(coord as any, 'syncRealWalletBalance').mockResolvedValue(undefined);
    const run = vi.spyOn(coord as any, 'runStartupReconciliation').mockResolvedValue({ status: 'EXECUTION_READY', mismatchesCount: 0, details: 'ok' });
    const heartbeat = () => {
      clearInterval((coord as any).feedHeartbeatInterval);
      (coord as any).startMarketFeedHeartbeat(); // runs one heartbeat now
    };
    return { coord, sync, run, heartbeat };
  }

  it('the first healthy heartbeat syncs the wallet and runs reconciliation once', async () => {
    const { sync, run, heartbeat } = await bootFailedThenRecover();
    heartbeat();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(sync).toHaveBeenCalled();
  });

  it('later heartbeats do not start it again', async () => {
    const { run, heartbeat } = await bootFailedThenRecover();
    heartbeat();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    heartbeat();
    heartbeat();
    await new Promise((r) => setTimeout(r, 50));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('nothing runs while the RPC is still down', async () => {
    const coord = make();
    await vi.waitFor(() => expect((coord as any).bootConnectFailed).toBe(true), { timeout: 10_000 });
    const run = vi.spyOn(coord as any, 'runStartupReconciliation');
    clearInterval((coord as any).feedHeartbeatInterval);
    (coord as any).startMarketFeedHeartbeat();
    await new Promise((r) => setTimeout(r, 200));
    expect(run).not.toHaveBeenCalled();
    expect((coord as any).bootConnectFailed).toBe(true);
  });
});
