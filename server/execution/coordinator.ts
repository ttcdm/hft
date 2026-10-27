import '../loadEnv'; // must stay the first import
import { isReadOnly, assertNotReadOnly } from '../solana/readOnly';
import bs58 from 'bs58';
import { solPriceService } from '../market/solPriceService';
import { Connection, PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createCloseAccountInstruction } from '@solana/spl-token';
import {
  ExecutionMode,
  NormalizedPosition,
  SystemDiagnostics,
  OperatorAlert,
  ExecutionLifecycleState,
  DataSource,
  SignalProvenance,
  TokenEligibilityReport,
  LiveReadiness,
  isLiveApprovedProvenance,
} from '../core/types';
/** C4: a mark older than this is not trusted for exits; the position is re-read directly first. */
/** Sell slippage by number of consecutive failed exit attempts on a position (critique #4). A stop-loss in a fast dump must eventually clear. */
export const SELL_SLIPPAGE_LADDER_BPS = [800, 1500, 2500, 4000];
/** Auto-exit retry backoff after a failed attempt: base * 2^(n-1), capped. Each failed LIVE send can pay fees. */
export const EXIT_RETRY_BASE_MS = 3_000;
export const EXIT_RETRY_MAX_MS = 30_000;
/**
 * T6: after a LIVE exit the RPC rate-limited past every resend, the exit pass waits this long before that position's next try. Flat and
 * short: it neither counts as a failure nor widens slippage; it only stops each 3 s tick from spending four more sends on a throttled RPC.
 */
export const EXIT_RATE_LIMITED_WAIT_MS = 6_000;
/** Consecutive failed exits before an operator alert is raised. */
export const EXIT_FAILURE_ALERT_AFTER = 4;
/** R8-6: sells the exit ladder can make of one position (TP1, TP2, then the trailing or hard stop); the round-trip cost gate counts each. */
export const EXIT_LADDER_SELL_COUNT = 3;
/** R4-6: consecutive exit passes that threw before EXIT_LOOP_FAILING is raised (and LIVE buys are refused): 3 passes, about 9 s. */
export const EXIT_LOOP_ALERT_AFTER = 3;

export const MARK_STALE_MS = 15_000;
/** C4: if a direct read still fails after this long, raise an operator alert. */
export const MARK_ALERT_AFTER_MS = 60_000;
export const MARK_RETRY_BASE_MS = 60_000;
export const MARK_RETRY_MAX_MS = 10 * 60_000;
/** R4-9: a heartbeat slot that has not advanced for this long while time passed marks the RPC DEGRADED (a slot lasts about 0.4 s). */
export const RPC_SLOT_STALL_MS = 30_000;
/** R5-10: at most this many direct stale-mark reads run at once in one exit pass. */
export const STALE_REFRESH_CONCURRENCY = 4;
/** At most this many PAPER positions get a direct stale-mark read in one exit pass; LIVE positions are never capped. */
export const PAPER_STALE_REFRESH_PER_PASS = 5;
/** PAPER positions with no price get their own alert up to this many per pass; the rest share one alert with a count. */
export const PAPER_INDIVIDUAL_ALERTS = 5;
import { EligibilityFilter } from '../signals/eligibilityFilter';
import { curveProgressPctOfState, curveProgressUnreadable, isCurveTooFar, curveTooFarReason } from '../signals/curveProgressCap';
import { localSigner } from '../solana/signer';
import { txBuilder, SolanaTransactionBuilder, PumpBuyParams, PumpSellParams } from '../solana/transactionBuilder';
import { SolanaRpcTransport, JitoTransport, onRpcAuthRejected, RPC_AUTH_REJECTED, RPC_AUTH_REJECTED_TEXT } from '../solana/transports';
import { riskEngine, estimateRoundTripCostLamports, MAX_ROUND_TRIP_COST_FRACTION, PUMP_USER_VOLUME_ACCUMULATOR_RENT_LAMPORTS } from '../risk/riskEngine';
import { userVolumeAccumulatorPda } from '@pump-fun/pump-sdk';
import { paperEngine, PaperExecutionEngine } from './paperEngine';
import { workstationDb, WorkstationDatabase, type PersistedTransaction } from '../db/database';
import { getRandomJitoTipAccount, TOKEN_2022_PROGRAM_ID } from '../solana/programs';
import { executionConfig } from '../solana/executionConfig';
import { Logger, endpointOrigin } from '../middleware/enterprise';
import { traced } from '../observability/tracing';
import { acquireLock, dbLockPath, isPidAlive, signerLockPath, updateHeldLock } from '../system/instanceLock';
import crypto from 'node:crypto';
import { createTradingConnection } from '../solana/rpcConnection';
import { allowedCluster, assertClusterAllowed, assertClusterAllowedCached, assertSendClusterAllowed, blockhashCheckEnabled, ClusterGuardError, forgetGenesisCheck, rememberGenesisCheck, resolveRpcUrl, verifyBlockhashIndependently } from '../solana/clusterGuard';
import { PumpCurveService, TradeQuote, PumpMarketState, fetchTokenHolderDistribution } from '../solana/pumpCurve';
import { TradeReconciler, RealMarkPriceService, PreTradeSnapshot } from './reconciliation';
export type { PreTradeSnapshot };
import { CapitalSizer } from '../capital/capitalSizer';
import { ExitEngine } from '../exits/exitEngine';

export interface ExecuteTradeRequest {
  mint: string;
  symbol: string;
  name: string;
  amountSol: number;
  currentPriceSol?: number;
  slippageBps?: number;
  jitoTipSol?: number;
  source: 'MANUAL' | 'AUTO_SNIPER' | 'TELEGRAM_BOT' | 'HOT_CALLOUT' | 'COPY_TRADE' | 'SOCIAL_SCANNER';
  provenance: SignalProvenance;
  eligibilityReport?: TokenEligibilityReport;
  liquidityUsd?: number;
  signalTimestamp?: number;
  marketDataTimestamp?: number;
  /**
   * The mode the caller sized and gated this trade for (R5). If the coordinator's mode is different when the trade arrives (LIVE was armed or
   * disarmed during the caller's awaits), the trade is refused instead of running in the other mode.
   */
  executionMode?: ExecutionMode;
}

/**
 * What closePosition did. R5-7/R6-9: `adoptedPendingSell` is set when the call sent nothing and instead booked an earlier sell of this
 * position that had landed unseen; `adoptedPartial` (with `remainingTokensRaw`) when that earlier sell was a partial, so the position is
 * still open (PARTIALLY_CLOSED) although the call asked for more. A caller that asked for 100% must not report it as closed.
 */
export interface ClosePositionResult {
  success: boolean;
  pnlSol: number;
  status?: string;
  error?: string;
  solMoved?: number;
  notSent?: boolean;
  adoptedPendingSell?: boolean;
  adoptedPartial?: boolean;
  remainingTokensRaw?: string;
}

export interface ExecutionResponse {
  success: boolean;
  lifecycleState: ExecutionLifecycleState;
  positionId?: string;
  signature?: string;
  txSignature?: string;
  bundleId?: string;
  fillPriceSol?: number;
  /** Q7: the price the order was quoted at (curve execution price, fees included), so a caller measures slippage against the quote and not a stale pool price. */
  quotePriceSol?: number;
  tokensReceived?: number;
  executionMode: ExecutionMode;
  feesPaidLamports?: number;
  error?: string;
  /** Which gates a PAPER fill passed (C5). */
  gates?: Record<string, unknown>;
  correlationId: string;
}

/**
 * S245: the waits before resending a SELL that the RPC refused with a rate limit (HTTP 429, -32007, "request limit reached"): three
 * resends, 0.5 s, 1 s and 2 s apart. Every sell gets them (the stop-loss, the hard stop and the panic among them: one rate-limit answer
 * must not leave a position open). 3.5 s of waits plus four bounded sends (RPC_REQUEST_TIMEOUT_MS each) is far inside a blockhash's
 * ~60-90 s life, and the resent bytes are the same signed transaction, so it can land at most once. A BUY gets none: it is optional,
 * its quote ages on a fast curve, and the next signal re-quotes; a rate-limited buy fails closed as SUBMIT_FAILED.
 */
export const SELL_RATE_LIMIT_BACKOFF_MS: readonly number[] = [500, 1_000, 2_000];

/** Exit reasons that run even while all trading is halted (see closePosition). */
// A blockhash lives ~60-90s; after this a sent-but-unseen sell can no longer land.
const PENDING_SELL_WINDOW_MS = 100_000;
const ORPHAN_MAX_AGE_MS = 15 * 60_000;
/** P1.7: how long one exit pass waits for the sells it started before it ends; a longer sell keeps running and the next pass goes on. */
export const EXIT_SELL_WAIT_MS = 2_500;
/** P1.1: a sell claim older than this is stale (longer than a sell takes end to end: build, send, confirm, reconcile). */
const EXIT_CLAIM_STALE_MS = 2 * PENDING_SELL_WINDOW_MS;
/** One id per process run: a pid alone is reused, and in a container every restart of the app is PID 1 again. */
const PROCESS_RUN_ID = crypto.randomUUID();
/** The exit claim owner for one sell: `<pid>:<run id>:<nonce>`. */
export const newExitClaimOwner = (): string => `${process.pid}:${PROCESS_RUN_ID}:${crypto.randomUUID()}`;
/**
 * P1.1: a claim whose process has died is stale at once (a crash mid-sell must not hold the stop-loss off). A claim with this process's pid
 * but another run id (or the older `<pid>:<nonce>` form) was left by an earlier run that had the same pid, so it is dead too: after a
 * container restart the app is PID 1 again, and `isPidAlive(1)` held the stop-loss off for EXIT_CLAIM_STALE_MS.
 */
export const exitClaimOwnerAlive = (owner: string): boolean => {
  const [pidText, runId] = owner.split(':');
  const pid = Number(pidText);
  if (pid === process.pid) return owner.split(':').length === 3 && runId === PROCESS_RUN_ID;
  return isPidAlive(pid);
};

/**
 * The take-profit stage a filled exit leaves the position at: TAKE_PROFIT_1 and TAKE_PROFIT_2 advance it (never backwards), every other
 * reason leaves it. Booked with the fill itself, and by startup recovery from the SELL row's reason, so a crash between the sell and a
 * separate stage write cannot make the same take-profit fire again (R1-24, R1-91).
 */
export function exitStageAfterFill(reason: string | undefined, current: NormalizedPosition['exitStage']): NormalizedPosition['exitStage'] {
  const reached = reason === 'TAKE_PROFIT_2' ? 2 : reason === 'TAKE_PROFIT_1' ? 1 : 0;
  return Math.max(current ?? 0, reached) as NormalizedPosition['exitStage'];
}

/** A balance found in the wallet that this app never bought (cost basis unknown): watched with a hard stop, not a trade the app chose. */
/** E2: true when a token program (SPL Token or Token-2022) owns the account; an unknown owner counts as owned, so a read that cannot tell decides nothing. */
const ownedByTokenProgram = (owner: PublicKey | undefined): boolean => !owner || typeof (owner as any).equals !== 'function' || owner.equals(TOKEN_PROGRAM_ID) || owner.equals(TOKEN_2022_PROGRAM_ID);

/** 3B: the decision-journal outcome of a landed LIVE buy (any caller); its row carries the buy's wallet SOL delta. */
export const LIVE_BUY_FILLED = 'LIVE_BUY_FILLED';
export const isRecoveredPosition = (p: { entryTxSignature?: string }): boolean => !!p.entryTxSignature?.startsWith('RECOVERED:');
/** R1 #4: the `error` tag of a landed SELL row whose fill could not be read when it was adopted (its basis share is booked as a loss). */
export const UNREAD_SELL_FILL_TAG = 'SELL_FILL_UNREAD_ASSUMED_LOSS';

// Q11: the reasons the operator routes actually pass ('Manual user order' from POST /api/wallet/close, 'Aggregator Close' from the WS
// CLOSE_POSITION / aggregator close route, 'Operator close' from POST /api/execution/close) count as manual closes, as the halt alert promises.
/** Late buy: the close reason of the sell of a buy that landed after a panic or kill (the panic's, emergencyStop.ts PANIC_CLOSE_REASON). */
export const LATE_BUY_EXIT_REASON = 'EMERGENCY_PANIC_LIQUIDATION';
export const PROTECTIVE_EXIT_REASONS = /^(STOP_LOSS|TRAILING_STOP|EMERGENCY_PANIC_LIQUIDATION|MANUAL|Manual Close|Manual user order|Aggregator Close|Operator close)$/;

export class ExecutionCoordinator {
  private executionMode: ExecutionMode = 'PAPER';
  private isLiveTradingArmed: boolean = false;
  private inFlightReservedSol: number = 0;
  /** Q8: exits between the first line of closePosition and the journal row that records their fill. */
  private exitsInFlight = 0;
  private inFlightPositionExits: Set<string> = new Set<string>();
  private inFlightBuyMints: Set<string> = new Set<string>();
  private connection: Connection;
  private rpcEndpoint: string;
  private rpcLatencyMs: number = 0;
  private rpcHealth: 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED' = 'DISCONNECTED';
  private pumpFeedHealth: 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED' = 'DISCONNECTED';
  private lastPumpFeedTimestamp: number = 0;
  /** Last time the (mainnet-only) pump.fun HTTP API answered while trading on another cluster. */
  private lastMainnetApiTimestamp: number = 0;
  private readonly startedAt: number = Date.now();
  private readonly startupGracePeriodMs: number = parseInt(process.env.STARTUP_GRACE_PERIOD_MS || '300000', 10); // 5-minute initialization grace period (B02)
  private positionMarkHealth: 'HEALTHY' | 'DEGRADED' | 'STALE' = 'HEALTHY';
  private lastPositionMarkTimestamp: number = 0;
  /** R4-3: performance.now() at the time of lastPositionMarkTimestamp (0 with it); every age of the mark feed is measured on this clock. */
  private lastPositionMarkMono: number = 0;
  /** R4-3: per position, the wall stamp of the last mark this process applied and the monotonic time it stands for. */
  private markMono = new Map<string, { wall: number; mono: number }>();
  private realWalletBalanceSol: number | null = null;
  private lastRpcSyncTimestamp: number = 0;
  private jitoTransport: JitoTransport;
  private rpcTransport: SolanaRpcTransport;
  private lastMarketEventTimestamp: number = 0;
  private lastRealMarketEventTimestamp: number = 0;
  private lastSyntheticMarketEventTimestamp: number = 0;
  private autoTpSlInterval: NodeJS.Timeout | null = null;
  private feedHeartbeatInterval: NodeJS.Timeout | null = null;
  private jitoProbeInterval: NodeJS.Timeout | null = null;
  private lastStartupReconciliation: {
    status: 'EXECUTION_READY' | 'RECONCILIATION_MISMATCH' | 'SIGNER_LOCKED' | 'OFFLINE';
    checkedAt: number;
    details: string;
  } | null = null;

  private readonly isDefaultSingleton: boolean;

  constructor(connectionOrIsSingleton: Connection | boolean = false, isDefaultSingleton: boolean = false) {
    const isConn = Boolean(
      connectionOrIsSingleton &&
      typeof connectionOrIsSingleton === 'object' &&
      ('getSlot' in connectionOrIsSingleton || (connectionOrIsSingleton as any) instanceof Connection)
    );
    if (isConn) {
      this.isDefaultSingleton = Boolean(isDefaultSingleton);
      this.connection = connectionOrIsSingleton as Connection;
      this.rpcEndpoint = (connectionOrIsSingleton as any)._rpcEndpoint || resolveRpcUrl();
    } else {
      this.isDefaultSingleton = Boolean(connectionOrIsSingleton);
      this.rpcEndpoint = resolveRpcUrl();
      this.connection = createTradingConnection(this.rpcEndpoint); // P1.7: bounded calls, no web3.js 429 sleeps
    }
    this.jitoTransport = new JitoTransport(this.connection);
    this.rpcTransport = new SolanaRpcTransport(this.connection);
    // R4-10: any read or send the RPC refuses with 401/402/403 (the trading Connection's fetch reports it) raises one named alert.
    this.offRpcAuthRejected = onRpcAuthRejected(({ status, method }) => this.raiseRpcAuthAlert(status, method));
    if (this.isDefaultSingleton) {
      // A halt (for example an unexplained wallet drain) must outlive a restart; only an operator clears it.
      const persisted = workstationDb.getPersistedHaltReason();
      if (persisted) {
        this.haltReason = persisted;
        Logger.error(`[HALT] Trading is still halted from before the restart: ${persisted}`);
        this.raiseOperatorAlert('TRADING_HALTED', `All trading is halted (restored after a restart): ${persisted}. Protective exits (stop-loss, trailing stop, manual close, panic) still run; clear it with POST /api/auto/resume {clearHalt:true}.`);
      }
      // The kill switch is in memory and off after a restart (by decision: LIVE boots disarmed, auto starts OFF at every boot). An operator who
      // tripped it must still hear that it no longer holds. The reset row makes the alert fire on this boot only.
      const killSwitchTrip = workstationDb.getKillSwitchTripBeforeRestart();
      if (killSwitchTrip) {
        Logger.warn(`[KILL SWITCH] It was on before the restart (${killSwitchTrip}) and is off now`);
        this.raiseOperatorAlert('KILL_SWITCH_WAS_ON', `The kill switch was on before the restart (${killSwitchTrip}) and is off now. LIVE is disarmed and auto is OFF (it starts OFF at every boot); check why it was tripped before arming or setting a mode. Cleared by POST /api/auto/resume {clearHalt:true}.`);
        workstationDb.logJournal('KILL_SWITCH_RESET', 'kill-switch', 'PAPER', { reason: 'process restart' });
      }
    }
    // P1.1 (N-51): the module singleton is built at import time and starts nothing; server.ts calls start() once its port is bound,
    // so a second process that fails to boot never reconciles, runs the exit loop or polls the RPC. Instances built directly (tests,
    // tools that pass their own Connection) start at once, as before.
    if (!this.isDefaultSingleton) this.start();
  }

  private started = false;

  /**
   * P1.1: begin trading-side work: the instance locks (database file and signing key), the RPC connection check with startup
   * reconciliation, the 3 s exit loop and the feed heartbeat. Idempotent. Throws InstanceLockError when another live process holds
   * either lock, before anything has started.
   */
  public start(): void {
    if (this.started) return;
    const dbLock = dbLockPath(workstationDb.getDbPath());
    if (dbLock) acquireLock(dbLock, { dbPath: workstationDb.getDbPath() });
    let pub: string | null;
    try {
      pub = localSigner.getStatus() === 'READY' ? localSigner.getPublicKey().toBase58() : null;
    } catch {
      pub = null; // no key to lock; signTransaction takes the signer lock on the first signature anyway
    }
    if (pub) {
      acquireLock(signerLockPath(pub), { walletPubkey: pub, dbPath: workstationDb.getDbPath() });
      if (dbLock) updateHeldLock(dbLock, { walletPubkey: pub });
    }
    this.started = true;
    this.seedPendingSellsFromLedger();
    this.initializeConnection();
    this.startAutoPositionMonitor();
    this.startMarketFeedHeartbeat();
  }

  public isStarted(): boolean {
    return this.started;
  }

  private startMarketFeedHeartbeat() {
    const checkFeed = async () => {
      try {
        const t0 = performance.now();
        const slot = await this.connection.getSlot('processed');
        const latency = Math.round(performance.now() - t0);
        if (slot > 0) {
          const hadProblem = this.clusterProblem !== null;
          if (await this.verifyCluster()) {
            this.recordRpcHeartbeat(slot, latency);
            // The boot pass skipped reconciliation (genesis unreadable or wrong, or the first connect failed outright - F3):
            // run it once now that the RPC is up and verified. startupReconciliation is single-flight, so this cannot overlap
            // a pass that is already running.
            if (this.lastStartupReconciliation === null && (hadProblem || this.bootConnectFailed)) {
              this.bootConnectFailed = false;
              void this.syncRealWalletBalance()
                .catch(() => undefined)
                .then(() => this.startupReconciliation())
                .catch(() => undefined);
            }
          }
        }
      } catch {
        this.rpcHealth = 'DISCONNECTED';
      }

      // Check pump feed freshness (strategy-critical Pump.fun stream)
      const now = Date.now();
      const pumpAge = this.lastPumpFeedTimestamp > 0 ? now - this.lastPumpFeedTimestamp : Infinity;
      if (pumpAge > 120000) {
        this.pumpFeedHealth = 'DISCONNECTED';
      } else if (pumpAge > 45000) {
        this.pumpFeedHealth = 'DEGRADED';
      } else {
        this.pumpFeedHealth = 'HEALTHY';
      }

      // Check position mark freshness. The clock belongs to open LIVE positions: with none open there is nothing to be
      // stale, so it resets (otherwise the feed read STALE 90 s after the last close and blocked arming until a restart),
      // and a PAPER position that cannot be priced (e.g. a mainnet-only mint on devnet) never turns the feed red.
      let liveOpen: boolean;
      try {
        // R5-1: an adopted RECOVERED balance (often one nobody can price) does not own the clock, or it would hold the feed STALE for good
        liveOpen = workstationDb.loadPositions('LIVE', 'ACTIVE').some((p) => !isRecoveredPosition(p));
      } catch {
        liveOpen = true; // cannot tell: keep the clock running rather than hide a dead feed
      }
      if (!liveOpen) this.setPositionMarkClock(0);
      const markAge = this.positionMarkAgeMs() ?? 0; // R4-3: monotonic
      if (markAge > 90000) {
        this.positionMarkHealth = 'STALE';
      } else if (markAge > 45000) {
        this.positionMarkHealth = 'DEGRADED';
      } else {
        this.positionMarkHealth = 'HEALTHY';
      }
    };
    checkFeed();
    this.feedHeartbeatInterval = setInterval(checkFeed, 10000);
  }

  /** Re-probe the block engine on an interval so readiness reflects current health, not boot-time health. */
  private startJitoProbeLoop() {
    if (this.jitoProbeInterval || !this.jitoTransport.isEnabled()) return;
    const intervalMs = Math.max(1000, executionConfig.getConfig().jitoProbeIntervalMs);
    this.jitoProbeInterval = setInterval(() => {
      if (this.jitoTransport.isEnabled()) void this.jitoTransport.probe();
    }, intervalMs);
  }

  private async initializeConnection() {
    try {
      const t0 = performance.now();
      const slot = await this.connection.getSlot('processed');
      this.rpcLatencyMs = Math.round(performance.now() - t0);
      // An RPC that answers for a cluster other than the allowed one is not "healthy": readiness must refuse to arm on it,
      // not wait for the first send to find out (the send path still re-checks). Started now, awaited after the Jito probe.
      const clusterCheck = this.verifyCluster();
      await this.jitoTransport.probe();
      this.startJitoProbeLoop();
      if (!(await clusterCheck)) {
        // S254 (L3): reconciliation is skipped here, so the heartbeat must run it once the RPC verifies. Its own check can pass before this
        // one fails (the two run at once at boot); it then sees no cluster problem and, without this flag, never reconciled, which left
        // the exit pass skipping every LIVE position with an unresolved sell for good.
        this.bootConnectFailed = true;
        Logger.warn(`Solana RPC is not on the allowed cluster: ${this.clusterProblem}. Staying DISCONNECTED; the heartbeat re-checks.`);
        return;
      }
      this.rpcHealth = this.rpcLatencyMs > 800 ? 'DEGRADED' : 'HEALTHY';
      Logger.info(`Solana RPC connected: Slot ${slot}, Latency ${this.rpcLatencyMs}ms`);
      await this.syncRealWalletBalance();
      await this.startupReconciliation();
    } catch (err: any) {
      this.rpcHealth = 'DISCONNECTED';
      this.bootConnectFailed = true; // F3: the heartbeat runs startup reconciliation once the RPC comes back
      Logger.warn(`Solana RPC connection failed: ${err.message}. Operating in safe paper/offline mode.`);
    }
  }

  /** Why the RPC is not trusted (wrong genesis, or genesis unreadable); null once a check passes. Sticky across heartbeats. */
  private clusterProblem: string | null = null;

  /**
   * Genesis check for readiness (not only for sends). Never throws: returns true when the RPC is on the allowed cluster.
   * A failure pins rpcHealth to DISCONNECTED until a later check passes, so a healthy getSlot cannot hide a wrong cluster.
   */
  private async verifyCluster(): Promise<boolean> {
    try {
      const { genesisHash } = await assertClusterAllowed(this.connection);
      // P2.2 (R1-89): the database remembers the cluster it was written for and refuses an RPC on another one.
      const stamp = workstationDb.checkClusterStamp(genesisHash);
      if (!stamp.ok && stamp.unreadable) throw new Error(`DB_CLUSTER_STAMP_UNREADABLE: the cluster stamp of ${workstationDb.getDbPath()} could not be read (${stamp.unreadable}); refusing to reconcile or trade until it can`);
      if (!stamp.ok) throw new Error(`DB_CLUSTER_MISMATCH: ${workstationDb.getDbPath()} holds the ledger of genesis ${stamp.stored}, but the RPC is on ${genesisHash}; refusing to reconcile or trade against it`);
      rememberGenesisCheck(this.connection); // S208: readiness warms the send-path cache
      this.clusterProblem = null;
      return true;
    } catch (err: any) {
      this.clusterProblem = err?.message ?? 'cluster check failed';
      this.rpcHealth = 'DISCONNECTED';
      forgetGenesisCheck(this.connection); // R1-1/N-27: sends must not ride an earlier pass for up to 60 s
      return false;
    }
  }

  /** S210: null when the order may be signed, else why not. See `verifyBlockhashIndependently`. A buy needs a clean pass; a sell is refused only on a definite "no" after its longer re-checks (R3-6), and one that goes out unchecked raises SELL_BLOCKHASH_UNCHECKED. */
  private async blockhashProblem(tx: VersionedTransaction, side: 'BUY' | 'SELL'): Promise<string | null> {
    if (!blockhashCheckEnabled()) return null;
    const verdict = await traced('guard.blockhash', () => verifyBlockhashIndependently(tx.message.recentBlockhash, process.env, {}, side), { 'apex.side': side });
    if (verdict.ok) {
      // S227: say so when the check really ran, so a run that has it on shows it; a skipped check (flag off, localnet) is silent.
      if (!('skipped' in verdict && verdict.skipped)) Logger.info(`[S210] independent blockhash check passed for the ${side}`);
      return null;
    }
    if (side === 'SELL' && !verdict.definite) {
      Logger.warn(`[S210] SELL not blocked: ${verdict.reason}`);
      // Round 1 #9: the guard did not run for this sell; say so where the operator looks, not only in the log.
      this.raiseOperatorAlert('SELL_BLOCKHASH_UNCHECKED', `A SELL was sent without the independent blockhash check: ${verdict.reason}`);
      return null;
    }
    Logger.error(`[S210] ${side} blocked: ${verdict.reason}`);
    return verdict.reason;
  }

  public getConnection(): Connection {
    return this.connection;
  }

  /** What the cluster check last said: the allowed cluster, why the RPC is not trusted (null when it is), and whether a check has passed. */
  public getClusterStatus(): { allowed: string; problem: string | null; rpcHealth: 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED' } {
    return { allowed: allowedCluster(), problem: this.clusterProblem, rpcHealth: this.rpcHealth };
  }

  /** The last startup reconciliation result (null before the first one finishes). */
  public getReconciliationStatus() {
    return this.lastStartupReconciliation ? { ...this.lastStartupReconciliation } : null;
  }

  /** Age in ms of the last pump event and the last position mark; null when none was ever seen. */
  public getFeedAges(now: number = Date.now()): { pumpFeedAgeMs: number | null; positionMarkAgeMs: number | null } {
    return {
      pumpFeedAgeMs: this.lastPumpFeedTimestamp > 0 ? now - this.lastPumpFeedTimestamp : null,
      positionMarkAgeMs: this.positionMarkAgeMs(),
    };
  }

  // Explicit LiveReadiness object with independent health tracking across all critical subsystems (R0.12)
  public getLiveReadiness(): LiveReadiness {
    const reasons: string[] = [];
    const now = Date.now();

    if (isReadOnly()) {
      reasons.push('READ_ONLY: APEX_READ_ONLY=true. This server watches and paper trades only; it has no signer and cannot execute live');
    }

    if (process.env.ALLOW_LIVE_REAL_MONEY_TRADING !== 'true') {
      reasons.push('Live real-money trading is disabled by environment policy (ALLOW_LIVE_REAL_MONEY_TRADING !== "true")');
    }

    const signerStatus = localSigner.getStatus();
    const signerHealthy = signerStatus === 'READY';
    if (!signerHealthy) {
      reasons.push(`Signer status is ${signerStatus} (Ed25519 keypair must be configured and ready)`);
    }

    if (this.realWalletBalanceSol === null || this.realWalletBalanceSol <= 0.015) {
      reasons.push(
        `Insufficient spendable wallet balance (${this.realWalletBalanceSol ?? 0} SOL, minimum 0.015 SOL reserve required)`
      );
    }

    const dbHealthy = workstationDb.isWritable();
    if (!dbHealthy) {
      reasons.push('Workstation SQLite database is not writable');
    }

    // P3.1 (N-20): DEMO_MODE loads fake callers and random-walks the demo pools' prices; it never runs next to LIVE, so arming refuses.
    if (process.env.DEMO_MODE === 'true') {
      reasons.push('DEMO_MODE=true: demo prices and callers are loaded; LIVE cannot be armed while it is on');
    }

    if (!this.lastStartupReconciliation || this.lastStartupReconciliation.status !== 'EXECUTION_READY') {
      reasons.push(
        this.lastStartupReconciliation
          ? `Startup reconciliation has unresolved issues: ${this.lastStartupReconciliation.details}`
          : 'Startup reconciliation is in progress or has not completed'
      );
    }

    const rpcHealthy = this.rpcHealth === 'HEALTHY';
    if (!rpcHealthy) {
      reasons.push(`Solana RPC health is ${this.rpcHealth} (Must be HEALTHY)`);
    }

    const inGracePeriod = now - this.startedAt < this.startupGracePeriodMs;
    const pumpFeedAgeMs = this.lastPumpFeedTimestamp > 0 ? now - this.lastPumpFeedTimestamp : Infinity;
    const isPumpFeedWarmingUp = this.isDefaultSingleton && this.lastPumpFeedTimestamp === 0 && inGracePeriod;
    const pumpFeedStatus: 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED' | 'WARMING_UP' = isPumpFeedWarmingUp
      ? 'WARMING_UP'
      : this.pumpFeedHealth;
    // The pump event stream and "real market events" are mainnet-activity signals. On devnet/localnet a quiet network is normal and the
    // pump.fun HTTP API is a MAINNET data source (see recordPumpFeedEvent), so neither blocks readiness there.
    const feedRequired = allowedCluster() === 'mainnet-beta';
    const pumpFeedHealthy = !feedRequired || (this.pumpFeedHealth === 'HEALTHY' && pumpFeedAgeMs <= 120000) || isPumpFeedWarmingUp;

    if (!pumpFeedHealthy) {
      const feedAgeSec = this.lastPumpFeedTimestamp > 0 ? Math.round(pumpFeedAgeMs / 1000) : null;
      reasons.push(
        `Pump.fun real event stream is ${this.pumpFeedHealth} (${feedAgeSec !== null ? `${feedAgeSec}s ago` : 'never received'})`
      );
    }

    const markAgeMs = this.positionMarkAgeMs() ?? Infinity; // R4-3: monotonic
    const markFeedHealthy = this.positionMarkHealth === 'HEALTHY' && (this.lastPositionMarkTimestamp === 0 || markAgeMs <= 120000);
    if (!markFeedHealthy || this.positionMarkHealth === 'STALE') {
      reasons.push(
        `Position mark feed is ${this.positionMarkHealth} (${markAgeMs === Infinity ? 'never marked' : `${Math.round(markAgeMs / 1000)}s ago`})`
      );
    }

    if (this.haltReason) {
      reasons.push(`All trading is halted: ${this.haltReason}`);
    }

    if (this.isExitLoopFailing()) {
      reasons.push(`The exit loop is failing (${this.exitPassFailures} passes in a row threw; stop-loss and take-profit are not running)`);
    }
    const unrecoveredBuys = this.unrecoveredLandedBuysProblem();
    if (unrecoveredBuys) reasons.push(unrecoveredBuys);

    if (riskEngine.isKillSwitchActive()) {
      reasons.push('Emergency risk kill switch is active');
    }

    // T1: the switch is off after a restart (by decision), but LIVE does not arm until the operator has cleared the boot alert that says it was on.
    if (this.operatorAlerts.some((a) => a.code === 'KILL_SWITCH_WAS_ON' && !a.cleared)) {
      reasons.push('The kill switch was on before the restart; clear KILL_SWITCH_WAS_ON with POST /api/auto/resume {clearHalt:true} before arming');
    }

    if (riskEngine.getCircuitBreakerState() !== 'CLOSED') {
      reasons.push(`Risk circuit breaker is tripped (${riskEngine.getCircuitBreakerState()})`);
    }

    const jitoTelemetry = this.jitoTransport.getTelemetry();
    const jitoReadiness = this.getJitoReadiness();
    const jitoHealthy = jitoReadiness.ready;
    if (!jitoHealthy && jitoReadiness.reason) {
      reasons.push(jitoReadiness.reason);
    }

    const realFeedAgeMs = this.lastRealMarketEventTimestamp > 0
      ? now - this.lastRealMarketEventTimestamp
      : Infinity;
    const isRealMarketWarmingUp = this.lastRealMarketEventTimestamp === 0 && inGracePeriod;
    if (feedRequired && realFeedAgeMs > 120000 && !isRealMarketWarmingUp) {
      reasons.push(
        `Real on-chain market feed has no recent events (${
          realFeedAgeMs === Infinity ? 'never received' : Math.round(realFeedAgeMs / 1000) + 's ago'
        })`
      );
    }

    return {
      ready: reasons.length === 0,
      reasons,
      components: {
        rpc: {
          healthy: rpcHealthy,
          latencyMs: this.rpcLatencyMs,
          status: this.rpcHealth,
        },
        pumpFeed: {
          healthy: pumpFeedHealthy,
          lastEventAgeMs: pumpFeedAgeMs === Infinity ? -1 : pumpFeedAgeMs,
          status: pumpFeedStatus,
          required: feedRequired,
          mainnetApiLastEventAgeMs: this.lastMainnetApiTimestamp > 0 ? now - this.lastMainnetApiTimestamp : -1,
        },
        markFeed: {
          healthy: markFeedHealthy,
          lastMarkAgeMs: markAgeMs === Infinity ? -1 : markAgeMs,
          status: this.positionMarkHealth,
        },
        jito: {
          healthy: jitoHealthy,
          status: jitoTelemetry.health,
        },
        db: {
          healthy: dbHealthy,
          status: dbHealthy ? 'HEALTHY' : 'ERROR',
        },
        signer: {
          healthy: signerHealthy,
          status: signerStatus,
        },
      },
      checkedAt: now,
    };
  }

  // Authoritative fail-closed evaluation of all live trading prerequisites
  public canExecuteLive(): { allowed: boolean; reasons: string[]; readiness: LiveReadiness } {
    const readiness = this.getLiveReadiness();
    return {
      allowed: readiness.ready,
      reasons: readiness.reasons,
      readiness,
    };
  }

  /** R7-3: a landed LIVE buy with no position has no stop-loss; while one is unresolved readiness is not green and LIVE buys are refused. */
  private unrecoveredLandedBuysProblem(): string | null {
    const n = this.unrecoveredLandedBuys.length;
    if (n === 0) return null;
    return `${n} LIVE buy(s) sent earlier are not resolved and may hold tokens with no stop-loss (${this.unrecoveredLandedBuys.map((s) => s.slice(0, 8)).join(',')}); orphan recovery keeps retrying`;
  }

  /**
   * P3.1 (R1-0): the cheap readiness checks every LIVE buy runs, not only the arm. canExecuteLive runs once, when LIVE is armed; a database
   * that turns read-only, a reconciliation mismatch, a tripped breaker or a stale mark feed after that must still stop the next buy. Direct
   * reads, no cache (the plan leaves a 2 s cached canExecuteLive open; these are cheap enough to run on every buy). Sells never call this.
   * Returns why the buy is refused; empty means it may go on.
   */
  private liveBuyReadinessProblems(): string[] {
    const problems: string[] = [];
    if (this.clusterProblem !== null) problems.push(`the RPC is not on the allowed cluster (${this.clusterProblem})`);
    if (this.rpcHealth === 'DISCONNECTED') problems.push('Solana RPC is DISCONNECTED');
    if (this.rpcSlotProblem) problems.push(`the RPC's slot cannot be trusted (${this.rpcSlotProblem})`); // R4-9
    if (!workstationDb.isWritable()) problems.push('the workstation database is not writable');
    if (!this.lastStartupReconciliation || this.lastStartupReconciliation.status !== 'EXECUTION_READY') {
      problems.push(`startup reconciliation is ${this.lastStartupReconciliation?.status ?? 'not finished'}`);
    }
    const breaker = riskEngine.getCircuitBreakerState();
    if (breaker !== 'CLOSED') problems.push(`the risk circuit breaker is ${breaker}`);
    if (this.positionMarkHealth === 'STALE') problems.push('the position mark feed is STALE');
    if (this.isExitLoopFailing()) problems.push(`the exit loop is failing (${this.exitPassFailures} passes in a row; EXIT_LOOP_FAILING)`);
    if (process.env.DEMO_MODE === 'true') problems.push('DEMO_MODE=true (demo prices and callers are loaded)');
    const unrecovered = this.unrecoveredLandedBuysProblem();
    if (unrecovered) problems.push(unrecovered);
    return problems;
  }

