import { executionCoordinator } from '../execution/coordinator';
import { autoSnipeController } from '../auto/controller';
import { pumpFeedListener } from '../solana/pumpFeedListener';
import { workstationDb } from '../db/database';
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
export interface SystemChecksResult { checkedAt: number; cluster: string; mode: string; checks: SystemCheck[] }

/** B3b: the capacity check warns when more than this share of seller funder lookups ended up unread, once this many were asked for. */
export const SELLER_FUNDER_UNREAD_WARN_SHARE = 0.05;
export const SELLER_FUNDER_UNREAD_MIN_ASKED = 20;

const sec = (ms: number | null) => (ms === null ? 'never' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

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
    value: `${feed.status}, last event ${sec(feedAge)} ago`, detail: `${feed.eventsReceived} logs received, ${feed.eventsParsed} creates and ${feed.tradesParsed} trades parsed. A quiet devnet is normal; on mainnet this is a warning.`,
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

  const alerts = diag.operatorAlerts ?? [];
  const markAlerts = alerts.filter((a) => a.code === 'POSITION_MARK_UNAVAILABLE' || a.code === 'PAPER_MARKS_UNAVAILABLE');
  checks.push({
    id: 'marks', label: 'Position marks', status: markAlerts.length ? 'WARN' : diag.positionMarkHealth === 'STALE' ? 'WARN' : 'OK',
    value: markAlerts.length ? `${markAlerts.length} stale-mark alert(s)` : `${diag.positionMarkHealth}, last mark ${sec(ages.positionMarkAgeMs)} ago`,
    detail: markAlerts.length ? markAlerts.map((a) => a.message).slice(0, 3).join(' | ') : `${diag.openPositionsCount} open position(s); no stale-mark alert.`,
  });

  checks.push({
    id: 'database', label: 'Database', status: diag.sqliteJournalOk ? 'OK' : 'FAIL', value: diag.sqliteJournalOk ? 'writable' : 'NOT writable', detail: `${workstationDb.getDbPath()}, journal mode ${workstationDb.getJournalMode()}`,
  });

  return { checkedAt: now, cluster: cluster.allowed, mode: `${diag.executionMode}${diag.liveTradingActive ? ' (LIVE armed)' : ''}`, checks };
}

/** S190: the launch recorder against its limits. Rate and days-left are measured from the last hour of writes, not assumed. */
let rateCache: { at: number; rows: number } | null = null;
export function recorderCheck(now: number): SystemCheck {
  const rt = getRecorderRuntime();
  if (!rt) return { id: 'recorder', label: 'Launch recorder', status: 'UNKNOWN', value: 'not started', detail: 'The launch recorder has not been created in this process, so there is nothing to read.' };
  const st = workstationDb.getLaunchRecordingStatus();
  if (!rateCache || now - rateCache.at > 30_000) rateCache = { at: now, rows: workstationDb.getLaunchRecordingRows(now - 3_600_000) };
  const perHour = rateCache.rows;
  const room = rt.config.maxRows - st.events;
  const hoursLeft = perHour > 0 ? Math.max(0, room) / perHour : null;
  const days = (h: number) => (h / 24).toFixed(1);
  const spanDays = st.oldestTs !== null && st.newestTs !== null ? (st.newestTs - st.oldestTs) / 86_400_000 : 0;
  const pruned = rt.prunedRows > 0;
  const nearFull = st.events >= rt.config.maxRows * 0.8;
  const limits = `window ${Math.round(rt.config.mintMs / 60_000)} min per launch, up to ${rt.config.maxTradesPerMint} trades each; keeps ${rt.config.maxRows} rows (about ${(rt.config.maxRows * 333 / 1e9).toFixed(1)} GB) and ${rt.config.retentionDays} days`;
  return {
    id: 'recorder', label: 'Launch recorder (backtest data)',
    status: pruned || nearFull ? 'WARN' : 'OK',
    value: `${st.launches} launches, ${st.events} of ${rt.config.maxRows} rows${pruned ? `, PRUNING (${rt.prunedRows} dropped)` : ''}`,
    detail: `${limits}. Last hour: ${perHour} rows${hoursLeft === null ? '' : `, so about ${days(hoursLeft)} days until the row limit at this rate`}. Recorded span so far: ${spanDays.toFixed(1)} days. ${pruned ? `Pruning started ${new Date(rt.firstPruneAt as number).toISOString()}: the OLDEST launches are being dropped; raise APEX_RECORD_MAX_ROWS or APEX_RECORD_RETENTION_DAYS to keep them.` : nearFull ? 'Over 80% of the row limit: the oldest launches will start to be dropped soon. Raise APEX_RECORD_MAX_ROWS to keep them.' : 'Nothing has been pruned.'}`,
  };
}
