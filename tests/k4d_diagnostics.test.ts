import '../suppress-warnings.cjs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Connection } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';

/** K4 #11: getDiagnostics reports the real journal check and a real trades-today count, not constants. */
describe('K4 #11: truthful diagnostics', () => {
  let coordinator: ExecutionCoordinator;
  beforeEach(async () => {
    vi.spyOn(Connection.prototype, 'getSlot').mockResolvedValue(1);
    vi.spyOn(Connection.prototype, 'getBalance').mockResolvedValue(1e9);
    coordinator = new ExecutionCoordinator();
    await vi.waitFor(() => expect((coordinator as any).lastStartupReconciliation).toBeTruthy());
  });
  afterEach(() => { coordinator.cleanup(); vi.restoreAllMocks(); });

  const mode = () => coordinator.getExecutionMode();
  const tx = (state: string, ageMs: number, m = mode()) => workstationDb.saveTransaction({
    signature: `k4d_${state}_${Math.random().toString(36).slice(2)}`, orderId: 'o', correlationId: 'c', mint: 'M', direction: 'BUY',
    submissionTransport: 'SOLANA_RPC', submissionTime: Date.now() - ageMs, confirmationTime: Date.now() - ageMs, reconciliationState: state as any,
    networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: m,
  });

  it('totalTradesToday counts landed trades today, not open positions; yesterday, pending and other-mode rows are excluded', () => {
    const before = coordinator.getDiagnostics().totalTradesToday;
    tx('RECONCILED', 1000); tx('RECONCILED', 2000); // today
    tx('RECONCILED', 3 * 24 * 3600 * 1000); // three days ago
    tx('PENDING', 1000); tx('REVERTED', 1000); // not landed
    tx('RECONCILED', 1000, mode() === 'LIVE' ? 'PAPER' : 'LIVE'); // other mode
    expect(coordinator.getDiagnostics().totalTradesToday).toBe(before + 2);
  });

  it('lastConfirmedTradeTime is the newest landed trade, not a position entry time', () => {
    const t0 = Date.now();
    tx('RECONCILED', 500);
    const d = coordinator.getDiagnostics();
    expect(d.lastConfirmedTradeTime).toBeGreaterThanOrEqual(t0 - 600);
    expect(d.lastConfirmedTradeTime).toBeLessThanOrEqual(Date.now());
  });

  it('sqliteJournalOk follows the real database check', () => {
    expect(coordinator.getDiagnostics().sqliteJournalOk).toBe(true);
    (coordinator as any).sqliteOkCache = null; // drop the 30s cache
    vi.spyOn(workstationDb, 'isWritable').mockReturnValue(false);
    expect(coordinator.getDiagnostics().sqliteJournalOk).toBe(false);
    (coordinator as any).sqliteOkCache = null;
    vi.spyOn(workstationDb, 'isWritable').mockReturnValue(true);
    vi.spyOn(workstationDb, 'getJournalMode').mockReturnValue('error');
    expect(coordinator.getDiagnostics().sqliteJournalOk).toBe(false);
  });

  it('the check is cached so repeated polling does not touch the database lock each time', () => {
    (coordinator as any).sqliteOkCache = null;
    const w = vi.spyOn(workstationDb, 'isWritable');
    for (let i = 0; i < 5; i++) coordinator.getDiagnostics();
    expect(w).toHaveBeenCalledTimes(1);
  });
});