  private connectionChangeListeners = new Set<(conn: Connection) => void>();

  /**
   * P4.2 (R1-63): called with the new trading Connection after every successful `setRpcEndpoint`, so what holds a Connection of its
   * own (the pump log listener) moves with it. Returns the unsubscribe function.
   */
  public onConnectionChange(fn: (conn: Connection) => void): () => void {
    this.connectionChangeListeners.add(fn);
    return () => { this.connectionChangeListeners.delete(fn); };
  }

  // Update RPC endpoint with safe re-instantiation
  public async setRpcEndpoint(newEndpoint: string): Promise<{ success: boolean; latencyMs: number; error?: string }> {
    try {
      if (resolveRpcUrl(newEndpoint) !== newEndpoint.trim()) {
        throw new Error(`CLUSTER_GUARD: RPC endpoint rejected (looks like mainnet while ALLOWED_CLUSTER=${allowedCluster()})`);
      }
      const newConn = createTradingConnection(newEndpoint); // P1.7: the replacement is bounded the same way
      forgetGenesisCheck(this.connection); // R1-1: a switch never keeps the old connection's pass
      await assertClusterAllowed(newConn);
      rememberGenesisCheck(newConn);
      const t0 = performance.now();
      await newConn.getSlot('processed');
      const latency = Math.round(performance.now() - t0);

      this.rpcEndpoint = newEndpoint;
      this.connection = newConn;
      this.heartbeatSlot = { slot: 0, firstSeenMono: 0 }; // R4-9: another endpoint has its own slot clock
      this.rpcSlotProblem = null;
      this.clusterProblem = null; // the new connection just passed the genesis check above
      this.rpcLatencyMs = latency;
      this.rpcHealth = latency > 800 ? 'DEGRADED' : 'HEALTHY';
      this.jitoTransport = new JitoTransport(this.connection);
      this.rpcTransport = new SolanaRpcTransport(this.connection);
      PumpCurveService.resetGlobalCache(); // P4.2 (N-43): the pump Global and FeeConfig are read again from the new endpoint
      for (const fn of this.connectionChangeListeners) {
        try { fn(newConn); } catch (e: any) { Logger.warn(`RPC switch listener failed: ${e?.message || e}`); }
      }

      Logger.info(`Switched Solana RPC endpoint to ${endpointOrigin(newEndpoint)} (${latency}ms)`);
      await this.syncRealWalletBalance();
      return { success: true, latencyMs: latency };
    } catch (err: any) {
      Logger.error(`Failed to switch RPC endpoint: ${err.message}`);
      return { success: false, latencyMs: 0, error: err.message };
    }
  }

  // Update Jito Block Engine URL
  public setJitoBlockEngineUrl(url: string) {
    this.jitoTransport.setBlockEngineUrl(url);
    Logger.info(`Updated Jito Block Engine URL to ${endpointOrigin(url)}`);
  }

  /**
   * Jito readiness for live execution. With no block engine configured (devnet), RPC is the only transport
   * and there is nothing to be healthy, so it is not a blocker. With a block engine configured it must be
   * HEALTHY from a recent real probe, otherwise live execution fails closed.
   */
  public getJitoReadiness(): { ready: boolean; enabled: boolean; status: string; reason?: string } {
    const telemetry = this.jitoTransport.getTelemetry();
    if (!this.jitoTransport.isEnabled()) {
      return { ready: true, enabled: false, status: 'NOT_CONFIGURED' };
    }
    const maxProbeAgeMs = Math.max(45_000, executionConfig.getConfig().jitoProbeIntervalMs * 3);
    const probeAgeMs = this.jitoTransport.getProbeAgeMs();
    if (telemetry.health !== 'HEALTHY') {
      return { ready: false, enabled: true, status: telemetry.health, reason: `Jito Block Engine is ${telemetry.health} (Must be HEALTHY for live execution)` };
    }
    if (probeAgeMs === null || probeAgeMs > maxProbeAgeMs) {
      return { ready: false, enabled: true, status: 'STALE', reason: 'Jito Block Engine health probe is stale (Must be HEALTHY for live execution)' };
    }
    return { ready: true, enabled: true, status: 'HEALTHY' };
  }

  /** Dynamic tip, forced to zero when Jito is not in use so no lamports are sent to a tip account. */
  private resolveLiveTip(params: Parameters<typeof executionConfig.resolveDynamicJitoTip>[0]) {
    const tip = executionConfig.resolveDynamicJitoTip(params);
    if (this.jitoTransport.isEnabled()) return tip;
    return { ...tip, tipLamports: 0, tipSol: 0, policyReason: `${tip.policyReason} -> Jito disabled, tip forced to 0 (RPC transport)` };
  }

  public getJitoTransport(): JitoTransport {
    return this.jitoTransport;
  }

  public setJitoTransport(transport: JitoTransport) {
    this.jitoTransport = transport;
  }

  public getRpcTransport(): SolanaRpcTransport {
    return this.rpcTransport;
  }

  public setRpcTransport(transport: SolanaRpcTransport) {
    this.rpcTransport = transport;
  }

  public setConnection(conn: Connection) {
    this.connection = conn;
    this.jitoTransport = new JitoTransport(this.connection);
    this.rpcTransport = new SolanaRpcTransport(this.connection);
  }

  // Provenance separation: Record verified on-chain RPC / market events
  public recordRealMarketEvent(source = 'SOLANA_RPC') {
    const now = Date.now();
    this.lastRealMarketEventTimestamp = now;
    this.lastMarketEventTimestamp = now;
  }

  /**
   * The pump.fun HTTP API (source 'PUMPFUN_SERVICE') is a MAINNET data source. Polling it says nothing about the cluster being traded, so
   * off mainnet it is recorded separately and never makes the pump feed or the real-market-event clock look healthy (critique K6).
   */
  public recordPumpFeedEvent(source = 'PUMPFUN_STREAM', mint?: string) {
    const now = Date.now();
    if (source === 'PUMPFUN_SERVICE' && allowedCluster() !== 'mainnet-beta') {
      this.lastMainnetApiTimestamp = now;
      return;
    }
    this.lastPumpFeedTimestamp = now;
    this.pumpFeedHealth = 'HEALTHY';
    this.lastRealMarketEventTimestamp = now;
    this.lastMarketEventTimestamp = now;
  }

  public recordRpcHeartbeat(slot: number, latencyMs: number) {
    this.rpcLatencyMs = latencyMs;
    if (this.clusterProblem) return; // a wrong-cluster RPC does not become healthy because getSlot answers
    // R4-9: health is not latency alone. A slot that goes backwards (a load balancer moved us to a lagging node) or stops advancing
    // while time passes means the node serves old state fast; it is DEGRADED (arming refuses) and every LIVE buy is refused meanwhile.
    this.rpcSlotProblem = this.heartbeatSlotProblem(slot);
    if (this.rpcSlotProblem) Logger.warn(`[R4-9] RPC slot check: ${this.rpcSlotProblem}`);
    this.rpcHealth = latencyMs > 800 || this.rpcSlotProblem ? 'DEGRADED' : 'HEALTHY';
  }

  /** R4-9: the heartbeat's slot clock: the highest slot seen and the monotonic time it was first seen. */
  private heartbeatSlot = { slot: 0, firstSeenMono: 0 };
  /** R4-9: why the heartbeat's slot cannot be trusted (backwards or stalled), null when it advances. */
  private rpcSlotProblem: string | null = null;

  private heartbeatSlotProblem(slot: number): string | null {
    const now = performance.now();
    if (!(slot > 0)) return null;
    const prev = this.heartbeatSlot;
    if (slot > prev.slot) {
      this.heartbeatSlot = { slot, firstSeenMono: now };
      return null;
    }
    if (slot < prev.slot) return `slot ${slot} is behind slot ${prev.slot} already seen on this endpoint (a lagging node)`;
    const stalledMs = now - prev.firstSeenMono;
    return stalledMs > RPC_SLOT_STALL_MS ? `slot ${slot} has not advanced for ${Math.round(stalledMs / 1000)}s` : null;
  }

  public recordPositionMarkEvent() {
    this.setPositionMarkClock(Date.now());
    this.positionMarkHealth = 'HEALTHY';
  }

  /**
   * R4-3: set the mark-feed clock to a wall time (0 resets it), with the monotonic time it stands for, so its age is measured on
   * performance.now() and a wall clock set back cannot make a dead feed look fresh.
   */
  private setPositionMarkClock(wall: number): void {
    this.lastPositionMarkTimestamp = wall;
    this.lastPositionMarkMono = wall > 0 ? performance.now() - Math.max(0, Date.now() - wall) : 0;
  }

  /** R4-3: age of the mark-feed clock in ms (monotonic), null when it is not running. A stamp set without its monotonic time ages on the wall clock, and one ahead of it is never fresh. */
  private positionMarkAgeMs(): number | null {
    if (this.lastPositionMarkTimestamp <= 0) return null;
    if (this.lastPositionMarkMono > 0) return Math.max(0, performance.now() - this.lastPositionMarkMono);
    const wall = Date.now() - this.lastPositionMarkTimestamp;
    return wall < 0 ? Infinity : wall;
  }

  /**
   * R4-3: how old a position's mark is, for the exit pass. A mark this process applied is aged on the monotonic clock. A mark from the
   * row only (written before a restart) is aged on the wall clock; a stamp ahead of the wall clock (the clock was set back) counts as
   * stale, so the position gets a direct read rather than a stop-loss blinded for the size of the step.
   */
  private markAgeMs(pos: NormalizedPosition): number {
    const wallStamp = pos.lastMarkTimestamp || pos.entryTimestamp || 0;
    const m = this.markMono.get(pos.id);
    if (m && pos.lastMarkTimestamp && m.wall === pos.lastMarkTimestamp) return Math.max(0, performance.now() - m.mono);
    if (!wallStamp) return 0;
    const wall = Date.now() - wallStamp;
    return wall < 0 ? MARK_STALE_MS + 1 : wall;
  }

  public getStartedAt(): number {
    return this.startedAt;
  }

  public getStartupGracePeriodMs(): number {
    return this.startupGracePeriodMs;
  }

  public getLastPumpFeedTimestamp(): number {
    return this.lastPumpFeedTimestamp;
  }

  // Record synthetic simulator events for UI visualizers without polluting real market freshness
  public recordSyntheticMarketEvent(source = 'SIMULATOR') {
    this.lastSyntheticMarketEventTimestamp = Date.now();
  }

  // Legacy fallback: route to synthetic to prevent spoofing live prerequisites
  public recordMarketEvent() {
    this.recordSyntheticMarketEvent('LEGACY_DISPATCH');
  }

  /** F3: the first RPC connect at boot failed, so startup reconciliation has not run yet. */
  private bootConnectFailed = false;
  private reconcileInFlight: Promise<{ status: 'EXECUTION_READY' | 'RECONCILIATION_MISMATCH' | 'SIGNER_LOCKED' | 'OFFLINE'; mismatchesCount: number; details: string }> | null = null;

