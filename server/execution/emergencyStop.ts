import { executionCoordinator } from './coordinator';
import { autoSnipeController } from '../auto/controller';
import { riskEngine } from '../risk/riskEngine';
import { workstationDb } from '../db/database';
import { Logger } from '../middleware/enterprise';
import type { NormalizedPosition } from '../core/types';

/**
 * How long the panic waits for LIVE buys already past the risk gate (a manual buy, a callout or Telegram snipe) before it reads the positions
 * to sell. A buy that is still unsettled after it is reported in `failed[]` as BUY_IN_FLIGHT, so the operator runs the panic again.
 */
export const PANIC_BUY_SETTLE_WAIT_MS = { value: 30_000 };

/**
 * R5-9: how long the panic keeps retrying a position whose last sell is still unconfirmed (SELL_PENDING_VERIFICATION), and how often.
 * A blockhash lives about 60-90 s, so within this bound the pending sell either lands (the retry adopts it, then sells any rest) or is
 * proven expired (the retry sells). One still pending after it is reported in `failed[]`, never as closed.
 */
export const PANIC_PENDING_SELL_WAIT_MS = { value: 90_000 };
export const PANIC_PENDING_SELL_POLL_MS = { value: 2_000 };

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
 *  3. LIVE is disarmed, and with `exitAll` the panic waits (PANIC_BUY_SETTLE_WAIT_MS) for every LIVE buy already past the risk gate, from any
 *     route, so the position it opens is sold too; one still unsettled is reported in `failed[]`;
 *  4. with `exitAll`, every ACTIVE position of every mode is closed at 100% with EMERGENCY_PANIC_LIQUIDATION. A close that meets an exit
 *     already in flight (a take-profit partial) waits for it, re-reads the row and closes what is left. The ACTIVE rows are read once
 *     more after the loop, and any new one is closed too.
 *
 * Late buy (decision 5): before step 1 the coordinator notes the stop (noteEmergencyStop). A LIVE buy that was already past the risk gate
 * and lands after it, with or without `exitAll` and also after this returns (BUY_IN_FLIGHT), is sold at once by the coordinator.
 *
 * While it runs the coordinator's panic flag is set (setPanicActive), so the exit pass can refuse non-protective auto exits.
 */
export async function emergencyStop(opts: { exitAll: boolean; reason?: string }): Promise<EmergencyStopReport> {
  const reason = opts.reason || 'emergency stop';
  running++;
  executionCoordinator.setPanicActive(true);
  try {
    executionCoordinator.noteEmergencyStop(reason); // late buy: a LIVE buy already past the gate that lands after this is sold at once
    riskEngine.setKillSwitch(true, reason);
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
      const stillBuying = await executionCoordinator.waitForBuysInFlight(PANIC_BUY_SETTLE_WAIT_MS.value);
      const attempted = new Set<string>();
      const pending = new Map<string, NormalizedPosition>();
      for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) await closeForPanic(p, attempted, report, pending);
      // a position opened while the loop ran (a manual buy that was already past the risk gate) is sold too
      for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) if (!attempted.has(p.id)) await closeForPanic(p, attempted, report, pending);
      if (stillBuying.length > 0) {
        // a buy that settled while the sells ran may have opened a position since the read above
        for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) if (!attempted.has(p.id)) await closeForPanic(p, attempted, report, pending);
      }
      await retryPendingSells(pending, report);
      // R5-9: never report a LIVE position as handled while it is still open
      const reported = new Set(report.failed.map((f) => f.id));
      for (const p of workstationDb.loadPositions('LIVE', 'ACTIVE')) {
        if (reported.has(p.id)) continue;
        report.failed.push({ id: p.id, symbol: p.symbol, error: `STILL_OPEN: ${p.symbol || p.mint} is still ${p.status} after the panic (${p.tokenQuantityRaw} raw tokens); run the panic again or close it by hand.` });
      }
      // a buy still unsettled may open a position after this report: say so instead of claiming nothing is open
      for (const mint of await executionCoordinator.waitForBuysInFlight(0)) {
        report.failed.push({ id: `buy-${mint}`, symbol: mint.slice(0, 6), error: `BUY_IN_FLIGHT: a LIVE buy of ${mint} was still being sent or confirmed when the panic ended; it may open a position. Run the panic again.` });
      }
    }
    Logger.warn(`[EMERGENCY STOP] ${reason}: kill switch on, auto ${autoStopped ? 'OFF' : 'NOT stopped'}, LIVE disarmed${opts.exitAll ? `; attempted ${report.attemptedCount}, succeeded ${report.succeeded.length}, failed ${report.failed.length}` : ''}`);
    return report;
  } finally {
    running--;
    if (running === 0) executionCoordinator.setPanicActive(false);
  }
}

