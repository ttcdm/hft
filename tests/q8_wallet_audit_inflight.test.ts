import { describe, it, expect, vi, afterEach } from 'vitest';
import { autoSnipeController, DEVNET_CONFIRMATION_CODE, AUTO_DEVNET_ORDER_SOL } from '../server/auto/controller';
import { executionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';
import { resetAuto } from './fixtures/auto';

/** Q8: the wallet audit read a fill as a drain while the trade was between its send and its journal row, and a PAPER exit journaled a wallet delta. */
describe('Q8: wallet audit ignores trades in flight and PAPER deltas', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await resetAuto();
  });

  const arm = async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    vi.stubEnv('ALLOWED_CLUSTER', 'devnet');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    vi.spyOn(executionCoordinator, 'syncRealWalletBalance').mockResolvedValue(null);
    const bal = vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol');
    bal.mockReturnValue(1);
    const ok = await autoSnipeController.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE });
    expect(ok.ok, ok.error).toBe(true);
    return bal;
  };

  it('a balance fall while a trade is in flight is not audited, and does not halt; the next look spans the journaled fill', async () => {
    const bal = await arm();
    const t0 = Date.now();
    expect(await autoSnipeController.auditWallet(t0)).toBeNull();

    const inflight = vi.spyOn(executionCoordinator, 'hasTradeInFlight').mockReturnValue(true);
    bal.mockReturnValue(1 - AUTO_DEVNET_ORDER_SOL); // the fill has landed, its row is not written yet
    expect(await autoSnipeController.auditWallet(t0 + 1)).toBeNull();
    expect(autoSnipeController.getMode()).toBe('DEVNET_LIVE');
    expect(executionCoordinator.getHaltReason()).toBeNull();

    workstationDb.logDecision({ ts: t0 + 2, autoMode: 'DEVNET_LIVE', mint: 'm', stage: 'fill', outcome: 'BOUGHT', reason: 'test', solDelta: -AUTO_DEVNET_ORDER_SOL });
    inflight.mockReturnValue(false);
    const after = await autoSnipeController.auditWallet(t0 + 3);
    expect(after?.explained).toBe(true);
    expect(executionCoordinator.getHaltReason()).toBeNull();
  });

  it('hasTradeInFlight is true for the whole of an exit, including a failed one', async () => {
    const seen: boolean[] = [];
    vi.spyOn(executionCoordinator as any, 'closePositionImpl').mockImplementation(async () => {
      seen.push(executionCoordinator.hasTradeInFlight());
      return { success: false, pnlSol: 0, error: 'x' };
    });
    expect(executionCoordinator.hasTradeInFlight()).toBe(false);
    await executionCoordinator.closePosition('nope', 100, 'STOP_LOSS');
    expect(seen).toEqual([true]);
    expect(executionCoordinator.hasTradeInFlight()).toBe(false);
    vi.spyOn(executionCoordinator as any, 'closePositionImpl').mockRejectedValue(new Error('boom'));
    await expect(executionCoordinator.closePosition('nope', 100, 'STOP_LOSS')).rejects.toThrow('boom');
    expect(executionCoordinator.hasTradeInFlight()).toBe(false);
  });

  it('a PAPER exit journals no wallet delta; a LIVE exit does', async () => {
    for (const mode of ['PAPER', 'LIVE'] as const) {
      vi.spyOn(workstationDb, 'loadPositions').mockReturnValue([{ id: `p-${mode}`, mint: `m-${mode}`, symbol: 'Q8', executionMode: mode, costBasisLamports: 5_000_000 } as any]);
      vi.spyOn(executionCoordinator as any, 'closePositionImpl').mockResolvedValue({ success: true, pnlSol: 0.001, status: 'CLOSED' });
      const log = vi.spyOn(workstationDb, 'logDecision');
      await executionCoordinator.closePosition(`p-${mode}`, 100, 'STOP_LOSS');
      const row = log.mock.calls.map((c) => c[0]).find((r) => r.outcome === 'EXITED')!;
      if (mode === 'PAPER') expect(row.solDelta).toBeUndefined();
      else expect(row.solDelta).toBeCloseTo(0.006, 9);
      vi.restoreAllMocks();
    }
  });
});