  // Startup Reconciliation checking database, on-chain balances, and transport health.
  // Single-flight: a second call (e.g. POST /api/execution/reconcile during boot) joins the run in progress, so two
  // passes never recover the same pending transaction or rewrite the same positions at once.
  // `fresh` (the operator's Reconcile click) never takes the result of a run that started before the click: it waits for the run in
  // progress and then runs once more, shared by every fresh caller meanwhile (R17: the click is usually made after fixing something).
  /** R7-4: the in-flight run whose pass outlived the timeout (it keeps the lock until the pass ends). */
  private reconcileTimedOutRun: Promise<unknown> | null = null;
  private reconcileFollowUp: Promise<{ status: 'EXECUTION_READY' | 'RECONCILIATION_MISMATCH' | 'SIGNER_LOCKED' | 'OFFLINE'; mismatchesCount: number; details: string }> | null = null;
  public startupReconciliation(opts: { fresh?: boolean } = {}): Promise<{
    status: 'EXECUTION_READY' | 'RECONCILIATION_MISMATCH' | 'SIGNER_LOCKED' | 'OFFLINE';
    mismatchesCount: number;
    details: string;
  }> {
    if (opts.fresh && this.reconcileInFlight) {
      // R7-4: a pass that timed out is still running and still holds the lock; a fresh pass cannot start beside it, so the click gets the
      // timed-out answer at once (it says the pass is still running) instead of waiting on a hung RPC call.
      if (this.reconcileTimedOutRun === this.reconcileInFlight) return this.reconcileInFlight;
      if (!this.reconcileFollowUp) {
        const follow: Promise<{ status: 'EXECUTION_READY' | 'RECONCILIATION_MISMATCH' | 'SIGNER_LOCKED' | 'OFFLINE'; mismatchesCount: number; details: string }> = this.reconcileInFlight
          .catch(() => undefined)
          .then(() => {
            if (this.reconcileFollowUp === follow) this.reconcileFollowUp = null; // later fresh callers start their own
            return this.startupReconciliation();
          });
        this.reconcileFollowUp = follow;
      }
      return this.reconcileFollowUp;
    }
    if (!this.reconcileInFlight) {
      // R7: no await inside a pass has a timeout of its own, so a hung RPC call would make every later Reconcile click join the same
      // hung promise and readiness would say "in progress" forever. Bound the whole pass; on timeout record it as a mismatch (R7-4: a new pass starts only once the timed-out one has ended).
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('RECONCILIATION_TIMED_OUT')), this.reconcileTimeoutMs);
        timer.unref?.();
      });
      // R7-4: the timeout answers the callers, but it cannot stop the pass, which goes on writing (step 4 can book a sell). The lock is
      // therefore held until the pass itself settles: a call made meanwhile gets the timed-out answer instead of a second pass beside it.
      const pass = this.runStartupReconciliation();
      let passSettled = false;
      let runSettled = false;
      const release = () => {
        if (!(passSettled && runSettled)) return;
        if (this.reconcileInFlight === run) this.reconcileInFlight = null;
        if (this.reconcileTimedOutRun === run) this.reconcileTimedOutRun = null;
      };
      pass.then(() => { passSettled = true; release(); }, () => { passSettled = true; release(); });
      const run: ReturnType<typeof this.runStartupReconciliation> = Promise.race([pass, timeout])
        .catch((err: Error) => {
          if (err.message !== 'RECONCILIATION_TIMED_OUT') throw err; // a real failure still rejects, as before
          this.reconcileTimedOutRun = run;
          const details = `Reconciliation did not finish within ${Math.round(this.reconcileTimeoutMs / 1000)}s (an RPC call is hanging); it is still running, and a new pass can start once it ends`;
          this.lastStartupReconciliation = { status: 'RECONCILIATION_MISMATCH', checkedAt: Date.now(), details };
          return { status: 'RECONCILIATION_MISMATCH' as const, mismatchesCount: 1, details };
        })
        .finally(() => {
          if (timer) clearTimeout(timer);
          this.firstReconciliationDone = true; // P2.2: whatever the outcome (a timeout included), exits stop waiting for it
          runSettled = true;
          release();
        });
      this.reconcileInFlight = run;
    }
    return this.reconcileInFlight;
  }

  private async runStartupReconciliation(): Promise<{
    status: 'EXECUTION_READY' | 'RECONCILIATION_MISMATCH' | 'SIGNER_LOCKED' | 'OFFLINE';
    mismatchesCount: number;
    details: string;
  }> {
    const now = Date.now();
    let mismatchesCount = 0;
    const issues: string[] = [];

    // 0. A reconcile never vouches for an RPC on the wrong cluster (it would otherwise make a mainnet-answering RPC armable).
    // A wrong-cluster RPC answers "no such signature" for every real one, so steps 4 and 5 would mark pending and orphaned rows TIMED_OUT
    // (a landed sell then never gets its PnL, a landed buy its cost basis). While it is untrusted they wait, the pass is a mismatch, and
    // it is tried again.
    const clusterTrusted = await this.verifyCluster();
    if (!clusterTrusted) {
      issues.push(`RPC is not on the allowed cluster: ${this.clusterProblem}`);
      mismatchesCount++;
      this.scheduleReconcileRetry();
    }

    // 1. Check signer status
    const signerStatus = localSigner.getStatus();
    if (signerStatus !== 'READY') {
      issues.push(`Signer status is ${signerStatus}`);
    }

    // 2. Query real wallet SOL
    await this.syncRealWalletBalance();

    // 4. Resolve pending transactions from previous runs with actual on-chain transaction verification
    // R5-4: an unreadable transactions table is unknown, not empty. Nothing is resolved, step 4b closes nothing, and the pass is a mismatch.
    // R1 #1 / R5-3: a LIVE SELL left RECONCILIATION_REQUIRED (its fill could not be matched or rebuilt, or it was confirmed on a boot with no
    // signer) is tried again on every pass. Nothing else revisits it, and its position must never be closed as a zero-balance loss meanwhile.
    const unresolvedRead = workstationDb.loadTransactionsInStates(['PENDING', 'RECONCILIATION_REQUIRED']);
    const pendingRead = unresolvedRead === null
      ? null
      : unresolvedRead.filter((t) => t.reconciliationState === 'PENDING' || (t.direction === 'SELL' && t.executionMode === 'LIVE'));
    const ledgerUnreadable = pendingRead === null;
    if (ledgerUnreadable) {
      mismatchesCount++;
      issues.push('The transactions table could not be read; no pending transaction was resolved and no position was closed');
      this.scheduleReconcileRetry();
    }
    const pendingTxs = pendingRead ?? [];
    const readInStep4 = new Set<string>(); // BUY rows step 4 already read this pass; step 5 does not read them again
    if (pendingTxs.length > 0 && !clusterTrusted) {
      issues.push(`${pendingTxs.length} pending transaction(s) left as they are until the RPC is on the allowed cluster`);
    } else if (pendingTxs.length > 0) {
      Logger.info(`Found ${pendingTxs.length} pending transactions from previous session to reconcile.`);
      const walletPubkey = signerStatus === 'READY' ? localSigner.getPublicKey() : null;

      for (const pTx of pendingTxs) {
        if (pTx.direction === 'BUY') readInStep4.add(pTx.signature);
        try {
          const txStatus = await this.connection.getSignatureStatuses([pTx.signature], {
            searchTransactionHistory: true,
          });
          const status = txStatus?.value?.[0];

          if (status?.err) {
            pTx.reconciliationState = 'REVERTED';
            pTx.error = JSON.stringify(status.err);
            workstationDb.saveTransaction(pTx);
          } else if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
            // Actually inspect transaction details, fees, and landing slot
            const txDetails = await this.connection.getTransaction(pTx.signature, {
              maxSupportedTransactionVersion: 0,
              commitment: 'confirmed',
            });

            if (txDetails?.meta?.err) {
              pTx.reconciliationState = 'REVERTED';
              pTx.error = JSON.stringify(txDetails.meta.err);
            } else if (!txDetails) {
              // N9: the signature is confirmed but its details are not readable yet. Leave it PENDING, say so, and look again soon
              // instead of waiting for the next restart.
              mismatchesCount++;
              issues.push(`Transaction ${pTx.signature.slice(0, 8)}... is confirmed but its details are not readable yet; retrying`);
              this.scheduleReconcileRetry();
            } else if (txDetails) {
              pTx.landingSlot = txDetails.slot;
              pTx.networkFeeLamports = txDetails.meta?.fee || 5000;
              pTx.confirmationTime = txDetails.blockTime ? txDetails.blockTime * 1000 : Date.now();

              const existingPos = workstationDb
                .loadPositions()
                .find((p) => (pTx.direction === 'SELL' ? p.exitTxSignature === pTx.signature : p.entryTxSignature === pTx.signature));
              const unreadSell = pTx.direction === 'SELL' ? /^SELL_FILL_UNREAD_ASSUMED_LOSS position=(\S+)/.exec(pTx.error ?? '') : null;

              if (unreadSell) {
                // R1 #4: its basis share was booked as an assumed loss when it was adopted; add the proceeds now if the fill can be read.
                if (!(await this.settleUnreadSellFill(pTx, unreadSell[1], walletPubkey, txDetails.slot))) {
                  mismatchesCount++;
                  issues.push(`SELL ${pTx.signature.slice(0, 8)}... landed and its basis share is booked as an assumed loss, but its proceeds cannot be read yet; retrying`);
                  this.scheduleReconcileRetry();
                }
              } else if (existingPos) {
                pTx.reconciliationState = 'RECONCILED';
              } else if (walletPubkey) {
                // Recover interrupted transaction directly from confirmed on-chain data
                const recovery = await TradeReconciler.recoverInterruptedTransaction(
                  this.connection,
                  pTx.signature,
                  walletPubkey,
                  pTx.jitoTipLamports
                );

                if (recovery.recovered && recovery.mint && recovery.type === 'BUY' && workstationDb.loadPositions().some((p) => p.entryTxSignature === pTx.signature)) {
                  pTx.reconciliationState = 'RECONCILED'; // R2-4: another writer saved it during the read above
                } else if (recovery.recovered && recovery.mint) {
                  if (recovery.type === 'BUY' && recovery.tokenQuantityRaw) {
                    const adopted = this.positionFromRecoveredBuy(pTx, recovery, txDetails.slot, walletPubkey);
                    workstationDb.savePosition(adopted);
                    pTx.reconciliationState = 'RECONCILED';
                    this.journalLiveBuySolDelta(adopted, recovery.solSpentLamports ?? 0, 'STARTUP_RECONCILIATION', 'RECOVERED'); // 3B (R1-38)
                    this.sellIfLateBuyAdopted(adopted);
                    Logger.info(`Successfully recovered interrupted BUY position for ${recovery.mint} (${pTx.signature})`);
                  } else if (recovery.type === 'SELL') {
                    const targetPos = workstationDb
                      .loadPositions()
                      .find((p) => p.mint === recovery.mint && p.executionMode === 'LIVE' && (p.status === 'OPEN' || p.status === 'PARTIALLY_CLOSED'));
                    if (targetPos) {
                      const remainingTokens = BigInt(recovery.remainingTokensRaw ?? '0');
                      const tokensSold = BigInt(recovery.tokensSoldRaw ?? '0');
                      const totalTokensBefore = BigInt(recovery.tokenBeforeRaw ?? targetPos.tokenQuantityRaw);
                      const sellFraction = totalTokensBefore > 0n ? Number(tokensSold) / Number(totalTokensBefore) : 1;
                      const costPortionLamports = Math.round(targetPos.costBasisLamports * sellFraction);
                      const netProceedsLamports = recovery.solReceivedLamports ?? 0;
                      const realizedPnLSol = (netProceedsLamports - costPortionLamports) / 1e9;

                      if (remainingTokens > 0n) {
                        targetPos.status = 'PARTIALLY_CLOSED';
                        targetPos.tokenQuantityRaw = remainingTokens.toString();
                        targetPos.costBasisLamports = Math.max(0, targetPos.costBasisLamports - costPortionLamports);
                        targetPos.realizedPnLSol = (targetPos.realizedPnLSol ?? 0) + realizedPnLSol;
                      } else {
                        targetPos.status = 'CLOSED';
                        targetPos.tokenQuantityRaw = '0';
                        targetPos.costBasisLamports = 0;
                        targetPos.realizedPnLSol = (targetPos.realizedPnLSol ?? 0) + realizedPnLSol;
                      }

                      targetPos.exitTxSignature = pTx.signature;
                      // R1-24: a take-profit sell that landed before the crash keeps its stage, or the next pass sells the same take-profit again
                      targetPos.exitStage = exitStageAfterFill(pTx.exitReason, targetPos.exitStage);
                      if (pTx.exitReason) targetPos.exitReason = pTx.exitReason;
                      targetPos.exitTimestamp = recovery.blockTime ?? Date.now();
                      targetPos.exitSlot = recovery.slot ?? txDetails.slot;
                      targetPos.lastUpdatedTimestamp = Date.now();
                      // S258: one write with the RECONCILED row; if it fails nothing is booked and the row stays PENDING for the next pass
                      workstationDb.saveSellBooking(targetPos, pTx.signature, { slot: txDetails.slot, networkFeeLamports: pTx.networkFeeLamports });
                      pTx.reconciliationState = 'RECONCILED';
                      Logger.info(`Successfully recovered interrupted SELL trade for ${recovery.mint} (${pTx.signature})`);
                    } else if (workstationDb.loadPositions('LIVE').some((p) => p.mint === recovery.mint && p.status === 'CLOSED')) {
                      // N8: the position is already closed (the sell was applied some other way); there is nothing left to apply.
                      // Left RECONCILIATION_REQUIRED this row would hold readiness at MISMATCH forever.
                      pTx.reconciliationState = 'RECONCILED';
                      pTx.error = 'position already closed; sell not re-applied';
                    } else {
                      pTx.reconciliationState = 'RECONCILIATION_REQUIRED';
                      mismatchesCount++;
                      issues.push(`SELL transaction ${pTx.signature.slice(0, 8)}... confirmed but could not match open position in database`);
                    }
                  }
                }
 else {
                  pTx.reconciliationState = 'RECONCILIATION_REQUIRED';
                  mismatchesCount++;
                  issues.push(`Transaction ${pTx.signature.slice(0, 8)}... confirmed but could not reconstruct position`);
                }
              } else {
                // R5-3: with no signer the fill cannot be rebuilt (it is read for the wallet). That decides nothing about the row, so it stays
                // as it was for a pass that has the signer, instead of becoming RECONCILIATION_REQUIRED.
                mismatchesCount++;
                issues.push(`Transaction ${pTx.signature.slice(0, 8)}... is confirmed but cannot be applied without a signer; left for a pass with one`);
              }
            }
            workstationDb.saveTransaction(pTx);
          } else if (status) {
            // R7-18: a status (processed, not yet confirmed) means the transaction landed; it is not expired whatever the block height says.
            mismatchesCount++;
            issues.push(`Transaction ${pTx.signature.slice(0, 8)}... has landed but is not confirmed yet; retrying`);
            this.scheduleReconcileRetry();
          } else if (typeof pTx.lastValidBlockHeight === 'number' && pTx.lastValidBlockHeight > 0) {
            // P2.1 here too: with no status, the row is decided by the chain's block height against its lastValidBlockHeight, not by its
            // age (a slow RPC or a long restart said nothing about whether it can still land). Not expired yet: keep it and look again.
            // R7-18: the status read above came before the height read, so a transaction that landed in between had no status then. Read
            // the status again after the height says expired (the runtime order, signatureUnseen), and only an unseen one is TIMED_OUT.
            if ((await this.blockhashExpired(pTx)) && (await this.signatureUnseen(pTx.signature))) {
              pTx.reconciliationState = 'TIMED_OUT';
              workstationDb.saveTransaction(pTx);
            } else {
              this.scheduleReconcileRetry();
            }
          } else if (Date.now() - pTx.submissionTime > 120000 && (await this.signatureUnseen(pTx.signature))) {
            pTx.reconciliationState = 'TIMED_OUT'; // a row written before lastValidBlockHeight was stored
            workstationDb.saveTransaction(pTx);
          }
        } catch (err: any) {
          // R5-5: a failed read is unknown, not fine. The row stays as it is, the pass is a mismatch and is tried again.
          Logger.warn(`Failed to reconcile pending transaction ${pTx.signature}: ${err.message}`);
          mismatchesCount++;
          issues.push(`Transaction ${pTx.signature.slice(0, 8)}... could not be checked (${String(err.message).slice(0, 60)}); retrying`);
          this.scheduleReconcileRetry();
        }
      }
      // R5-5: a BUY step 4 could not settle may have landed with no position (no stop-loss); background recovery keeps trying it.
      const unsettledBuys = workstationDb.loadTransactionsInStates(['PENDING', 'RECONCILIATION_REQUIRED']);
      if (unsettledBuys === null || unsettledBuys.some((t) => readInStep4.has(t.signature))) this.scheduleOrphanRecovery();
    }

    // 4b. (Q18: after the pending transactions, not before.) Verify ALL active LIVE positions (OPEN and PARTIALLY_CLOSED) against on-chain token accounts
    // A SELL that landed just before a crash is applied by step 4 above, with its realized PnL. Running this zero-balance close first
    // would close the position with cost 0 and realized PnL lost.
    if (signerStatus === 'READY') {
      const walletPubkey = localSigner.getPublicKey();
      const activeLivePositions = workstationDb.loadPositions('LIVE', 'ACTIVE');
      // S10: a SELL that step 4 could not settle (the RPC failed, or the signature is confirmed but its details are not readable yet) is
      // still PENDING here. Its position shows an empty wallet precisely BECAUSE the sell landed, and closing it now would zero the cost
      // basis; the retry would then find the position closed and drop the sell as "already applied", so its realized PnL is lost for good.
      // R1 #1: RECONCILIATION_REQUIRED sells count as unsettled too (step 4 could not apply them, and their PnL is still owed).
      // R5-4: when the ledger cannot be read, no sell can be ruled out, so no position is closed on a zero balance in this pass.
      const unsettledAfterStep4 = ledgerUnreadable ? null : workstationDb.loadTransactionsInStates(['PENDING', 'RECONCILIATION_REQUIRED']);
      const unsettledSellMints = unsettledAfterStep4 === null
        ? null
        : new Map(unsettledAfterStep4.filter((t) => t.direction === 'SELL' && t.executionMode === 'LIVE').map((t) => [t.mint, t.signature]));
      if (unsettledSellMints === null && !ledgerUnreadable) {
        mismatchesCount++;
        issues.push('The transactions table could not be read after resolving pending rows; no position was closed on a zero balance');
        this.scheduleReconcileRetry();
      }

      for (const pos of activeLivePositions) {
        let walletRefusal: string | null;
        try {
          const mintPubkey = new PublicKey(pos.mint);
          // N5: "the account does not exist" is a confirmed zero; any other RPC failure is unknown and must not close a position.
          // Audit 2026-10-22 (F1): the read goes through `readHeldTokens`, the exit path's read (P1.6), so an empty answer from an RPC
          // that is not on the allowed cluster, or from a slot before the buy landed, is `untrusted` and leaves the row open too.
          const read = await this.readHeldTokens(pos, walletPubkey, mintPubkey);
          if (read.held === null) throw new Error(read.error ?? 'the token balance could not be read');
          const onChainAmount = read.held;

          if (onChainAmount <= 0n && read.untrusted) {
            mismatchesCount++; // unknown is not zero: the row stays open and readiness stays at MISMATCH until a trusted read
            issues.push(`Position ${pos.symbol} (${pos.mint.slice(0, 6)}...) shows no tokens, but the read is not trusted (${read.untrusted}); left open`);
            this.scheduleReconcileRetry();
          } else if (onChainAmount <= 0n && unsettledSellMints === null) {
            mismatchesCount++;
            issues.push(`Position ${pos.symbol} (${pos.mint.slice(0, 6)}...) shows no tokens, but the ledger could not be read to rule out an unsettled sell; left open`);
          } else if (onChainAmount <= 0n && unsettledSellMints?.has(pos.mint)) {
            mismatchesCount++;
            issues.push(`Position ${pos.symbol} (${pos.mint.slice(0, 6)}...) shows no tokens but its sell ${String(unsettledSellMints?.get(pos.mint)).slice(0, 8)}... is not settled yet; left open so the fill and its PnL can be applied`);
            this.scheduleReconcileRetry();
          } else if (onChainAmount <= 0n && (walletRefusal = await this.walletBindingProblem(pos, walletPubkey)) !== null) {
            // R4-2: an empty balance in another wallet (a changed key, a copied database) proves nothing about this position.
            mismatchesCount++;
            issues.push(`Position ${pos.symbol} (${pos.mint.slice(0, 6)}...) shows no tokens in this wallet, but ${walletRefusal}`);
            this.raiseOperatorAlert('POSITION_WALLET_MISMATCH', walletRefusal, pos.id);
          } else if (onChainAmount <= 0n) {
            // The tokens are gone (sold or moved outside this app). Left OPEN this position blocks arming until someone edits the DB,
            // while the exit loop keeps trying to sell an empty account. Close it with the reason on the record, and say so.
            // P2.3 (N-28): with no sell found, the basis is booked as a realized loss (REALIZED_ASSUMED_LOSS), so the daily and session
            // loss caps and the expectancy count it. Booking 0 made a vanished position look free.
            const assumedLossSol = this.bookAssumedLoss(pos, 'startup reconciliation');
            pos.status = 'CLOSED';
            pos.tokenQuantityRaw = '0';
            pos.costBasisLamports = 0;
            pos.exitReason = 'RECONCILED_ZERO_BALANCE: no tokens in the wallet at startup reconciliation (REALIZED_ASSUMED_LOSS)';
            pos.lastUpdatedTimestamp = Date.now();
            workstationDb.savePosition(pos);
            this.raiseOperatorAlert('POSITION_GONE', `Position ${pos.symbol || pos.mint.slice(0, 6)} was recorded open but the wallet holds none of it. Closed in the database and booked as a loss of its cost basis (${assumedLossSol.toFixed(6)} SOL), since no sell was found.`, pos.id);
            issues.push(`Position ${pos.symbol} (${pos.mint.slice(0, 6)}...) had no on-chain balance: closed in the database`);
          }
        } catch (e: any) {
          mismatchesCount++; // unknown is not fine: an unreadable balance keeps readiness at MISMATCH, but never closes the position
          issues.push(`Failed to verify on-chain balance for ${pos.symbol}: ${e.message}`);
        }
      }
    }

    // 5. Landed LIVE buys whose fill could not be read earlier (RECONCILIATION_REQUIRED) still hold tokens with no stop-loss.
    if (signerStatus === 'READY') {
      const orphans = await this.recoverOrphanedBuys({ skip: readInStep4 });
      if (orphans.ledgerUnreadable) {
        mismatchesCount++;
        issues.push('Landed buys could not be checked: the transactions table could not be read');
      }
      // R5-5 / R7-3: whatever this pass could not adopt is retried in the background, not only at the next restart or click.
      if ((orphans.stillOrphaned.length > 0 || orphans.ledgerUnreadable) && !this.orphanRecoveryTimer) this.scheduleOrphanRecovery();
      if (orphans.stillOrphaned.length > 0) {
        mismatchesCount += orphans.stillOrphaned.length;
        issues.push(`${orphans.stillOrphaned.length} landed buy(s) have no position record: ${orphans.stillOrphaned.map((x) => x.slice(0, 8)).join(',')}`);
      }
    }

    // 6. Tokens in the wallet that no position covers (a lost buy record, a manual transfer) get a position so the exit engine watches them.
    if (signerStatus === 'READY') {
      try {
        const scan = await this.scanUntrackedWalletTokens();
        if (scan.untracked.length > 0) {
          issues.push(`${scan.untracked.length} wallet token balance(s) had no position: ${scan.adopted.length} adopted for exit monitoring, ${scan.untracked.length - scan.adopted.length} unpriced`);
        }
      } catch (e: any) {
        // Unknown is not "fine": a wallet balance with no stop-loss is exactly what this scan exists to find.
        Logger.warn(`Untracked-balance scan failed: ${e.message}`);
        mismatchesCount++;
        issues.push(`Wallet token scan failed (${String(e.message).slice(0, 80)}); untracked balances cannot be ruled out`);
      }
    }

    let status: 'EXECUTION_READY' | 'RECONCILIATION_MISMATCH' | 'SIGNER_LOCKED' | 'OFFLINE';
    if (this.rpcHealth === 'DISCONNECTED') {
      status = 'OFFLINE';
    } else if (signerStatus !== 'READY') {
      status = 'SIGNER_LOCKED';
    } else if (mismatchesCount > 0) {
      status = 'RECONCILIATION_MISMATCH';
    } else {
      status = 'EXECUTION_READY';
    }

    const details = issues.length > 0 ? issues.join('; ') : 'All on-chain state reconciled. Systems verified.';
    this.lastStartupReconciliation = { status, checkedAt: now, details };

    Logger.info(`Startup Reconciliation result: ${status} (${details})`);
    return { status, mismatchesCount, details };
  }

  private reconcileRetryTimer: NodeJS.Timeout | null = null;
  private reconcileTimeoutMs = 90_000;

  /** One follow-up reconciliation pass shortly after a pass found something not readable yet. */
  private scheduleReconcileRetry(delayMs = 15_000): void {
    if (this.reconcileRetryTimer) return;
    this.reconcileRetryTimer = setTimeout(() => {
      this.reconcileRetryTimer = null;
      void this.startupReconciliation().catch(() => undefined);
    }, delayMs);
    this.reconcileRetryTimer.unref?.();
  }

  /**
   * 3B (P3.2, R1-38): one decision row per landed LIVE buy, carrying the SOL it took from the wallet (negative), so the DEVNET_LIVE wallet
   * audit (sumDecisionSolDelta) explains it. Written once per buy: by the confirmed path when its position is saved, or by orphan recovery
   * when it adopts a buy that returned UNCONFIRMED or with an unread fill (that path's idempotent branch, a position already saved, writes none).
   * The auto controller's BOUGHT row carries no delta of its own, so an auto buy is not counted twice. PAPER buys never journal one.
   */
  private journalLiveBuySolDelta(pos: NormalizedPosition, walletDeltaLamports: number, source: string, how: 'CONFIRMED' | 'RECOVERED'): void {
    if (pos.executionMode !== 'LIVE') return;
    // R2-4: keyed on the buy's signature (the position id): a second writer of the same buy (two recovery passes, startup step 4 and a
    // background pass) writes nothing, so the wallet audit never sees the same SOL twice.
    workstationDb.logDecisionOnce({
      autoMode: 'n/a',
      mint: pos.mint,
      symbol: pos.symbol,
      source,
      stage: 'fill',
      outcome: LIVE_BUY_FILLED,
      reason: how === 'CONFIRMED' ? 'LIVE buy confirmed and reconciled' : 'LIVE buy adopted by orphan recovery',
      inputs: { walletDeltaLamports, signature: pos.entryTxSignature },
      positionId: pos.id,
      solDelta: -walletDeltaLamports / 1e9,
    });
  }

  /** Position for a buy rebuilt from confirmed on-chain data. Entry price is the curve price paid; cost basis is the whole wallet delta. */
  private positionFromRecoveredBuy(
    pTx: { signature: string; mint: string; jitoTipLamports: number; executionMode: ExecutionMode },
    recovery: Awaited<ReturnType<typeof TradeReconciler.recoverInterruptedTransaction>>,
    fallbackSlot: number,
    wallet: PublicKey
  ): NormalizedPosition {
    const tokenQty = Number(recovery.tokenQuantityRaw) / Math.pow(10, recovery.tokenDecimals ?? 6);
    const spent = recovery.solSpentLamports ?? 0;
    const curveSpend = recovery.curveSpendLamports ?? spent;
    const effectivePrice = curveSpend > 0 && tokenQty > 0 ? curveSpend / 1e9 / tokenQty : 0;
    return {
      id: pTx.signature,
      mint: recovery.mint!,
      symbol: pTx.mint ? pTx.mint.slice(0, 5).toUpperCase() : recovery.mint!.slice(0, 5).toUpperCase(),
      name: `Recovered ${recovery.mint!.slice(0, 4)}...${recovery.mint!.slice(-4)}`,
      tokenDecimals: recovery.tokenDecimals ?? 6,
      baseTokenProgram: recovery.baseTokenProgram,
      tokenQuantityRaw: recovery.tokenQuantityRaw!,
      costBasisLamports: spent,
      entryPriceSol: effectivePrice,
      currentPriceSol: effectivePrice,
      currentValueSol: spent / 1e9,
      unrealizedPnLSol: 0,
      unrealizedPnLPct: 0,
      realizedPnLSol: 0,
      entryTxSignature: pTx.signature,
      entrySlot: recovery.slot ?? fallbackSlot,
      entryTimestamp: recovery.blockTime ?? Date.now(),
      entryFeeLamports: recovery.networkFeeLamports ?? 5000,
      priorityFeeLamports: 0,
      jitoTipLamports: pTx.jitoTipLamports,
      markSource: 'RECONCILED_ON_CHAIN',
      markAgeMs: 0,
      executionMode: pTx.executionMode,
      status: 'OPEN',
      lastUpdatedTimestamp: Date.now(),
      walletPubkey: wallet.toBase58(), // R4-2: the fill was read for this wallet
    };
  }

  /**
   * Orphaned buys (critique #3): a LIVE buy confirmed but its fill could not be read (getTransaction null at that moment), so the row sits
   * at RECONCILIATION_REQUIRED with tokens in the wallet and no position, hence no stop-loss. Re-read each such signature and open the position.
   * Idempotent: a signature that already has a position is just marked RECONCILED.
   */
  public recoverOrphanedBuys(opts: { skip?: Set<string> } = {}): Promise<{ recovered: string[]; stillOrphaned: string[]; ledgerUnreadable?: boolean }> {
    // `skip`: signatures the caller has just read itself (startup step 4); a call that joins a pass in progress gets that pass's answer.
    // R2-4: single-flight. Every failed buy used to start its own timer chain, and two passes could both adopt the same buy and journal
    // its SOL twice. A call made while a pass runs joins it; the retry schedule picks up anything written after that pass read the ledger.
    if (!this.orphanRecoveryInFlight) {
      const run = this.runOrphanRecovery(opts.skip).finally(() => {
        if (this.orphanRecoveryInFlight === run) this.orphanRecoveryInFlight = null;
      });
      this.orphanRecoveryInFlight = run;
    }
    return this.orphanRecoveryInFlight;
  }

  private orphanRecoveryInFlight: Promise<{ recovered: string[]; stillOrphaned: string[]; ledgerUnreadable?: boolean }> | null = null;
  /** R7-3: landed LIVE buys the last recovery pass could not give a position (no stop-loss yet). Readiness refuses LIVE buys while any remain. */
  private unrecoveredLandedBuys: string[] = [];

  private async runOrphanRecovery(skip?: Set<string>): Promise<{ recovered: string[]; stillOrphaned: string[]; ledgerUnreadable?: boolean }> {
    const recovered: string[] = [];
    const stillOrphaned: string[] = [];
    if (localSigner.getStatus() !== 'READY') return { recovered, stillOrphaned };
    const wallet = localSigner.getPublicKey();
    const rows = workstationDb.loadTransactionsInStates(['RECONCILIATION_REQUIRED', 'PENDING']);
    // R5-4: an unreadable ledger is not "no orphans": the caller counts it as unresolved and keeps retrying.
    if (rows === null) return { recovered, stillOrphaned, ledgerUnreadable: true };
    // R4-4 / R5-5: a landed buy can also be left PENDING (its position and its ledger row were both refused, or a status read failed at
    // startup). Those are recovered the same way, except the buys this process is sending right now, which their own path settles.
    // A PENDING row whose order already has another row in a later state was superseded: that order's outcome is recorded under the other
    // signature (only when a send answers with a signature other than the one signed; never on a real cluster, where they are the same).
    const superseded = (t: PersistedTransaction) =>
      !!t.orderId && workstationDb.loadTransactions(t.orderId).some((o) => o.signature !== t.signature && o.reconciliationState !== 'PENDING');
    const candidates = rows.filter((t) => t.direction === 'BUY' && t.executionMode === 'LIVE' && !skip?.has(t.signature) &&
      (t.reconciliationState === 'RECONCILIATION_REQUIRED' ||
        (t.reconciliationState === 'PENDING' && !this.inFlightBuyMints.has(t.mint) && !superseded(t))));
    // On a wrong-cluster RPC every signature reads as "not found" and its block height means nothing: a row decided there could be
    // TIMED_OUT although the buy landed. Leave them all for a pass on a trusted RPC (the background retries keep trying).
    if (this.clusterProblem !== null) {
      this.unrecoveredLandedBuys = candidates.map((t) => t.signature);
      return { recovered, stillOrphaned: candidates.map((t) => t.signature) };
    }
    for (const t of candidates) {
      try {
        if (workstationDb.loadPositions().some((p) => p.entryTxSignature === t.signature)) {
          t.reconciliationState = 'RECONCILED';
          workstationDb.saveTransaction(t);
          continue;
        }
        const recovery = await TradeReconciler.recoverInterruptedTransaction(this.connection, t.signature, wallet, t.jitoTipLamports);
        // R2-4: the read above awaited; another writer (startup step 4, or the buy's own path) may have saved the position meanwhile.
        if (workstationDb.loadPositions().some((p) => p.entryTxSignature === t.signature)) {
          t.reconciliationState = 'RECONCILED';
          workstationDb.saveTransaction(t);
          continue;
        }
        if (recovery.recovered && recovery.type === 'BUY' && recovery.mint && recovery.tokenQuantityRaw) {
          const adopted = this.positionFromRecoveredBuy(t, recovery, t.landingSlot ?? 0, wallet);
          workstationDb.savePosition(adopted);
          t.reconciliationState = 'RECONCILED';
          workstationDb.saveTransaction(t);
          // 3B (R1-38): the SOL this buy took left the wallet without a journal row (it returned UNCONFIRMED, or its fill was unread); journal it now.
          this.journalLiveBuySolDelta(adopted, recovery.solSpentLamports ?? 0, 'ORPHAN_RECOVERY', 'RECOVERED');
          recovered.push(t.signature);
          Logger.warn(`Recovered orphaned LIVE buy ${t.signature} for ${recovery.mint}: position opened with stop-loss coverage`);
          this.sellIfLateBuyAdopted(adopted);
        } else if (recovery.error && /reverted/i.test(recovery.error)) {
          t.reconciliationState = 'REVERTED';
          t.error = recovery.error;
          workstationDb.saveTransaction(t);
          this.lateBuyWatch.delete(t.signature);
        } else if (recovery.error && /not found on-chain/i.test(recovery.error) && (await this.blockhashExpired(t) || Date.now() - t.submissionTime > ORPHAN_MAX_AGE_MS) && (await this.signatureUnseen(t.signature))) {
          // N6: a transaction that is still not on chain after its blockhash expired never landed. Any tokens it did buy would be
          // found by the wallet scan; leaving the row open would hold readiness at MISMATCH, and block buys of the mint, until a restart.
          // P2.1: decided by the chain's block height against the row's lastValidBlockHeight; the 15-minute age is only for rows without one.
          t.reconciliationState = 'TIMED_OUT';
          t.error = 'never landed: not found on chain after the blockhash window';
          workstationDb.saveTransaction(t);
          this.lateBuyWatch.delete(t.signature);
        } else {
          stillOrphaned.push(t.signature);
        }
      } catch (e: any) {
        Logger.warn(`Orphaned buy recovery failed for ${t.signature}: ${e.message}`);
        stillOrphaned.push(t.signature);
      }
    }
    this.unrecoveredLandedBuys = stillOrphaned;
    return { recovered, stillOrphaned };
  }

  /**
   * Scan the wallet's SPL and Token-2022 accounts for non-zero balances that no active LIVE position covers. R5-1: only a mint this app sent
   * a LIVE buy for is considered (anything else is one UNKNOWN_TOKEN_BALANCE alert and is never adopted). Each such one that has a readable
   * pump curve / PumpSwap price gets a position flagged RECOVERED (entry price = current mark, cost basis unknown = 0) so stop-loss and
   * trailing-stop run on it; every one raises an UNTRACKED_TOKEN_BALANCE alert. Balances with no pump price are only alerted, never traded.
   */
  public async scanUntrackedWalletTokens(): Promise<{ untracked: string[]; adopted: string[] }> {
    const untracked: string[] = [];
    const adopted: string[] = [];
    if (localSigner.getStatus() !== 'READY') return { untracked, adopted };
    const wallet = localSigner.getPublicKey();
    const held = new Map<string, { raw: bigint; decimals: number; program: PublicKey }>();
    for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const res = await this.connection.getParsedTokenAccountsByOwner(wallet, { programId: program }, 'confirmed');
      for (const acc of res.value) {
        const info = (acc.account.data as any)?.parsed?.info;
        const amount = BigInt(info?.tokenAmount?.amount ?? '0');
        if (!info?.mint || amount <= 0n) continue;
        const prev = held.get(info.mint);
        held.set(info.mint, { raw: (prev?.raw ?? 0n) + amount, decimals: info.tokenAmount.decimals ?? 6, program });
      }
    }
    const active = new Set(
      workstationDb.loadPositions('LIVE', 'ACTIVE').map((p) => p.mint)
    );
    // A buy still waiting for recovery (RECONCILIATION_REQUIRED / PENDING) owns its mint: recoverOrphanedBuys handles it.
    const unresolvedRows = workstationDb.loadTransactionsInStates(['RECONCILIATION_REQUIRED', 'PENDING']);
    // R5-4: with the ledger unreadable no balance can be told apart from a buy in recovery; the caller counts the thrown scan as a mismatch.
    if (unresolvedRows === null) throw new Error('the transactions table could not be read, so a buy still in recovery cannot be ruled out');
    const inRecovery = new Set(
      unresolvedRows
        .filter((t) => t.direction === 'BUY' && t.executionMode === 'LIVE' && (t.reconciliationState === 'RECONCILIATION_REQUIRED' || t.reconciliationState === 'PENDING'))
        .map((t) => t.mint)
    );
    const unexplained = [...held.keys()].filter((m) => !active.has(m) && !inRecovery.has(m));
    if (unexplained.length === 0) return { untracked, adopted };
    // R5-1: anyone can send the wallet any token. Only a mint this app sent a LIVE buy for (a lost buy record) is adopted; anything else is
    // reported once, in one alert, and never becomes a position, a slot or a stop-loss to watch.
    const bought = workstationDb.loadLiveBuyMints(unexplained);
    if (bought === null) throw new Error('the transactions table could not be read, so a lost buy cannot be told apart from a token sent to the wallet');
    const neverBought = unexplained.filter((m) => !bought.has(m));
    if (neverBought.length > 0) {
      this.raiseOperatorAlert('UNKNOWN_TOKEN_BALANCE', `${neverBought.length} token balance(s) in the wallet were never bought by this app (an airdrop or a manual transfer), so they are not adopted, traded or stop-lossed; sell them by hand if wanted: ${neverBought.slice(0, 5).join(', ')}${neverBought.length > 5 ? ', ...' : ''}`);
    }
    const missing = unexplained.filter((m) => bought.has(m));
    if (missing.length === 0) return { untracked, adopted };
    let marks: Record<string, { priceSol: number; source: string; timestamp: number; poolAddress?: string }> = {};
    try {
      marks = (await RealMarkPriceService.queryOnChainMarkPrices(this.connection, missing, 'LIVE')) as any;
    } catch (e: any) {
      Logger.warn(`Mark read for untracked balances failed: ${e.message}`);
    }
    // R5-27: the mark read awaited. A buy of the same mint may have started, landed or entered recovery meanwhile; it owns the mint, and
    // adopting too would leave two OPEN rows for one balance.
    const activeNow = new Set(workstationDb.loadPositions('LIVE', 'ACTIVE').map((p) => p.mint));
    const unresolvedNow = workstationDb.loadTransactionsInStates(['RECONCILIATION_REQUIRED', 'PENDING']);
    if (unresolvedNow === null) throw new Error('the transactions table could not be read, so a buy still in recovery cannot be ruled out');
    const inRecoveryNow = new Set(unresolvedNow.filter((t) => t.direction === 'BUY' && t.executionMode === 'LIVE').map((t) => t.mint));
    for (const mint of missing) {
      if (activeNow.has(mint) || inRecoveryNow.has(mint) || this.inFlightBuyMints.has(mint)) continue;
      untracked.push(mint);
      const h = held.get(mint)!;
      const mark = marks[mint];
      if (mark && mark.priceSol > 0) {
        const now = Date.now();
        const qty = Number(h.raw) / Math.pow(10, h.decimals);
        // R8-22: a closed adopted row keeps its realized PnL and exit signature; a balance found again is a new row.
        const baseId = `recovered-${mint}`;
        const recoveredId = workstationDb.loadPositions('LIVE').some((p) => p.id === baseId) ? `${baseId}-${now}` : baseId;
        workstationDb.savePosition({
          id: recoveredId,
          mint,
          symbol: mint.slice(0, 5).toUpperCase(),
          name: 'RECOVERED untracked wallet balance',
          tokenDecimals: h.decimals,
          baseTokenProgram: h.program.toBase58(),
          tokenQuantityRaw: h.raw.toString(),
          costBasisLamports: 0, // unknown: PnL for this position is not meaningful
          entryPriceSol: mark.priceSol,
          currentPriceSol: mark.priceSol,
          currentValueSol: Number((qty * mark.priceSol).toFixed(6)),
          unrealizedPnLSol: 0,
          unrealizedPnLPct: 0,
          realizedPnLSol: 0,
          entryTxSignature: `RECOVERED:${mint}`,
          entryTimestamp: now,
          markSource: 'RECONCILED_ON_CHAIN',
          markAgeMs: 0,
          lastMarkTimestamp: mark.timestamp || now,
          venue: mark.source === 'ON_CHAIN_PUMPSWAP_POOL' ? 'PUMPSWAP' : 'PUMP_BONDING_CURVE',
          poolAddress: mark.poolAddress,
          executionMode: 'LIVE',
          status: 'OPEN',
          lastUpdatedTimestamp: now,
          walletPubkey: wallet.toBase58(), // R4-2: found in this wallet
        } as NormalizedPosition);
        adopted.push(mint);
        this.raiseOperatorAlert('UNTRACKED_TOKEN_BALANCE', `Wallet held ${h.raw} raw of ${mint}, a mint this app bought, with no position. Adopted as RECOVERED with entry price = current mark; stop-loss now applies. Cost basis unknown.`, recoveredId);
      } else {
        this.raiseOperatorAlert('UNTRACKED_TOKEN_BALANCE', `Wallet holds ${h.raw} raw of ${mint} with no position and no readable pump price. Not traded; sell manually if unwanted.`, `untracked-${mint}`);
      }
    }
    return { untracked, adopted };
  }

  /**
   * P2.1: true when the chain's `confirmed` block height is past the row's lastValidBlockHeight, so the transaction can no longer land.
   * False when the row has no height or the height cannot be read (the caller then falls back to the wall-clock rule).
   */
  private async blockhashExpired(t: PersistedTransaction): Promise<boolean> {
    if (!(typeof t.lastValidBlockHeight === 'number' && t.lastValidBlockHeight > 0)) return false;
    try {
      return (await this.connection.getBlockHeight('confirmed')) > t.lastValidBlockHeight;
    } catch {
      return false;
    }
  }

  /**
   * S250: true only when the signature has no status, history included. getTransaction answers null both for a transaction that never
   * landed and for one this node cannot return (pruned history, not indexed yet), so "not found" alone does not prove it never landed.
   * A status, or a read that fails, is false: the row stays for the next pass.
   */
  private async signatureUnseen(signature: string): Promise<boolean> {
    try {
      const st = await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      return Array.isArray(st?.value) && st.value.length === 1 && st.value[0] === null;
    } catch {
      return false;
    }
  }

  /**
   * Delays (ms) at which a failed live-buy reconciliation is retried in the background. Tests set [] . R7-3: after the last step the last
   * delay repeats for as long as a landed buy is unresolved (the ladder used to stop after about 8 minutes, leaving the tokens with no
   * stop-loss until a restart).
   */
  public orphanRecoveryDelaysMs: number[] = [5_000, 15_000, 45_000, 120_000, 300_000];
  private orphanRecoveryTimer: NodeJS.Timeout | null = null;
  private orphanRecoveryStep = 0;

  /** One background retry chain per coordinator (R2-4). A new failed buy restarts the ladder from its first step. */
  private scheduleOrphanRecovery(restart: boolean = true): void {
    const delays = this.orphanRecoveryDelaysMs;
    if (delays.length === 0) return;
    if (this.orphanRecoveryTimer) {
      if (!restart) return;
      clearTimeout(this.orphanRecoveryTimer);
    }
    this.orphanRecoveryStep = restart ? 0 : Math.min(this.orphanRecoveryStep + 1, delays.length - 1);
    const timer = setTimeout(async () => {
      if (this.orphanRecoveryTimer === timer) this.orphanRecoveryTimer = null;
      try {
        const r = await this.recoverOrphanedBuys();
        if (r.stillOrphaned.length > 0 || r.ledgerUnreadable) this.scheduleOrphanRecovery(false);
      } catch (e: any) {
        Logger.warn(`Background orphan recovery error: ${e.message}`);
        this.scheduleOrphanRecovery(false);
      }
    }, delays[this.orphanRecoveryStep]);
    (timer as any).unref?.();
    this.orphanRecoveryTimer = timer;
  }

  public async syncRealWalletBalance(): Promise<number | null> {
    try {
      if (localSigner.getStatus() !== 'READY') {
        this.realWalletBalanceSol = null;
        return null;
      }
      const pubkey = localSigner.getPublicKey();
      const lamports = await this.connection.getBalance(pubkey, 'confirmed');
      this.realWalletBalanceSol = Number((lamports / 1e9).toFixed(5));
      this.lastRpcSyncTimestamp = Date.now();
      riskEngine.recordRpcSuccess();
      return this.realWalletBalanceSol;
    } catch (err: any) {
      Logger.warn(`Wallet balance sync failed: ${err.message}`);
      this.realWalletBalanceSol = null;
      const tripped = riskEngine.recordRpcFailure();
      if (tripped && this.isLiveTradingArmed) {
        this.armLiveTrading(false);
      }
      return null;
    }
  }

  public getExecutionMode(): ExecutionMode {
    return this.executionMode;
  }

  public getRealWalletBalanceSol(): number | null {
    return this.realWalletBalanceSol;
  }

  /**
   * C7c: SOL locked as rent in the token accounts of open LIVE positions (paper positions have no account). Uses the
   * SPL rent-exempt minimum for every account; a Token-2022 account with extensions needs more, so for those it is a floor.
   */
  /** Rent held in open positions' token accounts. Display only: it is already outside the wallet balance, so spendable does not subtract it. */
  public getRentLockedSol(): number {
    const open = workstationDb.loadPositions(undefined, 'ACTIVE').filter((p) => p.executionMode === 'LIVE');
    return (open.length * CapitalSizer.SPL_TOKEN_ACCOUNT_RENT_LAMPORTS) / 1e9;
  }

  public getSpendableBankrollSol(): number {
    const raw = this.realWalletBalanceSol ?? 0;
    return CapitalSizer.calculateSpendableBankroll(raw, 0.015, this.inFlightReservedSol);
  }

  public isLiveArmed(): boolean {
    return this.isLiveTradingArmed;
  }

  public armLiveTrading(arm: boolean, confirmationCode?: string): { success: boolean; message: string; reasons?: string[] } {
    if (isReadOnly()) {
      // S185: read-only never arms, and never claims to have changed mode; disarming has nothing to undo.
      this.isLiveTradingArmed = false;
      this.executionMode = 'PAPER';
      return { success: false, message: 'READ_ONLY: APEX_READ_ONLY=true. This server watches and paper trades only; live trading cannot be armed.', reasons: ['APEX_READ_ONLY=true'] };
    }
    if (arm) {
      if (confirmationCode !== 'CONFIRM_LIVE_TRADING_RISK') {
        return { success: false, message: 'Invalid confirmation code. Live trading arming rejected.' };
      }
      if (process.env.ALLOW_LIVE_REAL_MONEY_TRADING !== 'true') {
        return {
          success: false,
          message: 'REAL_MONEY_PROHIBITED: Live real-money trading is disabled by environment policy (ALLOW_LIVE_REAL_MONEY_TRADING !== "true").',
          reasons: ['ALLOW_LIVE_REAL_MONEY_TRADING !== "true"'],
        };
      }
      if (allowedCluster() === 'mainnet-beta') {
        return {
          success: false,
          message: 'MAINNET_PROHIBITED: ALLOWED_CLUSTER=mainnet-beta. This build never arms LIVE on mainnet (devnet and localnet only); watching and paper trading still work.',
          reasons: ['ALLOWED_CLUSTER=mainnet-beta'],
        };
      }
      const check = this.canExecuteLive();
      if (!check.allowed) {
        return {
          success: false,
          message: `Cannot arm live trading. Prerequisites failed: ${check.reasons.join('; ')}`,
          reasons: check.reasons,
        };
      }
      this.isLiveTradingArmed = true;
      this.executionMode = 'LIVE';
      const isWarmingUp = check.readiness.components.pumpFeed.status === 'WARMING_UP';
      if (isWarmingUp) {
        Logger.warn('*** LIVE TRADING HAS BEEN ARMED (FEEDS WARMING UP) *** Real Solana transactions will be broadcast once events arrive.');
        return {
          success: true,
          message: 'Live trading armed successfully during startup grace period (feeds warming up). Transactions will be broadcast on Solana.',
        };
      }
      Logger.warn('*** LIVE TRADING HAS BEEN ARMED *** Real Solana transactions will be broadcast.');
      return { success: true, message: 'Live trading armed successfully. Transactions will be broadcast on Solana.' };
    } else {
      this.isLiveTradingArmed = false;
      this.executionMode = 'PAPER';
      Logger.info('Live trading disarmed. Switched to PAPER mode.');
      return { success: true, message: 'Trading disarmed. System is operating in PAPER mode.' };
    }
  }

  public getPositions(mode?: ExecutionMode, status?: 'OPEN' | 'PARTIALLY_CLOSED' | 'CLOSED' | 'ACTIVE'): NormalizedPosition[] {
    return workstationDb.loadPositions(mode, status);
  }

  // Update real mark prices for active positions without random walk
  public async updatePositionMarkPrices(priceMap?: Record<string, { priceSol: number; source: string }>) {
    const positions = workstationDb.loadPositions(undefined, 'ACTIVE');
    if (positions.length === 0) return;

    const now = Date.now();

    // 1. If explicit price map provided, use it ONLY for non-LIVE positions
    if (priceMap && Object.keys(priceMap).length > 0) {
      for (const pos of positions) {
        if (pos.executionMode === 'LIVE') continue; // LIVE NEVER accepts synthetic marks
        const entry = priceMap[pos.mint];
        if (entry && entry.priceSol > 0) {
          this.applyMarkPrice(pos, entry.priceSol, entry.source, now);
        }
      }
    }

    // 2. Query on-chain bonding curve marks for active positions. A mint that failed recently waits out its back-off.
    for (const k of this.markRetry.keys()) if (!positions.some((p) => p.mint === k)) this.markRetry.delete(k); // closed positions leave the map
    const askable = positions.filter((p) => !this.markBackedOff(p, now));
    const mints = askable.map((p) => p.mint);
    try {
      const hasLivePositions = positions.some((p) => p.executionMode === 'LIVE');
      const onChainMarks = await RealMarkPriceService.queryOnChainMarkPrices(
        this.connection,
        mints,
        hasLivePositions ? 'LIVE' : 'PAPER'
      );
      if (Object.keys(onChainMarks).length > 0) {
        this.recordRealMarketEvent('BONDING_CURVE_RPC');
      }

      for (const pos of askable) {
        const mark = onChainMarks[pos.mint];
        if (mark && mark.priceSol > 0) {
          this.noteMarkSuccess(pos.mint);
          this.applyMarkPrice(pos, mark.priceSol, mark.source, mark.timestamp, mark.poolAddress);
        } else if (!priceMap || !priceMap[pos.mint]) {
          this.noteMarkFailure(pos.mint, now);
          const rejected = PumpCurveService.getMintRejection(pos.mint);
          if (rejected) this.raiseOperatorAlert('MARK_MINT_REJECTED', `${pos.symbol || pos.mint.slice(0, 6)} cannot be marked: ${rejected}. The position keeps its last mark and goes stale.`, pos.id); // R19
          // Mark age increases honestly
          const baseTimestamp = pos.lastMarkTimestamp || pos.lastUpdatedTimestamp;
          if (baseTimestamp) pos.markAgeMs = now - baseTimestamp;
          // nothing new to store: the mark age is derived from the stored timestamps on load (S11: no whole-row save here)
        }
      }
    } catch (err: any) {
      Logger.debug(`Failed on-chain mark refresh: ${err.message}`);
    }
  }

  private applyMarkPrice(pos: NormalizedPosition, priceSol: number, source: string, timestamp: number, poolAddress?: string) {
    pos.currentPriceSol = priceSol;
    const tokenQty = Number(pos.tokenQuantityRaw) / Math.pow(10, pos.tokenDecimals);
    pos.currentValueSol = Number((tokenQty * priceSol).toFixed(6));
    pos.unrealizedPnLSol = Number((pos.currentValueSol - pos.costBasisLamports / 1e9).toFixed(6));
    pos.unrealizedPnLPct =
      pos.costBasisLamports > 0
        ? Number(((pos.unrealizedPnLSol / (pos.costBasisLamports / 1e9)) * 100).toFixed(2))
        : 0;
    pos.lastMarkTimestamp = timestamp;
    pos.markAgeMs = Math.max(0, Date.now() - timestamp);
    this.markMono.set(pos.id, { wall: timestamp, mono: performance.now() - pos.markAgeMs }); // R4-3
    pos.markSource = source as DataSource;
    pos.highWaterMarkSol = Math.max(pos.highWaterMarkSol ?? 0, priceSol);

    // R0.4: If on-chain mark resolves to canonical PumpSwap pool, transition position to PUMPSWAP
    if (source === 'ON_CHAIN_PUMPSWAP_POOL' || pos.venue === 'PUMPSWAP') {
      if (pos.venue !== 'PUMPSWAP') {
        Logger.info(`[R0.4] Position ${pos.symbol || pos.mint} curve completed. Migrating to canonical PumpSwap pool.`);
        pos.venue = 'PUMPSWAP';
        pos.migrationTimestamp = pos.migrationTimestamp || Date.now();
      }
      if (poolAddress) {
        pos.poolAddress = poolAddress;
      }
    }

    pos.lastUpdatedTimestamp = Date.now();
    workstationDb.saveMark(pos); // S11: marks never rewrite status, quantity or realized
  }

  // Pre-retry and pre-fallback on-chain and database verification (R0.6)
  public async checkIfTransactionLanded(
    signature: string,
    bundleId: string | undefined,
    owner: PublicKey,
    mintPubkey: PublicKey,
    tokenProgram: PublicKey,
    preSnapshot: PreTradeSnapshot,
    side: 'BUY' | 'SELL',
    orderId?: string
  ): Promise<{ landed: boolean; slot?: number }> {
    // 1. Check existing DB records for this clientOrderId
    if (orderId) {
      try {
        const txs = workstationDb.loadTransactions(orderId);
        const resolved = txs.find(
          (t) => t.reconciliationState === 'RECONCILED'
        );
        if (resolved) {
          return { landed: true, slot: resolved.landingSlot };
        }
      } catch {}
    }

    // 2. Check on-chain signature status
    if (signature) {
      try {
        const statuses = await this.connection.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        });
        const status = statuses?.value?.[0];
        if (
          status &&
          !status.err &&
          (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
        ) {
          return { landed: true, slot: status.slot };
        }
      } catch {}
    }

    // 3. Check Jito inflight and bundle status if bundleId is present
    if (bundleId) {
      try {
        const inflight = await this.jitoTransport.getInflightBundleStatus(bundleId);
        if (inflight && inflight.status === 'Landed') {
          return { landed: true, slot: inflight.landedSlot };
        }
        const bStatus = await this.jitoTransport.getBundleStatus(bundleId);
        if (bStatus && (bStatus.status === 'confirmed' || bStatus.status === 'finalized' || bStatus.landedSlot)) {
          return { landed: true, slot: bStatus.landedSlot };
        }
      } catch {}
    }

    // 4. Check wallet token balance delta and SOL balance delta (when verifying in-flight tx)
    if (signature || bundleId) {
      try {
        const ata = PumpCurveService.getAssociatedTokenAddress(mintPubkey, owner, tokenProgram);
        const balRes = await this.connection.getTokenAccountBalance(ata, 'confirmed');
        if (balRes && balRes.value) {
          const currentBal = BigInt(balRes.value.amount);
          const prevBal = BigInt(preSnapshot.tokenBalanceRaw || '0');
          if (side === 'BUY' && currentBal > prevBal) {
            return { landed: true };
          }
          if (side === 'SELL' && currentBal < prevBal) {
            return { landed: true };
          }
        }
      } catch {}

      // The wallet's native SOL balance is deliberately NOT used: a drop of 100k lamports can come from a concurrent buy of another
      // mint or any fee, and calling that "landed" would stop retries and the RPC fallback for a transaction that never landed (critique #5).
      // Resubmitting the same signed transaction cannot double-fill (same signature), so "not landed" is the safe answer when unsure.
    }

    return { landed: false };
  }

  /**
   * true only when the cluster says this transaction can no longer land. Unknown (RPC error) counts as not expired.
   * R3-2: decided at `confirmed`, as "landed" is (checkIfTransactionLanded) and as transports.ts and pendingSellCannotLand decide it: the
   * confirmed block height is past the blockhash's lastValidBlockHeight (or, when the builder did not record that height, the blockhash
   * is invalid at `confirmed`), and the signature has no status with history searched. A transaction already in a block that is not
   * confirmed yet, near its last valid height, read "expired" at `processed`, and was retried or reported as never landed.
   */
  private async isBlockhashExpired(tx: VersionedTransaction, signature?: string): Promise<boolean> {
    try {
      const lvbh = txBuilder.lastValidBlockHeightOf(tx.message.recentBlockhash);
      if (typeof lvbh === 'number' && lvbh > 0) {
        if ((await this.connection.getBlockHeight('confirmed')) <= lvbh) return false;
      } else {
        const res = await this.connection.isBlockhashValid(tx.message.recentBlockhash, { commitment: 'confirmed' });
        if (res?.value !== false) return false;
      }
      const sig = signature || this.signatureOf(tx);
      if (sig) {
        const st = await this.connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
        if (!(Array.isArray(st?.value) && st.value.length === 1 && st.value[0] === null)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * R1 #8, R3-28: why a signed BUY must not be sent (or resent) now: the kill switch is on, trading is halted, or (first send only) the
   * send deadline set from the signal and market-data ages has passed. null when it may go. Never asked for a SELL: a protective exit is
   * never held by the kill switch.
   */
  private buySendRefusal(notAfter?: number): string | null {
    if (riskEngine.isKillSwitchActive()) return 'the kill switch was activated';
    if (this.haltReason) return `trading was halted (${this.haltReason})`;
    if (typeof notAfter === 'number' && Date.now() > notAfter) return `the signal or its market data is past the risk engine's age limit (send deadline ${new Date(notAfter).toISOString()})`;
    return null;
  }

  // Idempotent, bounded Jito retry loop with pre-checks and zero-double-fill RPC fallback (R0.6)
  /**
   * N20: the signature is known before anything is sent, so the PENDING row is written first. A crash between broadcast and
   * response then leaves a row that startup recovery can resolve, instead of only a wallet scan with no cost basis.
   */
  public async submitAndConfirmWithRetry(
    params: Parameters<ExecutionCoordinator['submitAndConfirmInner']>[0]
  ): ReturnType<ExecutionCoordinator['submitAndConfirmInner']> {
    // S227: an order that is already recorded as landed is answered before anything is written. The PENDING row below is for a signature about
    // to be sent; written first, a skipped resubmission left a row for a transaction that was never sent.
    const already = this.alreadyLandedResult(params.orderId);
    if (already) return already;
    // P1.5 (N-35): the read-only and cluster refusals run before the PENDING row is written, so a refused order leaves no row for a
    // transaction that was never sent (a REVERTED row with a fee that never existed, or a PENDING row that blocks the mint).
    assertNotReadOnly(`sending a ${params.side} order`);
    try {
      traced('guard.sendCluster', () => assertSendClusterAllowed());
      await traced('guard.genesis', () => assertClusterAllowedCached(this.connection));
    } catch (err: any) {
      Logger.error(`[R1] ${params.side} for order ${params.orderId} blocked before anything was recorded or sent: ${err.message}`);
      workstationDb.logJournal('CLUSTER_GUARD_BLOCK', params.correlationId, 'LIVE', { orderId: params.orderId, side: params.side, mint: params.mint, error: err.message });
      return { success: false, signature: '', transport: 'SOLANA_RPC', error: err.message, lifecycleState: 'SUBMIT_FAILED' };
    }
    const preSignature = this.signatureOf(params.tx);
    if (preSignature) {
      const pendingRow: PersistedTransaction = {
        signature: preSignature,
        orderId: params.orderId,
        correlationId: params.correlationId,
        mint: params.mint,
        direction: params.side,
        // S227: with no block engine configured nothing goes through Jito, so the row says SOLANA_RPC from the start.
        submissionTransport: this.jitoTransport.isEnabled() ? 'JITO' : 'SOLANA_RPC',
        submissionTime: Date.now(),
        reconciliationState: 'PENDING',
        networkFeeLamports: 5000,
        jitoTipLamports: params.jitoTipLamports,
        executionMode: 'LIVE',
        // P2.1: past this height a signature with no status never landed; orphan recovery resolves the row on it instead of on wall-clock age.
        lastValidBlockHeight: txBuilder.lastValidBlockHeightOf((params.tx as any)?.message?.recentBlockhash),
        exitReason: params.side === 'SELL' ? params.exitReason : undefined,
      };
      if (params.side === 'BUY') {
        // P1.1 (N-57): the check for another unresolved buy of this mint and this row are one database transaction, so a second process
        // (or a second coordinator) buying the same mint at the same moment is refused here, before anything is sent.
        let recorded: boolean;
        try {
          recorded = workstationDb.savePendingBuyIfNoneUnresolved(pendingRow);
        } catch (err: any) {
          return { success: false, signature: '', transport: 'SOLANA_RPC', error: `PENDING_WRITE_FAILED: ${err.message}; nothing was sent`, lifecycleState: 'SUBMIT_FAILED' };
        }
        if (!recorded) {
          workstationDb.logJournal('TRADE_REJECTED_UNRESOLVED_BUY', params.correlationId, 'LIVE', { mint: params.mint, orderId: params.orderId, at: 'submit' });
          return { success: false, signature: '', transport: 'SOLANA_RPC', error: `UNRESOLVED_BUY: another buy of ${params.mint} was sent and is not reconciled yet; nothing was sent`, lifecycleState: 'SUBMIT_FAILED' };
        }
      } else if (!workstationDb.saveTransaction(pendingRow)) {
        // R1 #3: as for a BUY, a sell is never sent without its durable record: dying after the send would leave nothing that names the
        // signature (pendingSells is memory only, and the restart seed reads these rows), so the position could be sold twice.
        return { success: false, signature: '', transport: 'SOLANA_RPC', error: 'PENDING_WRITE_FAILED: the SELL could not be recorded before sending; nothing was sent', lifecycleState: 'SUBMIT_FAILED' };
      }
    }
    const res = await this.submitAndConfirmInner(params);
    if (preSignature && !res.success && !res.unconfirmed) {
      // Definitely not landing (never sent, rejected, or seen failing): do not leave a PENDING row to block readiness.
      const rows = workstationDb.loadTransactions(params.orderId).filter((t) => t.signature === preSignature);
      if (rows.some((t) => t.reconciliationState === 'PENDING')) {
        // P2.1: a transaction whose blockhash expired unseen did not fail on chain; it never landed (TIMED_OUT, as orphan recovery writes it).
        const neverLanded = /^(BLOCKHASH_EXPIRED|RPC_RATE_LIMITED)/.test(res.error ?? ''); // S262: a rate-limited send is only reported after its blockhash expired
        workstationDb.saveTransaction({ ...rows[0], reconciliationState: neverLanded ? 'TIMED_OUT' : 'REVERTED', error: res.error ?? 'not sent or rejected' });
      }
    }
    return res;
  }

  /** R0.6: the result for an order the database already holds as landed (RECONCILED), or null. Writes nothing. */
  private alreadyLandedResult(orderId: string): { success: true; signature: string; transport: 'JITO' | 'SOLANA_RPC'; slot?: number; lifecycleState: 'CONFIRMED' } | null {
    if (!orderId) return null;
    const resolved = workstationDb.loadTransactions(orderId).find((t) => t.reconciliationState === 'RECONCILED');
    if (!resolved) return null;
    Logger.warn(`[R0.6] Order ${orderId} already landed or recorded in database; skipping resubmission`);
    return {
      success: true,
      signature: resolved.signature,
      transport: resolved.submissionTransport === 'SOLANA_RPC' ? 'SOLANA_RPC' : 'JITO',
      slot: resolved.landingSlot,
      lifecycleState: 'CONFIRMED',
    };
  }

  private signatureOf(tx: any): string | null {
    try {
      const sig = tx?.signatures?.[0];
      if (!sig || sig.every((b: number) => b === 0)) return null;
      return bs58.encode(sig);
    } catch {
      return null;
    }
  }

  private async submitAndConfirmInner(params: {
    tx: VersionedTransaction;
    orderId: string;
    correlationId: string;
    side: 'BUY' | 'SELL';
    mint: string;
    mintPubkey: PublicKey;
    owner: PublicKey;
    tokenProgram: PublicKey;
    preSnapshot: PreTradeSnapshot;
    jitoTipLamports: number;
    /** SELL only: the exit reason, stored on the transaction row (see exitStageAfterFill). */
    exitReason?: string;
    /** BUY only (R3-28): wall-clock ms after which the first send is refused (the signal or market data would be stale). */
    buyNotAfter?: number;
  }): Promise<{
    success: boolean;
    signature: string;
    bundleId?: string;
    transport: 'JITO' | 'SOLANA_RPC';
    slot?: number;
    error?: string;
    lifecycleState: 'CONFIRMED' | 'SUBMIT_FAILED' | 'REVERTED';
    /** N2: submitted but never seen failing on chain (timeout / RPC error). It may still land; do not treat as a revert. */
    unconfirmed?: boolean;
  }> {
    const { tx, orderId, correlationId, side, mint, mintPubkey, owner, tokenProgram, preSnapshot, jitoTipLamports } = params;
    assertNotReadOnly(`sending a ${side} order`); // S185: the one place every signed buy and sell is submitted from
    const cfg = executionConfig.getConfig();

    // Cluster guard: every signed buy and sell passes through here. Refuse before anything is sent
    // unless the RPC reports the allowed cluster's genesis hash (devnet unless Mike set ALLOWED_CLUSTER).
    try {
      traced('guard.sendCluster', () => assertSendClusterAllowed()); // mainnet is never a send target, even when the RPC reports its genesis
      // R1-1/N-27: while the heartbeat says the RPC is not on the allowed cluster, no buy or sell is sent, whatever the send-path cache holds.
      if (this.clusterProblem !== null) throw new ClusterGuardError(`the RPC is not trusted (${this.clusterProblem.replace(/^CLUSTER_GUARD: /, '')}); refusing to send`);
      await traced('guard.genesis', () => assertClusterAllowedCached(this.connection)); // S208: a pass is remembered per Connection for 60 s
    } catch (err: any) {
      Logger.error(`[R1] ${side} for order ${orderId} blocked: ${err.message}`);
      workstationDb.logJournal('CLUSTER_GUARD_BLOCK', correlationId, 'LIVE', { orderId, side, mint, error: err.message });
      return {
        success: false,
        signature: '',
        transport: 'SOLANA_RPC',
        error: err.message,
        lifecycleState: 'SUBMIT_FAILED',
      };
    }
    const jitoEnabled = this.jitoTransport.isEnabled();
    // Fail closed on Jito health: with a block engine configured, re-probe once if readiness is not current and
    // only use Jito if it answers HEALTHY. An unhealthy engine is not retried; the order goes to RPC only when
    // the operator enabled the RPC fallback, otherwise it is refused.
    let jitoUsable = jitoEnabled;
    let jitoUnhealthyReason: string | undefined;
    if (jitoEnabled && !this.getJitoReadiness().ready) {
      await this.jitoTransport.probe();
      const readiness = this.getJitoReadiness();
      jitoUsable = readiness.ready;
      if (!jitoUsable) {
        jitoUnhealthyReason = `Failed to submit: ${readiness.reason ?? 'Jito Block Engine is not healthy'} (fail closed)`;
        Logger.warn(`[A4] ${side} for order ${orderId}: ${jitoUnhealthyReason}`);
      }
    }
    // With no Jito block engine configured (always the case on devnet) there is nothing to retry: go straight to RPC.
    const maxRetries = jitoUsable ? Math.max(0, cfg.jitoMaxRetries) : -1;
    const retryIntervalMs = Math.max(0, cfg.jitoRetryIntervalMs);
    const confirmTimeoutMs = Math.max(1000, cfg.bundleConfirmTimeoutMs);

    // 0. Pre-execution check: Has this order already executed or landed?
    const already = this.alreadyLandedResult(orderId);
    if (already) return already;

    let lastSignature = '';
    let lastBundleId: string | undefined;
    let lastError: string | undefined = jitoUnhealthyReason;
    let lastConfirmDefinite = false;
    let landedSlot: number | undefined;
    let jitoLanded = false;
    let blockhashExpired = false;

    // Bounded Idempotent Jito Retry Loop
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        Logger.info(`[R0.6] Jito retry attempt ${attempt}/${maxRetries} for order ${orderId}`);
        // Before retrying after a timeout: check bundle status, check transaction status, check wallet/token balance, check existing execution record
        if (lastSignature || lastBundleId) {
          const check = await this.checkIfTransactionLanded(lastSignature, lastBundleId, owner, mintPubkey, tokenProgram, preSnapshot, side, orderId);
          if (check.landed) {
            Logger.info(`[R0.6] Pre-retry check verified tx ${lastSignature} already landed at slot ${check.slot}`);
            jitoLanded = true;
            landedSlot = check.slot;
            break;
          }
        }
        // The same signed transaction is resent on each retry (same signature, so it cannot fill twice). Once its blockhash has
        // expired and it has not landed, every further resend is wasted time, so stop and let the caller build a new transaction.
        if (await this.isBlockhashExpired(tx, lastSignature)) {
          blockhashExpired = true;
          lastError = 'BLOCKHASH_EXPIRED: the transaction did not land and its blockhash is no longer valid; safe to retry with a new transaction';
          break;
        }
        if (retryIntervalMs > 0) {
          await new Promise((r) => setTimeout(r, retryIntervalMs));
        }
      }

      // R1 #8: a kill or halt between signing and this send (or between two resends) stops the BUY here; a SELL is never held
      if (side === 'BUY') {
        const refused = this.buySendRefusal(lastSignature || lastBundleId ? undefined : params.buyNotAfter);
        if (refused) return this.revokedBuyResult(refused, params, lastSignature, lastBundleId, 'JITO');
      }

      // Submit bundle to Jito
      const submitRes = await traced('tx.submit', () => this.jitoTransport.submit(tx), { 'apex.transport': 'JITO', 'apex.side': side });
      if (submitRes.signature) lastSignature = submitRes.signature;
      if (submitRes.bundleId) lastBundleId = submitRes.bundleId;

      if (!submitRes.success || !submitRes.signature) {
        lastError = submitRes.error || 'Failed to submit bundle to Block Engine';
        // If Jito explicitly rejected with a fatal instruction simulation error, do not keep retrying
        if (lastError.includes('InstructionError') || lastError.includes('Transaction simulation failed')) {
          break;
        }
        continue;
      }

      // Record transaction in SQLite as PENDING under clientOrderId
      workstationDb.saveTransaction({
        signature: submitRes.signature,
        bundleId: submitRes.bundleId,
        orderId,
        correlationId,
        mint,
        direction: side,
        submissionTransport: 'JITO',
        submissionTime: Date.now(),
        reconciliationState: 'PENDING',
        networkFeeLamports: 5000,
        jitoTipLamports,
        executionMode: 'LIVE',
      });

      // Confirm with bounded timeout
      const confirmRes = await traced('tx.confirm', () => this.jitoTransport.confirm(submitRes.signature, confirmTimeoutMs, submitRes.bundleId), { 'apex.transport': 'JITO', 'apex.side': side });
      if (confirmRes.confirmed) {
        jitoLanded = true;
        landedSlot = confirmRes.slot;
        break;
      } else {
        lastError = confirmRes.error || 'Transaction dropped or expired on Solana';
        lastConfirmDefinite = confirmRes.lifecycleState === 'REVERTED';
        // Check if it landed despite confirm timing out
        const postConfirmCheck = await this.checkIfTransactionLanded(submitRes.signature, submitRes.bundleId, owner, mintPubkey, tokenProgram, preSnapshot, side, orderId);
        if (postConfirmCheck.landed) {
          jitoLanded = true;
          landedSlot = postConfirmCheck.slot;
          break;
        }
        // Q52: a transaction seen REVERTED on chain stays reverted; sending the same transaction again cannot change that.
        if (lastConfirmDefinite) break;
      }
    }

    if (jitoLanded) {
      return {
        success: true,
        signature: lastSignature,
        bundleId: lastBundleId,
        transport: 'JITO',
        slot: landedSlot,
        lifecycleState: 'CONFIRMED',
      };
    }

    // Direct RPC Fallback branch (if enabled and Jito retries did not land; always taken when Jito is disabled)
    if (cfg.enableRpcFallback || !jitoEnabled) {
      // If Jito explicitly rejected with a fatal simulation error, do not fallback to RPC
      if (lastError && (lastError.includes('InstructionError') || lastError.includes('Transaction simulation failed'))) {
        return {
          success: false,
          signature: lastSignature,
          bundleId: lastBundleId,
          transport: 'JITO',
          error: lastError,
          lifecycleState: 'REVERTED',
        };
      }

      if (jitoEnabled) Logger.warn(`[R0.6] Jito attempts exhausted for order ${orderId}. Evaluating direct RPC fallback...`);
      else Logger.info(`[S227] No Jito block engine is configured; order ${orderId} goes through the RPC transport`);
      // Crucial pre-check before fallback to prevent double fill:
      if (lastSignature || lastBundleId) {
        const preFallbackCheck = await this.checkIfTransactionLanded(lastSignature, lastBundleId, owner, mintPubkey, tokenProgram, preSnapshot, side, orderId);
        if (preFallbackCheck.landed) {
          Logger.info(`[R0.6] Pre-fallback check discovered Jito tx ${lastSignature} landed at slot ${preFallbackCheck.slot}. Aborting RPC fallback to prevent double fill.`);
          return {
            success: true,
            signature: lastSignature,
            bundleId: lastBundleId,
            transport: 'JITO',
            slot: preFallbackCheck.slot,
            lifecycleState: 'CONFIRMED',
          };
        }
      }

      // Sending an expired transaction through the RPC fallback cannot land. Checked after the landed check above, so "expired and not landed" is definitive.
      if (blockhashExpired || ((lastSignature || lastBundleId) && (await this.isBlockhashExpired(tx, lastSignature)))) {
        return {
          success: false,
          signature: lastSignature,
          bundleId: lastBundleId,
          transport: 'SOLANA_RPC',
          error: 'BLOCKHASH_EXPIRED: the transaction did not land and its blockhash is no longer valid; safe to retry with a new transaction',
          lifecycleState: 'SUBMIT_FAILED',
        };
      }

      if (jitoEnabled) {
        workstationDb.logJournal('FALLBACK_RPC_ATTEMPT', correlationId, 'LIVE', {
          orderId,
          previousJitoSignature: lastSignature,
          previousJitoBundleId: lastBundleId,
        });
      }

      // R1 #8: the last look before the RPC send of a BUY (after the genesis check, any Jito probe and the Jito attempts)
      if (side === 'BUY') {
        const refused = this.buySendRefusal(lastSignature || lastBundleId ? undefined : params.buyNotAfter);
        if (refused) return this.revokedBuyResult(refused, params, lastSignature, lastBundleId, 'SOLANA_RPC');
      }

      // S245: a rate-limited send was refused, not lost: a SELL is resent (same signed bytes) after short waits; a BUY is not.
      const rpcSubmit = await traced('tx.submit', () => this.rpcTransport.submitThroughRateLimit(tx, side === 'SELL' ? SELL_RATE_LIMIT_BACKOFF_MS : []), { 'apex.transport': 'SOLANA_RPC', 'apex.side': side });
      // S262 (review 2026-10-24, HIGH on S245): a send the RPC rate-limited past every resend is an unknown outcome, not "nothing was sent"
      // (a balancer may have forwarded an earlier attempt, or a block engine may hold the same transaction). It is watched below like any
      // ambiguous send, with resends, until it confirms or its blockhash expires; only then is it reported RPC_RATE_LIMITED (never landed).
      if (rpcSubmit.authRejected) this.raiseRpcAuthAlert(rpcSubmit.authRejected, `the ${side.toLowerCase()} for order ${orderId}`); // R4-10: definite, not forwarded
      const rateLimitedOnly = !!rpcSubmit.rateLimited && !rpcSubmit.success;
      if (rateLimitedOnly) {
        Logger.warn(`[S262] ${side} for order ${orderId}: the RPC rate-limited the send ${rpcSubmit.rateLimitedResends + 1} time(s); watching ${rpcSubmit.signature.slice(0, 8)} until it lands or its blockhash expires`);
        workstationDb.logJournal('SEND_RATE_LIMITED', correlationId, 'LIVE', { orderId, side, mint, signature: rpcSubmit.signature, tries: rpcSubmit.rateLimitedResends + 1, error: rpcSubmit.error });
      }
      // P1.5 (R1-2): a send that failed without proof of rejection (fetch failed, socket reset, 502/504 after forwarding) may still land.
      // It is watched like any sent transaction below: confirmed means success, failed on chain means REVERTED, unseen means unconfirmed
      // (the buy path then keeps it RECONCILIATION_REQUIRED with orphan recovery, the sell path records a pending sell). Never REVERTED here.
      const ambiguousSend = !rpcSubmit.success && (!!rpcSubmit.ambiguous || rateLimitedOnly) && !!rpcSubmit.signature;
      if (ambiguousSend) {
        Logger.warn(`[P1.5] ${side} for order ${orderId}: the send failed with no proof of rejection (${rpcSubmit.error}); watching ${rpcSubmit.signature.slice(0, 8)} in case it lands`);
        workstationDb.logJournal('SEND_OUTCOME_UNKNOWN', correlationId, 'LIVE', { orderId, side, mint, signature: rpcSubmit.signature, error: rpcSubmit.error });
      }
      if (!ambiguousSend && (!rpcSubmit.success || !rpcSubmit.signature)) {
        return {
          success: false,
          signature: rpcSubmit.signature || lastSignature,
          transport: 'SOLANA_RPC',
          error: rpcSubmit.error || 'RPC fallback submission failed',
          lifecycleState: 'SUBMIT_FAILED',
        };
      }

      // Record transaction under the SAME single logical orderId
      workstationDb.saveTransaction({
        signature: rpcSubmit.signature,
        orderId,
        correlationId,
        mint,
        direction: side,
        submissionTransport: 'SOLANA_RPC',
        submissionTime: Date.now(),
        reconciliationState: 'PENDING',
        networkFeeLamports: 5000,
        jitoTipLamports: 0,
        executionMode: 'LIVE',
      });

      // P2.1: the same signed bytes are resent while the transaction is watched, and the watch runs until the blockhash expires (not a fixed 15 s).
      const rpcConfirm = await traced('tx.confirm', () => this.rpcTransport.confirm(rpcSubmit.signature, cfg.rpcFallbackTimeoutMs || 15000, undefined, {
        rebroadcast: tx,
        lastValidBlockHeight: txBuilder.lastValidBlockHeightOf((tx as any)?.message?.recentBlockhash),
        // R1 #8: a kill or halt during the watch stops the resends of a BUY (the watch itself goes on); a SELL keeps every resend
        ...(side === 'BUY' ? { stopResends: () => this.buySendRefusal() } : {}),
      }), { 'apex.transport': 'SOLANA_RPC', 'apex.side': side });
      if (rpcConfirm.confirmed) {
        return {
          success: true,
          signature: rpcSubmit.signature,
          transport: 'SOLANA_RPC',
          slot: rpcConfirm.slot,
          lifecycleState: 'CONFIRMED',
        };
      } else {
        const postRpcCheck = await this.checkIfTransactionLanded(rpcSubmit.signature, undefined, owner, mintPubkey, tokenProgram, preSnapshot, side, orderId);
        if (postRpcCheck.landed) {
          return {
            success: true,
            signature: rpcSubmit.signature,
            transport: 'SOLANA_RPC',
            slot: postRpcCheck.slot,
            lifecycleState: 'CONFIRMED',
          };
        }
        // P2.1: expired with no status and not landed by the balance check either: a definite "never landed", like the Jito path's
        // BLOCKHASH_EXPIRED. Not unconfirmed, so a buy leaves no unresolved row for the mint and a sell leaves no pending sell.
        if (rpcConfirm.lifecycleState === 'EXPIRED_BLOCKHASH') {
          workstationDb.logJournal('SEND_EXPIRED_UNLANDED', correlationId, 'LIVE', { orderId, side, mint, signature: rpcSubmit.signature });
          // S262: every send of it was rate-limited and it never landed: the refusals are now proven, so it is RPC_RATE_LIMITED (a sell then
          // counts as no attempt and raises EXIT_RATE_LIMITED, as in S245), with BLOCKHASH_EXPIRED kept in the text.
          const error = rateLimitedOnly
            ? `RPC_RATE_LIMITED: the RPC refused the ${side.toLowerCase()} ${rpcSubmit.rateLimitedResends + 1} time(s) with a rate limit and it never landed (${rpcConfirm.error}; ${rpcSubmit.error})`
            : rpcConfirm.error;
          return { success: false, signature: rpcSubmit.signature, transport: 'SOLANA_RPC', error, lifecycleState: 'SUBMIT_FAILED' };
        }
        return {
          success: false,
          signature: rpcSubmit.signature,
          transport: 'SOLANA_RPC',
          error: ambiguousSend && rpcConfirm.lifecycleState !== 'REVERTED'
            ? `SEND_OUTCOME_UNKNOWN: ${rpcSubmit.error}; not seen on chain yet (${rpcConfirm.error || 'unconfirmed'})`
            : rpcConfirm.error || 'RPC fallback transaction dropped or unconfirmed',
          lifecycleState: 'REVERTED',
          unconfirmed: rpcConfirm.lifecycleState !== 'REVERTED',
        };
      }
    }

    // If we reach here, Jito failed/timed out and RPC fallback was not enabled or failed
    return {
      success: false,
      signature: lastSignature,
      bundleId: lastBundleId,
      transport: 'JITO',
      error: lastError || 'Transaction unconfirmed or dropped across Jito attempts',
      lifecycleState: lastError?.includes('Failed to submit') ? 'SUBMIT_FAILED' : 'REVERTED',
      unconfirmed: !!lastSignature && !lastError?.includes('Failed to submit') && !lastConfirmDefinite,
    };
  }

  /**
   * R1 #8: the result of a BUY stopped by buySendRefusal. Nothing sent yet: a plain refusal (nothing can land). Sent before: no more
   * resends, but an earlier send may still land, so unless it is seen landed it is reported unconfirmed (the buy path keeps the row
   * RECONCILIATION_REQUIRED, orphan recovery adopts the tokens, and the late-buy watch sells them).
   */
  private async revokedBuyResult(
    why: string,
    params: { owner: PublicKey; mintPubkey: PublicKey; tokenProgram: PublicKey; preSnapshot: PreTradeSnapshot; orderId: string; correlationId: string; mint: string },
    lastSignature: string,
    lastBundleId: string | undefined,
    transport: 'JITO' | 'SOLANA_RPC'
  ): Promise<{ success: boolean; signature: string; bundleId?: string; transport: 'JITO' | 'SOLANA_RPC'; slot?: number; error?: string; lifecycleState: 'CONFIRMED' | 'SUBMIT_FAILED' | 'REVERTED'; unconfirmed?: boolean }> {
    workstationDb.logJournal('TRADE_REVOKED_BEFORE_SEND', params.correlationId, 'LIVE', { mint: params.mint, orderId: params.orderId, reason: why, alreadySent: !!(lastSignature || lastBundleId) });
    if (!lastSignature && !lastBundleId) {
      Logger.warn(`[R1 #8] BUY for order ${params.orderId} not sent: ${why}`);
      return { success: false, signature: '', transport, error: `ENTRY_REVOKED: ${why} after the order was signed; nothing was sent.`, lifecycleState: 'SUBMIT_FAILED' };
    }
    Logger.warn(`[R1 #8] BUY for order ${params.orderId}: no more resends (${why}); an earlier send may still land`);
    const check = await this.checkIfTransactionLanded(lastSignature, lastBundleId, params.owner, params.mintPubkey, params.tokenProgram, params.preSnapshot, 'BUY', params.orderId);
    if (check.landed) return { success: true, signature: lastSignature, bundleId: lastBundleId, transport, slot: check.slot, lifecycleState: 'CONFIRMED' };
    return { success: false, signature: lastSignature, bundleId: lastBundleId, transport, error: `ENTRY_REVOKED_AFTER_SEND: ${why}; not resent, and the earlier send may still land`, lifecycleState: 'REVERTED', unconfirmed: !!lastSignature };
  }

  /**
   * R8-6: the round-trip cost the 20% gate compares with the order: estimateRoundTripCostLamports (one buy, one sell) plus, for each
   * further sell of the exit ladder, one more sell tip, base fee and priority fee.
   */
  public static ladderRoundTripCostLamports(p: Parameters<typeof estimateRoundTripCostLamports>[0]): number {
    const extraSells = EXIT_LADDER_SELL_COUNT - 1;
    return estimateRoundTripCostLamports(p) + extraSells * (p.sellTipLamports + 5_000 + p.priorityFeeLamports);
  }

  /** Shared by LIVE and PAPER (C5): the same on-chain facts become the same eligibility inputs. */
  private eligibilityInputFromMarket(
    req: ExecuteTradeRequest,
    marketState: any,
    holderDist: { devHoldingPct: number; top10HoldersPct: number } | null,
    liquidityUsd: number | undefined
  ) {
    return {
      mint: req.mint,
      symbol: req.symbol,
      name: req.name,
      creator: marketState.creator.toBase58(),
      priceSol:
        Number(marketState.virtualSolReserves) /
        Number(marketState.virtualTokenReserves) /
        (1e9 / Math.pow(10, marketState.tokenDecimals)),
      liquidityUsd,
      bondingCurveProgress: Number(
        Math.min(100, (Number(marketState.realSolReserves) / (85 * 1e9)) * 100).toFixed(1)
      ),
      isMigrated: marketState.complete,
      isMintAuthorityRevoked: marketState.isMintAuthorityRevoked,
      isFreezeAuthorityRevoked: marketState.isFreezeAuthorityRevoked,
      hasToken2022Extensions: marketState.baseTokenProgram?.equals(TOKEN_2022_PROGRAM_ID) ?? false,
      // Pass the extension inspection result through. LIVE already refuses unsafe mints in fetchPumpMarketState,
      // so a Token-2022 mint that reaches here with a report is explicitly safe; without this it was UNKNOWN and rejected.
      token2022Safe: marketState.token2022Report ? marketState.token2022Report.isSafe : undefined,
      unsupportedToken2022Extension:
        marketState.token2022Report && !marketState.token2022Report.isSafe
          ? marketState.token2022Report.unsupportedExtensionNames.join(',') || true
          : undefined,
      devHoldingPct: holderDist ? holderDist.devHoldingPct : null,
      top10HoldersPct: holderDist ? holderDist.top10HoldersPct : null,
    };
  }

  /**
   * The single eligibility verdict used by BOTH modes (C5), so the same report gives the same accept/reject.
   * Strict (LIVE, or PAPER with PAPER_STRICT_GATES=1) also rejects holder checks that are unverified;
   * non-strict PAPER lets UNKNOWN pass but the caller records it as unverified on the fill.
   */
  private eligibilityVerdict(
    eligibility: TokenEligibilityReport,
    now: number,
    mode: ExecutionMode,
    correlationId: string,
    strict: boolean = mode === 'LIVE'
  ): ExecutionResponse | null {
    const reject = (error: string): ExecutionResponse => ({
      success: false,
      lifecycleState: 'FILTER_REJECTED',
      executionMode: mode,
      error,
      correlationId,
    });
    if (now - eligibility.evaluatedAt > 60000) {
      return reject(`ELIGIBILITY_REPORT_STALE: Eligibility report evaluated ${Math.round((now - eligibility.evaluatedAt) / 1000)}s ago exceeds 60s max age for live trading.`);
    }

    const unsupportedExtensionCheck = eligibility.checks.find(
      (c) => c.ruleId === 'TOKEN_2022_POLICY' && !c.passed
    );
    if (unsupportedExtensionCheck) {
      return reject(`UNSUPPORTED_TOKEN_EXTENSION: ${unsupportedExtensionCheck.reason}`);
    }

    if (!eligibility.isEligible) {
      const failReasons = eligibility.checks.filter((c) => !c.passed).map((c) => c.reason).join('; ');
      return reject(`ELIGIBILITY_CHECK_FAILED: Token failed ${eligibility.failedCount} safety check(s): ${failReasons}`);
    }

    const hasUnverifiedHolders = eligibility.checks.some(
      (c) =>
        (c.ruleId === 'MAX_CREATOR_EXPOSURE' || c.ruleId === 'TOP_10_CONCENTRATION') &&
        (!c.passed || String(c.observedValue).toLowerCase().includes('unknown') || String(c.observedValue).toLowerCase().includes('unverified'))
    );
    if (strict && hasUnverifiedHolders) {
      return reject('SAFETY_CHECK_UNVERIFIED: Dev holding or top 10 holders distribution is unverified. Live trade rejected.');
    }

    return null;
  }

  /**
   * Everything a PAPER buy must pass before a fill: price, the shared eligibility gate, capital ceiling and risk.
   * Used by the paper fill itself and by previewBuy (auto-snipe Shadow mode), so a dry run runs the same gates.
   */
  private async evaluatePaperBuy(
    req: ExecuteTradeRequest,
    correlationId: string,
    now: number,
    openPositions: NormalizedPosition[],
    totalExposureSol: number
  ): Promise<
    | { rejection: ExecutionResponse }
    | { quotePriceSol: number; paperEligibility: { gates: Record<string, unknown> }; paperTip: ReturnType<typeof executionConfig.resolveDynamicJitoTip>; maxPaperOrderSol: number; curveState: PumpMarketState | null }
  > {
    let quotePriceSol = req.currentPriceSol;
    // Q7: read the real curve for every paper order. Its price replaces the caller's (a WS pool's came from the create event), and the
    // fill is quoted from its reserves and fee settings. null when the curve cannot be read (offline, migrated): the fill is then the MODEL.
    let curveState: PumpMarketState | null = null;
    try {
      const state = await PumpCurveService.fetchPumpMarketState({ connection: this.connection, mint: new PublicKey(req.mint), executionMode: 'PAPER' });
      if (state && !state.complete) {
        curveState = state;
        quotePriceSol = Number(state.virtualSolReserves) / Number(state.virtualTokenReserves) / (1e9 / Math.pow(10, state.tokenDecimals));
      }
    } catch {}

    // P4.3 (R1-57): the curve-progress cap on the fresh read, so SHADOW, PAPER and manual PAPER buys stop where LIVE does
    if (curveState) {
      const progressPct = curveProgressPctOfState(curveState);
      if (progressPct !== null && isCurveTooFar(progressPct)) {
        const error = curveTooFarReason('CURVE_PROGRESS_TOO_HIGH', progressPct);
        workstationDb.logJournal('TRADE_FILTER_REJECTED', correlationId, 'PAPER', { reason: error, curveProgressPct: progressPct });
        return { rejection: { success: false, lifecycleState: 'FILTER_REJECTED', executionMode: 'PAPER', error, correlationId } };
      }
    }

    if (!quotePriceSol || quotePriceSol <= 0) {
      return { rejection: {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'PAPER',
        error: 'MARKET_DATA_UNAVAILABLE: No valid market price available to execute paper order',
        correlationId,
      } };
    }

    const paperEligibility = await this.runPaperEligibility(req, quotePriceSol, now, correlationId);
    if (paperEligibility.verdict) {
      workstationDb.logJournal('TRADE_FILTER_REJECTED', correlationId, 'PAPER', {
        reason: paperEligibility.verdict.error,
        gates: paperEligibility.gates,
      });
      return { rejection: paperEligibility.verdict };
    }

    // Resolve dynamic tip for paper mode to respect economic sanity bounds
    const paperTip = executionConfig.resolveDynamicJitoTip({
      tradeAmountSol: req.amountSol,
      explicitTipSol: req.jitoTipSol,
    });

    // Pre-trade capital sizing check: ensure order does not exceed 10% of spendable bankroll (B12)
    // C5: the configured paper bankroll (default 0.07 SOL), never an invented 1.0
    const paperBalanceSol = this.realWalletBalanceSol !== null ? this.realWalletBalanceSol : executionConfig.getConfig().paperBankrollSol;
    const paperSpendable = CapitalSizer.calculateSpendableBankroll(paperBalanceSol, 0.015, this.inFlightReservedSol);
    const maxPaperOrderSol = Number((paperSpendable * 0.10).toFixed(6));
    if (paperSpendable > 0 && req.amountSol > maxPaperOrderSol + 0.000001) {
      return { rejection: {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'PAPER',
        error: `EXCEEDS_CAPITAL_CEILING: Trade size ${req.amountSol} SOL exceeds 10% spendable bankroll ceiling (${maxPaperOrderSol} SOL).`,
        correlationId,
      } };
    }

    // Evaluate Risk in Paper Mode
    // Q51: read the open positions now (the caller's list is from before the awaits above)
    const paperOpenNow = workstationDb.loadPositions('PAPER', 'ACTIVE');
    const riskDecision = traced('risk.evaluateOrder', () => riskEngine.evaluateOrder({
      mint: req.mint,
      orderSizeSol: req.amountSol,
      expectedPriceSol: quotePriceSol,
      slippageBps: req.slippageBps || 800,
      estimatedPriceImpactBps: PaperExecutionEngine.estimateImpactBps(req.amountSol, req.liquidityUsd),
      estimatedFeeLamports: 15000,
      jitoTipLamports: paperTip.tipLamports,
      signalTimestamp: req.signalTimestamp || now,
      marketDataTimestamp: req.marketDataTimestamp || now,
      currentOpenPositionsCount: paperOpenNow.length,
      currentTotalExposureSol: paperOpenNow.reduce((acc, p) => acc + p.costBasisLamports / 1e9, 0),
      // Q50: the risk engine applies the 0.015 reserve itself, so it gets the balance net of in-flight orders only (as LIVE does, N12);
      // `paperSpendable` already had the reserve taken off, and passing it charged the reserve twice.
      walletSpendableSol: Math.max(0, paperBalanceSol - this.inFlightReservedSol),
      executionMode: 'PAPER',
    }));

    if (!riskDecision.approved) {
      workstationDb.logJournal('TRADE_RISK_REJECTED', correlationId, 'PAPER', {
        reason: riskDecision.reasonCode,
        message: riskDecision.message,
      });
      return { rejection: {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'PAPER',
        error: `${riskDecision.reasonCode}: ${riskDecision.message}`,
        correlationId,
      } };
    }
    return { quotePriceSol, paperEligibility, paperTip, maxPaperOrderSol, curveState };
  }


  /**
   * G1: run every PAPER-side gate for a buy (price, eligibility, capital ceiling, risk) and stop before any fill.
   * Never touches the signer or the paper ledger, whatever the coordinator mode is. Used by auto-snipe Shadow mode.
   */
  public async previewBuy(req: ExecuteTradeRequest): Promise<
    | { status: 'OK'; quotePriceSol: number; tipLamports: number; amountSol: number; gates: Record<string, unknown> }
    | { status: 'REJECTED'; error: string; lifecycleState: ExecutionResponse['lifecycleState'] }
  > {
    const correlationId = `preview-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const openPositions = workstationDb.loadPositions('PAPER', 'ACTIVE');
    const totalExposureSol = openPositions.reduce((acc, p) => acc + p.costBasisLamports / 1e9, 0);
    const evaluated = await this.evaluatePaperBuy(req, correlationId, Date.now(), openPositions, totalExposureSol);
    if ('rejection' in evaluated) {
      return { status: 'REJECTED', error: evaluated.rejection.error || 'REJECTED', lifecycleState: evaluated.rejection.lifecycleState };
    }
    return {
      status: 'OK',
      quotePriceSol: evaluated.quotePriceSol,
      tipLamports: evaluated.paperTip.tipLamports,
      amountSol: req.amountSol,
      gates: evaluated.paperEligibility.gates,
    };
  }

  /**
   * C5: PAPER runs the same eligibility gate as LIVE. With a report supplied it is used as-is; otherwise the on-chain
   * facts are read (best effort, 4s cap) and evaluated. Facts that cannot be read stay UNKNOWN: strict mode
   * (PAPER_STRICT_GATES=1) rejects them like LIVE, default mode lets them through but records them as unverified.
   */
  private async runPaperEligibility(req: ExecuteTradeRequest, quotePriceSol: number, now: number, correlationId: string) {
    const strict = executionConfig.getConfig().paperStrictGates;
    let eligibility = req.eligibilityReport;
    const needsFacts = !eligibility || eligibility.checks.some(
      (c) => (c.ruleId === 'TOP_10_CONCENTRATION' || c.ruleId === 'MAX_CREATOR_EXPOSURE') && c.status === 'UNKNOWN'
    );
    if (needsFacts) {
      const within = <T>(p: Promise<T>) =>
        Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
      let marketState: any = null;
      let holderDist: { devHoldingPct: number; top10HoldersPct: number } | null = null;
      try {
        const mintPk = new PublicKey(req.mint);
        marketState = await within(
          PumpCurveService.fetchPumpMarketState({ connection: this.connection, mint: mintPk, executionMode: 'PAPER' })
        );
        if (marketState) {
          holderDist = await within(
            fetchTokenHolderDistribution(this.connection, mintPk, marketState.creator, marketState.bondingCurve)
          );
        }
      } catch (err: any) {
        Logger.debug(`[C5] Paper gate could not read on-chain facts for ${req.mint}: ${err.message}`);
      }
      const solUsd = solPriceService.lastKnownPrice();
      if (marketState) {
        const liquidityUsd = solUsd !== null ? (Number(marketState.realSolReserves) / 1e9) * solUsd * 2 : req.liquidityUsd;
        eligibility = EligibilityFilter.evaluate(this.eligibilityInputFromMarket(req, marketState, holderDist, liquidityUsd), strict);
      } else if (!eligibility) {
        eligibility = EligibilityFilter.evaluate(
          { mint: req.mint, symbol: req.symbol, name: req.name, priceSol: quotePriceSol, liquidityUsd: req.liquidityUsd },
          strict
        );
      }
    }
    const verdict = traced('gate.eligibility', () => this.eligibilityVerdict(eligibility!, now, 'PAPER', correlationId, strict), { 'apex.mode': 'PAPER' });
    const checks = eligibility!.checks;
    const gates = {
      strict,
      eligibility: {
        passed: checks.filter((c) => c.status === 'PASS' || (c.status === undefined && c.passed)).map((c) => c.ruleId),
        failed: checks.filter((c) => c.status === 'FAIL' || (c.status === undefined && !c.passed)).map((c) => c.ruleId),
        unverified: checks.filter((c) => c.status === 'UNKNOWN').map((c) => c.ruleId),
      },
    };
    return { verdict, gates };
  }

  /** 3F (R1-9): the MINT_RECENTLY_EXITED refusal for a buy of `mint` in the current mode, or null when it may be bought. Fails closed. */
  private mintReentryRefusal(mint: string, now: number): string | null {
    const exits = workstationDb.loadMintExits(mint, this.executionMode);
    if (exits === null) return `MINT_RECENTLY_EXITED: the closed positions of ${mint} could not be read, so a re-entry after an exit cannot be ruled out; buy refused.`;
    if (exits.loss) return `MINT_RECENTLY_EXITED: ${mint} was closed at a loss (position ${exits.loss.positionId}, ${(exits.loss.realizedLamports / 1e9).toFixed(6)} SOL); this mint is not bought again.`;
    if (!exits.lastExit) return null;
    const ageMs = now - exits.lastExit.exitedAt;
    if (ageMs >= MINT_REENTRY_BLOCK_MS) return null; // a missing or future close time (NaN, negative age) stays blocked
    const until = Number.isFinite(exits.lastExit.exitedAt) ? new Date(exits.lastExit.exitedAt + MINT_REENTRY_BLOCK_MS).toISOString() : 'an unknown time (the close time is unreadable)';
    const ago = Number.isFinite(ageMs) ? `${(Math.max(0, ageMs) / 3_600_000).toFixed(1)} h ago` : 'at an unreadable time';
    return `MINT_RECENTLY_EXITED: ${mint} was closed ${ago} (position ${exits.lastExit.positionId}); it can be bought again after ${until}, 24 h after the exit.`;
  }

  // Authoritative Central Execution Entrypoint
  /** The one entry for every trade. S209: a span of its own (a child of the auto candidate's when auto started it, else the root of a manual trade's trace). */
  public executeTrade(req: ExecuteTradeRequest): Promise<ExecutionResponse> {
    return traced('trade.execute', () => this.executeTradeUntraced(req), { 'apex.mode': this.executionMode });
  }

  private async executeTradeUntraced(req: ExecuteTradeRequest): Promise<ExecutionResponse> {
    const correlationId = `exec-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const now = Date.now();
    this.recordMarketEvent();

    if (this.haltReason) {
      return { success: false, lifecycleState: 'RISK_REJECTED', executionMode: this.executionMode, error: `TRADING_HALTED: ${this.haltReason}`, correlationId };
    }

    // S185: read-only mode has no LIVE; a trade that somehow arrives in LIVE is refused before any gate runs.
    if (isReadOnly() && this.executionMode === 'LIVE') {
      return { success: false, lifecycleState: 'RISK_REJECTED', executionMode: this.executionMode, error: 'READ_ONLY: APEX_READ_ONLY=true; a LIVE trade is refused', correlationId };
    }

    if (req.executionMode && req.executionMode !== this.executionMode) {
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: this.executionMode,
        error: `MODE_CHANGED: the trade was prepared for ${req.executionMode} but the coordinator is now ${this.executionMode}; refused rather than run in the other mode`,
        correlationId,
      };
    }

    workstationDb.logJournal('TRADE_REQUEST_RECEIVED', correlationId, this.executionMode, {
      ...req,
      executionMode: this.executionMode,
    });

    // Invariant: If an eligibility report is provided, its mint must match the trade mint exactly
    if (req.eligibilityReport && req.eligibilityReport.mint !== req.mint) {
      return {
        success: false,
        lifecycleState: 'FILTER_REJECTED',
        executionMode: this.executionMode,
        error: `ELIGIBILITY_MINT_MISMATCH: Provided eligibility report mint ${req.eligibilityReport.mint} does not match trade request mint ${req.mint}`,
        correlationId,
      };
    }

    if (this.executionMode === 'LIVE') {
      if (!isLiveApprovedProvenance(req.provenance)) {
        workstationDb.logJournal('TRADE_REJECTED_PROVENANCE_VIOLATION', correlationId, 'LIVE', {
          reason: 'PROVENANCE_VIOLATION',
          provenance: req.provenance,
          message: `Live execution rejected: signal provenance '${req.provenance}' is not permitted for live mainnet trades.`,
        });
        return {
          success: false,
          lifecycleState: 'RISK_REJECTED',
          executionMode: 'LIVE',
          error: `PROVENANCE_VIOLATION: Live trading requires LIVE_PUMP_STREAM, REAL_ONCHAIN, PUMP_HTTP_API, REAL_SOCIAL, COPY_TRADE, or MANUAL_OPERATOR provenance. Observed: '${req.provenance}'.`,
          correlationId,
        };
      }
    }

    // The risk engine's signal-age limit only means something if the timestamp is the SOURCE event's. LIVE never defaults it to "now"
    // (or to the market-data fetch time, which is also "now"): a caller that cannot say when the signal happened is refused.
    if (this.executionMode === 'LIVE' && !(Number.isFinite(req.signalTimestamp) && (req.signalTimestamp as number) > 0 && (req.signalTimestamp as number) <= now + 5_000)) {
      workstationDb.logJournal('TRADE_RISK_REJECTED', correlationId, 'LIVE', { reason: 'MISSING_SIGNAL_TIMESTAMP', signalTimestamp: req.signalTimestamp ?? null });
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: 'MISSING_SIGNAL_TIMESTAMP: LIVE trades must carry the time of the signal that triggered them (not in the future); it is never defaulted to now.',
        correlationId,
      };
    }

    const openPositions = workstationDb.loadPositions(this.executionMode, 'ACTIVE');
    const totalExposureSol = openPositions.reduce((acc, p) => acc + p.costBasisLamports / 1e9, 0);

    // =========================================================================
    // BRANCH A: PAPER EXECUTION
    // =========================================================================
    if (this.executionMode === 'PAPER') {
      const evaluated = await this.evaluatePaperBuy(req, correlationId, now, openPositions, totalExposureSol);
      if ('rejection' in evaluated) return evaluated.rejection;
      // 3F (R1-9): after the paper gates, so a halt, the kill switch or a loss limit still answers first
      const paperReentry = this.mintReentryRefusal(req.mint, now);
      if (paperReentry) {
        workstationDb.logJournal('TRADE_RISK_REJECTED', correlationId, 'PAPER', { reason: 'MINT_RECENTLY_EXITED', mint: req.mint, message: paperReentry });
        return { success: false, lifecycleState: 'RISK_REJECTED', executionMode: 'PAPER', error: paperReentry, correlationId };
      }
      const { quotePriceSol, paperEligibility, paperTip, maxPaperOrderSol, curveState } = evaluated;

      // Q7: quote the fill from the curve that was just read. A quote that cannot be made (curve nearly complete, order larger than the
      // curve holds) is a refusal, not a reason to fall back to the flat model.
      let curveQuote: ReturnType<typeof PumpCurveService.calculateBuyQuote> | undefined;
      if (curveState) {
        try {
          curveQuote = PumpCurveService.calculateBuyQuote({ state: curveState, amountSol: req.amountSol, slippageBps: req.slippageBps || 800, jitoTipSol: paperTip.tipSol, executionMode: 'PAPER' });
        } catch (e: any) {
          return { success: false, lifecycleState: 'RISK_REJECTED', executionMode: 'PAPER', error: `PAPER_QUOTE_FAILED: ${e.message}`, correlationId };
        }
      }

      const paperRes = paperEngine.executePaperBuy({
        mint: req.mint,
        symbol: req.symbol,
        name: req.name,
        amountSol: req.amountSol,
        currentPriceSol: quotePriceSol,
        slippageBps: req.slippageBps || 800,
        jitoTipSol: paperTip.tipSol,
        liquidityUsd: req.liquidityUsd,
        curveQuote,
        tokenDecimals: curveState?.tokenDecimals,
      });

      if (!paperRes.success) {
        return {
          success: false,
          lifecycleState: 'SUBMIT_FAILED',
          executionMode: 'PAPER',
          error: paperRes.error,
          correlationId,
        };
      }

      riskEngine.recordTradeSuccess(req.mint);

      const gates = {
        ...paperEligibility.gates,
        capitalCeiling: { maxOrderSol: maxPaperOrderSol, orderSol: req.amountSol, passed: true },
        risk: { approved: true, tipLamports: paperTip.tipLamports, tipPolicy: paperTip.policyReason },
        pricing: paperRes.pricing,
      };
      workstationDb.logJournal('PAPER_FILL_GATES', correlationId, 'PAPER', { mint: req.mint, orderId: paperRes.paperOrderId, gates });

      return {
        success: true,
        gates,
        lifecycleState: 'CONFIRMED',
        positionId: paperRes.paperOrderId,
        txSignature: paperRes.paperOrderId,
        fillPriceSol: paperRes.fillPriceSol,
        quotePriceSol: curveQuote?.executionPriceSol,
        tokensReceived: paperRes.tokensReceived,
        executionMode: 'PAPER',
        feesPaidLamports: paperRes.networkFeeLamports + paperRes.jitoTipLamports,
        correlationId,
      };
    }

    // =========================================================================
    // BRANCH B: LIVE EXECUTION (Real Solana Mainnet On-Chain)
    // =========================================================================
    if (!this.isLiveTradingArmed || localSigner.getStatus() !== 'READY') {
      return {
        success: false,
        lifecycleState: 'SIGN_FAILED',
        executionMode: 'LIVE',
        error: 'Live trading is not armed or signer is unavailable',
        correlationId,
      };
    }
    try {
      assertSendClusterAllowed();
    } catch (err: any) {
      return { success: false, lifecycleState: 'RISK_REJECTED', executionMode: 'LIVE', error: err.message, correlationId };
    }
    const notReady = this.liveBuyReadinessProblems();
    if (notReady.length > 0) {
      const error = `LIVE_NOT_READY: ${notReady.join('; ')}; the buy is refused (exits are not affected)`;
      workstationDb.logJournal('TRADE_RISK_REJECTED', correlationId, 'LIVE', { reason: 'LIVE_NOT_READY', problems: notReady });
      return { success: false, lifecycleState: 'RISK_REJECTED', executionMode: 'LIVE', error, correlationId };
    }

    let mintPubkey: PublicKey;
    try {
      mintPubkey = new PublicKey(req.mint);
    } catch {
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: `Invalid Solana mint public key: ${req.mint}`,
        correlationId,
      };
    }

    // 1. Fetch real on-chain Pump bonding curve market state (NEVER use fallback price)
    const marketState = await PumpCurveService.fetchPumpMarketState({
      connection: this.connection,
      mint: mintPubkey,
      executionMode: 'LIVE',
    });
    if (!marketState) {
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: 'MARKET_DATA_UNAVAILABLE: Could not fetch real Pump.fun bonding curve from Solana RPC. Live execution rejected.',
        correlationId,
      };
    }

    if (marketState.complete) {
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: 'BONDING_CURVE_MIGRATED: Token has graduated from bonding curve. Direct Pump.fun trade rejected.',
        correlationId,
      };
    }

    // P4.3 (R1-57): the authoritative curve-progress cap, on this fresh read, for every caller (auto, callout, manual)
    const liveProgressPct = curveProgressPctOfState(marketState);
    // Review 2026-10-24, finding 8: a LIVE buy needs a known progress. With the token reserves unreadable the cap cannot be
    // checked, so the buy is refused (fail closed). PAPER and SHADOW still let an unknown progress through (see curveProgressCap.ts).
    if (liveProgressPct === null) {
      const error = curveProgressUnreadable(marketState)
        ? 'CURVE_PROGRESS_UNREADABLE: the bonding curve\'s token reserves could not be read (SOL reserves did), so its progress is unknown; LIVE buy refused'
        : 'CURVE_PROGRESS_UNREADABLE: the bonding curve state carries no readable reserves, so its progress is unknown; LIVE buy refused';
      workstationDb.logJournal('TRADE_FILTER_REJECTED', correlationId, 'LIVE', { reason: error, curveProgressPct: null });
      return { success: false, lifecycleState: 'RISK_REJECTED', executionMode: 'LIVE', error, correlationId };
    }
    if (isCurveTooFar(liveProgressPct)) {
      const error = curveTooFarReason('CURVE_PROGRESS_TOO_HIGH', liveProgressPct);
      workstationDb.logJournal('TRADE_FILTER_REJECTED', correlationId, 'LIVE', { reason: error, curveProgressPct: liveProgressPct });
      return { success: false, lifecycleState: 'FILTER_REJECTED', executionMode: 'LIVE', error, correlationId };
    }

    // 2. Authoritative Token Eligibility Verification (Fail-Closed in LIVE mode)
    if (req.eligibilityReport && req.eligibilityReport.mint !== req.mint) {
      return {
        success: false,
        lifecycleState: 'FILTER_REJECTED',
        executionMode: 'LIVE',
        error: `ELIGIBILITY_MINT_MISMATCH: Provided eligibility report mint ${req.eligibilityReport.mint} does not match trade request mint ${req.mint}`,
        correlationId,
      };
    }

    let eligibility = req.eligibilityReport;
    const needsHolderVerification = !eligibility || eligibility.checks.some(
      (c) => (c.ruleId === 'TOP_10_CONCENTRATION' || c.ruleId === 'MAX_CREATOR_EXPOSURE') && c.status === 'UNKNOWN'
    );

    if (needsHolderVerification) {
      let holderDist: Awaited<ReturnType<typeof fetchTokenHolderDistribution>> | null = null;
      try {
        holderDist = await fetchTokenHolderDistribution(
          this.connection,
          mintPubkey,
          marketState.creator,
          marketState.bondingCurve
        );
      } catch (err: any) {
        Logger.warn(`Could not fetch token holder distribution for ${req.mint}: ${err.message}`);
      }

      // C3: the liquidity gate needs the SOL/USD price. A missing or stale price fails closed in LIVE.
      let liveSolUsd: number;
      try {
        liveSolUsd = solPriceService.requireFreshPrice();
      } catch (e: any) {
        return {
          success: false,
          lifecycleState: 'RISK_REJECTED',
          executionMode: 'LIVE',
          error: e.message,
          correlationId,
        };
      }

      eligibility = EligibilityFilter.evaluate(
        this.eligibilityInputFromMarket(req, marketState, holderDist, (Number(marketState.realSolReserves) / 1e9) * liveSolUsd * 2),
        true
      );
    }

    const verdict = traced('gate.eligibility', () => this.eligibilityVerdict(eligibility!, now, 'LIVE', correlationId), { 'apex.mode': 'LIVE' }); // set above whenever it was missing
    if (verdict) return verdict;

    // Q16: one open LIVE row per mint. A second buy over the same token account leaves two rows against one balance (the N3 adoption and the
    // N5 zero-balance check each compare one row with the whole account), and the risk engine's DUPLICATE_MINT is only a 30 s cooldown.
    if (openPositions.some((p) => p.mint === req.mint)) {
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: `POSITION_ALREADY_OPEN: an open LIVE position in ${req.mint} exists; close it before buying the same mint again.`,
        correlationId,
      };
    }

    // 3. Pre-Trade Capital Sizing (B12): spendable bankroll and 10% ceiling check
    const rawWalletBalance = this.realWalletBalanceSol ?? 0;
    const spendable = CapitalSizer.calculateSpendableBankroll(rawWalletBalance, 0.015, this.inFlightReservedSol);

    if (spendable <= 0) {
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: `INSUFFICIENT_SPENDABLE_BANKROLL: Spendable bankroll is ${spendable.toFixed(4)} SOL after reserve (0.015 SOL) and in-flight orders (${this.inFlightReservedSol.toFixed(4)} SOL).`,
        correlationId,
      };
    }

    // Pre-trade sizing: trade size must not exceed 10% of spendable bankroll (B12)
    const maxAllowedOrderSol = Number((spendable * 0.10).toFixed(6));
    if (req.amountSol > maxAllowedOrderSol + 0.000001) {
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: `EXCEEDS_CAPITAL_CEILING: Trade size ${req.amountSol} SOL exceeds 10% spendable bankroll ceiling (${maxAllowedOrderSol} SOL).`,
        correlationId,
      };
    }

    // 4. Resolve dynamic Jito tip from live floor telemetry and execution policy
    const tipFloor = await this.jitoTransport.getTipFloorLamports();
    const resolvedTip = this.resolveLiveTip({
      tipFloorLamports: tipFloor,
      tradeAmountSol: req.amountSol,
      explicitTipSol: req.jitoTipSol,
    });

    // 5. Compute accurate mathematical trade quote with LIVE dynamic fee enforcement
    let quote: TradeQuote;
    try {
      quote = PumpCurveService.calculateBuyQuote({
        state: marketState,
        amountSol: req.amountSol,
        slippageBps: req.slippageBps || 800,
        jitoTipSol: resolvedTip.tipSol,
        priorityFeeLamports: Math.round(executionConfig.getConfig().priorityFeeMicrolamports * 0.25),
        executionMode: 'LIVE',
      });
    } catch (quoteErr: any) {
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: `QUOTE_FAILED: ${quoteErr.message}`,
        correlationId,
      };
    }

    // N13: reserve the worst case the transaction can spend, not the nominal order: the buy instruction may pull up to maxInputLamports
    // (the slippage headroom, about 8% over the order) and the first buy of a mint also pays rent for the new token account.
    // S6: the wallet's first pump buy also pays the (never refunded) rent of its volume accumulator account; later buys do not.
    // P3.1 (R1-14): read before requiredSol, so the reserve check and the reservation include it too.
    const accumulatorRentLamports = await this.unrefundedFirstBuyRentLamports();
    const worstCaseOrderSol = Math.max(req.amountSol, Number(quote.maxInputLamports) / 1e9);
    const requiredSol = worstCaseOrderSol + (CapitalSizer.SPL_TOKEN_ACCOUNT_RENT_LAMPORTS + accumulatorRentLamports) / 1e9 + (quote.expectedJitoTipLamports + quote.expectedPriorityFeeLamports + 5000) / 1e9;

    // Q51: count and exposure are read now, not from the snapshot taken before the awaits above. There is no await from here to the
    // reservation below, so the reserve check, the risk check and the reservation all see the same rows.
    const freshOpen = workstationDb.loadPositions(this.executionMode, 'ACTIVE');
    // 3B (P3.2, R1-4): LIVE buys sent earlier and still unresolved (UNCONFIRMED, or landed with an unread fill) can become positions any
    // moment. They hold a slot and their worst-case SOL like a buy in flight here does, until reconciliation or orphan recovery settles them.
    const unresolved = this.getUnresolvedLiveBuys({ activeLive: freshOpen });
    if (unresolved === null) {
      workstationDb.logJournal('TRADE_RISK_REJECTED', correlationId, 'LIVE', { reason: 'UNRESOLVED_BUYS_UNREADABLE', mint: req.mint });
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: 'UNRESOLVED_BUY: the ledger of unresolved LIVE buys could not be read, so their slots and SOL cannot be counted; buy refused.',
        correlationId,
      };
    }
    const reservedSol = this.inFlightReservedSol + unresolved.reservedSol;

    // Check balance concurrency reservation
    if (rawWalletBalance - reservedSol - requiredSol < 0.015) {
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: `INSUFFICIENT_FUNDS_CONCURRENCY: Wallet balance (${rawWalletBalance.toFixed(4)} SOL) minus in-flight reservations (${this.inFlightReservedSol.toFixed(4)} SOL) and unresolved buys (${unresolved.reservedSol.toFixed(4)} SOL) cannot cover required ${requiredSol.toFixed(4)} SOL plus 0.015 SOL reserve.`,
        correlationId,
      };
    }

    // C7b: an entry whose round-trip execution cost (both tips, both base+priority fees, pump fees both sides)
    // exceeds 20% of the order cannot realistically be profitable. The size is never rounded up to make it pass.
    // S6: accumulatorRentLamports (read above) is part of the round trip too.
    // R8-6: the exit ladder sells up to EXIT_LADDER_SELL_COUNT times (TP1, TP2, then the trailing or hard stop), each with its own tip,
    // base fee and priority fee; the pump fee is a share of what is sold, so it is the same in total however the sale is split.
    const roundTripCostLamports = ExecutionCoordinator.ladderRoundTripCostLamports({
      buyTipLamports: quote.expectedJitoTipLamports,
      sellTipLamports: resolvedTip.tipLamports,
      priorityFeeLamports: quote.expectedPriorityFeeLamports,
      buyProtocolFeeLamports: quote.protocolFeeLamports,
      buyCreatorFeeLamports: quote.creatorFeeLamports,
      nonRefundableRentLamports: accumulatorRentLamports,
    });
    if (roundTripCostLamports > MAX_ROUND_TRIP_COST_FRACTION * req.amountSol * 1e9) {
      workstationDb.logJournal('TRADE_RISK_REJECTED', correlationId, 'LIVE', {
        reason: 'EXPECTED_EDGE_BELOW_EXECUTION_COST',
        roundTripCostLamports,
        orderLamports: Math.round(req.amountSol * 1e9),
      });
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: `EXPECTED_EDGE_BELOW_EXECUTION_COST: Round-trip cost ${roundTripCostLamports} lamports exceeds ${MAX_ROUND_TRIP_COST_FRACTION * 100}% of the ${req.amountSol} SOL order.${accumulatorRentLamports > 0 ? ` It includes ${accumulatorRentLamports} lamports of one-time pump account rent this wallet has not paid yet; a larger first buy (about ${(Math.ceil(roundTripCostLamports / MAX_ROUND_TRIP_COST_FRACTION / 1e6) / 1e3).toFixed(3)} SOL) pays it once, after which smaller buys pass.` : ''}`,
        correlationId,
      };
    }

    // Q51: count and exposure include the buys of other mints that are in flight (not positions yet) and (3B) the unresolved ones.
    const freshExposureSol = freshOpen.reduce((acc, p) => acc + p.costBasisLamports / 1e9, 0) + reservedSol;
    const riskDecision = traced('risk.evaluateOrder', () => riskEngine.evaluateOrder({
      mint: req.mint,
      orderSizeSol: req.amountSol,
      expectedPriceSol: quote.executionPriceSol,
      slippageBps: quote.slippageBps,
      estimatedPriceImpactBps: quote.estimatedPriceImpactBps,
      estimatedFeeLamports: quote.expectedPriorityFeeLamports + 5000,
      jitoTipLamports: quote.expectedJitoTipLamports,
      signalTimestamp: req.signalTimestamp as number,
      marketDataTimestamp: marketState.marketDataTimestamp,
      // R3: adopted wallet dust is not a position the app chose to open; it must not fill the position cap forever.
      currentOpenPositionsCount: freshOpen.filter((p) => !isRecoveredPosition(p)).length + this.inFlightBuyMints.size + unresolved.mints.length,
      currentTotalExposureSol: freshExposureSol,
      // N12: the risk engine applies the minimum reserve itself, so it gets the balance net of in-flight orders (3B: and unresolved buys) only. `spendable` already
      // has the reserve and the in-flight amount taken off; passing it (minus in-flight again) charged both twice. Rent held in token accounts
      // is not in getBalance, so it is not subtracted either.
      walletSpendableSol: Math.max(0, rawWalletBalance - reservedSol),
      executionMode: 'LIVE',
    }));

    // R3-28: the risk engine checked the signal and market-data ages once, here. Several awaits follow before the send (snapshot,
    // build with a blockhash read, the optional blockhash check, signing, the cluster check), so the same limits become a send deadline
    // that the pre-send re-check and the send itself enforce.
    const riskLimits = riskEngine.getLimits();
    const buySendDeadline = Math.min(
      (req.signalTimestamp as number) + riskLimits.maxSignalAgeMs,
      marketState.marketDataTimestamp + riskLimits.maxDataAgeMs
    );

    if (!riskDecision.approved) {
      workstationDb.logJournal('TRADE_RISK_REJECTED', correlationId, 'LIVE', {
        reason: riskDecision.reasonCode,
        message: riskDecision.message,
        quote,
      });
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: `${riskDecision.reasonCode}: ${riskDecision.message}`,
        correlationId,
      };
    }

    // Cross-request dedupe: only one LIVE buy per mint may be in flight. The per-mint cooldown is only recorded
    // after a fill, so two concurrent requests (double click, WS plus HTTP, auto-snipe plus operator) could both pass it.
    // Check and add run in the same synchronous block as the reservation, so there is no await between them.
    if (this.inFlightBuyMints.has(req.mint)) {
      workstationDb.logJournal('TRADE_REJECTED_DUPLICATE_IN_FLIGHT', correlationId, 'LIVE', { mint: req.mint });
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: `DUPLICATE_MINT: A buy for ${req.mint} is already in flight.`,
        correlationId,
      };
    }
    // N4: a buy of this mint that was sent and is still unresolved may become a position any moment; a second buy now would double the exposure.
    if (workstationDb.hasUnresolvedLiveBuy(req.mint)) {
      workstationDb.logJournal('TRADE_REJECTED_UNRESOLVED_BUY', correlationId, 'LIVE', { mint: req.mint });
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: `UNRESOLVED_BUY: an earlier buy of ${req.mint} was sent and is not reconciled yet (or the check could not read the database); waiting for it before buying again.`,
        correlationId,
      };
    }
    // P3.1 (R1-7): the Q16 check above used the positions read before the awaits; orphan recovery (or another path) may have saved a row
    // for this mint since. freshOpen was read with no await before this point, so this check and the reservation below see the same rows.
    if (freshOpen.some((p) => p.mint === req.mint)) {
      workstationDb.logJournal('TRADE_RISK_REJECTED', correlationId, 'LIVE', { reason: 'POSITION_ALREADY_OPEN', mint: req.mint, stage: 'reservation' });
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: `POSITION_ALREADY_OPEN: an open LIVE position in ${req.mint} exists; close it before buying the same mint again.`,
        correlationId,
      };
    }
    // 3F (R1-9): no re-entry into a mint closed in the last 24 h, and none ever after a loss. Read from the positions table, for manual
    // and auto buys alike, so the auto controller's setMode (which clears its per-session attempted set), a re-arm or a restart cannot clear
    // it. Here, after the risk check (a halt, the kill switch or the loss latch answers first) and with no await before the reservation, so a
    // close written during the awaits above is seen.
    const reentry = this.mintReentryRefusal(req.mint, Date.now());
    if (reentry) {
      workstationDb.logJournal('TRADE_RISK_REJECTED', correlationId, 'LIVE', { reason: 'MINT_RECENTLY_EXITED', mint: req.mint, message: reentry });
      return { success: false, lifecycleState: 'RISK_REJECTED', executionMode: 'LIVE', error: reentry, correlationId };
    }
    this.inFlightBuyMints.add(req.mint);
    const stopSeqAtGate = this.emergencyStopSeq; // late buy: a panic or kill after this point sells what this buy opens
    let buySettled!: () => void;
    this.liveBuysInFlight.set(req.mint, new Promise<void>((r) => { buySettled = r; })); // waitForBuysInFlight awaits it

    // Acquire in-flight balance reservation
    this.inFlightReservedSol += requiredSol;
    try {
      // 4. Capture Pre-Trade Balances for real reconciliation
      const buyer = localSigner.getPublicKey();
      const preSnapshot = await TradeReconciler.capturePreTradeSnapshot(
        this.connection,
        buyer,
        mintPubkey,
        marketState.tokenProgram,
        'LIVE'
      );

      const associatedUser = PumpCurveService.getAssociatedTokenAddress(
        mintPubkey,
        buyer,
        marketState.tokenProgram
      );

      const buyParams: PumpBuyParams = {
        buyer,
        mint: mintPubkey,
        bondingCurve: marketState.bondingCurve,
        associatedBondingCurve: marketState.associatedBondingCurve,
        associatedUser,
        creator: marketState.creator,
        feeRecipient: marketState.feeRecipient,
        buybackFeeRecipient: marketState.buybackFeeRecipient,
        quoteMint: marketState.quoteMint,
        tokenProgram: marketState.tokenProgram,
        quoteTokenProgram: marketState.quoteTokenProgram,
        amountTokens: BigInt(quote.tokenAmountRaw),
        maxSolCostLamports: BigInt(quote.maxInputLamports),
        computeUnits: 250000,
        priorityFeeMicroLamports: executionConfig.getConfig().priorityFeeMicrolamports,
        jitoTipLamports: BigInt(resolvedTip.tipLamports),
        jitoTipAccount: executionConfig.getJitoTipAccountPublicKey(),
      };

      // 5. Build, sign, and submit real Solana transaction
      const v0Tx = await traced('tx.build', () => txBuilder.buildBuyTransaction(this.connection, buyParams), { 'apex.side': 'BUY' });
      // S210 (opt-in, APEX_VERIFY_BLOCKHASH=true): a second, independent devnet RPC must know this order's blockhash. A buy that cannot be checked is refused.
      const bhBuy = await this.blockhashProblem(v0Tx, 'BUY');
      if (bhBuy) {
        workstationDb.logJournal('CLUSTER_GUARD_BLOCK', correlationId, 'LIVE', { side: 'BUY', mint: req.mint, error: bhBuy });
        return { success: false, lifecycleState: 'RISK_REJECTED', executionMode: 'LIVE', error: `CLUSTER_GUARD: ${bhBuy}; nothing was signed or sent.`, correlationId };
      }
      await traced('tx.sign', () => localSigner.signTransaction(v0Tx), { 'apex.side': 'BUY' });

      // Q17: risk approval was several awaits ago (curve read, holder lookup, tip floor, blockhash, snapshot, sign). Disarm, a halt or the
      // kill switch may have happened in between; nothing is sent after any of them.
      // P3.1 (R1-0): the per-buy readiness checks run again here, for the same reason.
      const notReadyAtSend = this.liveBuyReadinessProblems();
      const staleAtSend = !(Date.now() <= buySendDeadline); // R3-28 (a NaN deadline is stale too)
      if (!this.isLiveTradingArmed || this.executionMode !== 'LIVE' || this.haltReason || riskEngine.isKillSwitchActive() || notReadyAtSend.length > 0 || staleAtSend) {
        const why = !this.isLiveTradingArmed || this.executionMode !== 'LIVE' ? 'live trading was disarmed' : this.haltReason ? `trading was halted (${this.haltReason})` : riskEngine.isKillSwitchActive() ? 'the kill switch was activated' : notReadyAtSend.length > 0 ? `live readiness failed (${notReadyAtSend.join('; ')})` : `the signal or its market data went stale before the send (limits ${riskLimits.maxSignalAgeMs} ms and ${riskLimits.maxDataAgeMs} ms)`;
        workstationDb.logJournal('TRADE_REVOKED_BEFORE_SEND', correlationId, 'LIVE', { mint: req.mint, reason: why });
        return {
          success: false,
          lifecycleState: 'RISK_REJECTED',
          executionMode: 'LIVE',
          error: `ENTRY_REVOKED: ${why} after the order was approved; nothing was sent.`,
          correlationId,
        };
      }

      // The tip transfer is an instruction inside the signed transaction, so it is paid on-chain whichever
      // transport lands it (Jito bundle or the RPC fallback). Accounting uses resolvedTip.tipLamports for both.
      // Record order in SQLite
      const clientOrderId = `ord-${correlationId}`;
      workstationDb.saveOrder({
        id: clientOrderId,
        clientOrderId,
        correlationId,
        mint: req.mint,
        symbol: req.symbol,
        side: 'BUY',
        amountLamports: quote.expectedSolAmountLamports,
        expectedTokensRaw: quote.tokenAmountRaw,
        slippageBps: quote.slippageBps,
        status: 'SUBMITTED',
        quoteJson: JSON.stringify(quote, (_key, value) =>
          typeof value === 'bigint' ? value.toString() : value
        ),
        executionMode: 'LIVE',
        createdAt: now,
        updatedAt: now,
      });

      // 5 & 6. Submit transaction with bounded idempotent retry & RPC fallback
      const subRes = await this.submitAndConfirmWithRetry({
        tx: v0Tx,
        orderId: clientOrderId,
        correlationId,
        side: 'BUY',
        mint: req.mint,
        mintPubkey,
        owner: buyer,
        tokenProgram: marketState.tokenProgram,
        preSnapshot,
        jitoTipLamports: resolvedTip.tipLamports,
        buyNotAfter: buySendDeadline,
      });

      if (!subRes.success && subRes.unconfirmed && subRes.signature) {
        // N2: the buy was sent and never seen failing. It can still land after this returns, so it is not "reverted":
        // keep it open for reconciliation and let orphan recovery adopt the tokens (and give them a stop-loss) if it does.
        riskEngine.recordTradeFailure();
        workstationDb.saveTransaction({
          signature: subRes.signature,
          bundleId: subRes.bundleId,
          orderId: clientOrderId,
          correlationId,
          mint: req.mint,
          direction: 'BUY',
          submissionTransport: subRes.transport,
          submissionTime: Date.now(),
          reconciliationState: 'RECONCILIATION_REQUIRED',
          networkFeeLamports: 5000,
          jitoTipLamports: resolvedTip.tipLamports,
          executionMode: 'LIVE',
          error: `UNCONFIRMED: ${subRes.error || 'no confirmation before timeout'}`,
        });
        this.lateBuyWatch.set(subRes.signature, stopSeqAtGate);
        this.scheduleOrphanRecovery();
        return {
          success: false,
          lifecycleState: 'RECONCILIATION_REQUIRED',
          executionMode: 'LIVE',
          txSignature: subRes.signature,
          bundleId: subRes.bundleId,
          error: `UNCONFIRMED: ${subRes.error || 'no confirmation before timeout'}. The transaction was sent and may still land; it is being watched, do not retry the buy.`,
          correlationId,
        };
      }

      if (!subRes.success || !subRes.signature) {
        riskEngine.recordTradeFailure();
        workstationDb.saveTransaction({
          signature: subRes.signature || `failed_${Date.now()}`,
          bundleId: subRes.bundleId,
          orderId: clientOrderId,
          correlationId,
          mint: req.mint,
          direction: 'BUY',
          submissionTransport: subRes.transport,
          submissionTime: Date.now(),
          // P2.1/S262: a buy whose blockhash expired unseen never landed (TIMED_OUT, as submitAndConfirmWithRetry wrote it); it did not fail on chain
          reconciliationState: /^(BLOCKHASH_EXPIRED|RPC_RATE_LIMITED)/.test(subRes.error ?? '') ? 'TIMED_OUT' : 'REVERTED',
          networkFeeLamports: 5000,
          jitoTipLamports: resolvedTip.tipLamports,
          executionMode: 'LIVE',
          error: subRes.error || 'Transaction unconfirmed or dropped across attempts',
        });

        return {
          success: false,
          lifecycleState: subRes.lifecycleState,
          executionMode: 'LIVE',
          txSignature: subRes.signature,
          bundleId: subRes.bundleId,
          error: subRes.error || 'Transaction dropped or expired on Solana',
          correlationId,
        };
      }

      // 7. REAL FILL RECONCILIATION
      // Do not construct position from estimates; verify confirmed on-chain fill
      const reconciliation = await traced('tx.reconcile', () => TradeReconciler.reconcileBuyTransaction(
        this.connection,
        subRes.signature,
        buyer,
        mintPubkey,
        marketState.tokenProgram,
        preSnapshot,
        resolvedTip.tipLamports
      ), { 'apex.side': 'BUY' });

      if (!reconciliation.success || reconciliation.reconciliationState !== 'RECONCILED') {
        riskEngine.recordTradeFailure();
        workstationDb.saveTransaction({
          signature: subRes.signature,
          bundleId: subRes.bundleId,
          orderId: clientOrderId,
          correlationId,
          mint: req.mint,
          direction: 'BUY',
          submissionTransport: subRes.transport,
          submissionTime: Date.now(),
          landingSlot: subRes.slot,
          confirmationTime: Date.now(),
          reconciliationState: 'RECONCILIATION_REQUIRED',
          networkFeeLamports: reconciliation.actualNetworkFeeLamports || 5000,
          jitoTipLamports: resolvedTip.tipLamports,
          executionMode: 'LIVE',
          error: reconciliation.error || 'Token balance increase not verified',
        });
        // The buy landed but its fill is unread: keep retrying so the tokens get a position (and a stop-loss).
        // Any non-RECONCILED outcome (including ERROR): the buy landed, so keep trying to give the tokens a position and a stop-loss.
        this.lateBuyWatch.set(subRes.signature, stopSeqAtGate);
        this.scheduleOrphanRecovery();

        return {
          success: false,
          lifecycleState: 'RECONCILIATION_REQUIRED',
          executionMode: 'LIVE',
          txSignature: subRes.signature,
          bundleId: subRes.bundleId,
          error: `RECONCILIATION FAILED: ${reconciliation.error}. Conflicting live executions blocked.`,
          correlationId,
        };
      }

      // 8. Reconciled Successfully: Persist verified OPEN position
      riskEngine.recordTradeSuccess(req.mint);

      const livePosition: NormalizedPosition = {
        id: subRes.signature,
        mint: req.mint,
        symbol: req.symbol,
        name: req.name,
        tokenDecimals: reconciliation.tokenDecimals,
        baseTokenProgram: marketState.baseTokenProgram.toBase58(),
        tokenQuantityRaw: reconciliation.actualTokensReceivedRaw,
        costBasisLamports: reconciliation.actualSolSpentLamports,
        entryPriceSol: reconciliation.effectiveFillPriceSol,
        currentPriceSol: reconciliation.effectiveFillPriceSol,
        currentValueSol: reconciliation.actualSolSpentLamports / 1e9,
        unrealizedPnLSol: 0,
        unrealizedPnLPct: 0,
        realizedPnLSol: 0,
        entryTxSignature: subRes.signature,
        entrySlot: reconciliation.slot,
        entryTimestamp: Date.now(),
        entryFeeLamports: reconciliation.actualNetworkFeeLamports,
        priorityFeeLamports: quote.expectedPriorityFeeLamports,
        jitoTipLamports: resolvedTip.tipLamports,
        markSource: 'RECONCILED_ON_CHAIN',
        markAgeMs: 0,
        venue: 'PUMP_BONDING_CURVE',
        poolAddress: marketState.bondingCurve.toBase58(),
        executionMode: 'LIVE',
        status: 'OPEN',
        lastUpdatedTimestamp: Date.now(),
        walletPubkey: buyer.toBase58(), // R4-2: the ledger row is bound to the wallet that bought it
      };

      // N11: the tokens are in the wallet. If the database refuses the position the buy must not turn into a "chain error" with an
      // unwatched balance: keep the transaction row open for recovery (it rebuilds the position from chain data) and tell the operator.
      let positionPersisted = true;
      try {
        workstationDb.savePosition(livePosition);
      } catch (err: any) {
        positionPersisted = false;
        Logger.error(`Position write failed after a landed buy ${subRes.signature}: ${err.message}`);
        this.raiseOperatorAlert('POSITION_NOT_PERSISTED', `A buy of ${req.symbol || req.mint} landed (${subRes.signature.slice(0, 8)}) but the database refused the position (${String(err.message).slice(0, 80)}). Orphan recovery retries in the background (every 5 minutes at most, until it succeeds) to rebuild it from chain data; until then it has no stop-loss and LIVE buys are refused. Close it by hand if it stays unresolved.`, subRes.signature);
        this.lateBuyWatch.set(subRes.signature, stopSeqAtGate);
        this.scheduleOrphanRecovery();
      }

      const ledgerWritten = workstationDb.saveTransaction({
        signature: subRes.signature,
        bundleId: subRes.bundleId,
        orderId: clientOrderId,
        correlationId,
        mint: req.mint,
        direction: 'BUY',
        submissionTransport: subRes.transport,
        submissionTime: Date.now(),
        landingSlot: reconciliation.slot,
        confirmationTime: Date.now(),
        reconciliationState: positionPersisted ? 'RECONCILED' : 'RECONCILIATION_REQUIRED',
        networkFeeLamports: reconciliation.actualNetworkFeeLamports,
        jitoTipLamports: resolvedTip.tipLamports,
        executionMode: 'LIVE',
      });
      // 3B (P3.2, R1-38): every LIVE buy journals what it took from the wallet, whoever placed it (auto, a manual route, Telegram), so the
      // DEVNET_LIVE wallet audit can explain it. The whole wallet delta: curve spend, tip, fees, and the rent of the token account and (first
      // buy) the volume accumulator. A position the database refused is journaled by orphan recovery when it rebuilds it, not here.
      if (positionPersisted) this.journalLiveBuySolDelta(livePosition, reconciliation.actualSolSpentLamports, req.source, 'CONFIRMED');
      if (!ledgerWritten) {
        this.raiseOperatorAlert('LEDGER_WRITE_FAILED', `The transaction row for a landed buy (${subRes.signature.slice(0, 8)}) could not be written; the position ${positionPersisted ? 'was saved' : 'was NOT saved either'}.`, subRes.signature);
      }
      try {
        await this.syncRealWalletBalance();
      } catch (err: any) {
        Logger.warn(`Wallet balance sync after a landed buy failed: ${err.message}`); // the buy is done; a stale balance self-corrects on the next sync
      }
      // Late buy: a panic or kill came after this buy passed the gate. The sell starts now and is not awaited, so the buy settles (a
      // panic waiting in waitForBuysInFlight goes on) and a panic close that meets this sell waits for it (EXIT_IN_PROGRESS).
      if (positionPersisted && this.emergencyStopSeq !== stopSeqAtGate) void this.sellLateBuy(livePosition, 'landed after the stop');

      return {
        success: true,
        lifecycleState: 'CONFIRMED',
        positionId: subRes.signature,
        txSignature: subRes.signature,
        bundleId: subRes.bundleId,
        fillPriceSol: reconciliation.effectiveFillPriceSol,
        quotePriceSol: quote.executionPriceSol,
        tokensReceived: reconciliation.tokensReceivedHuman,
        executionMode: 'LIVE',
        feesPaidLamports: reconciliation.actualNetworkFeeLamports + quote.expectedJitoTipLamports,
        correlationId,
      };
    } catch (err: any) {
      riskEngine.recordTradeFailure();
      Logger.error(`LIVE trade exception: ${err.message}`);
      // P1.5 (R1-6, R1-80): an exception after the PENDING row was written (the transaction may have been sent) must not leave that row
      // PENDING and unwatched: it becomes RECONCILIATION_REQUIRED, which orphan recovery re-reads and adopts if the buy landed.
      const pending = workstationDb.loadTransactions(`ord-${correlationId}`).filter((t) => t.direction === 'BUY' && t.reconciliationState === 'PENDING');
      if (pending.length > 0) {
        for (const t of pending) {
          workstationDb.saveTransaction({ ...t, reconciliationState: 'RECONCILIATION_REQUIRED', error: `UNCONFIRMED: exception after the send was prepared: ${err.message}` });
          this.lateBuyWatch.set(t.signature, stopSeqAtGate);
        }
        this.scheduleOrphanRecovery();
        return {
          success: false,
          lifecycleState: 'RECONCILIATION_REQUIRED',
          executionMode: 'LIVE',
          txSignature: pending[0].signature,
          error: `UNCONFIRMED: ${err.message}. The transaction may have been sent; it is being watched, do not retry the buy.`,
          correlationId,
        };
      }
      return {
        success: false,
        lifecycleState: 'CHAIN_ERROR',
        executionMode: 'LIVE',
        error: err.message,
        correlationId,
      };
    } finally {
      // Always release in-flight balance reservation
      this.inFlightReservedSol = Math.max(0, this.inFlightReservedSol - requiredSol);
      this.inFlightBuyMints.delete(req.mint);
      this.liveBuysInFlight.delete(req.mint);
      buySettled();
    }
  }

  // Canonical Close Position supporting partial sells (1-100%) and real proceeds reconciliation
  private haltReason: string | null = null;

  /** G3: halt every buy plus the take-profit and stale exits; protective exits still run (PROTECTIVE_EXIT_REASONS). Used when the wallet balance changes for a reason the journal cannot explain. */
  public haltAll(reason: string): void {
    if (this.haltReason) return;
    this.haltReason = reason;
    // Only the process-wide coordinator persists a halt (it is the only one that restores it); a script or test coordinator must not halt the next real boot.
    if (this.isDefaultSingleton && !workstationDb.logJournal('TRADING_HALTED', 'halt', this.executionMode, { reason })) {
      // R8: the halt holds in memory but will not survive a restart; say so instead of letting the operator assume it will.
      this.raiseOperatorAlert('HALT_NOT_PERSISTED', `The halt could not be written to the database (${reason}). It holds until this process restarts; after a restart trading would not be halted. Fix the database and halt again.`);
    }
    this.raiseOperatorAlert('TRADING_HALTED', `All buys, take-profit and stale exits are halted: ${reason}. Stop-loss, trailing stop, manual close and panic still run; clear it with POST /api/auto/resume {clearHalt:true}.`);
  }

  public clearHalt(): void {
    if (this.haltReason && this.isDefaultSingleton) workstationDb.logJournal('TRADING_HALT_CLEARED', 'halt', this.executionMode, {});
    this.haltReason = null;
    this.clearOperatorAlert('TRADING_HALTED');
    this.clearOperatorAlert('KILL_SWITCH_WAS_ON');
  }

  /** One promise per LIVE buy past its reservation (any caller: auto, manual routes, Telegram); it resolves when the buy has settled. */
  private liveBuysInFlight = new Map<string, Promise<void>>();

  /**
   * Late buy (decision 5, 2026-10-26): how many emergency stops (panic or kill switch, emergencyStop.ts) this process has run. A LIVE buy
   * notes the count when it passes the gate; if it has changed when the buy's position is saved, the buy landed after a stop and is sold
   * at once (sellLateBuy). In memory only: after a restart the kill switch is off and auto is OFF, so a buy adopted then is treated as any
   * other recovered buy.
   */
  private emergencyStopSeq = 0;
  /** Late buy: entry signature -> emergencyStopSeq at its gate, for a buy that returned without a position (orphan recovery adopts it later). */
  private lateBuyWatch = new Map<string, number>();

  /** Called by emergencyStop first, before the kill switch goes on. */
  public noteEmergencyStop(reason: string): void {
    this.emergencyStopSeq++;
    if (this.inFlightBuyMints.size > 0 || this.lateBuyWatch.size > 0) {
      Logger.warn(`[LATE BUY] ${reason}: ${this.inFlightBuyMints.size} LIVE buy(s) in flight and ${this.lateBuyWatch.size} unresolved; any that lands is sold at once`);
    }
  }

  /** Late buy: a position orphan recovery or reconciliation rebuilt from a buy sent before a stop it landed after is sold too. */
  private sellIfLateBuyAdopted(pos: NormalizedPosition): void {
    const seqAtGate = this.lateBuyWatch.get(pos.entryTxSignature ?? pos.id);
    if (seqAtGate === undefined) return;
    this.lateBuyWatch.delete(pos.entryTxSignature ?? pos.id);
    if (pos.executionMode === 'LIVE' && this.emergencyStopSeq !== seqAtGate) void this.sellLateBuy(pos, 'adopted after the stop');
  }

  /**
   * Late buy: sell all of a LIVE position whose buy landed after a panic or kill switch. The normal sell path (closePosition) with the
   * panic's protective reason, so a halt, the kill switch (it blocks buys, not exits) and the dust check do not hold it. One try, and one
   * more after an exit already running on it finishes, as the panic does; a sell that fails leaves the position open with its stop-loss
   * and raises LATE_BUY_NOT_SOLD. Never rejects.
   */
  private async sellLateBuy(pos: NormalizedPosition, how: string): Promise<void> {
    const name = pos.symbol || pos.mint.slice(0, 6);
    workstationDb.logJournal('LATE_BUY_EXIT', pos.id, 'LIVE', { positionId: pos.id, mint: pos.mint, signature: pos.entryTxSignature, how });
    Logger.warn(`[LATE BUY] ${name} (${pos.id.slice(0, 8)}) ${how}: selling 100% now`);
    const close = () => this.closePosition(pos.id, 100, LATE_BUY_EXIT_REASON).catch((e: any) => ({ success: false, pnlSol: 0, error: e?.message || String(e) }));
    try {
      const stillOpen = () => workstationDb.loadPositions(undefined, 'ACTIVE').some((p) => p.id === pos.id);
      let res: { success: boolean; pnlSol: number; error?: string } = await close();
      if (!res.success && /^EXIT_IN_PROGRESS/.test(res.error || '')) {
        await this.waitForPositionExit(pos.id);
        res = stillOpen() ? await close() : { success: true, pnlSol: 0 };
      }
      if (!res.success && !stillOpen()) res = { success: true, pnlSol: 0 }; // another exit (the panic's own close) sold it first
      if (res.success) {
        this.raiseOperatorAlert('LATE_BUY_SOLD', `A LIVE buy of ${name} (${pos.id.slice(0, 8)}) ${how} (panic or kill switch) and was sold at once (PnL ${res.pnlSol.toFixed(6)} SOL).`, pos.id);
      } else {
        this.raiseOperatorAlert('LATE_BUY_NOT_SOLD', `A LIVE buy of ${name} (${pos.id.slice(0, 8)}) ${how} (panic or kill switch); selling it failed (${String(res.error).slice(0, 140)}). It is still open with its stop-loss: run the panic again or close it by hand.`, pos.id);
      }
    } catch (e: any) {
      this.raiseOperatorAlert('LATE_BUY_NOT_SOLD', `A LIVE buy of ${name} (${pos.id.slice(0, 8)}) ${how}; selling it threw (${String(e?.message ?? e).slice(0, 140)}). It is still open: run the panic again or close it by hand.`, pos.id);
    }
  }

  /**
   * The emergency stop waits here before it reads the positions to sell: a LIVE buy already past the risk gate (a manual one included;
   * auto's own buy is awaited by its kill) may still turn into a position. Resolves once no LIVE buy is in flight, or after `timeoutMs`
   * with the mints still in flight. Never rejects.
   */
  public async waitForBuysInFlight(timeoutMs: number): Promise<string[]> {
    const deadline = performance.now() + timeoutMs; // monotonic: a wall clock set back cannot hold the emergency stop (S271 review)
    while (this.liveBuysInFlight.size > 0) {
      const left = deadline - performance.now();
      if (left <= 0) break;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.allSettled([...this.liveBuysInFlight.values()]), new Promise<void>((r) => { timer = setTimeout(r, left); })]);
      clearTimeout(timer);
    }
    return [...this.liveBuysInFlight.keys()];
  }

  /** Q8: true while a LIVE buy is being sent/reconciled or an exit is between its send and its journal row. */
  public hasTradeInFlight(): boolean {
    return this.inFlightReservedSol > 0 || this.exitsInFlight > 0;
  }

  public getHaltReason(): string | null {
    return this.haltReason;
  }

  /**
   * 3B (P3.2, R1-4): LIVE buys that were sent and are not resolved (PENDING or RECONCILIATION_REQUIRED in the ledger), each priced at the
   * worst case it can still take from the wallet. Such a buy can land any moment (orphan recovery then opens its position), so it fills a
   * position slot and holds its SOL until it is resolved; before, an UNCONFIRMED buy stopped counting the moment executeTrade returned.
   * Left out: a row whose buy already has an ACTIVE position (a landed buy whose ledger write failed; the position counts already), and,
   * unless `includeOwnInFlight`, this process's own buys still in executeTrade (they count through inFlightBuyMints and inFlightReservedSol).
   * The worst case is the order's quoted maxInputLamports (or the order amount) plus token-account rent, tip, priority and base fee; a row
   * without a readable quote is priced at the largest order the risk limits allow. It may double-count a buy that landed and already left
   * the wallet; that refuses a buy too many, never one too few. null when the ledger cannot be read: callers refuse (fail closed).
   */
  public getUnresolvedLiveBuys(opts: { includeOwnInFlight?: boolean; activeLive?: Array<{ entryTxSignature?: string }> } = {}): { mints: string[]; reservedSol: number } | null {
    const rows = workstationDb.loadUnresolvedLiveBuys();
    if (rows === null) return null;
    const active = opts.activeLive ?? workstationDb.loadPositions('LIVE', 'ACTIVE');
    const positionSigs = new Set(active.map((p) => p.entryTxSignature));
    const limits = riskEngine.getLimits();
    const mints = new Set<string>();
    let reservedLamports = 0;
    for (const r of rows) {
      if (positionSigs.has(r.signature)) continue;
      if (!opts.includeOwnInFlight && this.inFlightBuyMints.has(r.mint)) continue;
      let quote: { maxInputLamports?: unknown; expectedJitoTipLamports?: unknown; expectedPriorityFeeLamports?: unknown } | null;
      try { quote = r.quoteJson ? JSON.parse(r.quoteJson) : null; } catch { quote = null; }
      const maxInput = Number(quote?.maxInputLamports);
      const worst = quote && Number.isFinite(maxInput) && maxInput > 0
        ? Math.max(maxInput, r.amountLamports ?? 0) + Math.max(Number(quote.expectedJitoTipLamports) || 0, r.jitoTipLamports) + (Number(quote.expectedPriorityFeeLamports) || 0) + 5000
        : Math.max(r.amountLamports ?? 0, limits.maxPositionSol * 1e9) * (1 + limits.maxSlippageBps / 10_000) + limits.maxExecutionCostLamports;
      reservedLamports += worst + CapitalSizer.SPL_TOKEN_ACCOUNT_RENT_LAMPORTS;
      mints.add(r.mint);
    }
    return { mints: [...mints], reservedSol: reservedLamports / 1e9 };
  }

  /**
   * Failed exits, one entry per position AND exit reason (R5-6, R2-5): key `<positionId>|<reason>`. A take-profit that keeps failing no
   * longer widens the slippage of the stop-loss that follows, and its backoff no longer holds the stop-loss or the trailing stop, which
   * keep counters and waits of their own. `count` steps the slippage ladder; `waitMs` is the backoff (0 after a failure that sent nothing
   * and spent no fee, such as a failed simulation).
   */
  private exitFailures = new Map<string, { count: number; nextAttemptAt: number; lastError: string; waitMs?: number; setAtMono?: number }>();

  private static exitFailureKey(positionId: string, reason?: string): string {
    return `${positionId}|${reason ?? ''}`;
  }

  /** The entries for one reason, or (no reason given) every entry of the position. */
  private exitFailureEntries(positionId: string, reason?: string): Array<{ count: number; nextAttemptAt: number; lastError: string; waitMs?: number; setAtMono?: number }> {
    if (reason !== undefined) {
      const f = this.exitFailures.get(ExecutionCoordinator.exitFailureKey(positionId, reason));
      return f ? [f] : [];
    }
    const out: Array<{ count: number; nextAttemptAt: number; lastError: string; waitMs?: number; setAtMono?: number }> = [];
    for (const [k, f] of this.exitFailures) if (k === positionId || k.startsWith(`${positionId}|`)) out.push(f);
    return out;
  }

  private static exitFailurePositionId(key: string): string {
    const bar = key.indexOf('|');
    return bar < 0 ? key : key.slice(0, bar);
  }

  /**
   * Sell slippage for the next attempt of this exit reason on this position: starts at 800 bps and widens after each consecutive failure
   * of that reason (no reason: the widest of the position's reasons, for display).
   * T2: never above MAX_SELL_SLIPPAGE_BPS (default 4000, the last step), so an operator can keep a stop-loss from accepting 40% less.
   */
  public exitSlippageBps(positionId: string, reason?: string): number {
    const n = Math.max(0, ...this.exitFailureEntries(positionId, reason).map((f) => f.count));
    const step = SELL_SLIPPAGE_LADDER_BPS[Math.min(n, SELL_SLIPPAGE_LADDER_BPS.length - 1)];
    return Math.min(step, executionConfig.getConfig().maxSellSlippageBps);
  }

  /** ms until the auto-exit loop may try this exit reason on this position again (0 when free; no reason: the longest wait of any reason). */
  public exitRetryWaitMs(positionId: string, now: number = Date.now(), reason?: string): number {
    return Math.max(0, ...this.exitFailureEntries(positionId, reason).map((f) => {
      // S271 review: never more than the backoff that was set. nextAttemptAt is wall-clock time; set under a clock that was later set back
      // (devnet harness, NTP), it would hold this position's exits, its stop-loss included, for the size of the jump.
      // A3: and a wall clock set back after that never stretches it either: the wait also runs down on the monotonic clock, which ignores
      // wall-clock steps, so the cap alone (which left the full wait on every poll) cannot hold the position past waitMs of real time.
      const left = f.nextAttemptAt - now;
      if (f.waitMs === undefined) return Math.max(0, left);
      const monoLeft = f.setAtMono === undefined ? f.waitMs : Math.ceil(f.waitMs - (performance.now() - f.setAtMono));
      return Math.max(0, Math.min(left, f.waitMs, monoLeft));
    }));
  }

  public getExitFailureCount(positionId: string, reason?: string): number {
    return Math.max(0, ...this.exitFailureEntries(positionId, reason).map((f) => f.count));
  }

  /**
   * Errors that mean no send was attempted (or that an earlier send is still being waited for), so they neither cost fees nor count
   * toward backoff or the EXIT_FAILING alert. Q12: waiting for a pending sell, an undeterminable venue, a missing signer and a zero
   * quantity are not rejected sends; counting them walked the ladder to 4000 bps before the real resend. P1.6: nor are a refusal by the
   * cluster guard, an invalid sell percentage, or anything thrown before the send (closePositionImpl reports those with `notSent`).
   * S245: nor is a sell the RPC rate-limited past every resend (RPC_RATE_LIMITED): it was refused, not priced wrong; it raises EXIT_RATE_LIMITED.
   * R4-10: nor a send the RPC refused with 401/402/403 (RPC_AUTH_REJECTED): nothing was forwarded, and wider slippage cannot help.
   */
  private static isNonAttemptExitError(error?: string): boolean {
    return !error || /^(TRADING_HALTED|EXIT_IN_PROGRESS|DUST_POSITION_EXIT_UNECONOMICAL|Position not found|SELL_PENDING_VERIFICATION|UNKNOWN_TRADING_VENUE|Trading venue for mint|Signer is not configured|Calculated sell quantity is zero|CLUSTER_GUARD|INVALID_SELL_PCT|BALANCE_UNTRUSTED|RPC_RATE_LIMITED|RPC_AUTH_REJECTED)/.test(error) || ExecutionCoordinator.isQuoteFailure(error);
  }

  /**
   * R10: the sell could not even be quoted (fail-closed quote, fee config, market state). Nothing was sent, and widening slippage cannot help.
   * P1.6 (R1-30, N-42): also the quote and pool errors thrown before anything is sent: a math cross-check, a migrated or invalid curve
   * state, every PumpSwap pool error, and a curve read that failed (CURVE_READ_FAILED, which names the reason).
   */
  private static isQuoteFailure(error?: string): boolean {
    return !!error && /^(OFFICIAL_PUMP_QUOTE_FAILED|DYNAMIC_FEE_CALCULATION_FAILED|FEE_RECIPIENT_UNRESOLVED|UNSUPPORTED_QUOTE_MINT|Cannot fetch market state|QUOTE_MATH_DISCREPANCY|BONDING_CURVE_MIGRATED|Invalid curve state|PUMPSWAP_|UNSUPPORTED_PUMPSWAP_QUOTE_MINT|CURVE_READ_FAILED)/.test(error);
  }

  private recordExitOutcome(positionId: string, res: { success: boolean; error?: string; notSent?: boolean }, mode?: string, reason?: string): void {
    const key = ExecutionCoordinator.exitFailureKey(positionId, reason);
    if (res.success) {
      // a sell went through (or a landed one was adopted): every reason of the position starts again at the base step
      for (const k of [...this.exitFailures.keys()]) if (ExecutionCoordinator.exitFailurePositionId(k) === positionId) this.exitFailures.delete(k);
      this.clearOperatorAlert('EXIT_FAILING', positionId);
      this.clearOperatorAlert('EXIT_NO_ROUTE', positionId);
      this.clearOperatorAlert('EXIT_QUOTE_FAILING', positionId);
      this.clearOperatorAlert('EXIT_RATE_LIMITED', positionId);
      this.clearOperatorAlert('EXIT_NO_SIGNER', positionId);
      return;
    }
    if (mode === 'LIVE' && /^Signer is not configured/.test(res.error || '')) {
      // A LIVE exit that cannot be signed sends nothing and costs nothing, so it is no attempt; but the position has no working stop-loss
      // until a signer is back (a locked or missing key, or a read-only server over a database with LIVE rows), and the operator must know.
      this.raiseOperatorAlert('EXIT_NO_SIGNER', `Exit for LIVE position ${positionId.slice(0, 8)} cannot be signed: ${isReadOnly() ? 'this server is read-only (APEX_READ_ONLY=true) and holds no key' : `the signer is ${localSigner.getStatus()}`}. Its stop-loss cannot sell until a signer is loaded; nothing was sent.`, positionId);
    }
    const quoteFailure = ExecutionCoordinator.isQuoteFailure(res.error);
    if (mode === 'LIVE' && /^RPC_RATE_LIMITED/.test(res.error || '')) {
      // S245: no fee was spent and wider slippage cannot help, but an exit the RPC keeps refusing is something an operator must hear about.
      this.raiseOperatorAlert('EXIT_RATE_LIMITED', `Exit for position ${positionId.slice(0, 8)} was refused by the RPC's rate limit after ${SELL_RATE_LIMIT_BACKOFF_MS.length} resends; nothing was sent. Retrying in ${EXIT_RATE_LIMITED_WAIT_MS / 1000}s; set RPC_MAX_REQUESTS_PER_SEC or use a private RPC if this persists.`, positionId);
      // T6: wait before the next try, keeping the failure count (and so the slippage step) as it was. waitMs caps it as A2 caps every
      // exit wait, so a wall clock set back cannot stretch it.
      const prev = this.exitFailures.get(key);
      this.exitFailures.set(key, { count: prev?.count ?? 0, nextAttemptAt: Date.now() + EXIT_RATE_LIMITED_WAIT_MS, lastError: res.error || 'RPC_RATE_LIMITED', waitMs: EXIT_RATE_LIMITED_WAIT_MS, setAtMono: performance.now() });
    }
    if (mode === 'LIVE' && (quoteFailure || (res.notSent && !ExecutionCoordinator.isNonAttemptExitError(res.error)))) {
      // No fee was spent and the ladder must not advance, but a stop-loss that cannot be priced or built is exactly what an operator must hear about.
      this.raiseOperatorAlert('EXIT_QUOTE_FAILING', `Exit for position ${positionId.slice(0, 8)} cannot be quoted or built, so nothing is being sent (${String(res.error).slice(0, 140)}). Retrying every tick; close it manually if this persists.`, positionId);
    }
    if (mode === 'LIVE' && /^(UNKNOWN_TRADING_VENUE|Trading venue for mint)/.test(res.error || '')) {
      // R8-5: no sellable route was found, so nothing was built or sent. The slippage ladder does not move (it is not a price problem), the
      // exit is retried every pass at the step it was at, and the operator hears that this position cannot be sold by the app right now.
      this.raiseOperatorAlert('EXIT_NO_ROUTE', `Exit for LIVE position ${positionId.slice(0, 8)} has no sellable route (${String(res.error).slice(0, 140)}); nothing was sent. Retrying every pass; check the mint and close it by hand if this persists.`, positionId);
    }
    if (mode !== 'LIVE' || res.notSent || ExecutionCoordinator.isNonAttemptExitError(res.error)) return;
    const count = (this.exitFailures.get(key)?.count ?? 0) + 1;
    // R2-5: a failed simulation sent nothing and spent no fee, so it steps the slippage ladder (that is what a slippage breach needs) but
    // sets no backoff; the next pass retries at the wider step. A send that failed did cost a fee and backs off as before.
    const simulationOnly = /^SELL_SIMULATION_FAILED/.test(res.error || '');
    const wait = simulationOnly ? 0 : Math.min(EXIT_RETRY_MAX_MS, EXIT_RETRY_BASE_MS * 2 ** (count - 1));
    this.exitFailures.set(key, { count, nextAttemptAt: Date.now() + wait, lastError: res.error || 'unknown', waitMs: wait, setAtMono: performance.now() });
    if (count >= EXIT_FAILURE_ALERT_AFTER) {
      this.raiseOperatorAlert('EXIT_FAILING', `Exit (${reason ?? 'exit'}) for position ${positionId.slice(0, 8)} failed ${count} times in a row (last: ${res.error}). Retrying ${wait > 0 ? `every ${Math.round(wait / 1000)}s` : 'every pass'} with wider slippage; consider closing manually.`, positionId);
    }
  }

  /** Close (part of) a position, and write the exit to the decision journal (G3). */
  /** S209: the exit pass gets its own span (a trace of its own unless a caller's trace is active). */
  public closePosition(
    positionId: string,
    sellPct: number = 100,
    reason: string = 'Manual Close'
  ): Promise<ClosePositionResult> {
    return traced('exit.close', () => this.closePositionUntraced(positionId, sellPct, reason), { 'apex.reason': reason, 'apex.sellPct': sellPct });
  }

  private async closePositionUntraced(
    positionId: string,
    sellPct: number = 100,
    reason: string = 'Manual Close'
  ): Promise<ClosePositionResult> {
    // A halt stops entries and discretionary exits. It never stops the exits that protect the wallet: stop-loss, trailing stop,
    // an operator's manual close and panic liquidation (a halt that froze a losing position would be the opposite of its purpose).
    if (this.haltReason && !PROTECTIVE_EXIT_REASONS.test(reason)) {
      return { success: false, pnlSol: 0, error: `TRADING_HALTED: ${this.haltReason}` };
    }
    const before = workstationDb.loadPositions().find((p) => p.id === positionId);
    // Q8: an exit is "in flight" until its fill is journaled, so the wallet audit does not look at the balance in between.
    this.exitsInFlight++;
    try {
      const res = await this.closePositionImpl(positionId, sellPct, reason);
      this.recordExitOutcome(positionId, res, before?.executionMode, reason);
      if (res.success && before) {
        workstationDb.logDecision({
          autoMode: 'n/a',
          mint: before.mint,
          symbol: before.symbol,
          source: 'EXIT_ENGINE',
          stage: 'exit',
          outcome: 'EXITED',
          reason,
          inputs: { sellPct, mode: before.executionMode, pnlSol: res.pnlSol },
          positionId,
          // Q8: only a LIVE exit moves the wallet; a PAPER exit journaled a delta the balance never showed, which the wallet audit read as a drain.
          // S2: and only what THIS call actually moved. Adopting an earlier sell, closing an empty wallet without a send, and a sell clamped
          // to a smaller wallet balance all used to journal the pre-clamp cost basis as an inflow that never arrived (a phantom credit that
          // the DEVNET_LIVE audit then read as an unexplained change). closePositionImpl reports the SOL it moved; a LIVE success that
          // reports none journals 0, which fails safe (any real inflow it missed shows up as unexplained and halts).
          solDelta: before.executionMode === 'LIVE' ? (res.solMoved ?? 0) : undefined,
        });
      }
      return res;
    } finally {
      this.exitsInFlight--;
    }
  }

  private async closePositionImpl(
    positionId: string,
    sellPct: number,
    reason: string
  ): Promise<ClosePositionResult> {
    if (this.inFlightPositionExits.has(positionId)) {
      return { success: false, pnlSol: 0, error: 'EXIT_IN_PROGRESS: An exit transaction for this position is already in progress.' };
    }
    this.inFlightPositionExits.add(positionId);
    let exitDone!: () => void;
    this.positionExitDone.set(positionId, new Promise<void>((r) => { exitDone = r; })); // P1.7: what waitForPositionExit awaits
    let claimed = false;
    let sendStarted = false;
    const exitClaimOwner = newExitClaimOwner();

    try {
      const positions = workstationDb.loadPositions();
      let target = positions.find((p) => p.id === positionId && (p.status === 'OPEN' || p.status === 'PARTIALLY_CLOSED'));

      if (!target) {
        return { success: false, pnlSol: 0, error: 'Position not found or already closed' };
      }

      // N-44: the share is computed in basis points, so a fractional percentage (33.5) sells floor(raw * 3350 / 10000) instead of
      // throwing a BigInt RangeError (the HTTP schemas take integers only; this covers every other caller).
      if (typeof sellPct !== 'number' || !Number.isFinite(sellPct)) {
        return { success: false, pnlSol: 0, error: `INVALID_SELL_PCT: ${String(sellPct)} is not a number between 1 and 100`, notSent: true };
      }
      const sellBps = Math.round(Math.min(100, Math.max(1, sellPct)) * 100);
      const safeSellPct = sellBps / 100;
      const fraction = sellBps / 10_000;
      const closeAta = sellBps >= 10_000;

      const tipFloor = await this.jitoTransport.getTipFloorLamports();
      const resolvedTip = this.resolveLiveTip({
        tipFloorLamports: tipFloor,
        tradeAmountSol: (target.currentValueSol || 0.05) * fraction,
      });

      // Check economic viability of exits in LIVE mode: calculate net proceeds residualValue + (closeAta ? 0.00203928 : 0) - fees (B19)
      if (target.executionMode === 'LIVE') {
        const tokenDecimals = target.tokenDecimals ?? 6;
        const tokenQty = Number(target.tokenQuantityRaw || 0) / Math.pow(10, tokenDecimals);
        const residualValue = ((target.currentValueSol !== undefined && target.currentValueSol !== null && target.currentValueSol > 0)
          ? target.currentValueSol
          : (tokenQty * (target.currentPriceSol || 0))) * fraction;

        const priorityFeeMicrolamports = executionConfig.getConfig().priorityFeeMicrolamports;
        const estimatedFeeLamports = resolvedTip.tipLamports + Math.round(priorityFeeMicrolamports * 0.25) + 5000;
        const fees = estimatedFeeLamports / 1e9;
        const netProceeds = residualValue + (closeAta ? 0.00203928 : 0) - fees;

        // Hard-stop and trailing-stop exits are never blocked by the dust check: a full exit closes the ATA and returns
        // about 0.002 SOL of rent, and holding a falling position to avoid a tip is worse. The check only gates
        // take-profit partials, the stale-position exit and manual closes.
        const isProtectiveExit = reason === 'STOP_LOSS' || reason === 'TRAILING_STOP' || reason === 'EMERGENCY_PANIC_LIQUIDATION';
        if (netProceeds <= 0 && !isProtectiveExit) {
          return {
            success: false,
            pnlSol: 0,
            error: 'DUST_POSITION_EXIT_UNECONOMICAL',
          };
        }
      }

      // PAPER Sell Branch
      if (target.executionMode === 'PAPER') {
        await new Promise((r) => setTimeout(r, 10));
        // Q7: sell against the curve as it is now. Unreadable or migrated curve: the flat model, which the journal row says.
        let sellQuote: ReturnType<typeof PumpCurveService.calculateSellQuote> | undefined;
        try {
          const state = await PumpCurveService.fetchPumpMarketState({ connection: this.connection, mint: new PublicKey(target.mint), executionMode: 'PAPER' });
          if (state && !state.complete) {
            const sold = (BigInt(target.tokenQuantityRaw) * BigInt(sellBps)) / 10_000n;
            if (sold > 0n) sellQuote = PumpCurveService.calculateSellQuote({ state, tokenAmountRaw: sold, executionMode: 'PAPER' });
          }
        } catch {}
        const res = paperEngine.executePaperSell(target.id, target.currentPriceSol, safeSellPct, reason, sellQuote && {
          netSolOutLamports: sellQuote.expectedSolAmountLamports, executionPriceSol: sellQuote.executionPriceSol, spotPriceSol: sellQuote.spotPriceSol,
        });
        return {
          success: res.success,
          pnlSol: res.realizedPnLSol,
          status: res.position?.status,
          error: res.error,
        };
      }

    // LIVE Sell Branch (Risk-reducing exits always permitted when local signer is configured and ready)
    if (localSigner.getStatus() !== 'READY') {
      return { success: false, pnlSol: 0, error: 'Signer is not configured or locked' };
    }

    // P1.6: on an RPC the cluster check does not trust (wrong genesis, or genesis unreadable) every read answers for the wrong chain, so a
    // wallet balance read there would "find" no tokens and close the row although the tokens are on the real chain. Refuse before any
    // read decides anything; the position stays open and the next pass tries again once the RPC is trusted.
    if (this.clusterProblem !== null) {
      return { success: false, pnlSol: 0, error: `CLUSTER_GUARD: the RPC is not trusted (${this.clusterProblem.replace(/^CLUSTER_GUARD: /, '')}); not reading balances or selling`, notSent: true };
    }

    // P1.1 (N-52): inFlightPositionExits guards this coordinator only. The claim in the database stops a second coordinator or a second
    // process from selling the same position at the same time (both would sell a take-profit partial or a stop-loss). Cleared in finally.
    if (!workstationDb.claimExit(positionId, exitClaimOwner, Date.now(), Date.now() - EXIT_CLAIM_STALE_MS, exitClaimOwnerAlive)) {
      return { success: false, pnlSol: 0, error: 'EXIT_IN_PROGRESS: another process or coordinator is selling this position.' };
    }
    claimed = true;

    // R7-11: `target` was read before the claim (and before the tip-floor await); a sell that finished in between (this process's own
    // exit that just released its claim, or another process's) changed the quantity. Compute the sale from the row as it is now.
    const claimedRow = workstationDb.loadPositions().find((p) => p.id === positionId && (p.status === 'OPEN' || p.status === 'PARTIALLY_CLOSED'));
    if (!claimedRow) {
      return { success: false, pnlSol: 0, error: 'Position not found or already closed', notSent: true };
    }
    target = claimedRow;

    const seller = localSigner.getPublicKey();
    const mintPubkey = new PublicKey(target.mint);

      let totalTokensRaw = BigInt(target.tokenQuantityRaw);
      let amountTokensToSell = (totalTokensRaw * BigInt(sellBps)) / 10_000n;

      if (amountTokensToSell <= 0n) {
        return { success: false, pnlSol: 0, error: 'Calculated sell quantity is zero' };
      }

      // N3: an earlier sell of this position was sent but its outcome is unknown. Selling again could double-sell a partial, so
      // read the wallet first: if the balance dropped the sell landed (adopt it), if not wait out the blockhash window.
      const pendingSell = this.pendingSells.get(positionId);
      if (pendingSell) {
        // an unreadable ATA balance after a sell that closed the account means it is gone; P1.6: only when the read is trusted
        const read = await this.readHeldTokens(target, seller, mintPubkey);
        if (read.untrusted) return { success: false, pnlSol: 0, error: read.untrusted, notSent: true };
        let onChain = read.held;
        // R5-8: the pending sell's own signature decides first. The wallet balance alone is defeated by a transfer that tops it back up.
        const sigState = await this.pendingSellSignatureState(pendingSell.signature);
        if (sigState === 'LANDED' && onChain !== null && onChain >= totalTokensRaw) {
          const sold = await this.landedSellTokensSold(pendingSell.signature, seller, mintPubkey, target, totalTokensRaw);
          if (sold !== null) {
            onChain = totalTokensRaw - sold; // what the row keeps; tokens sent in from outside stay untracked
            this.raiseOperatorAlert('SELL_LANDED_WALLET_TOPPED_UP', `A sell of ${target.symbol || target.mint} (${pendingSell.signature.slice(0, 8)}) landed, but the wallet holds at least as many tokens as before it (tokens were sent in). Booked from the transaction: ${sold} sold.`, positionId);
          } else if (sellBps >= 10_000) {
            // a full exit sells what the wallet holds (clamped below), so it cannot double-sell a partial; the earlier sell's fill stays unbooked
            this.pendingSells.delete(positionId);
            this.raiseOperatorAlert('SELL_LANDED_UNBOOKED', `A sell of ${target.symbol || target.mint} (${pendingSell.signature.slice(0, 8)}) landed but its fill could not be read and the wallet was topped up since; the full exit sells what the wallet holds. Realized PnL of the earlier sell is not recorded.`, positionId);
          } else {
            return { success: false, pnlSol: 0, error: `SELL_PENDING_VERIFICATION: sell ${pendingSell.signature.slice(0, 8)} landed but the amount it sold cannot be read yet; not selling again` };
          }
        }
        if (this.pendingSells.has(positionId) && sigState !== 'FAILED' && onChain !== null && onChain < totalTokensRaw) {
          this.pendingSells.delete(positionId);
          // P2.3 (R1-21, R1-22, R1-86): the earlier sell landed. Read its transaction and book the chain's numbers (proceeds, PnL, the row
          // RECONCILED) instead of 0, so the daily loss, the realized events and the DEVNET_LIVE wallet audit see the SOL it moved.
          // Only when the transaction cannot be read does it fall back to matching the wallet with no PnL, as before.
          const adoptedTp = target.baseTokenProgram ? new PublicKey(target.baseTokenProgram) : TOKEN_PROGRAM_ID;
          const adopted = await TradeReconciler.reconcileSellTransaction(
            this.connection, pendingSell.signature, seller, mintPubkey, adoptedTp,
            { walletSolLamports: 0, tokenBalanceRaw: totalTokensRaw.toString(), tokenDecimals: target.tokenDecimals ?? 6, timestamp: Date.now() },
            target.costBasisLamports, Number(totalTokensRaw - onChain!) / Number(totalTokensRaw), 0
          ).catch(() => null);
          const booked = !!adopted?.success && BigInt(adopted.actualTokensSoldRaw) > 0n;
          // S258 (L2): book on the row as it is now, as the normal sell path does: `target` was loaded before the wallet and
          // transaction reads above, and saving it would undo marks or exit state written meanwhile.
          const filled = workstationDb.loadPositions().find((p) => p.id === positionId) ?? target;
          filled.baseTokenProgram = target.baseTokenProgram; // S259: readHeldTokens may have corrected it
          if (booked) filled.realizedPnLSol = (filled.realizedPnLSol ?? 0) + Number(adopted!.actualRealizedPnLSol.toFixed(6));
          filled.exitReason = pendingSell.reason ?? reason; filled.exitStage = exitStageAfterFill(pendingSell.reason, filled.exitStage); // R5-7: the stage of the sell that landed
          filled.exitTxSignature = pendingSell.signature;
          filled.lastUpdatedTimestamp = Date.now();
          const basisBefore = filled.costBasisLamports;
          if (onChain === 0n) {
            filled.status = 'CLOSED';
            filled.tokenQuantityRaw = '0';
            filled.costBasisLamports = 0;
          } else {
            filled.status = 'PARTIALLY_CLOSED';
            filled.costBasisLamports = Math.round(filled.costBasisLamports * Number(onChain) / Number(totalTokensRaw));
            filled.tokenQuantityRaw = onChain.toString();
          }
          target.status = filled.status;
          let unreadLossSol = 0;
          if (booked) {
            try {
              workstationDb.saveSellBooking(filled, pendingSell.signature, { slot: adopted!.slot, networkFeeLamports: adopted!.actualNetworkFeeLamports });
            } catch (err: any) {
              // S258: nothing was written, so the sell is still pending; the next pass adopts it again
              this.pendingSells.set(positionId, pendingSell);
              return { success: false, pnlSol: 0, error: `SELL_BOOKING_FAILED: ${err?.message ?? err}; the landed sell ${pendingSell.signature.slice(0, 8)} is booked on the next pass`, notSent: true };
            }
            this.raiseOperatorAlert('SELL_ADOPTED', `A sell of ${target.symbol || target.mint} (${pendingSell.signature.slice(0, 8)}) landed after its confirmation was missed. Its fill was read from the chain and booked (PnL ${adopted!.actualRealizedPnLSol.toFixed(6)} SOL); the position now matches the wallet.`, positionId);
          } else {
            // R5-2: the balance drop is evidence only when it was read for the position's own wallet.
            const walletProblem = await this.walletBindingProblem(target, seller);
            if (walletProblem) {
              this.pendingSells.set(positionId, pendingSell);
              this.raiseOperatorAlert('POSITION_WALLET_MISMATCH', walletProblem, positionId);
              return { success: false, pnlSol: 0, error: walletProblem, notSent: true };
            }
            // R1 #4 / R5-28: the sold share of the basis is booked now as an assumed loss, so the daily-loss gate sees it, and the SELL row is
            // left RECONCILIATION_REQUIRED (tagged) for reconciliation, which adds the proceeds once the fill can be read, in the same write
            // that marks the row RECONCILED (settleUnreadSellFill), so nothing is booked twice.
            const soldBasisLamports = Math.max(0, basisBefore - filled.costBasisLamports);
            unreadLossSol = soldBasisLamports / 1e9;
            filled.realizedPnLSol = Number(((filled.realizedPnLSol ?? 0) - unreadLossSol).toFixed(9));
            try {
              workstationDb.saveUnreadSellAssumedLoss(filled, pendingSell.signature, `${UNREAD_SELL_FILL_TAG} position=${positionId} basis=${soldBasisLamports}`);
            } catch (err: any) {
              this.pendingSells.set(positionId, pendingSell);
              return { success: false, pnlSol: 0, error: `SELL_BOOKING_FAILED: ${err?.message ?? err}; the landed sell ${pendingSell.signature.slice(0, 8)} is booked on the next pass`, notSent: true };
            }
            if (unreadLossSol > 0) workstationDb.logJournal('REALIZED_ASSUMED_LOSS', `assumed-loss-${positionId.slice(0, 8)}`, filled.executionMode, { positionId, mint: filled.mint, lossSol: unreadLossSol, where: 'a landed sell whose fill could not be read', signature: pendingSell.signature });
            this.scheduleReconcileRetry();
            this.raiseOperatorAlert('SELL_ADOPTED', `A sell of ${target.symbol || target.mint} (${pendingSell.signature.slice(0, 8)}) landed but its fill could not be read. The position now matches the wallet; the sold share of its cost basis (${unreadLossSol.toFixed(6)} SOL) is booked as an assumed loss, and the proceeds are added when reconciliation can read the fill.`, positionId);
          }
          await this.syncRealWalletBalance();
          // S2: with no readable fill this call moved nothing it can account for. P2.3: with one, it reports the earlier sell's net proceeds,
          // which reached the wallet unjournaled, so the wallet audit can explain them.
          // R6-9: say that this call only adopted the earlier sell, and whether the position is still open after it
          const adoptedInfo = { adoptedPendingSell: true, ...(target.status === 'PARTIALLY_CLOSED' ? { adoptedPartial: true, remainingTokensRaw: onChain!.toString() } : {}) };
          return booked
            ? { success: true, pnlSol: adopted!.actualRealizedPnLSol, status: target.status, solMoved: adopted!.actualNetSolProceedsLamports / 1e9, ...adoptedInfo }
            : { success: true, pnlSol: -unreadLossSol, status: target.status, solMoved: 0, ...adoptedInfo };
        }
        // P2.1: the window is only an upper bound. Once the blockhash has expired and the signature has no status, the sell can never land,
        // so the next pass (a stop-loss included) may sell at once instead of waiting out the rest of the 100 s.
        // S271 review: a send time ahead of now means the wall clock was set back since; the window restarts from now (bounded), rather
        // than holding the position until the clock catches up (hours, for a sell with no lastValidBlockHeight to prove it expired).
        // R1 #2, R4-8: the hold is released only when the sell is proven unable to land: it failed on chain, or its blockhash expired
        // (confirmed block height past lastValidBlockHeight) with no signature status. The clock alone never releases it, and neither does
        // a wallet read that failed (held === null is unknown). Only a sell recorded with no lastValidBlockHeight (a ledger row from before
        // P2.1) falls back to the window, and then only on a wallet read that succeeded and a signature with no status.
        if (pendingSell.ts > Date.now()) pendingSell.ts = Date.now();
        if (this.pendingSells.has(positionId) && sigState !== 'FAILED' && !(await this.pendingSellCannotLand(pendingSell))) {
          const noHeight = !(typeof pendingSell.lastValidBlockHeight === 'number' && pendingSell.lastValidBlockHeight > 0);
          const legacyExpired = noHeight && Date.now() - pendingSell.ts >= PENDING_SELL_WINDOW_MS && onChain !== null && sigState === 'UNSEEN';
          if (!legacyExpired) {
            return { success: false, pnlSol: 0, error: `SELL_PENDING_VERIFICATION: sell ${pendingSell.signature.slice(0, 8)} was sent and is not confirmed or proven expired yet; not selling again` };
          }
        }
        this.pendingSells.delete(positionId);
      }

      // Q13: a 100% sell sells what the wallet holds. When the row says more than the wallet has (tokens moved outside the app, a partial
      // that landed with no pending record), every attempt fails simulation and the stop-loss can never clear. Scale the row to the wallet
      // (the N3 adoption arithmetic) and sell that; an empty wallet closes the row without a send.
      if (sellBps >= 10_000) {
        // unreadable for another reason: sell what the row says; P1.6: an empty answer closes the row only when the read is trusted
        const read = await this.readHeldTokens(target, seller, mintPubkey);
        if (read.untrusted) return { success: false, pnlSol: 0, error: read.untrusted, notSent: true };
        const held = read.held;
        if (held !== null && held < totalTokensRaw) {
          target.lastUpdatedTimestamp = Date.now();
          if (held === 0n) {
            // R5-2: an empty wallet closes the row only when this signer is the position's wallet (a key change reads a stranger's empty account)
            const walletProblem = await this.walletBindingProblem(target, seller);
            if (walletProblem) {
              this.raiseOperatorAlert('POSITION_WALLET_MISMATCH', walletProblem, positionId);
              return { success: false, pnlSol: 0, error: walletProblem, notSent: true };
            }
            const assumedLossSol = this.bookAssumedLoss(target, 'an exit found an empty wallet'); // P2.3 (N-28)
            target.status = 'CLOSED';
            target.tokenQuantityRaw = '0';
            target.costBasisLamports = 0;
            target.exitReason = 'RECONCILED_ZERO_BALANCE: the wallet held no tokens when the sell was prepared (REALIZED_ASSUMED_LOSS)';
            workstationDb.savePosition(target);
            this.raiseOperatorAlert('POSITION_BALANCE_MISSING', `${target.symbol || target.mint} was closed without a sell: the wallet held none of it. Booked as a loss of its cost basis (${assumedLossSol.toFixed(6)} SOL), since no sell was found.`, positionId);
            return { success: true, pnlSol: -assumedLossSol, status: 'CLOSED', solMoved: 0 }; // S2: nothing was sent, so nothing moved
          }
          target.costBasisLamports = Math.round(target.costBasisLamports * Number(held) / Number(totalTokensRaw));
          target.tokenQuantityRaw = held.toString();
          workstationDb.savePosition(target);
          this.raiseOperatorAlert('POSITION_BALANCE_CLAMPED', `${target.symbol || target.mint}: the position said ${totalTokensRaw} but the wallet holds ${held}; selling what the wallet holds.`, positionId);
          totalTokensRaw = held;
          amountTokensToSell = held;
        }
      }

      // A95 (R7-11): a partial sells its share of what the wallet holds, as a 100% sell does above. When the row says more than the
      // wallet has (a partial that landed with no pending record, tokens moved out), the row is scaled to the wallet first, so the share
      // is never computed from tokens that are not there. An empty wallet sends nothing here; the stop-loss path closes such a row.
      if (sellBps < 10_000) {
        const read = await this.readHeldTokens(target, seller, mintPubkey);
        if (read.untrusted) return { success: false, pnlSol: 0, error: read.untrusted, notSent: true };
        const held = read.held;
        if (held !== null && held < totalTokensRaw) {
          if (held === 0n) {
            return { success: false, pnlSol: 0, error: 'Calculated sell quantity is zero: the wallet holds none of this token; a partial sell sends nothing', notSent: true };
          }
          target.costBasisLamports = Math.round(target.costBasisLamports * Number(held) / Number(totalTokensRaw));
          target.tokenQuantityRaw = held.toString();
          target.lastUpdatedTimestamp = Date.now();
          workstationDb.savePosition(target);
          this.raiseOperatorAlert('POSITION_BALANCE_CLAMPED', `${target.symbol || target.mint}: the position said ${totalTokensRaw} but the wallet holds ${held}; the ${safeSellPct}% sell is a share of what the wallet holds.`, positionId);
          totalTokensRaw = held;
          amountTokensToSell = (held * BigInt(sellBps)) / 10_000n;
          if (amountTokensToSell <= 0n) return { success: false, pnlSol: 0, error: 'Calculated sell quantity is zero', notSent: true };
        }
      }

      // CloseAccount only succeeds on an empty token account. If the wallet holds more than this sell (dust, an airdrop) or the balance
      // cannot be read, a close instruction would revert the whole sell and the stop-loss with it, so keep the account open (critique #9).
      let closeAtaEffective = closeAta;
      if (closeAta) {
        closeAtaEffective = false;
        try {
          const tp = target.baseTokenProgram ? new PublicKey(target.baseTokenProgram) : TOKEN_PROGRAM_ID;
          const ataBal = await this.connection.getTokenAccountBalance(PumpCurveService.getAssociatedTokenAddress(mintPubkey, seller, tp), 'confirmed');
          closeAtaEffective = BigInt(ataBal?.value?.amount ?? '1') <= amountTokensToSell;
        } catch {
          // unreadable: keep the account
        }
      }

      // S207: a LIVE sell on a mainnet setting is refused before anything is built, signed or simulated (submit still checks too), so no never-sent row is left behind.
      if (target.executionMode === 'LIVE') {
        try {
          traced('guard.sendCluster', () => assertSendClusterAllowed());
        } catch (err: any) {
          Logger.error(`[R1] SELL for position ${positionId} blocked before signing: ${err.message}`);
          workstationDb.logJournal('CLUSTER_GUARD_BLOCK', `exit-${positionId.slice(0, 8)}`, 'LIVE', { side: 'SELL', mint: target.mint, error: err.message });
          return { success: false, pnlSol: 0, error: err.message, notSent: true };
        }
      }

      const { PumpSwapVenueService } = await import('../solana/pumpSwapService');
      const posMode: ExecutionMode = target.executionMode === 'LIVE' ? 'LIVE' : 'PAPER';
      const venueInfo = await PumpSwapVenueService.resolveVenue(this.connection, mintPubkey, posMode);

      if (venueInfo.venue === 'UNKNOWN' && target.executionMode === 'LIVE') {
        // P1.6 (N-42): when the curve could not be read, say so (decode failure, fee config, RPC error) instead of an unknown venue
        const cf = venueInfo.curveFailure;
        return {
          success: false,
          pnlSol: 0,
          error: cf
            ? `CURVE_READ_FAILED (${cf.reason}): ${cf.message}; no PumpSwap pool either, so nothing was sent.`
            : 'UNKNOWN_TRADING_VENUE: Could not authoritatively determine whether token is bonding curve or PumpSwap pool in LIVE mode.',
          notSent: true,
        };
      }

      const sellSlippageBps = this.exitSlippageBps(positionId, reason); // R5-6: this reason's own step
      let v0Tx: any;
      let expectedJitoTipLamports = resolvedTip.tipLamports;
      const jitoTipAccount = executionConfig.getJitoTipAccountPublicKey();
      let tokenProgramToUse = target.baseTokenProgram ? new PublicKey(target.baseTokenProgram) : TOKEN_PROGRAM_ID;

      if (venueInfo.venue === 'PUMPSWAP') {
        Logger.info(`Closing position ${target.symbol} via canonical PumpSwap AMM pool`);
        if (target.venue !== 'PUMPSWAP' || !target.poolAddress || !target.migrationTimestamp) {
          target.venue = 'PUMPSWAP';
          target.poolAddress = venueInfo.poolAddress?.toBase58() || target.poolAddress;
          target.migrationTimestamp = target.migrationTimestamp || Date.now();
          target.lastUpdatedTimestamp = Date.now();
          workstationDb.savePosition(target);
        }
        const pumpSwapSell = await PumpSwapVenueService.buildPumpSwapSellInstructions(
          this.connection,
          seller,
          mintPubkey,
          amountTokensToSell,
          sellSlippageBps,
          posMode
        );

        const associatedUser = PumpCurveService.getAssociatedTokenAddress(mintPubkey, seller, tokenProgramToUse);
        const instructions = [
          ...SolanaTransactionBuilder.createComputeBudgetInstructions(250000, executionConfig.getConfig().priorityFeeMicrolamports),
          ...pumpSwapSell.instructions,
          ...(closeAtaEffective ? [createCloseAccountInstruction(associatedUser, seller, seller, [], tokenProgramToUse)] : []),
          // Q52: no tip transfer when the tip is 0 (the builder guards the same way)
          ...(expectedJitoTipLamports > 0
            ? [SystemProgram.transfer({ fromPubkey: seller, toPubkey: jitoTipAccount, lamports: expectedJitoTipLamports })]
            : []),
        ];

        v0Tx = await txBuilder.buildCustomVersionedTransaction(this.connection, seller, instructions);
      } else if (venueInfo.venue === 'PUMP_BONDING_CURVE') {
        const read = await PumpCurveService.fetchPumpMarketStateResult({ connection: this.connection, mint: mintPubkey, executionMode: posMode });
        // P1.6 (N-42): when only the fee tier could not be verified, the sell is quoted at the highest fee tier (a lower minimum output)
        const marketState = read.state ?? read.failure.sellableState;
        if (!marketState) {
          return { success: false, pnlSol: 0, error: `Cannot fetch market state to quote and execute sell (${read.failure?.reason}: ${read.failure?.message})`, notSent: true };
        }
        if (!read.state) Logger.warn(`[P1.6] SELL of ${target.symbol || target.mint} built with an unverified fee tier (${read.failure?.reason}); minimum output assumes ${marketState.unverifiedFeeCeilingBps} bps in fees`);
        tokenProgramToUse = marketState.tokenProgram;

        const sellQuote = PumpCurveService.calculateSellQuote({
          state: marketState,
          tokenAmountRaw: amountTokensToSell,
          slippageBps: sellSlippageBps,
          jitoTipSol: resolvedTip.tipSol,
          priorityFeeLamports: Math.round(executionConfig.getConfig().priorityFeeMicrolamports * 0.25),
          executionMode: posMode,
        });
        expectedJitoTipLamports = sellQuote.expectedJitoTipLamports;

        const associatedUser = PumpCurveService.getAssociatedTokenAddress(
          mintPubkey,
          seller,
          marketState.tokenProgram
        );

        const sellParams: PumpSellParams = {
          seller,
          mint: mintPubkey,
          bondingCurve: marketState.bondingCurve,
          associatedBondingCurve: marketState.associatedBondingCurve,
          associatedUser,
          creator: marketState.creator,
          feeRecipient: marketState.feeRecipient,
          buybackFeeRecipient: marketState.buybackFeeRecipient,
          quoteMint: marketState.quoteMint,
          tokenProgram: marketState.tokenProgram,
          quoteTokenProgram: marketState.quoteTokenProgram,
          amountTokens: amountTokensToSell,
          minSolOutputLamports: BigInt(sellQuote.minOutputLamports),
          computeUnits: 200000,
          priorityFeeMicroLamports: executionConfig.getConfig().priorityFeeMicrolamports,
          jitoTipLamports: BigInt(sellQuote.expectedJitoTipLamports),
          jitoTipAccount: jitoTipAccount,
          closeAta: closeAtaEffective,
        };

        v0Tx = await traced('tx.build', () => txBuilder.buildSellTransaction(this.connection, sellParams, closeAtaEffective), { 'apex.side': 'SELL' });
      } else {
        return { success: false, pnlSol: 0, error: `Trading venue for mint ${target.mint} cannot be resolved or migrated to unknown DEX`, notSent: true };
      }

      // Capture pre-sell balance snapshot
      const preSnapshot = await TradeReconciler.capturePreTradeSnapshot(
        this.connection,
        seller,
        mintPubkey,
        tokenProgramToUse
      );

      // S210: same check for a sell, but only a definite "unknown blockhash" refuses it; if the independent RPC cannot be reached the sell goes ahead,
      // because a stop-loss must not be blocked by a flaky public endpoint.
      const bhSell = await this.blockhashProblem(v0Tx, 'SELL');
      if (bhSell) {
        workstationDb.logJournal('CLUSTER_GUARD_BLOCK', `exit-${positionId.slice(0, 8)}`, 'LIVE', { side: 'SELL', mint: target.mint, error: bhSell });
        return { success: false, pnlSol: 0, error: `CLUSTER_GUARD: ${bhSell}; nothing was signed or sent.`, notSent: true };
      }
      await traced('tx.sign', () => localSigner.signTransaction(v0Tx), { 'apex.side': 'SELL' });

      // A sell that would revert (slippage breached, bad account) costs fees every time it lands. Simulate first and only send one that passes.
      // If the simulation call itself fails, send anyway: a stop-loss must not be blocked by a flaky RPC.
      const sim = await this.simulateSell(v0Tx);
      if (!sim.ok) {
        return { success: false, pnlSol: 0, error: `SELL_SIMULATION_FAILED: ${sim.error} (slippage ${sellSlippageBps} bps)` };
      }

      const exitOrderId = `ord-exit-${positionId.slice(0, 8)}-${Date.now()}`;
      sendStarted = true; // P1.6: from here a throw may follow a send; before it, nothing left this process
      const subRes = await this.submitAndConfirmWithRetry({
        tx: v0Tx,
        orderId: exitOrderId,
        correlationId: `exit-${positionId.slice(0, 8)}`,
        side: 'SELL',
        mint: target.mint,
        mintPubkey,
        owner: seller,
        tokenProgram: tokenProgramToUse,
        preSnapshot,
        jitoTipLamports: expectedJitoTipLamports,
        exitReason: reason,
      });

      if (!subRes.success || !subRes.signature) {
        if (subRes.unconfirmed && subRes.signature) this.pendingSells.set(positionId, { signature: subRes.signature, ts: Date.now(), lastValidBlockHeight: txBuilder.lastValidBlockHeightOf((v0Tx as any)?.message?.recentBlockhash), reason });
        // S245: a sell the RPC rate-limited past every resend was never accepted: no pending sell (unconfirmed is false), no fee, and not a
        // slippage failure, so it is reported as not sent and the ladder does not widen.
        const rateLimited = /^RPC_RATE_LIMITED/.test(subRes.error || '');
        const notRecorded = /^PENDING_WRITE_FAILED/.test(subRes.error || ''); // R1 #3: refused before the send
        return { success: false, pnlSol: 0, error: subRes.error || 'Failed to submit or confirm sell bundle', ...(rateLimited || notRecorded ? { notSent: true } : {}) };
      }

      // R4-7: the sell landed. From here until its booking is written, the position holds it as a pending sell, so a read or write below
      // that throws (the reconcile, the row reload, the booking) cannot leave the row at its old quantity and stage with nothing to say
      // that a sell landed: the next pass adopts it instead of selling (or taking the same profit) again. Cleared only after the booked write.
      this.pendingSells.set(positionId, { signature: subRes.signature, ts: Date.now(), lastValidBlockHeight: txBuilder.lastValidBlockHeightOf((v0Tx as any)?.message?.recentBlockhash), reason });

      // S2: the basis being sold, AFTER any clamp to the wallet balance above (target.costBasisLamports was scaled there)
      const costSoldSol = (target.costBasisLamports / 1e9) * fraction;

      // Reconcile real proceeds from confirmed transaction
      const sellRecon = await traced('tx.reconcile', () => TradeReconciler.reconcileSellTransaction(
        this.connection,
        subRes.signature,
        seller,
        mintPubkey,
        tokenProgramToUse,
        preSnapshot,
        target.costBasisLamports,
        fraction,
        expectedJitoTipLamports
      ), { 'apex.side': 'SELL' });

      if (!sellRecon.success) {
        return { success: false, pnlSol: 0, error: sellRecon.error }; // R4-7: the pending sell set above stays
      }

      // P1.1 (N-52): book the fill on the row as it is NOW, not on `target`, which was loaded before several awaits (marks and exit
      // state written meanwhile would be undone, and the realized delta would be computed against a stale copy).
      const filled = workstationDb.loadPositions().find((p) => p.id === positionId) ?? target;
      filled.baseTokenProgram = target.baseTokenProgram; // S259: readHeldTokens may have corrected it
      filled.realizedPnLSol = (filled.realizedPnLSol ?? 0) + Number(sellRecon.actualRealizedPnLSol.toFixed(6));
      filled.exitReason = reason;
      filled.exitTxSignature = subRes.signature;
      filled.lastUpdatedTimestamp = Date.now();
      filled.exitStage = exitStageAfterFill(reason, filled.exitStage); // in the same write as the fill (R1-91)

      if (sellRecon.isFullyClosed || sellBps >= 10_000) {
        filled.status = 'CLOSED';
        filled.tokenQuantityRaw = '0';
        filled.costBasisLamports = 0;
      } else {
        filled.status = 'PARTIALLY_CLOSED';
        filled.tokenQuantityRaw = sellRecon.remainingTokensRaw;
        filled.costBasisLamports = Math.round(filled.costBasisLamports * (1 - fraction));
      }
      target.status = filled.status;

      try {
        // S258: the position and its RECONCILED ledger row are one write, so a crash between them cannot leave a booked sell PENDING
        // (startup reconciliation would book it a second time once a later sell had replaced exitTxSignature)
        workstationDb.saveSellBooking(filled, subRes.signature, { slot: sellRecon.slot, networkFeeLamports: sellRecon.actualNetworkFeeLamports });
      } catch (err: any) {
        // nothing was written: the row still holds the sold tokens, so the sell stays pending (set above) and the next pass adopts it
        return { success: false, pnlSol: 0, error: `SELL_BOOKING_FAILED: ${err?.message ?? err}; the landed sell ${subRes.signature.slice(0, 8)} is booked on the next pass` };
      }
      this.pendingSells.delete(positionId); // R4-7: booked
      await this.syncRealWalletBalance();

      return {
        success: true,
        pnlSol: sellRecon.actualRealizedPnLSol,
        status: target.status,
        solMoved: costSoldSol + sellRecon.actualRealizedPnLSol,
      };
    } catch (err: any) {
      // P1.6 (N-44, R1-30): a throw before the send (quote math, pool reads, building, signing) attempted nothing, so it is not counted
      return { success: false, pnlSol: 0, error: err?.message ?? String(err), notSent: !sendStarted };
    } finally {
      if (claimed) workstationDb.releaseExitClaim(positionId, exitClaimOwner);
      this.inFlightPositionExits.delete(positionId);
      this.positionExitDone.delete(positionId);
      exitDone();
    }
  }

  /**
   * P1.6: the wallet's balance of a LIVE position's token, read before an exit. `held` is the raw amount, 0n when the token account does
   * not exist, null when the read failed for another reason (the caller then sells what the row says). A zero or absent answer closes the
   * row without a sell, so it must come from a read that can be trusted: `untrusted` (a non-attempt error the exit returns as it is) is
   * set when the RPC is not on the allowed cluster, or when its answer is from a slot before the position's buy landed (a lagging node).
   * `error` carries the RPC's message when `held` is null. Startup reconciliation (step 4b) reads through this too, with the same rules.
   */
  private async readHeldTokens(target: NormalizedPosition, owner: PublicKey, mint: PublicKey): Promise<{ held: bigint | null; untrusted?: string; error?: string }> {
    const tp = target.baseTokenProgram ? new PublicKey(target.baseTokenProgram) : TOKEN_PROGRAM_ID;
    const ata = PumpCurveService.getAssociatedTokenAddress(mint, owner, tp);
    let held: bigint;
    let slot: number | undefined;
    let absent = false;
    try {
      const bal = await this.connection.getTokenAccountBalance(ata, 'confirmed');
      held = BigInt(bal?.value?.amount ?? '0');
      slot = bal?.context?.slot;
    } catch (e: any) {
      // S259: "could not find account" means the account is absent. E2 (devnet run 12): an ATA closed by a 100% sell reads as "not a Token
      // account" on devnet, which is no tokens too, once the account read below shows no token program owns that address. Any other
      // "Invalid param" (a mint that cannot be unpacked, say) says nothing about the balance, and a 0 here closes the row as an assumed loss.
      const msg = String(e?.message ?? e);
      if (/not a Token account/i.test(msg)) {
        let r: Awaited<ReturnType<Connection['getAccountInfoAndContext']>> | null;
        try {
          r = await this.connection.getAccountInfoAndContext(ata, 'confirmed');
        } catch (err: any) {
          return { held: null, error: `${msg}; the account itself could not be read (${err?.message ?? err})` };
        }
        if (r?.value && ownedByTokenProgram(r.value.owner)) {
          return { held: null, error: `${msg}, but the token program owns the account; the balance is unknown` };
        }
        slot = r?.context?.slot;
      } else if (!/could not find account/i.test(msg)) {
        return { held: null, error: msg };
      }
      held = 0n;
      absent = true;
    }
    if (held > 0n) return { held };
    // S259: a row written before base_token_program existed got the column default (SPL Token), so a Token-2022 mint's tokens sit in a
    // token account this read did not look at. Before an empty answer decides anything, ask the mint which program owns it; on a mismatch
    // read again with that program (and keep it on the row, saved with it).
    const mintProgram = await this.mintOwnerProgram(mint);
    if (mintProgram === 'UNREADABLE') return { held: null, error: `the empty balance was not checked: the mint account of ${mint.toBase58()} could not be read` };
    if (mintProgram && !mintProgram.equals(tp)) {
      Logger.warn(`[S259] ${target.symbol || target.mint}: the row says token program ${tp.toBase58()} but the mint is owned by ${mintProgram.toBase58()}; reading that token account`);
      target.baseTokenProgram = mintProgram.toBase58();
      return this.readHeldTokens(target, owner, mint);
    }
    if (this.clusterProblem !== null) {
      return { held, untrusted: `CLUSTER_GUARD: the RPC is not trusted (${this.clusterProblem.replace(/^CLUSTER_GUARD: /, '')}); an empty wallet balance from it does not close the position` };
    }
    try {
      await assertClusterAllowedCached(this.connection);
    } catch (err: any) {
      const why = String(err?.message ?? err).replace(/^CLUSTER_GUARD: /, '');
      return { held, untrusted: `CLUSTER_GUARD: ${why}; an empty wallet balance from this RPC does not close the position` };
    }
    const entrySlot = target.entrySlot ?? 0;
    if (entrySlot > 0) {
      if (slot === undefined) {
        try {
          const r = await this.connection.getAccountInfoAndContext(ata, 'confirmed');
          slot = r?.context?.slot;
          // a token account exists after all: the two reads disagree, so neither decides (an account no token program owns holds no tokens)
          if (absent && r?.value && ownedByTokenProgram(r.value.owner)) slot = undefined;
        } catch {
          slot = undefined;
        }
      }
      if (slot === undefined || slot < entrySlot) {
        return { held, untrusted: `BALANCE_UNTRUSTED: the RPC reported no tokens as of slot ${slot ?? 'unknown'}, but the buy landed in slot ${entrySlot}; not closing the position on that read` };
      }
    }
    return { held };
  }

  /**
   * S259: the program that owns the mint account (SPL Token or Token-2022), null when the account does not exist or is owned by another
   * program (nothing to correct the row with), 'UNREADABLE' when the read failed.
   */
  private async mintOwnerProgram(mint: PublicKey): Promise<PublicKey | null | 'UNREADABLE'> {
    try {
      const owner = (await this.connection.getAccountInfo(mint, 'confirmed'))?.owner;
      return owner && (owner.equals(TOKEN_PROGRAM_ID) || owner.equals(TOKEN_2022_PROGRAM_ID)) ? owner : null;
    } catch {
      return 'UNREADABLE';
    }
  }

  /** Wallets whose pump volume accumulator is known to exist (it is never closed by this app), so the account is read once. */
  private volumeAccumulatorKnown = new Set<string>();

  /** S6: 0 when the signer wallet already has its pump volume accumulator; the rent of creating it otherwise (also when it cannot be read). */
  private async unrefundedFirstBuyRentLamports(): Promise<number> {
    let owner: PublicKey;
    try { owner = localSigner.getPublicKey(); } catch { return PUMP_USER_VOLUME_ACCUMULATOR_RENT_LAMPORTS; }
    const key = owner.toBase58();
    if (this.volumeAccumulatorKnown.has(key)) return 0;
    try {
      const info = await this.connection.getAccountInfo(userVolumeAccumulatorPda(owner), 'confirmed');
      if (info) { this.volumeAccumulatorKnown.add(key); return 0; }
    } catch { /* unreadable: assume the rent is still to be paid */ }
    return PUMP_USER_VOLUME_ACCUMULATOR_RENT_LAMPORTS;
  }

  private async simulateSell(tx: any): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await this.connection.simulateTransaction(tx, { sigVerify: false, commitment: 'processed' });
      if (res?.value?.err) {
        // the program log tail says which program refused and why; the error code alone does not
        const tail = (res.value.logs ?? []).filter((l) => !l.startsWith('Program data:')).slice(-6).join(' | ');
        return { ok: false, error: `${JSON.stringify(res.value.err)}${tail ? ` [logs: ${tail}]` : ''}` };
      }
      return { ok: true };
    } catch (e: any) {
      Logger.warn(`Sell simulation unavailable (${e.message}); sending without it`);
      return { ok: true };
    }
  }

  /**
   * A mint whose price could not be read is not asked again at once. Without this, 515 stale PAPER positions on mints that do not exist
   * cost one RPC read each on every 3 s pass (and a log line each), which also drew 429s from the endpoint. The wait doubles from
   * MARK_RETRY_BASE_MS to MARK_RETRY_MAX_MS and resets on a successful read.
   * P1.6 (R1-19, R1-112): a LIVE position is never backed off, so one failed read cannot blind its stop-loss for a minute or more; it is
   * read on every pass. The exception is a mint that can never be marked (PumpCurveService.getMintRejection: not a token mint).
   */
  private markRetry = new Map<string, { failures: number; nextAt: number }>();
  private markBackedOff(pos: Pick<NormalizedPosition, 'mint' | 'executionMode'>, now = Date.now()): boolean {
    if (pos.executionMode === 'LIVE' && !PumpCurveService.getMintRejection(pos.mint)) return false;
    const r = this.markRetry.get(pos.mint);
    return !!r && now < r.nextAt;
  }
  private noteMarkFailure(mint: string, now = Date.now()): void {
    const failures = (this.markRetry.get(mint)?.failures ?? 0) + 1;
    this.markRetry.set(mint, { failures, nextAt: now + Math.min(MARK_RETRY_MAX_MS, MARK_RETRY_BASE_MS * 2 ** (failures - 1)) });
  }
  private noteMarkSuccess(mint: string): void {
    this.markRetry.delete(mint);
  }

  /** C4: isolated per-position price read used when the shared mark feed has gone stale. */
  private async refreshStaleMark(pos: NormalizedPosition): Promise<boolean> {
    if (this.markBackedOff(pos)) return false; // asked recently and failed: no RPC read this time (never a LIVE position, P1.6)
    try {
      const marks = await RealMarkPriceService.queryOnChainMarkPrices(
        this.connection,
        [pos.mint],
        pos.executionMode === 'LIVE' ? 'LIVE' : 'PAPER'
      );
      const mark = marks[pos.mint];
      if (!mark || !(mark.priceSol > 0)) {
        const rejected = PumpCurveService.getMintRejection(pos.mint);
        if (rejected) this.raiseOperatorAlert('MARK_MINT_REJECTED', `${pos.symbol || pos.mint.slice(0, 6)} cannot be marked: ${rejected}. The position keeps its last mark and goes stale.`, pos.id); // R19
        this.noteMarkFailure(pos.mint);
        return false;
      }
      this.noteMarkSuccess(pos.mint);
      this.applyMarkPrice(pos, mark.priceSol, mark.source, mark.timestamp, mark.poolAddress);
      return true;
    } catch (err: any) {
      Logger.debug(`Direct mark read failed for ${pos.mint}: ${err.message}`);
      this.noteMarkFailure(pos.mint);
      return false;
    }
  }

  private operatorAlerts: OperatorAlert[] = [];

  /** Recent operator alerts (newest last). Surfaced in diagnostics. */
  public getOperatorAlerts(): OperatorAlert[] {
    return this.operatorAlerts.filter((a) => !a.cleared).map((a) => ({ ...a }));
  }

  private raiseOperatorAlert(code: string, message: string, positionId?: string) {
    const now = Date.now();
    const existing = this.operatorAlerts.find((a) => a.code === code && a.positionId === positionId && !a.cleared);
    if (existing) {
      existing.lastSeenAt = now;
      existing.message = message; // counts and ages in an aggregate alert stay current; no new log line
      return;
    }
    this.operatorAlerts.push({ code, message, positionId, raisedAt: now, lastSeenAt: now, cleared: false });
    // N17: at the cap drop a cleared alert first; an uncleared one is only dropped when everything is uncleared.
    if (this.operatorAlerts.length > 50) {
      const cleared = this.operatorAlerts.findIndex((a) => a.cleared);
      this.operatorAlerts.splice(cleared >= 0 ? cleared : 0, 1);
    }
    Logger.error(`[OPERATOR ALERT] ${code}: ${message}`);
  }

  private clearOperatorAlert(code: string, positionId?: string) {
    for (const a of this.operatorAlerts) {
      if (a.code === code && a.positionId === positionId) a.cleared = true;
    }
  }

  // Evaluate dynamic exit conditions for all active positions and execute exits via ExitEngine (B13)
  private exitPassInFlight: Promise<void> | null = null;
  /** P1.7: one promise per position whose sell is running (set and cleared with inFlightPositionExits); it only ever resolves. */
  private positionExitDone = new Map<string, Promise<void>>();
  private panicActive = false;

  /**
   * P1.7: resolves once no exit (sell) of this position is running on this coordinator; at once when none is. Never rejects. A panic
   * liquidation (P1.4) awaits it so it does not race a sell that is already on its way.
   */
  public async waitForPositionExit(positionId: string): Promise<void> {
    for (let p = this.positionExitDone.get(positionId); p; p = this.positionExitDone.get(positionId)) await p;
  }

  /** P1.7: while a panic liquidation runs, the exit pass sends only protective exits (PROTECTIVE_EXIT_REASONS, the haltAll set). */
  public setPanicActive(active: boolean): void {
    this.panicActive = active;
  }

  public isPanicActive(): boolean {
    return this.panicActive;
  }

  /**
   * P1.7: one auto exit, started by the exit pass and not awaited in its loop. The exit stage advances here, after the sell filled, from
   * the row as it is then. Never rejects.
   */
  private dispatchExit(pos: NormalizedPosition, sellPct: number, reason: string, priorExitStage: NormalizedPosition['exitStage'], newExitStage: NormalizedPosition['exitStage']): Promise<void> {
    return this.closePosition(pos.id, sellPct, reason).then((exitRes) => {
      // R5-7: an exit that only adopted an earlier landed sell sold nothing for this decision; the adoption booked that sell's own stage
      if (exitRes.success && !exitRes.adoptedPendingSell && newExitStage !== priorExitStage) {
        const after = workstationDb.loadPositions(undefined, 'ACTIVE').find((p) => p.id === pos.id);
        if (after) {
          after.exitStage = newExitStage;
          workstationDb.savePosition(after);
        }
      }
    }).catch((err: any) => {
      Logger.error(`[B13 ExitEngine] ${reason} for ${pos.symbol || pos.mint} failed: ${err?.message ?? err}`);
    });
  }

  /** A sell of the position that was sent and is not booked yet. `reason` is its exit reason (R5-7: an adoption books its stage). */
  private pendingSells = new Map<string, { signature: string; ts: number; lastValidBlockHeight?: number; reason?: string }>();
  /** P2.2: set when the first startup reconciliation run ends, whatever its result. */
  private firstReconciliationDone = false;

  /**
   * R1 #4 / R5-28: a landed sell adopted with an unreadable fill had the sold share of its basis booked as an assumed loss. Once its fill can
   * be read, the net proceeds are added to the position's realized PnL in one write with the row marked RECONCILED (saveSellBooking), so the
   * result is proceeds minus basis, booked once. False when it cannot be settled yet (no signer, no position, fill still unreadable).
   */
  private async settleUnreadSellFill(pTx: PersistedTransaction, positionId: string, wallet: PublicKey | null, slot: number): Promise<boolean> {
    if (!wallet || !workstationDb.loadPositions('LIVE').some((p) => p.id === positionId)) return false;
    const recovery = await TradeReconciler.recoverInterruptedTransaction(this.connection, pTx.signature, wallet, pTx.jitoTipLamports);
    if (!(recovery.recovered && recovery.type === 'SELL')) return false;
    const pos = workstationDb.loadPositions('LIVE').find((p) => p.id === positionId); // read again: the await above may have let a write in
    if (!pos) return false;
    const proceedsLamports = recovery.solReceivedLamports ?? 0;
    pos.realizedPnLSol = Number(((pos.realizedPnLSol ?? 0) + proceedsLamports / 1e9).toFixed(9));
    pos.lastUpdatedTimestamp = Date.now();
    workstationDb.saveSellBooking(pos, pTx.signature, { slot, networkFeeLamports: pTx.networkFeeLamports });
    workstationDb.logJournal('REALIZED_ASSUMED_LOSS_SETTLED', `assumed-loss-${positionId.slice(0, 8)}`, pos.executionMode, { positionId, signature: pTx.signature, proceedsSol: proceedsLamports / 1e9 });
    pTx.reconciliationState = 'RECONCILED';
    pTx.error = `${pTx.error}; settled: ${proceedsLamports} lamports of proceeds booked`;
    return true;
  }

  /**
   * R4-2 / R5-2: null when the signer is proven to be the wallet that holds this LIVE position, else why a zero balance read with it proves
   * nothing and must not close the row. The binding is the row's walletPubkey; a row written before that column existed is bound on the
   * spot to the fee payer of its own buy transaction (read from chain), when that can be read. Unknown is refused, like a mismatch.
   */
  private async walletBindingProblem(pos: NormalizedPosition, signer: PublicKey): Promise<string | null> {
    if (pos.executionMode !== 'LIVE') return null;
    let bound = pos.walletPubkey;
    if (!bound && !isRecoveredPosition(pos) && pos.entryTxSignature) {
      bound = (await this.buyFeePayer(pos.entryTxSignature)) ?? undefined;
      if (bound) {
        workstationDb.bindPositionWallet(pos.id, bound);
        pos.walletPubkey = bound;
      }
    }
    const me = signer.toBase58();
    if (!bound) {
      return `WALLET_BINDING_UNKNOWN: ${pos.symbol || pos.mint} has no recorded wallet and its buy transaction could not be read, so an empty balance in ${me} does not prove the tokens are gone; the position is left open`;
    }
    if (bound !== me) {
      return `WALLET_MISMATCH: ${pos.symbol || pos.mint} was bought by wallet ${bound}, but the signer is ${me}; its tokens are not in this wallet, so the position is left open (load the key of ${bound} to manage it)`;
    }
    return null;
  }

  /** R4-2: the fee payer (first account key) of a confirmed transaction, or null when it cannot be read. */
  private async buyFeePayer(signature: string): Promise<string | null> {
    try {
      const tx: any = await this.connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
      const msg = tx?.transaction?.message;
      if (!msg || tx?.meta?.err) return null;
      const keys = msg.staticAccountKeys ?? msg.accountKeys ?? (typeof msg.getAccountKeys === 'function' ? msg.getAccountKeys().staticAccountKeys : undefined);
      const payer = keys?.[0];
      if (!payer) return null;
      return typeof payer === 'string' ? payer : typeof payer.toBase58 === 'function' ? payer.toBase58() : null;
    } catch {
      return null;
    }
  }

  /**
   * P2.3 (N-28): a position closed because the wallet holds none of it, with no sell found, loses its whole remaining cost basis.
   * Adds that loss to `pos.realizedPnLSol` (the caller's savePosition writes the realized_events delta) and journals
   * REALIZED_ASSUMED_LOSS. Returns the loss in SOL (0 for a RECOVERED position, whose basis is unknown and stored as 0).
   */
  private bookAssumedLoss(pos: NormalizedPosition, where: string): number {
    const lossSol = Math.max(0, pos.costBasisLamports || 0) / 1e9;
    if (lossSol <= 0) return 0;
    pos.realizedPnLSol = Number(((pos.realizedPnLSol ?? 0) - lossSol).toFixed(9));
    workstationDb.logJournal('REALIZED_ASSUMED_LOSS', `assumed-loss-${pos.id.slice(0, 8)}`, pos.executionMode, { positionId: pos.id, mint: pos.mint, lossSol, where });
    return lossSol;
  }

  /** P2.2: mints with a LIVE SELL row still PENDING or RECONCILIATION_REQUIRED. R5-4: null when the ledger cannot be read (unknown). */
  private unresolvedLiveSellMints(): Set<string> | null {
    const rows = workstationDb.loadTransactionsInStates(['PENDING', 'RECONCILIATION_REQUIRED']);
    if (rows === null) return null;
    return new Set(rows.filter((t) => t.direction === 'SELL' && t.executionMode === 'LIVE').map((t) => t.mint));
  }

  /**
   * P2.2 (R1-23, R1-83): pendingSells lived in memory only, so after a restart a sell that was sent but not confirmed was forgotten and the
   * position could be sold again (or closed at cost 0 by the zero-balance branch). At start, every LIVE SELL row still PENDING or
   * RECONCILIATION_REQUIRED becomes a pending sell of the active LIVE position of that mint (one position per mint), with its submission
   * time and blockhash height, so closePosition reads the wallet before it sells again (the N3 adoption path).
   */
  private seedPendingSellsFromLedger(): void {
    try {
      const active = workstationDb.loadPositions(undefined, 'ACTIVE').filter((p) => p.executionMode === 'LIVE');
      const read = workstationDb.loadTransactionsInStates(['PENDING', 'RECONCILIATION_REQUIRED']);
      if (read === null) throw new Error('the transactions table could not be read'); // R5-4: the exit pass holds LIVE exits until a seed succeeds
      this.pendingSellSeedFailed = false;
      // R1 #4: a tagged row was already adopted (its position matches the wallet); seeding it would only hold the next exit for the window
      const rows = read.filter((t) => t.direction === 'SELL' && t.executionMode === 'LIVE' && !t.error?.startsWith(UNREAD_SELL_FILL_TAG));
      for (const t of rows) {
        const pos = active.find((p) => p.mint === t.mint);
        if (!pos) continue;
        const known = this.pendingSells.get(pos.id);
        if (known && known.ts >= t.submissionTime) continue; // keep the latest sell of the position
        this.pendingSells.set(pos.id, { signature: t.signature, ts: t.submissionTime, lastValidBlockHeight: t.lastValidBlockHeight, reason: t.exitReason });
      }
      if (this.pendingSells.size > 0) Logger.warn(`[P2.2] ${this.pendingSells.size} sell(s) sent before the restart are unresolved; their positions check the wallet before selling again`);
    } catch (err: any) {
      this.pendingSellSeedFailed = true;
      Logger.warn(`[P2.2] could not seed pending sells from the ledger: ${err.message}`);
    }
  }

  /** R5-4: the last seedPendingSellsFromLedger could not read the ledger, so a sell sent before the restart may be unknown to pendingSells. */
  private pendingSellSeedFailed = false;

  /**
   * P2.1: true only when the pending sell's blockhash has expired (confirmed block height past its lastValidBlockHeight) AND its signature
   * has no status, history included: it was never processed and can no longer be. Any read that fails, or a sell with no stored height, is false.
   */
  private async pendingSellCannotLand(p: { signature: string; lastValidBlockHeight?: number }): Promise<boolean> {
    if (!(typeof p.lastValidBlockHeight === 'number' && p.lastValidBlockHeight > 0)) return false;
    try {
      if ((await this.connection.getBlockHeight('confirmed')) <= p.lastValidBlockHeight) return false;
      const st = await this.connection.getSignatureStatuses([p.signature], { searchTransactionHistory: true });
      return Array.isArray(st?.value) && st.value.length === 1 && st.value[0] === null;
    } catch {
      return false;
    }
  }

  /**
   * R5-8: what the cluster says about a pending sell's signature (history included). LANDED is confirmed or finalized with no error;
   * FAILED is processed with an error (it can never land); SEEN is processed but not confirmed yet; UNSEEN is no status at all;
   * UNREADABLE is a failed read. Only LANDED and FAILED decide anything on their own.
   */
  private async pendingSellSignatureState(signature: string): Promise<'LANDED' | 'FAILED' | 'SEEN' | 'UNSEEN' | 'UNREADABLE'> {
    try {
      const st = await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      if (!Array.isArray(st?.value) || st.value.length !== 1) return 'UNREADABLE';
      const v = st.value[0];
      if (v === null || v === undefined) return 'UNSEEN';
      if (v.err) return 'FAILED';
      return v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized' ? 'LANDED' : 'SEEN';
    } catch {
      return 'UNREADABLE';
    }
  }

  /** R5-8: how many tokens a landed sell took from the wallet, read from its transaction; null when that cannot be read. */
  private async landedSellTokensSold(signature: string, seller: PublicKey, mint: PublicKey, target: NormalizedPosition, totalTokensRaw: bigint): Promise<bigint | null> {
    const tp = target.baseTokenProgram ? new PublicKey(target.baseTokenProgram) : TOKEN_PROGRAM_ID;
    const r = await TradeReconciler.reconcileSellTransaction(
      this.connection, signature, seller, mint, tp,
      { walletSolLamports: 0, tokenBalanceRaw: totalTokensRaw.toString(), tokenDecimals: target.tokenDecimals ?? 6, timestamp: Date.now() },
      0, 0, 0
    ).catch(() => null);
    if (!r?.success) return null;
    let sold: bigint;
    try { sold = BigInt(r.actualTokensSoldRaw); } catch { return null; }
    return sold > 0n && sold <= totalTokensRaw ? sold : null;
  }

  // N1: one pass at a time. A pass waits (up to EXIT_SELL_WAIT_MS) for sells that can outlast the 3s timer; an overlapping pass would see the same
  // ACTIVE row and sell it again, or write back its stale copy over a position the first pass already closed.
  // R4-6: a pass that throws (a DB read in it failing) is caught here, never left to the process-wide unhandledRejection handler; after
  // EXIT_LOOP_ALERT_AFTER failed passes in a row EXIT_LOOP_FAILING is raised and LIVE buys are refused until a pass completes again.
  public evaluateAndProcessExits(): Promise<void> {
    if (this.exitPassInFlight) return this.exitPassInFlight;
    const run = this.runExitPass().then(() => this.noteExitPassOutcome(null), (err) => this.noteExitPassOutcome(err)).finally(() => {
      if (this.exitPassInFlight === run) this.exitPassInFlight = null;
    });
    this.exitPassInFlight = run;
    return run;
  }

  /** R4-6: consecutive exit passes that threw; 0 after a pass that completed. */
  private exitPassFailures = 0;

  /** R4-6: true while the exit loop is failing (EXIT_LOOP_ALERT_AFTER passes in a row threw): stop-loss and take-profit are not running. */
  public isExitLoopFailing(): boolean {
    return this.exitPassFailures >= EXIT_LOOP_ALERT_AFTER;
  }

  private noteExitPassOutcome(err: unknown): void {
    if (err === null) {
      if (this.exitPassFailures > 0) Logger.info(`[R4-6] exit pass completed again after ${this.exitPassFailures} failed pass(es)`);
      this.exitPassFailures = 0;
      this.clearOperatorAlert('EXIT_LOOP_FAILING');
      return;
    }
    this.exitPassFailures++;
    const msg = String((err as any)?.message ?? err).slice(0, 200);
    Logger.error(`[R4-6] exit pass failed (${this.exitPassFailures} in a row): ${msg}`);
    if (this.isExitLoopFailing()) {
      this.raiseOperatorAlert('EXIT_LOOP_FAILING', `The exit loop has failed ${this.exitPassFailures} passes in a row (last: ${msg}). Stop-loss, trailing stop and take-profit are NOT running and LIVE buys are refused until it recovers; close positions by hand or run the panic if this persists.`);
    }
  }

  private async runExitPass(): Promise<void> {
    try {
      await this.updatePositionMarkPrices();
    } catch {}

    let positions = workstationDb.loadPositions(undefined, 'ACTIVE');
    // P2.2 (R1-23, R1-83, R1-115): until the first startup reconciliation has applied the SELL rows from before a restart, a LIVE position
    // with an unresolved sell is not evaluated: its earlier sell may have landed, and selling again could sell a partial twice.
    // R5-4: a ledger that cannot be read (here, or when pendingSells was seeded) is unknown: every LIVE position is held, since any of
    // them may have an unsettled sell that a second sell would double.
    if (this.pendingSellSeedFailed) this.seedPendingSellsFromLedger();
    if (!this.firstReconciliationDone || this.pendingSellSeedFailed) {
      const held = this.unresolvedLiveSellMints();
      if (held === null || this.pendingSellSeedFailed) {
        positions = positions.filter((p) => p.executionMode !== 'LIVE');
        this.raiseOperatorAlert('LEDGER_UNREADABLE', 'The transactions table could not be read, so sells sent earlier cannot be ruled out. LIVE exits are held until it can be read.');
      } else if (held.size > 0) positions = positions.filter((p) => !(p.executionMode === 'LIVE' && held.has(p.mint)));
    }
    const loadedQty = new Map(positions.map((p) => [p.id, p.tokenQuantityRaw]));
    // N17: failure counters only matter for positions still open; drop the rest so the map cannot grow forever.
    for (const k of [...this.exitFailures.keys()]) if (!loadedQty.has(ExecutionCoordinator.exitFailurePositionId(k))) this.exitFailures.delete(k);
    for (const id of [...this.markMono.keys()]) if (!loadedQty.has(id)) this.markMono.delete(id);
    // Nothing LIVE is open, so there is no mark to be stale (see the feed heartbeat): reset the clock here too.
    if (!positions.some((p) => p.executionMode === 'LIVE' && !isRecoveredPosition(p))) { // R5-1: RECOVERED rows do not own the mark clock
      this.setPositionMarkClock(0);
      this.positionMarkHealth = 'HEALTHY';
    }

    let paperRefreshes = 0;
    let paperAlertsThisPass = 0;
    const paperNoMark: Array<{ pos: NormalizedPosition; ageMs: number }> = [];
    const sells: Promise<void>[] = [];
    // R5-10 / R7-10 (P1.7): an exit decided on a fresh mark is sent at once, before any stale-mark read in this pass, and the stale reads
    // run STALE_REFRESH_CONCURRENCY at a time; each position is evaluated (and its exit sent) as soon as its own read returns. A decided
    // stop-loss no longer waits behind every other position's direct read.
    const stale: Array<{ pos: NormalizedPosition; markAge: number; skipRead: boolean }> = [];
    for (const pos of positions) {
      // C4: staleness is measured from the last real mark only. lastUpdatedTimestamp is rewritten on every tick
      // and would hide a dead feed, so it is never a fallback; a never-marked position ages from its entry. R4-3: on the monotonic clock.
      const markAge = this.markAgeMs(pos);
      if (markAge > MARK_STALE_MS) {
        // Before skipping, read this position's curve/pool directly. A fresh read lets the stop-loss run.
        // PAPER positions cost no more than PAPER_STALE_REFRESH_PER_PASS direct reads per pass; LIVE positions always get theirs.
        const skipRead = pos.executionMode !== 'LIVE' && ++paperRefreshes > PAPER_STALE_REFRESH_PER_PASS;
        stale.push({ pos, markAge, skipRead });
        continue;
      }
      if (pos.executionMode === 'LIVE' && !isRecoveredPosition(pos)) this.recordPositionMarkEvent(); // a real mark within the staleness window
      this.decideAndDispatchExit(pos, false, loadedQty, sells);
    }

    const afterRefresh = (pos: NormalizedPosition, markAge: number, refreshed: boolean): void => {
      let staleStopOnly = false;
      if (!refreshed) {
        // Missing data is never "safe": exits cannot be priced, so say so loudly once the gap is long enough.
        if (markAge > MARK_ALERT_AFTER_MS && pos.executionMode !== 'LIVE' && ++paperAlertsThisPass > PAPER_INDIVIDUAL_ALERTS) {
          paperNoMark.push({ pos, ageMs: markAge }); // past the first few: one alert with a count for the rest, below
        } else if (markAge > MARK_ALERT_AFTER_MS) {
          this.raiseOperatorAlert(
            'POSITION_MARK_UNAVAILABLE',
            `No price for ${pos.symbol || pos.mint} for ${Math.round(markAge / 1000)}s and a direct curve/pool read failed. Stop-loss and take-profit cannot fire until a mark returns; consider closing manually.`,
            pos.id
          );
        }
        // A position nobody can price must age the mark feed from its entry, or an empty history would read as healthy.
        if (pos.executionMode === 'LIVE' && !isRecoveredPosition(pos) && this.lastPositionMarkTimestamp === 0) this.setPositionMarkClock(pos.entryTimestamp || Date.now());
        // P1.6: a LIVE position whose last known mark is already past the hard stop still gets its STOP_LOSS (and nothing else): the
        // sell re-reads the curve or pool before it is built, so it does not trade on the stale price. Every other exit waits for a mark.
        if (pos.executionMode !== 'LIVE' || !(pos.currentPriceSol > 0)) return;
        staleStopOnly = true;
      }
      if (!staleStopOnly) {
        this.clearOperatorAlert('POSITION_MARK_UNAVAILABLE', pos.id);
        if (pos.executionMode === 'LIVE' && !isRecoveredPosition(pos)) this.recordPositionMarkEvent();
      }
      this.decideAndDispatchExit(pos, staleStopOnly, loadedQty, sells);
    };
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < stale.length) {
        const { pos, markAge, skipRead } = stale[next++];
        const refreshed = skipRead ? false : await this.refreshStaleMark(pos);
        afterRefresh(pos, markAge, refreshed);
      }
    };
    await Promise.all(Array.from({ length: Math.min(STALE_REFRESH_CONCURRENCY, stale.length) }, () => worker()));

    // P1.7 (R1-71): the sells run together, so a slow or hung sell of one position cannot hold another position's stop-loss. The pass waits
    // for them at most EXIT_SELL_WAIT_MS; a sell still running after that keeps going in the background, its position stays in
    // inFlightPositionExits (no second send), and the next pass evaluates the rest.
    if (sells.length > 0) {
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>((r) => { timer = setTimeout(r, EXIT_SELL_WAIT_MS); });
      try {
        await Promise.race([Promise.allSettled(sells), deadline]);
      } finally {
        clearTimeout(timer);
      }
    }

    // One alert for every PAPER position with no price, with a count; a per-position alert for 500 stale paper rows filled the alert list
    // (cap 50) and re-logged on every pass. LIVE positions keep their own alert above.
    if (paperNoMark.length > 0) {
      const oldest = Math.max(...paperNoMark.map((x) => x.ageMs));
      this.raiseOperatorAlert(
        'PAPER_MARKS_UNAVAILABLE',
        `${paperNoMark.length} more PAPER position(s) have no price (oldest ${Math.round(oldest / 1000)}s). Their stop-loss and take-profit cannot fire until a mark returns. They are re-read at most every ${Math.round(MARK_RETRY_BASE_MS / 1000)}s.`
      );
    } else {
      this.clearOperatorAlert('PAPER_MARKS_UNAVAILABLE');
    }
  }

  /**
   * One position's exit decision in the exit pass, and its sell started at once when there is one (pushed to `sells`, not awaited).
   * Synchronous: the row re-read, the exit-state write and the gates (backoff of this reason, a sell already running, a panic) run with
   * no await between them and the start of the sell.
   */
  private decideAndDispatchExit(pos: NormalizedPosition, staleStopOnly: boolean, loadedQty: Map<string, string>, sells: Promise<void>[]): void {
    // R1-32: each position's clock is read when it is evaluated, not when the pass started (a stale-mark read can take a while).
    const posNow = Date.now();
    let decision = ExitEngine.evaluate({
      positionId: pos.id,
      entryPriceSol: pos.entryPriceSol,
      currentPriceSol: pos.currentPriceSol,
      highWaterMarkSol: pos.highWaterMarkSol,
      trailingStopSol: pos.trailingStopSol,
      exitStage: pos.exitStage,
      entryTimestamp: pos.entryTimestamp,
      currentTimestamp: posNow,
    });
    // P1.6: no price, and not past the hard stop. R5-21: the trailing stop is protective too (PROTECTIVE_EXIT_REASONS), so it goes as well
    if (staleStopOnly && !(decision.shouldExit && (decision.reason === 'STOP_LOSS' || decision.reason === 'TRAILING_STOP'))) return;

    // A RECOVERED position (a balance found in the wallet that this app never bought) has an entry price that is just the mark at
    // adoption, so take-profit, trailing and stale exits would sell whatever lands in the wallet on an invented schedule. Only the
    // hard stop applies, unless the operator opts in with AUTO_MANAGE_RECOVERED=true.
    const ladderSuppressed = isRecoveredPosition(pos) && process.env.AUTO_MANAGE_RECOVERED !== 'true';
    if (decision.shouldExit && decision.reason !== 'STOP_LOSS' && ladderSuppressed) {
      decision = { ...decision, shouldExit: false, newExitStage: pos.exitStage ?? 0 };
    }
    if (ladderSuppressed) {
      // R15: while the ladder is off, the high-water mark and trailing stop must not keep ratcheting up, or enabling
      // AUTO_MANAGE_RECOVERED later would fire a trailing stop built from days of suppressed history at once.
      decision = { ...decision, newHighWaterMarkSol: pos.highWaterMarkSol ?? decision.newHighWaterMarkSol, newTrailingStopSol: pos.trailingStopSol ?? decision.newTrailingStopSol };
    }

    // Persist high_water_mark_sol and trailing_stop_sol to SQLite (B13). The exit stage only advances after the
    // sell actually fills: advancing it first would skip a take-profit stage when the sell reverts or is refused.
    const priorExitStage = pos.exitStage;
    pos.highWaterMarkSol = decision.newHighWaterMarkSol;
    pos.trailingStopSol = decision.newTrailingStopSol;
    pos.exitStage = decision.shouldExit ? priorExitStage : decision.newExitStage;
    pos.lastUpdatedTimestamp = posNow;
    // N1: this row was loaded before the awaits above (and before earlier positions' sells in this pass). If a manual
    // close, partial sell or reconcile changed it since, writing the stale copy back would resurrect a sold position
    // or undo a partial; skip it and let the next pass re-evaluate from the current row.
    const current = workstationDb.loadPositions(undefined, undefined).find((p) => p.id === pos.id);
    if (!current || current.status === 'CLOSED' || current.tokenQuantityRaw !== loadedQty.get(pos.id)) return;
    try {
      workstationDb.saveExitState(pos); // S11: only the exit engine's fields, so a stale copy cannot undo a sell; Q56: a failing write must not stop the exits in this pass
    } catch (err: any) {
      Logger.error(`[B13 ExitEngine] could not persist the trailing state of ${pos.symbol || pos.mint}: ${err.message}. Exit evaluation continues.`);
    }

    if (!decision.shouldExit) return;
    if (this.exitRetryWaitMs(pos.id, posNow, decision.reason) > 0) return; // R2-5: this reason backing off after a failed attempt (a TP's wait never holds the stop)
    if (this.inFlightPositionExits.has(pos.id)) return; // P1.7: its sell from an earlier pass is still running; it must not be sent twice
    if (this.panicActive && !PROTECTIVE_EXIT_REASONS.test(decision.reason)) {
      Logger.warn(`[B13 ExitEngine] ${decision.reason} for ${pos.symbol || pos.mint} refused: panic liquidation is running`);
      return;
    }
    Logger.info(
      `[B13 ExitEngine] ${decision.reason} triggered for ${pos.symbol || pos.mint} (Sell ${decision.sellPercentage}%, PnL: ${decision.profitPct.toFixed(2)}%)`
    );
    sells.push(this.dispatchExit(pos, decision.sellPercentage, decision.reason, priorExitStage, decision.newExitStage));
  }

  // Periodic Auto Position Monitor driven by ExitEngine (B13)
  private startAutoPositionMonitor() {
    this.autoTpSlInterval = setInterval(async () => {
      await this.evaluateAndProcessExits();
    }, 3000);
  }

  // Collect Comprehensive Truthful Diagnostics
  public getDiagnostics(): SystemDiagnostics {
    const activePositions = workstationDb.loadPositions(this.executionMode, 'ACTIVE');
    const signerStatus = localSigner.getStatus();
    const activeWallet =
      signerStatus === 'READY'
        ? localSigner.getPublicKey().toBase58()
        : 'NO_SIGNER_CONFIGURED';

    const now = Date.now();
    const jitoTelemetry = this.jitoTransport.getTelemetry();

    // Truthful market feed status derived from actual real on-chain events
    let marketFeedHealth: 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED' | 'WARMING_UP' = 'DISCONNECTED';
    let marketFeedLastEventMsAgo: number | null = null;
    if (this.lastRealMarketEventTimestamp > 0) {
      marketFeedLastEventMsAgo = now - this.lastRealMarketEventTimestamp;
      marketFeedHealth = marketFeedLastEventMsAgo < 30000 ? 'HEALTHY' : 'DEGRADED';
    } else if (now - this.startedAt < this.startupGracePeriodMs) {
      marketFeedHealth = 'WARMING_UP';
    } else if (this.lastMarketEventTimestamp > 0) {
      marketFeedLastEventMsAgo = now - this.lastMarketEventTimestamp;
      marketFeedHealth = 'DEGRADED';
    }

    const dailyFees = workstationDb.getDailyFeesPaidLamports(this.executionMode);

    return {
      executionMode: this.executionMode,
      liveTradingActive: this.isLiveTradingArmed,
      killSwitchActive: riskEngine.isKillSwitchActive(),
      circuitBreakerState: riskEngine.getCircuitBreakerState(),
      activeWalletAddress: activeWallet,
      signerStatus,
      rpcEndpoint: this.rpcEndpoint,
      rpcLatencyMs: this.rpcLatencyMs,
      rpcHealth: this.rpcHealth,
      pumpFeedHealth: (this.isDefaultSingleton && this.lastPumpFeedTimestamp === 0 && now - this.startedAt < this.startupGracePeriodMs)
        ? 'WARMING_UP'
        : this.pumpFeedHealth,
      positionMarkHealth: this.positionMarkHealth,
      operatorAlerts: this.getOperatorAlerts(),
      marketFeedHealth,
      marketFeedLastEventMsAgo: marketFeedLastEventMsAgo ?? 0,
      jitoHealth: jitoTelemetry.health === 'OFFLINE' ? 'DISCONNECTED' : jitoTelemetry.health,
      jitoTipFloorLamports: jitoTelemetry.tipFloorLamports ?? 0,
      walletSolBalance: this.realWalletBalanceSol,
      walletSpendableSol:
        this.realWalletBalanceSol !== null
          ? Math.max(0, this.realWalletBalanceSol - 0.015)
          : null,
      openPositionsCount: activePositions.length,
      dailyRealizedPnLSol: workstationDb.getDailyRealizedPnLSol(this.executionMode),
      dailyFeesPaidLamports: dailyFees,
      totalTradesToday: workstationDb.countReconciledTradesToday(this.executionMode),
      lastConfirmedTradeTime: workstationDb.getLastConfirmedTradeTime(this.executionMode),
      dbPath: workstationDb.getDbPath(),
      sqliteJournalOk: this.checkSqliteJournalOk(),
    };
  }

  private sqliteOkCache: { at: number; ok: boolean } | null = null;

  /** Real check: the DB takes a write lock and reports a known journal mode. Cached 30s so status polling never contends with writers. */
  private checkSqliteJournalOk(now: number = Date.now()): boolean {
    if (this.sqliteOkCache && now - this.sqliteOkCache.at < 30_000) return this.sqliteOkCache.ok;
    const mode = workstationDb.getJournalMode();
    const ok = workstationDb.isWritable() && mode !== 'error' && mode !== 'unknown' && mode.toLowerCase() !== 'off';
    this.sqliteOkCache = { at: now, ok };
    // Low-disk warning: below LOW_FREE_WARN_BYTES the operator is told while buys still go on; isWritable refuses them below MIN_FREE_BYTES.
    const free = workstationDb.getFreeBytes();
    if (free !== null && free < WorkstationDatabase.LOW_FREE_WARN_BYTES) {
      const mib = (b: number) => `${Math.floor(b / (1024 * 1024))} MiB`;
      this.raiseOperatorAlert('DISK_SPACE_LOW', `Only ${mib(free)} free on the database's disk (warning below ${mib(WorkstationDatabase.LOW_FREE_WARN_BYTES)}). Buys stop below ${mib(WorkstationDatabase.MIN_FREE_BYTES)}; free some space.`);
    } else {
      this.clearOperatorAlert('DISK_SPACE_LOW');
    }
    return ok;
  }

  private offRpcAuthRejected: (() => void) | null = null;
  /** R4-10: the RPC refused this process (HTTP 401/402/403): every send and read fails until the plan or key is fixed. Logged once, kept until restart. */
  private raiseRpcAuthAlert(status: number, method: string) {
    this.raiseOperatorAlert(RPC_AUTH_REJECTED, `${RPC_AUTH_REJECTED_TEXT}: the RPC answered HTTP ${status} to ${method}. Nothing refused this way was sent; sells and reads fail until SOLANA_RPC_URL points at a working plan or key.`);
  }

  public cleanup() {
    this.offRpcAuthRejected?.();
    this.offRpcAuthRejected = null;
    if (this.orphanRecoveryTimer) {
      clearTimeout(this.orphanRecoveryTimer);
      this.orphanRecoveryTimer = null;
    }
    if (this.reconcileRetryTimer) {
      clearTimeout(this.reconcileRetryTimer);
      this.reconcileRetryTimer = null;
    }
    if (this.autoTpSlInterval) {
      clearInterval(this.autoTpSlInterval);
      this.autoTpSlInterval = null;
    }
    if (this.jitoProbeInterval) {
      clearInterval(this.jitoProbeInterval);
      this.jitoProbeInterval = null;
    }
    if (this.feedHeartbeatInterval) {
      clearInterval(this.feedHeartbeatInterval);
      this.feedHeartbeatInterval = null;
    }
  }
}

/** 3F (R1-9): a mint whose position (in the same execution mode) was closed less than this long ago is not bought again; after a loss, never. */
export const MINT_REENTRY_BLOCK_MS = 24 * 60 * 60 * 1000;

export const executionCoordinator = new ExecutionCoordinator(true);