async function closeOnce(id: string): Promise<{ success: boolean; pnlSol: number; status?: string; error?: string; adoptedPartial?: boolean }> {
  try {
    return await executionCoordinator.closePosition(id, 100, PANIC_CLOSE_REASON);
  } catch (e: any) {
    return { success: false, pnlSol: 0, error: e?.message || String(e) };
  }
}

async function closeForPanic(p: NormalizedPosition, attempted: Set<string>, report: EmergencyStopReport, pending: Map<string, NormalizedPosition>): Promise<void> {
  attempted.add(p.id);
  report.attemptedCount++;
  const res = await closeWithFollowUps(p);
  if (!res.success && /^SELL_PENDING_VERIFICATION/.test(res.error || '')) {
    pending.set(p.id, p); // R5-9: retried below until the earlier sell resolves, within PANIC_PENDING_SELL_WAIT_MS
    return;
  }
  recordPanicResult(p, res, report);
}

function recordPanicResult(p: NormalizedPosition, res: { success: boolean; pnlSol: number; status?: string; error?: string }, report: EmergencyStopReport): void {
  if (res.success) {
    report.succeeded.push({ id: p.id, symbol: p.symbol, pnlSol: res.pnlSol, status: res.status });
    report.totalRealizedPnLSol += res.pnlSol;
  } else {
    report.failed.push({ id: p.id, symbol: p.symbol, error: res.error || 'Execution failed' });
  }
}

/** R5-9: positions whose earlier sell was unconfirmed when the panic reached them, retried until it resolves or the bound runs out. */
async function retryPendingSells(pending: Map<string, NormalizedPosition>, report: EmergencyStopReport): Promise<void> {
  const deadline = performance.now() + PANIC_PENDING_SELL_WAIT_MS.value; // monotonic, as waitForBuysInFlight
  while (pending.size > 0 && performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.max(0, Math.min(PANIC_PENDING_SELL_POLL_MS.value, deadline - performance.now()))));
    for (const [id, p] of [...pending]) {
      const res = await closeWithFollowUps(p);
      if (!res.success && /^SELL_PENDING_VERIFICATION/.test(res.error || '')) continue;
      pending.delete(id);
      recordPanicResult(p, res, report);
    }
  }
  for (const p of pending.values()) {
    report.failed.push({ id: p.id, symbol: p.symbol, error: `SELL_PENDING_VERIFICATION: an earlier sell of ${p.symbol || p.mint} was still unconfirmed when the panic ended (waited ${Math.round(PANIC_PENDING_SELL_WAIT_MS.value / 1000)}s); the position may still be open. Run the panic again.` });
  }
}

/** One panic close of a position, plus the follow-ups: waiting for an exit already in flight, and selling what an adopted partial left. */
async function closeWithFollowUps(p: NormalizedPosition): Promise<{ success: boolean; pnlSol: number; status?: string; error?: string }> {
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
  if (res.success && res.adoptedPartial) {
    // R6-9: the close only adopted an earlier partial that had landed unseen; the rest is still open, so sell it now
    const first = res;
    const rest = await closeOnce(p.id);
    res = rest.success ? { ...rest, pnlSol: first.pnlSol + rest.pnlSol } : rest;
  }
  return res;
}
