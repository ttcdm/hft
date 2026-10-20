import { executionCoordinator } from './coordinator';
import { autoSnipeController } from '../auto/controller';
import { riskEngine } from '../risk/riskEngine';
import { workstationDb } from '../db/database';
import { Logger } from '../middleware/enterprise';
import type { NormalizedPosition } from '../core/types';

/** The close reason of every panic sell: protective for the halt and for the dust check alike. */
export const PANIC_CLOSE_REASON = 'EMERGENCY_PANIC_LIQUIDATION';

export interface EmergencyStopReport {
  attemptedCount: number;
  succeeded: Array<{ id: string; symbol: string; pnlSol: number; status?: string }>;
  failed: Array<{ id: string; symbol: string; error: string }>;
  totalRealizedPnLSol: number;
  killSwitchActivated: boolean;
  /** true when auto ended OFF; false (with autoStopError) when stopping it threw. */
  autoStopped: boolean;
  autoStopError?: string;
}

let running = 0;

/**
 * P1.4 (N-0, N-1, N-2, N-11, R1-29, R1-119): the one emergency stop. The HTTP panic, the WebSocket PANIC_LIQUIDATE, Telegram /panic_sell
 * and the kill-switch route all call this, so they stop the same things in the same order:
 *
 *  1. the kill switch goes on (the risk gate refuses every buy not yet past it);
 *  2. auto is killed, which waits for a buy already in flight, so the position it opens is in the list read below; auto ends OFF;
 *  3. LIVE is disarmed;
 *  4. with `exitAll`, every ACTIVE position of every mode is closed at 100% with EMERGENCY_PANIC_LIQUIDATION. A close that meets an exit
 *     already in flight (a take-profit partial) waits for it, re-reads the row and closes what is left. The ACTIVE rows are read once
 *     more after the loop, and any new one is closed too.
 *
 * While it runs the coordinator's panic flag is set (setPanicActive), so the exit pass can refuse non-protective auto exits.
 */
export async function emergencyStop(opts: { exitAll: boolean; reason?: string }): Promise<EmergencyStopReport> {
  const reason = opts.reason || 'emergency stop';
  running++;
  executionCoordinator.setPanicActive(true);
  try {
    riskEngine.setKillSwitch(true);
    let autoStopped = true;
    let autoStopError: string | undefined;
    try {
      await autoSnipeController.kill({ exitAll: false, reason });
    } catch (e: any) {
      autoStopError = e?.message || String(e);
      Logger.error(`[EMERGENCY STOP] auto kill failed: ${autoStopError}; forcing auto OFF`);
      try { await autoSnipeController.setMode('OFF'); } catch { /* the mode is already OFF: kill() sets it before its first await */ }
    }
    if (autoSnipeController.getMode() !== 'OFF') autoStopped = false;
    executionCoordinator.armLiveTrading(false);

    const report: EmergencyStopReport = { attemptedCount: 0, succeeded: [], failed: [], totalRealizedPnLSol: 0, killSwitchActivated: true, autoStopped, autoStopError };
    if (opts.exitAll) {
      const attempted = new Set<string>();
      for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) await closeForPanic(p, attempted, report);
      // a position opened while the loop ran (a manual buy that was already past the risk gate) is sold too
      for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) if (!attempted.has(p.id)) await closeForPanic(p, attempted, report);
    }
    Logger.warn(`[EMERGENCY STOP] ${reason}: kill switch on, auto ${autoStopped ? 'OFF' : 'NOT stopped'}, LIVE disarmed${opts.exitAll ? `; attempted ${report.attemptedCount}, succeeded ${report.succeeded.length}, failed ${report.failed.length}` : ''}`);
    return report;
  } finally {
    running--;
    if (running === 0) executionCoordinator.setPanicActive(false);
  }
}

async function closeOnce(id: string): Promise<{ success: boolean; pnlSol: number; status?: string; error?: string }> {
  try {
    return await executionCoordinator.closePosition(id, 100, PANIC_CLOSE_REASON);
  } catch (e: any) {
    return { success: false, pnlSol: 0, error: e?.message || String(e) };
  }
}

async function closeForPanic(p: NormalizedPosition, attempted: Set<string>, report: EmergencyStopReport): Promise<void> {
  attempted.add(p.id);
  report.attemptedCount++;
  let res = await closeOnce(p.id);
  if (!res.success && /^EXIT_IN_PROGRESS/.test(res.error || '')) {
    // R1-29: an exit (a take-profit partial, the exit pass, another panic) holds the position. Wait for it, then sell what it left.
    await executionCoordinator.waitForPositionExit(p.id);
    const row = workstationDb.loadPositions(undefined, 'ACTIVE').find((x) => x.id === p.id);
    if (!row) {
      const closed = workstationDb.loadPositions().find((x) => x.id === p.id);
      res = { success: true, pnlSol: 0, status: closed?.status ?? 'CLOSED' };
    } else {
      res = await closeOnce(p.id);
    }
  }
  if (res.success) {
    report.succeeded.push({ id: p.id, symbol: p.symbol, pnlSol: res.pnlSol, status: res.status });
    report.totalRealizedPnLSol += res.pnlSol;
  } else {
    report.failed.push({ id: p.id, symbol: p.symbol, error: res.error || 'Execution failed' });
  }
}
