import { executionCoordinator } from '../execution/coordinator';
import type { OperatorAlert } from '../core/types';
import { autoSnipeController } from '../auto/controller';
import { pumpFeedListener } from '../solana/pumpFeedListener';
import { workstationDb, WorkstationDatabase } from '../db/database';
import { riskEngine } from '../risk/riskEngine';
import { endpointOrigin } from '../middleware/enterprise';
import { resolveRpcUrl, allowedCluster } from '../solana/clusterGuard';
import { isReadOnly } from '../solana/readOnly';
import { watchWindow } from '../signals/watchWindow';
import { onChainPoolStats } from '../market/poolStats';
import { memecoinAggregator } from '../memecoinAggregator';
import { minLiquidityUsd } from '../solana/executionConfig';
import { getRecorderRuntime } from '../backtest/recorderConfig';

export type CheckStatus = 'OK' | 'WARN' | 'FAIL' | 'UNKNOWN';
export interface SystemCheck {
  id: string;
  label: string;
  status: CheckStatus;
  /** the measured value, as text */
  value: string;
  /** what it was measured from, or why it is not OK */
  detail: string;
}
export interface SystemChecksResult { checkedAt: number; cluster: string; mode: string; checks: SystemCheck[]; operatorAlerts: OperatorAlertView[] }

/**
 * R6-1 / R7-1: the coordinator's open operator alerts, as the UI and the runbook read them from GET /api/system/checks. Each carries a
 * level: CRITICAL means money may be at risk or a record is wrong (an exit that cannot run, a position the wallet does not hold, a halt
 * that did not persist); the UI keeps those on screen until the server clears them. A code not listed here is CRITICAL (fail closed).
 */
export type OperatorAlertLevel = 'CRITICAL' | 'WARNING' | 'INFO';
export interface OperatorAlertView extends OperatorAlert { level: OperatorAlertLevel }
export const OPERATOR_ALERT_LEVELS: Record<string, OperatorAlertLevel> = {
  TRADING_HALTED: 'CRITICAL',
  HALT_NOT_PERSISTED: 'CRITICAL',
  KILL_SWITCH_WAS_ON: 'CRITICAL',
  EXIT_FAILING: 'CRITICAL',
  EXIT_NO_SIGNER: 'CRITICAL',
  EXIT_QUOTE_FAILING: 'CRITICAL',
  POSITION_GONE: 'CRITICAL',
  POSITION_BALANCE_MISSING: 'CRITICAL',
  POSITION_NOT_PERSISTED: 'CRITICAL',
  POSITION_MARK_UNAVAILABLE: 'CRITICAL',
  LEDGER_WRITE_FAILED: 'CRITICAL',
  LATE_BUY_NOT_SOLD: 'CRITICAL',
  UNTRACKED_TOKEN_BALANCE: 'CRITICAL',
  // raised by other batches (C1, C2, D): listed here so they stay CRITICAL by name, not only by the unknown-code default
  RPC_AUTH_REJECTED: 'CRITICAL',
  EXIT_LOOP_FAILING: 'CRITICAL',
  SELL_LANDED_UNBOOKED: 'CRITICAL',
  SELL_BLOCKHASH_UNCHECKED: 'CRITICAL',
  EXIT_RATE_LIMITED: 'WARNING',
  SELL_ADOPTED: 'WARNING',
  POSITION_BALANCE_CLAMPED: 'WARNING',
  MARK_MINT_REJECTED: 'WARNING',
  PAPER_MARKS_UNAVAILABLE: 'WARNING',
  DISK_SPACE_LOW: 'WARNING',
  LATE_BUY_SOLD: 'INFO',
};
/**
 * R9-12: split the mark alerts that no longer apply: a POSITION_MARK_UNAVAILABLE whose position is not open. (PAPER_MARKS_UNAVAILABLE needs
 * no help: every exit pass raises or clears it.) Every other alert is kept as it is.
 */
export function splitMootMarkAlerts(alerts: OperatorAlert[], open: Array<{ id: string }>): { current: OperatorAlert[]; moot: OperatorAlert[] } {
  const openIds = new Set(open.map((p) => p.id));
  const isMoot = (a: OperatorAlert) => a.code === 'POSITION_MARK_UNAVAILABLE' && !!a.positionId && !openIds.has(a.positionId);
  return { current: alerts.filter((a) => !isMoot(a)), moot: alerts.filter(isMoot) };
}
export const operatorAlertLevel = (code: string): OperatorAlertLevel => OPERATOR_ALERT_LEVELS[code] ?? 'CRITICAL';
const LEVEL_RANK: Record<OperatorAlertLevel, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };

