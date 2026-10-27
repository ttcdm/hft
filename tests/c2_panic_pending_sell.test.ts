import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { executionCoordinator } from '../server/execution/coordinator';
import { emergencyStop, PANIC_PENDING_SELL_WAIT_MS, PANIC_PENDING_SELL_POLL_MS, PANIC_BUY_SETTLE_WAIT_MS } from '../server/execution/emergencyStop';
import { autoSnipeController } from '../server/auto/controller';
import { riskEngine } from '../server/risk/riskEngine';
import { workstationDb } from '../server/db/database';

/**
 * R5-9 (+R6-9): the panic retries a position whose last sell is SELL_PENDING_VERIFICATION, and never reports a LIVE position that is
 * still open as handled. Real emergencyStop and SQLite; the coordinator's closePosition is the stubbed boundary (its own suites cover it).
 */
const seedLive = (): string => {
  const id = `c2-panic-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  workstationDb.savePosition({
    id, mint: Keypair.generate().publicKey.toBase58(), symbol: 'PND', name: 'C2 panic', tokenDecimals: 6, tokenQuantityRaw: '1000000000',
    entryPriceSol: 1e-7, currentPriceSol: 1e-7, currentValueSol: 0.0001, costBasisLamports: 100_000, realizedPnLSol: 0, status: 'OPEN',
    venue: 'PUMP_BONDING_CURVE', executionMode: 'LIVE', entryTxSignature: `C2Panic${id}`, entryTimestamp: now, lastMarkTimestamp: now, recordUpdatedAt: now, updatedAt: now,
  } as any);
  return id;
};
const closeRow = (id: string, qty = '0', status: 'CLOSED' | 'PARTIALLY_CLOSED' = 'CLOSED') => {
  const p = workstationDb.loadPositions().find((x) => x.id === id)!;
  workstationDb.savePosition({ ...p, status, tokenQuantityRaw: qty } as any);
};

describe('R5-9: the panic and a pending sell', () => {
  const saved = { wait: PANIC_PENDING_SELL_WAIT_MS.value, poll: PANIC_PENDING_SELL_POLL_MS.value, buy: PANIC_BUY_SETTLE_WAIT_MS.value };
  beforeEach(() => {
    for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0' } as any);
    vi.spyOn(autoSnipeController, 'kill').mockResolvedValue(undefined as any);
    vi.spyOn(autoSnipeController, 'getMode').mockReturnValue('OFF' as any);
    PANIC_PENDING_SELL_POLL_MS.value = 5;
    PANIC_BUY_SETTLE_WAIT_MS.value = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    riskEngine.setKillSwitch(false);
    PANIC_PENDING_SELL_WAIT_MS.value = saved.wait;
    PANIC_PENDING_SELL_POLL_MS.value = saved.poll;
    PANIC_BUY_SETTLE_WAIT_MS.value = saved.buy;
  });

  it('a position whose sell is pending is retried once the pending sell resolves, then sold', async () => {
    const id = seedLive();
    let calls = 0;
    vi.spyOn(executionCoordinator, 'closePosition').mockImplementation(async (pid: string) => {
      if (pid !== id) return { success: true, pnlSol: 0 };
      calls++;
      if (calls < 3) return { success: false, pnlSol: 0, error: 'SELL_PENDING_VERIFICATION: sell abc was sent and is not confirmed or proven expired yet' };
      closeRow(id);
      return { success: true, pnlSol: -0.0001, status: 'CLOSED' };
    });
    const report = await emergencyStop({ exitAll: true, reason: 'c2 pending test' });
    expect(calls).toBe(3);
    expect(report.failed).toEqual([]);
    expect(report.succeeded.map((s) => s.id)).toContain(id);
  });

  it('a pending sell that does not resolve within the bound is reported as failed, never as closed', async () => {
    const id = seedLive();
    PANIC_PENDING_SELL_WAIT_MS.value = 30;
    vi.spyOn(executionCoordinator, 'closePosition').mockResolvedValue({ success: false, pnlSol: 0, error: 'SELL_PENDING_VERIFICATION: still pending' });
    const report = await emergencyStop({ exitAll: true, reason: 'c2 pending test' });
    expect(report.succeeded.some((s) => s.id === id)).toBe(false);
    expect(report.failed.find((f) => f.id === id)?.error).toMatch(/^SELL_PENDING_VERIFICATION/);
  });

  it('R6-9: a close that only adopted an earlier partial is followed by a sell of the rest', async () => {
    const id = seedLive();
    let calls = 0;
    vi.spyOn(executionCoordinator, 'closePosition').mockImplementation(async (pid: string) => {
      if (pid !== id) return { success: true, pnlSol: 0 };
      calls++;
      if (calls === 1) {
        closeRow(id, '670000000', 'PARTIALLY_CLOSED');
        return { success: true, pnlSol: 0.01, status: 'PARTIALLY_CLOSED', adoptedPendingSell: true, adoptedPartial: true, remainingTokensRaw: '670000000' };
      }
      closeRow(id);
      return { success: true, pnlSol: 0.02, status: 'CLOSED' };
    });
    const report = await emergencyStop({ exitAll: true, reason: 'c2 adopted partial' });
    expect(calls).toBe(2);
    expect(report.failed).toEqual([]);
    expect(report.succeeded.find((s) => s.id === id)).toMatchObject({ status: 'CLOSED' });
    expect(report.totalRealizedPnLSol).toBeCloseTo(0.03, 9);
  });

  it('a LIVE position still open after the panic is reported, even when its close said success', async () => {
    const id = seedLive();
    vi.spyOn(executionCoordinator, 'closePosition').mockResolvedValue({ success: true, pnlSol: 0, status: 'PARTIALLY_CLOSED' });
    const report = await emergencyStop({ exitAll: true, reason: 'c2 still open' });
    expect(report.failed.find((f) => f.id === id)?.error).toMatch(/^STILL_OPEN/);
  });
});