/** Every open alert with its level, CRITICAL first, newest first within a level. */
export function operatorAlertViews(alerts: OperatorAlert[]): OperatorAlertView[] {
  return alerts
    .map((a) => ({ ...a, level: operatorAlertLevel(a.code) }))
    .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || b.lastSeenAt - a.lastSeenAt);
}

/** The System checks row for the alerts: FAIL with any CRITICAL open, WARN with any other, OK with none. */
export function operatorAlertsCheck(views: OperatorAlertView[]): SystemCheck {
  const crit = views.filter((a) => a.level === 'CRITICAL').length;
  const codes = [...new Set(views.map((a) => a.code))].join(', ');
  return {
    id: 'alerts', label: 'Operator alerts', status: crit ? 'FAIL' : views.length ? 'WARN' : 'OK',
    value: views.length ? `${views.length} open (${crit} critical): ${codes}` : 'none open',
    detail: views.length ? views.slice(0, 3).map((a) => `${a.code}: ${a.message}`).join(' | ') : 'No operator alert is open. Alerts live in memory only; a restart forgets them (the journal keeps the events).',
  };
}

/** B3b: the capacity check warns when more than this share of seller funder lookups ended up unread, once this many were asked for. */
export const SELLER_FUNDER_UNREAD_WARN_SHARE = 0.05;
export const SELLER_FUNDER_UNREAD_MIN_ASKED = 20;

const sec = (ms: number | null) => (ms === null ? 'never' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
/** "12.0 s ago", or "none yet" when it never happened (it used to print "never ago"). */
const ago = (ms: number | null) => (ms === null ? 'none yet' : `${sec(ms)} ago`);

/**
 * Live results, each read from the component that owns the fact (no check here is computed from a constant). A check that cannot be read
 * is UNKNOWN, never OK. Order is the order an operator reads a start-up: cluster, signer, RPC, reconciliation, halt, feeds, marks, database.
 */
export function buildSystemChecks(now: number = Date.now()): SystemChecksResult {
  const diag = executionCoordinator.getDiagnostics();
  const cluster = executionCoordinator.getClusterStatus();
  const recon = executionCoordinator.getReconciliationStatus();
  const ages = executionCoordinator.getFeedAges(now);
  const auto = autoSnipeController.getStatus();
  const halt = executionCoordinator.getHaltReason();
  const feed = pumpFeedListener.getTelemetry();
  const checks: SystemCheck[] = [];

  checks.push(cluster.problem
    ? { id: 'cluster', label: 'Cluster / genesis', status: 'FAIL', value: `${cluster.allowed}: NOT verified`, detail: cluster.problem }
    : cluster.rpcHealth === 'DISCONNECTED'
    ? { id: 'cluster', label: 'Cluster / genesis', status: 'UNKNOWN', value: `${cluster.allowed}: not checked`, detail: 'The RPC is not reachable, so the genesis hash could not be read.' }
    : { id: 'cluster', label: 'Cluster / genesis', status: 'OK', value: `${cluster.allowed}: genesis hash matches`, detail: `RPC ${endpointOrigin(diag.rpcEndpoint || resolveRpcUrl())} reports the genesis hash configured for ${cluster.allowed}.` });

  if (isReadOnly()) {
    const cl = allowedCluster();
    checks.push({
      id: 'readonly', label: 'Read-only mode', status: diag.signerStatus === 'NOT_CONFIGURED' && !diag.liveTradingActive ? 'OK' : 'FAIL',
      value: `${cl === 'mainnet-beta' ? 'MAINNET' : cl.toUpperCase()} · READ-ONLY · PAPER`,
      detail: `APEX_READ_ONLY=true: no signer is loaded, no transaction can be signed or sent, arming LIVE is refused, auto allows OFF, SHADOW and PAPER only. Paper fills use the real curve maths and the real eligibility floor (liquidity at least $${minLiquidityUsd()}${cl === 'mainnet-beta' ? '; MIN_LIQUIDITY_USD is ignored on mainnet' : ''}).`,
    });
  }
  checks.push(isReadOnly()
    ? { id: 'signer', label: 'Signer', status: diag.signerStatus === 'NOT_CONFIGURED' ? 'OK' : 'FAIL', value: 'none (read-only by design)', detail: diag.signerStatus === 'NOT_CONFIGURED' ? 'Read-only mode loads no key. PAPER only.' : `Read-only mode is on but the signer says ${diag.signerStatus}: this must never happen.` }
    : {
    id: 'signer', label: 'Signer', status: diag.signerStatus === 'READY' ? 'OK' : 'WARN', value: diag.signerStatus,
    detail: diag.signerStatus === 'READY' ? `wallet ${diag.activeWalletAddress.slice(0, 6)}...${diag.activeWalletAddress.slice(-4)}` : 'No usable keypair: PAPER only, no real transaction can be signed.',
  });

  const lat = diag.rpcLatencyMs;
  checks.push({
    id: 'rpc', label: 'RPC latency', status: diag.rpcHealth === 'HEALTHY' ? (lat > 1500 ? 'WARN' : 'OK') : diag.rpcHealth === 'DEGRADED' ? 'WARN' : 'FAIL',
    value: diag.rpcHealth === 'DISCONNECTED' ? 'disconnected' : `${Math.round(lat)} ms (${diag.rpcHealth})`, detail: 'Round trip of the last getSlot probe the coordinator made.',
  });

  checks.push(!recon
    ? { id: 'reconciliation', label: 'Startup reconciliation', status: 'UNKNOWN', value: 'not finished', detail: 'No reconciliation has completed since start.' }
    : { id: 'reconciliation', label: 'Startup reconciliation', status: recon.status === 'EXECUTION_READY' ? 'OK' : 'FAIL', value: recon.status, detail: `${recon.details} (${sec(now - recon.checkedAt)} ago)` });

  const walletAuditRuns = auto.mode === 'DEVNET_LIVE';
  checks.push(halt
    ? { id: 'halt', label: 'Wallet audit / halt', status: 'FAIL', value: 'ALL TRADING HALTED', detail: halt }
    // R9-4: "OK, no halt" read as "trading is allowed" right above a red kill-switch row; with the switch on, say so here too
    : riskEngine.isKillSwitchActive()
    ? { id: 'halt', label: 'Wallet audit / halt', status: 'WARN', value: 'no wallet-audit halt, but the KILL SWITCH is ON (orders refused)', detail: 'There is no persisted halt. The kill switch (row below) refuses every new order until it is reset.' }
    : { id: 'halt', label: 'Wallet audit / halt', status: 'OK', value: walletAuditRuns ? 'audit running, no halt' : 'no halt', detail: walletAuditRuns ? 'The wallet balance is compared with the journal; an unexplained change halts every buy plus the take-profit and stale exits; stop-loss, trailing stop, manual close and panic still run.' : `The wallet audit only runs in DEVNET_LIVE (auto mode is ${auto.mode}).` });

  const breakerOpen = riskEngine.getCircuitBreakerState() !== 'CLOSED';
  const lastRead = riskEngine.getLastBalanceRead();
  const triggerNote = auto.triggers.length ? `auto kill triggers: ${auto.triggers.map((t) => t.code).join(', ')}` : 'no auto kill trigger set';
  // F2: an open breaker says how to close it: a kill-switch reset closes it once the latest wallet-balance read has succeeded
  const breakerNote = !breakerOpen
    ? ''
    : lastRead?.ok
      ? `The breaker opened after failed wallet-balance reads; the latest read succeeded ${sec(now - lastRead.at)} ago, so resetting the kill switch closes it. `
      : `The breaker opened after failed wallet-balance reads and the latest read ${lastRead ? `failed ${sec(now - lastRead.at)} ago` : 'has not happened'}; it stays open until a read succeeds and the kill switch is reset. `;
  checks.push({
    id: 'killswitch', label: 'Kill switch / circuit breaker', status: riskEngine.isKillSwitchActive() ? 'FAIL' : breakerOpen ? 'FAIL' : 'OK',
    value: `kill switch ${riskEngine.isKillSwitchActive() ? 'ON' : 'off'}, breaker ${riskEngine.getCircuitBreakerState()}`, detail: `${breakerNote}${triggerNote}`,
  });

  const feedOk = feed.status === 'ACTIVE';
  const feedAge = feed.lastEventAgeMs >= 0 ? feed.lastEventAgeMs : null;
  checks.push({
    id: 'feed', label: 'Pump.fun event feed', status: !feedOk ? 'WARN' : feedAge === null ? 'WARN' : feedAge > 120_000 ? 'WARN' : 'OK',
    value: `${feed.status}, last event ${ago(feedAge)}`, detail: `${feed.eventsReceived} logs received, ${feed.eventsParsed} creates and ${feed.tradesParsed} trades parsed. A quiet devnet is normal; on mainnet this is a warning.`,
  });

  const cap = watchWindow.getSnapshot(now).capacity;
  const evicted = onChainPoolStats.getEvictedCount();
  const trimmed = memecoinAggregator.getPoolsTrimmedCount();
  const dropped = cap.refusedFull + evicted + trimmed + feed.handlerErrors;
  // B3b: seller funders that ended up unread. Above SELLER_FUNDER_UNREAD_WARN_SHARE of at least SELLER_FUNDER_UNREAD_MIN_ASKED lookups, the lookups need more capacity.
  const sf = watchWindow.getSellerFunderStats();
  const sfUnread = sf.unreadable + sf.pendingAtWindowEnd;
  const sfWarn = sf.asked >= SELLER_FUNDER_UNREAD_MIN_ASKED && sfUnread / sf.asked > SELLER_FUNDER_UNREAD_WARN_SHARE;
  checks.push({
    id: 'capacity', label: 'Feed capacity (dropped candidates)', status: dropped > 0 || sfWarn ? 'WARN' : 'OK',
    value: `watching ${cap.active} of ${cap.max}; dropped ${dropped}; seller funders unread ${sfUnread} of ${sf.asked}`,
    detail: `Launches refused because the watch window was full: ${cap.refusedFull}${cap.lastRefusedMint ? ` (last ${cap.lastRefusedMint.slice(0, 8)}...)` : ''}. Measured-stat tables evicted: ${evicted}. Board pools trimmed: ${trimmed}. Feed log handler errors: ${feed.handlerErrors} (slowest handler ${feed.slowestHandlerMs} ms). Raise APEX_WATCH_MAX_CANDIDATES if the first number grows. Logs the RPC provider itself drops are not visible here. Seller funder lookups: ${sf.asked} asked, ${sf.unreadable} failed or refused, ${sf.pendingAtWindowEnd} still pending at the window end (each costs that launch its buyers signal; a WARN above ${SELLER_FUNDER_UNREAD_WARN_SHARE * 100}% of ${SELLER_FUNDER_UNREAD_MIN_ASKED}+ lookups means the funder lookups need more RPC capacity).`,
  });

  checks.push(recorderCheck(now));

  // R9-12: a mark alert is about a position the exit pass prices; the pass clears it only while the position is open, so after a close it
  // stayed for good. A mark alert for a position that is no longer open is moot: it is left out of the marks row and the alert list.
  const { current: alerts, moot: mootMarkAlerts } = splitMootMarkAlerts(diag.operatorAlerts ?? [], workstationDb.loadPositions(undefined, 'ACTIVE'));
  const markAlerts = alerts.filter((a) => a.code === 'POSITION_MARK_UNAVAILABLE' || a.code === 'PAPER_MARKS_UNAVAILABLE');
  const mootNote = mootMarkAlerts.length ? ` ${mootMarkAlerts.length} mark alert(s) for positions no longer open are not counted.` : '';
  checks.push({
    id: 'marks', label: 'Position marks', status: markAlerts.length ? 'WARN' : diag.positionMarkHealth === 'STALE' ? 'WARN' : 'OK',
    value: markAlerts.length ? `${markAlerts.length} stale-mark alert(s)` : `${diag.positionMarkHealth}, last mark ${ago(ages.positionMarkAgeMs)}`,
    detail: (markAlerts.length ? markAlerts.map((a) => a.message).slice(0, 3).join(' | ') : `${diag.openPositionsCount} open position(s); no stale-mark alert.`) + mootNote,
  });

  const operatorAlerts = operatorAlertViews(alerts);
  checks.push(operatorAlertsCheck(operatorAlerts));

  checks.push(databaseCheck(diag.sqliteJournalOk));

  return { checkedAt: now, cluster: cluster.allowed, mode: `${diag.executionMode}${diag.liveTradingActive ? ' (LIVE armed)' : ''}`, checks, operatorAlerts };
}

/**
 * The database row: FAIL when the writable check fails (it needs MIN_FREE_BYTES free), WARN while it passes with less than
 * LOW_FREE_WARN_BYTES free, so the operator hears about a filling disk before buys stop.
 */
export function databaseCheck(writable: boolean): SystemCheck {
  const free = workstationDb.getFreeBytes();
  const mib = (b: number) => `${Math.floor(b / (1024 * 1024))} MiB`;
  const low = free !== null && free < WorkstationDatabase.LOW_FREE_WARN_BYTES;
  const where = `${workstationDb.getDbPath()}, journal mode ${workstationDb.getJournalMode()}${free === null ? '' : `, ${mib(free)} free`}`;
  if (!writable) {
    return { id: 'database', label: 'Database', status: 'FAIL', value: 'NOT writable', detail: `${where}. A test write failed, or less than ${mib(WorkstationDatabase.MIN_FREE_BYTES)} is free; buys are refused until it passes.` };
  }
  if (low) {
    return { id: 'database', label: 'Database', status: 'WARN', value: `writable, ${mib(free)} free`, detail: `${where}. Free disk is below ${mib(WorkstationDatabase.LOW_FREE_WARN_BYTES)}; buys stop below ${mib(WorkstationDatabase.MIN_FREE_BYTES)}. Free some space.` };
  }
  return { id: 'database', label: 'Database', status: 'OK', value: free === null ? 'writable' : `writable, ${mib(free)} free`, detail: where };
}

/** S190: the launch recorder against its limits. Rate and days-left are measured from the last hour of writes, not assumed. */
let rateCache: { at: number; rows: number } | null = null;
export function recorderCheck(now: number): SystemCheck {
  const rt = getRecorderRuntime();
  if (!rt) return { id: 'recorder', label: 'Launch recorder', status: 'UNKNOWN', value: 'not started', detail: 'The launch recorder has not been created in this process, so there is nothing to read.' };
  const st = workstationDb.getLaunchRecordingStatus();
  if (!rateCache || now - rateCache.at > 30_000) rateCache = { at: now, rows: workstationDb.getLaunchRecordingRows(now - 3_600_000) };
  const perHour = rateCache.rows;
  // 5B: the row limit applies to launch rows; funder facts are kept outside it (they are never pruned)
  const room = rt.config.maxRows - st.launchRows;
  const hoursLeft = perHour > 0 ? Math.max(0, room) / perHour : null;
  const days = (h: number) => (h / 24).toFixed(1);
  const spanDays = st.oldestTs !== null && st.newestTs !== null ? (st.newestTs - st.oldestTs) / 86_400_000 : 0;
  const pruned = rt.prunedRows > 0;
  const nearFull = st.launchRows >= rt.config.maxRows * 0.8;
  const limits = `window ${Math.round(rt.config.mintMs / 60_000)} min per launch, up to ${rt.config.maxTradesPerMint} trades each; keeps ${rt.config.maxRows} rows (about ${(rt.config.maxRows * 333 / 1e9).toFixed(1)} GB) and ${rt.config.retentionDays} days`;
  return {
    id: 'recorder', label: 'Launch recorder (backtest data)',
    status: pruned || nearFull ? 'WARN' : 'OK',
    value: `${st.launches} launches, ${st.launchRows} of ${rt.config.maxRows} rows${pruned ? `, PRUNING (${rt.prunedRows} dropped)` : ''}`,
    detail: `${limits}. ${st.endedLaunches} of ${st.launches} launches have an end marker (trade cap, window or curve complete); the rest are still recording or were cut off by a stop. ${st.funderRows} funder facts are kept outside the row limit (never pruned). Last hour: ${perHour} rows${hoursLeft === null ? '' : `, so about ${days(hoursLeft)} days until the row limit at this rate`}. Recorded span so far: ${spanDays.toFixed(1)} days. ${pruned ? `Pruning started ${new Date(rt.firstPruneAt as number).toISOString()}: the OLDEST launches are being dropped; raise APEX_RECORD_MAX_ROWS or APEX_RECORD_RETENTION_DAYS to keep them.` : nearFull ? 'Over 80% of the row limit: the oldest launches will start to be dropped soon. Raise APEX_RECORD_MAX_ROWS to keep them.' : 'Nothing has been pruned.'}`,
  };
}
