import { EventEmitter } from 'events';
import { isReadOnly } from '../solana/readOnly';
import { workstationDb } from '../db/database';
import { traced } from '../observability/tracing';
import { executionCoordinator, isRecoveredPosition, LIVE_BUY_FILLED } from '../execution/coordinator';
import { CapitalSizer } from '../capital/capitalSizer';
import { memecoinAggregator } from '../memecoinAggregator';
import { solPriceService } from '../market/solPriceService';
import { executionConfig } from '../solana/executionConfig';
import { checkSnipeAmountSol, SNIPE_AMOUNT_MIN_SOL } from '../execution/snipeAmount';
import { allowedCluster, assertClusterAllowed } from '../solana/clusterGuard';
import { Logger } from '../middleware/enterprise';
import type { SignalProvenance } from '../core/types';
import { computeJournalStats, type JournalStats } from './journalStats';
import { evaluateKillTriggers, auditWalletChange, type KillTrigger } from './killSwitch';
import { riskEngine, PUMP_USER_VOLUME_ACCUMULATOR_RENT_LAMPORTS } from '../risk/riskEngine';
import { watchWindow, readyGate, type WatchResult, type WatchVerdict } from '../signals/watchWindow';
import { checkConfluenceThreshold, getConfluenceThreshold, setConfluenceThreshold, confluenceThresholdInfo, CONFLUENCE_DEVNET_LIVE_FLOOR, type ConfluenceThresholdInfo } from '../signals/confluenceThreshold';
import { isCurveTooFar, curveTooFarReason } from '../signals/curveProgressCap';
import { onChainPoolStats } from '../market/poolStats';
import { dbLockPath, liveLockHolder } from '../system/instanceLock';

/**
 * G1: the only owner of auto trading.
 *
 * Both candidate sources (pumpfunService callouts, the memecoinAggregator sniper loop) hand candidates to
 * `submitCandidate`; neither may call execution directly. The mode is saved, and a restart brings it back up to PAPER
 * (a saved DEVNET_LIVE comes back as SHADOW and needs a fresh arm). There is no mainnet mode. Open positions stay under the exit engine in every mode.
 *
 *   OFF         drop every candidate (manual trades still work)
 *   SHADOW      run every gate and journal "would buy"; nothing is sent or filled
 *   PAPER       simulated fills through the coordinator (coordinator must be in PAPER)
 *   DEVNET_LIVE real devnet orders: fixed small size, at most 1 open position, cluster check must say devnet,
 *               coordinator armed LIVE, confirmation code required
 */
export type AutoMode = 'OFF' | 'SHADOW' | 'PAPER' | 'DEVNET_LIVE';

export const DEVNET_CONFIRMATION_CODE = 'CONFIRM_AUTO_DEVNET';
/** Fixed order size in DEVNET_LIVE. */
export const AUTO_DEVNET_ORDER_SOL = 0.005;
export const DEVNET_MAX_OPEN_POSITIONS = 1;

export const SESSION_BUDGETS = {
  maxBuys: 5,
  maxSpendSol: 0.02, // including fees
  maxLossFraction: 0.15, // realized + unrealized, of the starting bankroll
  maxDurationMs: 4 * 60 * 60 * 1000,
} as const;

/**
 * Q28: the 0.02 SOL / 5 buy limits above are a REAL-SOL cap for DEVNET_LIVE. Applied to PAPER (orders of ~0.007 SOL on the 0.07 SOL
 * paper bankroll) they ended every PAPER session after 2 or 3 buys, far too few to say anything about expectancy. A paper session
 * may turn its bankroll over: spend up to 10x the starting bankroll and 50 buys. Loss and time limits are the same.
 */
export const PAPER_SESSION_BUDGETS = {
  maxBuys: 50,
  maxSpendBankrollMultiple: 10,
  maxLossFraction: 0.15,
  maxDurationMs: 4 * 60 * 60 * 1000,
} as const;

export interface SessionBudgets {
  maxBuys: number;
  maxSpendSol: number;
  maxLossFraction: number;
  maxDurationMs: number;
}

export interface AutoCandidate {
  mint: string;
  symbol?: string;
  source: 'PUMPFUN_CALLOUT' | 'AGGREGATOR_LOOP' | 'WATCH_WINDOW' | 'TEST';
  signalId?: string;
  provenance?: SignalProvenance;
  amountUsd?: number;
  slippagePct?: number;
  jitoTipSol?: number;
  enforceConfluence?: boolean;
}

export type AutoOutcome = 'DROPPED' | 'WOULD_BUY' | 'BOUGHT' | 'REJECTED';

export interface AutoDecision {
  ts: number;
  mode: AutoMode;
  mint: string;
  symbol?: string;
  source: AutoCandidate['source'];
  outcome: AutoOutcome;
  /** Pipeline stage that decided (G3): queue | auto | watch | curve | budget | eligibility | score | size | risk | execute | fill | exit */
  stage: string;
  reason: string;
  amountSol?: number;
  positionId?: string;
}

export interface AutoSession {
  startedAt: number;
  startingBankrollSol: number;
  buys: number;
  spentSol: number;
  positionIds: string[];
  /** The limits this session runs under, fixed when it starts (PAPER and DEVNET_LIVE differ). */
  budgets: SessionBudgets;
}

export interface AutoStatus {
  /** false when AUTO_SNIPE_ENABLED is not "true": every mode but OFF is refused. The panel tells the operator how to enable it. */
  envEnabled: boolean;
  mode: AutoMode;
  killed: boolean;
  killReason: string | null;
  downgradeReason: string | null;
  /** G3: kill-switch triggers that dropped the controller to SHADOW, and the all-trading halt reason if one is set. */
  triggers: KillTrigger[];
  haltReason: string | null;
  slippageBreaches: number;
  session: (AutoSession & { sessionPnlSol: number; budgetsLeft: { buys: number; spendSol: number; lossSol: number; msLeft: number } }) | null;
  budgets: SessionBudgets;
  /** S181: the largest session spend the operator may set (3 x MAX_POSITION_SIZE_SOL), and the smallest (one order). */
  budgetLimits: { maxSpendSol: number; minSpendSol: number; maxBuys: number; capKind: 'PAPER' | 'REAL'; capNote: string };
  /** S183: size of one auto order (SOL) and the bounds the server accepts for it. */
  orderSol: number;
  orderLimits: { minSol: number; maxSol: number };
  /** S187: the confluence buy threshold in force (HOT gate and execution gate together). */
  confluence: ConfluenceThresholdInfo;
  /** S189: set while a PAPER session waits in SHADOW for readiness to stay green; it then comes back by itself. */
  autoRestore: { greenForMs: number; needMs: number } | null;
}

const MAX_DECISIONS = 500;
/** Q27: the same unwatched / pending / dead mint from the same source is not journaled again for this long. */
export const DROP_REPEAT_MS = 10 * 60_000;
/** S4b: how many releases may wait behind a buy in flight, and how long a signal stays good (the watch window decides in 120 s; a release older than this is not acted on late). */
export const PENDING_RELEASE_MAX = 10;
/**
 * P4.3 (R1-46, R1-59): what the curve, eligibility and balance reads take between a queued release leaving the queue and the risk engine checking its
 * age. A queued release is kept only while it is younger than the risk engine's signal-age limit (8 s) minus this, so it is never retried just to fail
 * STALE_SIGNAL after a round of RPC reads. Measured from the release (`releasedAt`), not from when it was queued.
 */
export const RELEASE_READ_ALLOWANCE_MS = 2_000;
/** The default that rule gives: 8 000 - 2 000 ms (was 20 s, longer than the 8 s signal-age limit). `pendingReleaseMaxAgeMs` follows the risk engine's limit. */
export const PENDING_RELEASE_MAX_AGE_MS = 6_000;
/** P4.3 (R1-46): a watch release refused for a passing reason (a cooldown, a stale read) is tried again after this, while it is still fresh. */
export const RELEASE_RETRY_MS = 2_000;

/** The queue age limit in force: never above PENDING_RELEASE_MAX_AGE_MS, nor above the risk engine's signal-age limit minus the read allowance. */
export function pendingReleaseMaxAgeMs(): number {
  return Math.max(0, Math.min(PENDING_RELEASE_MAX_AGE_MS, riskEngine.getLimits().maxSignalAgeMs - RELEASE_READ_ALLOWANCE_MS));
}

/**
 * P4.3 (R1-46): refusals that say "not now", not "not this mint": a cooldown after a failed trade, a stale or missing market read, the SOL price, the
 * wallet balance, exposure, a halt or kill switch that may be lifted, a mode that changed under the trade. Such a candidate is not marked attempted,
 * so a later submission (or the watch-release retry) while its signal is fresh can still buy. Everything else (a send, an eligibility, score or
 * curve refusal, a stale signal, an unknown error) is final for the session. Pre-send refusals only: no message here is produced after a send.
 */
export const RETRYABLE_REJECTION = /^(REJECTED: )?(EXECUTION_DISABLED|CIRCUIT_BREAKER_OPEN|KILL_SWITCH_ACTIVE|TRADING_HALTED|STALE_MARKET_DATA|SOL_PRICE_UNAVAILABLE|WALLET_BALANCE_UNKNOWN|MARKET_DATA_UNAVAILABLE|MAX_EXPOSURE|INSUFFICIENT_BALANCE|SIGNER_UNAVAILABLE|MODE_CHANGED)\b/;
const MONITOR_INTERVAL_MS = 5_000;
/** S222: keys in `app_settings`. */
const SETTING_THRESHOLD = 'auto.confluenceThreshold';
const SETTING_MODE = 'auto.mode';
/** 3E: the last kill, `{ reason, ts }`, or null once an operator has set a trading mode again. Read back by `restorePersisted`. */
const SETTING_KILL = 'auto.kill';
/** S189: how long readiness must stay green before a PAPER session downgraded by READINESS_RED is put back. */
export const READINESS_RESTORE_GREEN_MS = 60_000;

/** Map a rejection message to the pipeline stage that produced it. */
export function classifyRejection(message: string): string {
  const m = message || '';
  if (/^(REJECTED: )?CURVE_PROGRESS_TOO_HIGH/.test(m)) return 'curve';
  if (/^(REJECTED: )?(ELIGIBILITY|UNSUPPORTED_TOKEN|SAFETY_CHECK|Freeze authority|Creator holds)/.test(m)) return 'eligibility';
  if (/Confluence score/.test(m)) return 'score';
  if (/^(REJECTED: )?(Capital sizing|WALLET_BALANCE_UNKNOWN|SOL_PRICE_UNAVAILABLE)|^(EXCEEDS_CAPITAL_CEILING|INSUFFICIENT_|EXPECTED_EDGE_BELOW|MARKET_DATA_UNAVAILABLE)/.test(m)) return 'size';
  if (/^(CIRCUIT_BREAKER_OPEN|DAILY_LOSS_LIMIT|DUPLICATE_MINT|EXECUTION_DISABLED|FEE_TOO_HIGH|INSUFFICIENT_BALANCE|KILL_SWITCH_ACTIVE|MAX_EXPOSURE|MAX_POSITION_SIZE|PRICE_IMPACT_TOO_HIGH|SLIPPAGE_TOO_HIGH|STALE_MARKET_DATA|STALE_SIGNAL|TRADING_HALTED)/.test(m)) return 'risk';
  return 'execute';
}

export class AutoSnipeController extends EventEmitter {
  constructor() {
    super();
    this.on('mode', () => this.persistMode());
  }

  private mode: AutoMode = 'OFF'; // S222: restored from the last run at startup by `restorePersisted`, never above PAPER
  private killed = false;
  private killReason: string | null = null;
  private downgradeReason: string | null = null;
  private session: AutoSession | null = null;
  private decisions: AutoDecision[] = [];
  private attempted = new Set<string>();
  private busy = false;
  /** Q27: last watch-stage drop per mint, source, mode and verdict. */
  private repeatDrops = new Map<string, { ts: number; decision: AutoDecision }>();
  /** Q29: the buy now in progress, so kill() and setMode() can wait for it instead of racing it. */
  private inflight: Promise<void> | null = null;
  private triggers: KillTrigger[] = [];
  private slippageBreaches = 0;
  private redSince = new Map<string, number>();
  private monitorTimer: NodeJS.Timeout | null = null;
  private walletMark: { sol: number; ts: number } | null = null;

  public getMode(): AutoMode {
    return this.mode;
  }

  /** Session stats straight from the decision journal. Journal rows since the current session started (or all rows when OFF). */
  public getJournalStats(): JournalStats {
    const rows = workstationDb.loadDecisions({ sinceTs: this.session?.startedAt, limit: 5000 });
    const status = new Map(workstationDb.loadPositions().map((p) => [p.id, p.status as string]));
    return computeJournalStats(rows, (id) => status.get(id));
  }

  public getDecisions(limit = 100): AutoDecision[] {
    return this.decisions.slice(-limit).map((d) => ({ ...d }));
  }

  /**
   * P4.3 (R1-56): the watch facts every decision row carries, so the journal shows what a release had behind it. passingSignals is null for a mint the
   * window never released (never watched, still watching).
   */
  private static watchInputs(v: WatchVerdict | null): Record<string, unknown> {
    return {
      watchState: v?.state ?? null,
      passingSignals: v?.passingSignals ?? null,
      concentrationPass: v?.concentrationPass ?? null,
      releaseScore: v?.score ?? null,
      releasedAt: v?.releasedAt ?? null,
    };
  }

  private record(c: AutoCandidate, outcome: AutoOutcome, stage: string, reason: string, extra: Partial<AutoDecision> & { feesSol?: number; inputs?: Record<string, any>; unverified?: boolean } = {}): AutoDecision {
    const { feesSol: _f, inputs: _i, unverified: _u, ...pub } = extra;
    const d: AutoDecision = { ts: Date.now(), mode: this.mode, mint: c.mint, symbol: c.symbol, source: c.source, outcome, stage, reason, ...pub };
    this.decisions.push(d);
    if (this.decisions.length > MAX_DECISIONS) this.decisions.shift();
    // 3B (R1-38): a BOUGHT row carries no wallet delta. The coordinator journals every landed LIVE buy (LIVE_BUY_FILLED, the whole wallet
    // delta with rent, keyed by the same positionId), whoever placed it; a delta here as well would count an auto buy twice in the audit.
    // (Q8: a PAPER fill never had one.)
    workstationDb.logDecision({
      ts: d.ts,
      autoMode: d.mode,
      mint: d.mint,
      symbol: d.symbol,
      source: d.source,
      stage: d.stage,
      outcome: d.outcome,
      reason: d.reason,
      inputs: extra.inputs,
      positionId: d.positionId,
      unverified: extra.unverified,
    });
    this.emit('decision', d);
    return d;
  }

  private sessionPnlSol(): number {
    if (!this.session) return 0;
    const ids = new Set(this.session.positionIds);
    if (ids.size === 0) return 0;
    return workstationDb
      .loadPositions()
      .filter((p) => ids.has(p.id))
      .reduce((acc, p) => acc + (p.realizedPnLSol ?? 0) + (p.status === 'CLOSED' ? 0 : p.unrealizedPnLSol ?? 0), 0);
  }

  /** S181: operator-edited session budget. In memory only, like the mode: a restart returns the defaults. */
  private budgetOverride: { maxBuys: number; maxSpendSol: number } | null = null;

  /** The most a REAL-SOL session may spend: the risk engine's own aggregate exposure limit (3 x MAX_POSITION_SIZE_SOL). */
  public static maxSessionSpendSol(): number {
    return executionConfig.getConfig().maxPositionSizeSol * 3;
  }

  /** S189: the most a PAPER session may spend: the ceiling the server itself starts a PAPER session with (10 x the paper bankroll). Paper spends nothing. */
  public static maxPaperSessionSpendSol(): number {
    return PAPER_SESSION_BUDGETS.maxSpendBankrollMultiple * executionConfig.getConfig().paperBankrollSol;
  }

  /** S189: which kind of session the budget editor is talking to. A running (or SHADOW-downgraded) PAPER session is PAPER; anything else gets the real-SOL cap. */
  private sessionKind: 'PAPER' | 'DEVNET_LIVE' | null = null;
  private spendCap(): { cap: number; kind: 'PAPER' | 'REAL'; note: string } {
    if (this.session && this.sessionKind === 'PAPER') {
      const cap = AutoSnipeController.maxPaperSessionSpendSol();
      return { cap, kind: 'PAPER', note: '10 x the paper bankroll, the PAPER session ceiling' };
    }
    return { cap: AutoSnipeController.maxSessionSpendSol(), kind: 'REAL', note: '3 x MAX_POSITION_SIZE_SOL' };
  }

  /**
   * S181: change the session budget. Refused (never clamped) when the spend is below one order or above the server's cap.
   * It applies to the running session at once and to every later one.
   */
  public setBudget(b: { maxBuys: number; maxSpendSol: number }): { ok: boolean; reason?: string } {
    const { cap, note } = this.spendCap();
    if (!Number.isInteger(b.maxBuys) || b.maxBuys < 1 || b.maxBuys > 50) return { ok: false, reason: 'REJECTED: max buys must be a whole number from 1 to 50.' };
    const order = this.orderSol();
    if (!Number.isFinite(b.maxSpendSol) || b.maxSpendSol < order) {
      return { ok: false, reason: `REJECTED: the session spend limit must cover at least one order (${order} SOL).` };
    }
    if (b.maxSpendSol > cap + 1e-9) {
      return { ok: false, reason: `REJECTED: ${b.maxSpendSol} SOL is above the ${Number(cap.toFixed(6))} SOL session cap (${note}).${note.startsWith('10 x') ? ' Lower it.' : ' Lower it, or raise MAX_POSITION_SIZE_SOL in .env and restart.'}` };
    }
    this.budgetOverride = { maxBuys: b.maxBuys, maxSpendSol: b.maxSpendSol };
    if (this.session) this.session.budgets = { ...this.session.budgets, ...this.budgetOverride };
    workstationDb.logDecision({ autoMode: this.mode, mint: '-', stage: 'budget', outcome: 'INFO', reason: `operator set the session budget: ${b.maxBuys} buys, ${b.maxSpendSol} SOL` });
    return { ok: true };
  }

  /** S183: operator-set size of one auto order in SOL. In memory only, like the mode. Null: the built-in default. */
  private orderSolOverride: number | null = null;

  /** The size of one auto order: the operator's, else the fixed 0.005 SOL. */
  public orderSol(): number {
    return this.orderSolOverride ?? AUTO_DEVNET_ORDER_SOL;
  }

  /**
   * S183: change the size of one auto order. The same refusal rules as the manual snipe amount (not a number, under the minimum, over
   * MAX_POSITION_SIZE_SOL), plus: it must fit inside the session spend limit. Refused, never clamped. It applies from the next order.
   * Once set it sizes every auto buy that is sent or simulated (PAPER and DEVNET_LIVE), so paper results match what live would do.
   */
  public setOrderSol(sol: number): { ok: boolean; reason?: string } {
    const check = checkSnipeAmountSol(sol);
    if (!check.ok) return { ok: false, reason: check.reason };
    const spendLimit = (this.session?.budgets ?? this.getStatus().budgets).maxSpendSol;
    if (sol > spendLimit + 1e-9) {
      return { ok: false, reason: `REJECTED: AUTO_ORDER_ABOVE_SESSION_LIMIT: ${sol} SOL is above the ${Number(spendLimit.toFixed(6))} SOL session spend limit; raise the session budget first.` };
    }
    this.orderSolOverride = sol;
    workstationDb.logDecision({ autoMode: this.mode, mint: '-', stage: 'budget', outcome: 'INFO', reason: `operator set the auto order size: ${sol} SOL` });
    return { ok: true };
  }

  /** S187: set the one confluence buy threshold (watch window HOT gate and the execution gate, manual snipes included). Journaled. */
  public setConfluenceThreshold(raw: unknown): { ok: boolean; reason?: string; value?: number } {
    const r = setConfluenceThreshold(raw);
    if (!r.ok) return { ok: false, reason: r.reason };
    workstationDb.logDecision({ autoMode: this.mode, mint: '-', stage: 'score', outcome: 'INFO', reason: `operator set the confluence buy threshold: ${r.previous} -> ${r.value} (watch window HOT gate and execution gate together)` });
    workstationDb.setSetting(SETTING_THRESHOLD, r.value); // S222: kept across restarts
    return { ok: true, value: r.value };
  }

  /**
   * S222: bring back what the operator had set before a restart. The confluence threshold always. The mode only up to PAPER: a saved
   * DEVNET_LIVE comes back as SHADOW (nothing is sent) and needs a fresh arm and confirmation code, so a restart never resumes live
   * sending by itself. A mode that cannot be restored (AUTO_SNIPE_ENABLED not true, coordinator not in PAPER) leaves auto OFF.
   * 3E: a kill saved by the last run (`auto.kill`) keeps auto OFF and `killed` with its reason, until an operator sets a mode.
   * Call once at startup, before `startMonitor`.
   */
  public async restorePersisted(): Promise<{ threshold: number | null; mode: AutoMode; note: string | null }> {
    let threshold: number | null = null;
    const savedThreshold = workstationDb.getSetting<unknown>(SETTING_THRESHOLD);
    if (savedThreshold !== null) {
      const c = checkConfluenceThreshold(savedThreshold);
      if (c.ok) { setConfluenceThreshold(c.value); threshold = c.value; } else Logger.warn(`[AUTO] saved confluence threshold ignored: ${c.reason}`);
    }
    let note: string | null = null;
    // P1.1 (N-59): another live process owns this database. Restoring here would start a second session on it and rewrite the mode that
    // process saved, out of reach of its kill switch. The instance lock normally stops a second server before this; this is the backstop.
    const lock = dbLockPath(workstationDb.getDbPath());
    const holder = lock ? liveLockHolder(lock) : null;
    if (holder && holder.pid !== process.pid) {
      note = `restart: auto mode not restored: process ${holder.pid} holds ${lock}; auto stays OFF and the saved mode is left as it is`;
      Logger.warn(`[AUTO] ${note}`);
      return { threshold, mode: this.mode, note };
    }
    // 3E: a kill saved by the last run keeps auto OFF and killed, whatever mode is saved (a kill that saved OFF but crashed mid-way, or an
    // older build that saved the mode only at the end of the kill). Only an operator setting a mode again clears it.
    const savedKill = workstationDb.getSetting<{ reason?: unknown; ts?: unknown }>(SETTING_KILL);
    if (savedKill && typeof savedKill === 'object') {
      this.killed = true;
      this.killReason = typeof savedKill.reason === 'string' && savedKill.reason ? savedKill.reason : 'kill before the restart (no reason saved)';
      note = `restart: auto was killed before the restart (${this.killReason}); auto stays OFF until an operator sets a mode`;
      if (workstationDb.getSetting<unknown>(SETTING_MODE) !== 'OFF') workstationDb.setSetting(SETTING_MODE, 'OFF');
      Logger.warn(`[AUTO] ${note}`);
      workstationDb.logDecision({ autoMode: this.mode, mint: '-', stage: 'auto', outcome: 'INFO', reason: note });
      return { threshold, mode: this.mode, note };
    }
    const saved = workstationDb.getSetting<unknown>(SETTING_MODE);
    if (saved === 'PAPER' || saved === 'SHADOW' || saved === 'DEVNET_LIVE') {
      const target: AutoMode = saved === 'DEVNET_LIVE' ? 'SHADOW' : saved;
      const res = await this.setMode(target);
      if (res.ok) {
        note = saved === 'DEVNET_LIVE'
          ? 'restart: the last run was in DEVNET_LIVE; auto came back as SHADOW (nothing is sent). Arm LIVE and set DEVNET_LIVE again to trade.'
          : `restart: auto mode ${target} restored from the last run`;
        if (saved === 'DEVNET_LIVE') this.downgradeReason = note;
        workstationDb.logDecision({ autoMode: this.mode, mint: '-', stage: 'auto', outcome: 'INFO', reason: note });
      } else {
        note = `restart: could not restore auto mode ${target} (${res.error}); auto stays OFF`;
        Logger.warn(`[AUTO] ${note}`);
      }
    }
    if (note) Logger.info(`[AUTO] ${note}`);
    return { threshold, mode: this.mode, note };
  }

  /** S222: every mode change is saved, so `restorePersisted` can bring it back. */
  private persistMode = (): void => { workstationDb.setSetting(SETTING_MODE, this.mode); };

  /** 3E: save OFF and the kill reason now, synchronously. A failed write is logged; the in-memory kill still holds for this process. */
  private persistKill(): void {
    const modeSaved = workstationDb.setSetting(SETTING_MODE, 'OFF');
    const killSaved = workstationDb.setSetting(SETTING_KILL, { reason: this.killReason, ts: Date.now() });
    if (!modeSaved || !killSaved) Logger.error(`[AUTO] kill: could not save auto OFF and the kill reason; a restart may not know auto was killed (${this.killReason})`);
  }

  public getStatus(): AutoStatus {
    this.settleUnresolvedSpend();
    this.enforceBudgets();
    this.dropDevnetLiveIfUnarmed(); // P1.4: the status never shows a DEVNET_LIVE session that can no longer trade
    let session: AutoStatus['session'] = null;
    if (this.session) {
      const pnl = this.sessionPnlSol();
      session = {
        ...this.session,
        sessionPnlSol: pnl,
        budgetsLeft: {
          buys: Math.max(0, this.session.budgets.maxBuys - this.session.buys),
          spendSol: Math.max(0, this.session.budgets.maxSpendSol - this.session.spentSol),
          lossSol: Math.max(0, this.session.budgets.maxLossFraction * this.session.startingBankrollSol + pnl),
          msLeft: Math.max(0, this.session.budgets.maxDurationMs - (Date.now() - this.session.startedAt)),
        },
      };
    }
    return {
      envEnabled: process.env.AUTO_SNIPE_ENABLED === 'true',
      mode: this.mode, killed: this.killed, killReason: this.killReason, downgradeReason: this.downgradeReason,
      triggers: [...this.triggers], haltReason: executionCoordinator.getHaltReason(), slippageBreaches: this.slippageBreaches,
      session, budgets: session?.budgets ?? (this.budgetOverride ? { ...SESSION_BUDGETS, ...this.budgetOverride } : SESSION_BUDGETS),
      budgetLimits: { maxSpendSol: this.spendCap().cap, minSpendSol: this.orderSol(), maxBuys: 50, capKind: this.spendCap().kind, capNote: this.spendCap().note },
      orderSol: this.orderSol(),
      orderLimits: { minSol: SNIPE_AMOUNT_MIN_SOL, maxSol: executionConfig.getConfig().maxPositionSizeSol },
      confluence: confluenceThresholdInfo(),
      autoRestore: this.autoRestore ? { greenForMs: this.autoRestore.greenSince === null ? 0 : Date.now() - this.autoRestore.greenSince, needMs: READINESS_RESTORE_GREEN_MS } : null,
    };
  }

  /** Drop to SHADOW when any session budget has run out. Called before every decision and status read. */
  private enforceBudgets(): string | null {
    if (!this.session || (this.mode !== 'PAPER' && this.mode !== 'DEVNET_LIVE')) return null;
    const s = this.session;
    const b = s.budgets;
    let reason: string | null = null;
    if (s.buys >= b.maxBuys) reason = `max buys per session (${b.maxBuys}) used`;
    else if (s.spentSol >= b.maxSpendSol) reason = `max spend per session (${Number(b.maxSpendSol.toFixed(4))} SOL incl. fees) used`;
    else if (Date.now() - s.startedAt >= b.maxDurationMs) reason = 'session time limit (4h) reached';
    else if (this.sessionPnlSol() <= -b.maxLossFraction * s.startingBankrollSol) {
      reason = `session loss reached ${b.maxLossFraction * 100}% of the starting bankroll`;
    }
    if (reason) {
      this.mode = 'SHADOW';
      this.downgradeReason = reason;
      Logger.warn(`[AUTO] budget exhausted: ${reason}. Dropped to SHADOW.`);
      this.emit('mode', { mode: this.mode, reason });
    }
    return reason;
  }

  /** S17: how long kill()/setMode() wait for a buy in flight. It settles in a `finally`, so this is a backstop, not an expected path. */
  private inflightWaitMs = 90_000;

  private async waitInflight(who: string): Promise<void> {
    const p = this.inflight;
    if (!p) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      p.then(() => false),
      new Promise<boolean>((r) => { timer = setTimeout(() => r(true), this.inflightWaitMs); timer.unref?.(); }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) Logger.warn(`[AUTO] ${who}: a buy in flight did not settle within ${this.inflightWaitMs} ms; continuing without it. A position it opens later is still found through the decision journal.`);
  }

  public async setMode(next: AutoMode, opts: { confirmationCode?: string } = {}): Promise<{ ok: boolean; mode: AutoMode; error?: string }> {
    if (!['OFF', 'SHADOW', 'PAPER', 'DEVNET_LIVE'].includes(next)) return { ok: false, mode: this.mode, error: `unknown mode ${next}` };
    this.autoRestore = null; // S189: an operator choice replaces any pending automatic restore
    if (next === 'OFF') {
      this.mode = 'OFF';
      this.clearPendingReleases();
      // Q29: OFF stops new candidates at once; the session is dropped only after a buy in flight has booked itself in it
      await this.waitInflight('setMode(OFF)');
      this.session = null;
      this.downgradeReason = null;
      this.emit('mode', { mode: this.mode });
      return { ok: true, mode: this.mode };
    }
    if (process.env.AUTO_SNIPE_ENABLED !== 'true') {
      return { ok: false, mode: this.mode, error: 'AUTO_SNIPE_ENABLED is not true: auto trading stays OFF' };
    }
    // Q29: never swap the session under a buy in flight; its spend and position belong to the session it started in
    await this.waitInflight('setMode');
    const coordMode = executionCoordinator.getExecutionMode();
    if (next === 'PAPER' && coordMode !== 'PAPER') {
      return { ok: false, mode: this.mode, error: 'PAPER auto mode needs the execution coordinator in PAPER' };
    }
    if (next === 'DEVNET_LIVE') {
      if (isReadOnly()) return { ok: false, mode: this.mode, error: 'DEVNET_LIVE is refused: APEX_READ_ONLY=true allows OFF, SHADOW and PAPER only.' };
      if (allowedCluster() === 'mainnet-beta') return { ok: false, mode: this.mode, error: 'DEVNET_LIVE is refused: ALLOWED_CLUSTER is mainnet-beta (devnet or localnet only). There is no mainnet auto mode.' };
      if (coordMode !== 'LIVE') return { ok: false, mode: this.mode, error: 'DEVNET_LIVE needs the coordinator armed LIVE (on devnet)' };
      // S189: a spend limit saved for PAPER (up to 10 x the paper bankroll) must never carry into real SOL
      const realCap = AutoSnipeController.maxSessionSpendSol();
      if (this.budgetOverride && this.budgetOverride.maxSpendSol > realCap + 1e-9) {
        return { ok: false, mode: this.mode, error: `DEVNET_LIVE is refused: the saved session spend limit (${this.budgetOverride.maxSpendSol} SOL) is above the ${Number(realCap.toFixed(6))} SOL real-SOL cap. Lower it first (it was allowed because PAPER spends nothing).` };
      }
      if (opts.confirmationCode !== DEVNET_CONFIRMATION_CODE) return { ok: false, mode: this.mode, error: 'DEVNET_LIVE needs the confirmation code' };
      try {
        await assertClusterAllowed(executionCoordinator.getConnection());
      } catch (e: any) {
        return { ok: false, mode: this.mode, error: `cluster check failed: ${e.message}` };
      }
    }
    this.killed = false;
    this.killReason = null;
    workstationDb.setSetting(SETTING_KILL, null); // 3E: an operator setting a mode again is what clears a kill, here and after a restart
    this.downgradeReason = null;
    this.triggers = [];
    this.slippageBreaches = 0;
    this.redSince.clear();
    this.walletMark = null;
    this.attempted.clear();
    this.clearPendingReleases();
    this.mode = next;
    if (next === 'PAPER' || next === 'DEVNET_LIVE') {
      // S12: only DEVNET_LIVE sizes from the real wallet; PAPER trades a simulated bankroll, so its budgets must not depend on what the wallet holds.
      const paperBankroll = executionConfig.getConfig().paperBankrollSol;
      const bankroll = next === 'DEVNET_LIVE' ? (executionCoordinator.getRealWalletBalanceSol() ?? paperBankroll) : paperBankroll;
      const base: SessionBudgets = next === 'PAPER'
        ? { maxBuys: PAPER_SESSION_BUDGETS.maxBuys, maxSpendSol: PAPER_SESSION_BUDGETS.maxSpendBankrollMultiple * bankroll, maxLossFraction: PAPER_SESSION_BUDGETS.maxLossFraction, maxDurationMs: PAPER_SESSION_BUDGETS.maxDurationMs }
        : { ...SESSION_BUDGETS };
      // S181: the operator's saved budget (buys and spend) replaces the defaults; loss and time limits stay fixed.
      const budgets: SessionBudgets = this.budgetOverride ? { ...base, ...this.budgetOverride } : base;
      this.session = { startedAt: Date.now(), startingBankrollSol: bankroll, buys: 0, spentSol: 0, positionIds: [], budgets };
      this.sessionKind = next;
    } else {
      this.session = null;
    }
    this.emit('mode', { mode: this.mode });
    return { ok: true, mode: this.mode };
  }

  /** Kill switch for auto trading: back to OFF now, optionally selling everything the session opened. Exits keep running otherwise. */
  public async kill(opts: { exitAll?: boolean; reason?: string } = {}): Promise<{ mode: AutoMode; closed: number }> {
    this.mode = 'OFF';
    this.autoRestore = null;
    this.killed = true;
    this.killReason = opts.reason || 'operator kill';
    // 3E (R1-43): saved before the first await. The `mode` event below comes only after the wait and the closes, so a crash or a close that
    // never returns used to leave the old mode saved, and restorePersisted brought it back on the next boot.
    this.persistKill();
    this.clearPendingReleases(); // P1.4: a release queued behind the buy in flight is not bought after a kill
    // Q29: a buy already past the gates finishes (its position exists once it does); wait for it so its position is in the owned set below
    // and is sold by exitAll. Mode OFF already stops any new candidate.
    await this.waitInflight('kill');
    // R23: "sell what it bought" means the positions the auto controller opened: this session's, plus any the journal records as
    // BOUGHT by auto (a restart empties the in-memory session). A position the operator opened by hand is never in either set.
    const owned = new Set<string>(this.session?.positionIds ?? []);
    for (const d of workstationDb.loadDecisions({ outcome: 'BOUGHT', limit: 5000 })) if (d.positionId) owned.add(d.positionId);
    this.session = null;
    let closed = 0;
    if (opts.exitAll) {
      for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) {
        if (!owned.has(p.id)) continue;
        const r = await executionCoordinator.closePosition(p.id, 100, 'MANUAL');
        if (r.success) closed++;
      }
    }
    Logger.warn(`[AUTO] kill: ${this.killReason}; closed ${closed} position(s)`);
    this.emit('mode', { mode: this.mode, reason: this.killReason });
    return { mode: this.mode, closed };
  }

  // ---- G3: kill switch ---------------------------------------------------------------------------------------

  /**
   * Evaluate the kill-switch triggers. A hit drops PAPER / DEVNET_LIVE to SHADOW: buys stop, candidates are still
   * journaled as "would buy", and exits keep running. A DEVNET_LIVE hit also disarms the coordinator (S207). Only an operator setting the mode again brings buys back.
   */
  public async checkTriggers(now = Date.now()): Promise<KillTrigger[]> {
    if (this.mode === 'SHADOW' && this.autoRestore) { this.tryAutoRestore(now); return []; }
    if (this.dropDevnetLiveIfUnarmed()) return [];
    if (this.mode !== 'PAPER' && this.mode !== 'DEVNET_LIVE') return [];
    const live = this.mode === 'DEVNET_LIVE';
    const execMode = live ? 'LIVE' : 'PAPER';

    const comps = executionCoordinator.getLiveReadiness().components;
    const watched: Array<[string, boolean]> = [['rpc', comps.rpc.healthy], ['markFeed', comps.markFeed.healthy], ['db', comps.db.healthy]];
    for (const [name, healthy] of watched) {
      if (healthy) this.redSince.delete(name);
      else if (!this.redSince.has(name)) this.redSince.set(name, now);
    }

    const ctx = {
      mode: this.mode,
      closedNetPnlSol: this.sessionEvidencePnl(execMode),
      dailyTotalPnlSol: riskEngine.getDailyTotalPnLSol(execMode),
      maxDailyLossSol: riskEngine.effectiveMaxDailyLossSol(),
      slippageBreaches: this.slippageBreaches,
      readinessRed: [...this.redSince.entries()].map(([name, since]) => ({ name, redForMs: now - since })),
      walletSol: executionCoordinator.getRealWalletBalanceSol(),
      reserveSol: 0.015,
      maxTradeSol: this.orderSol(),
    };
    const hits = evaluateKillTriggers(ctx);
    if (hits.length === 0) return [];

    const reason = `kill switch: ${hits.map((h) => `${h.code} (${h.message})`).join('; ')}`;
    const from = this.mode;
    this.triggers = hits;
    this.mode = 'SHADOW';
    this.downgradeReason = reason;
    // S189: nothing real is at risk in PAPER, so a downgrade caused ONLY by a flapping readiness check comes back by itself once readiness has
    // been green for a while. DEVNET_LIVE stays sticky (an operator sets it again), and so does any other trigger.
    this.autoRestore = from === 'PAPER' && hits.every((h) => h.code === 'READINESS_RED') ? { greenSince: null } : null;
    // S207: a tripped DEVNET_LIVE session also disarms the coordinator, so nothing can keep sending on a LIVE arming left over from before the trip.
    if (from === 'DEVNET_LIVE') executionCoordinator.armLiveTrading(false);
    workstationDb.logDecision({ autoMode: from, mint: '-', stage: 'risk', outcome: 'KILL_TRIGGER', reason, inputs: { triggers: hits } });
    Logger.warn(`[AUTO] ${reason}. Dropped ${from} -> SHADOW; exits keep running.`);
    this.emit('mode', { mode: this.mode, reason });
    return hits;
  }

  /**
   * P1.4 (N-0): a DEVNET_LIVE session that finds the coordinator disarmed (or not LIVE) or the kill switch on turns itself OFF, for good.
   * Re-arming LIVE later does not revive it: only setMode('DEVNET_LIVE') with the confirmation code does. Returns the reason, or null.
   */
  private dropDevnetLiveIfUnarmed(): string | null {
    if (this.mode !== 'DEVNET_LIVE') return null;
    const coordMode = executionCoordinator.getExecutionMode();
    const armed = executionCoordinator.isLiveArmed();
    const killSwitch = riskEngine.isKillSwitchActive();
    if (coordMode === 'LIVE' && armed && !killSwitch) return null;
    const reason = killSwitch
      ? 'the kill switch is on'
      : `the coordinator is ${coordMode} and LIVE is ${armed ? 'armed' : 'not armed'}`;
    const note = `DEVNET_LIVE turned OFF: ${reason}. Arm LIVE and set DEVNET_LIVE again (with its confirmation code) to trade.`;
    this.mode = 'OFF';
    this.session = null;
    this.autoRestore = null;
    this.clearPendingReleases();
    this.downgradeReason = note;
    workstationDb.logDecision({ autoMode: 'DEVNET_LIVE', mint: '-', stage: 'mode', outcome: 'INFO', reason: note });
    Logger.warn(`[AUTO] ${note}`);
    this.emit('mode', { mode: this.mode, reason: note });
    return reason;
  }

  /** S189: set only while a PAPER session sits in SHADOW because of READINESS_RED; greenSince is when readiness last turned (and stayed) all green. */
  private autoRestore: { greenSince: number | null } | null = null;

  private tryAutoRestore(now: number): boolean {
    const st = this.autoRestore;
    if (!st || this.mode !== 'SHADOW' || this.killed || !this.session || this.sessionKind !== 'PAPER') { this.autoRestore = null; return false; }
    if (executionCoordinator.getExecutionMode() !== 'PAPER') { this.autoRestore = null; return false; } // never restore into a different execution mode
    const c = executionCoordinator.getLiveReadiness().components;
    const green = c.rpc.healthy && c.markFeed.healthy && c.db.healthy;
    if (!green) { st.greenSince = null; return false; }
    if (st.greenSince === null) { st.greenSince = now; return false; }
    if (now - st.greenSince < READINESS_RESTORE_GREEN_MS) return false;
    const reason = `PAPER restored: readiness has been green for ${Math.round((now - st.greenSince) / 1000)}s after: ${this.downgradeReason}`;
    this.mode = 'PAPER';
    this.downgradeReason = null;
    this.triggers = [];
    this.redSince.clear();
    this.autoRestore = null;
    workstationDb.logDecision({ autoMode: 'PAPER', mint: '-', stage: 'risk', outcome: 'INFO', reason });
    Logger.warn(`[AUTO] ${reason}`);
    this.emit('mode', { mode: this.mode, reason });
    return true;
  }

  /**
   * DEVNET_LIVE only: compare the real wallet balance with what the decision journal says moved since the last look.
   * A change nothing in the journal explains (a drain, or an unknown spend) halts every buy plus the take-profit and stale exits;
   * stop-loss, trailing stop, manual close and panic still run (coordinator PROTECTIVE_EXIT_REASONS).
   */
  public async auditWallet(now = Date.now()): Promise<{ explained: boolean; unexplainedSol: number } | null> {
    if (this.mode !== 'DEVNET_LIVE') {
      this.walletMark = null;
      return null;
    }
    // Q8: while a buy or an exit is between its send and its journal row, the balance has moved and the journal has not. Looking now
    // would read the fill as a drain. Skip, and keep the old mark so the next look spans the whole trade and its row.
    if (this.busy || executionCoordinator.hasTradeInFlight()) return null;
    await executionCoordinator.syncRealWalletBalance();
    if (this.busy || executionCoordinator.hasTradeInFlight()) return null; // a trade started during the balance read
    const bal = executionCoordinator.getRealWalletBalanceSol();
    if (bal === null || bal === undefined) return null;
    // 3B (P3.2, R1-62): LIVE buys sent and still unresolved are in flight too, for as long as they stay unresolved (a buy that returned
    // UNCONFIRMED, any caller, any process). A drop up to their worst case is held as theirs and the old mark is kept, so the look after
    // orphan recovery journals the buy spans both. Unreadable: skip this look, keep the mark.
    const unresolved = executionCoordinator.getUnresolvedLiveBuys({ includeOwnInFlight: true });
    if (unresolved === null) return null;
    const prev = this.walletMark;
    if (!prev || unresolved.mints.length === 0) this.walletMark = { sol: bal, ts: now };
    if (!prev) return null;
    const audit = auditWalletChange(prev.sol, bal, workstationDb.sumDecisionSolDelta(prev.ts, now), { worstCaseSol: unresolved.reservedSol, count: unresolved.mints.length });
    if (!audit.explained) {
      const reason = `wallet changed by an unexplained ${audit.unexplainedSol.toFixed(6)} SOL (tolerance ${audit.toleranceSol.toFixed(6)})`;
      executionCoordinator.haltAll(reason);
      this.mode = 'OFF';
      this.killed = true;
      this.killReason = reason;
      this.session = null;
      workstationDb.logDecision({ autoMode: 'DEVNET_LIVE', mint: '-', stage: 'risk', outcome: 'HALT_ALL', reason, inputs: { prevSol: prev.sol, nowSol: bal } });
      Logger.error(`[AUTO] HALT ALL: ${reason}`);
      this.emit('mode', { mode: this.mode, reason });
    }
    return { explained: audit.explained, unexplainedSol: audit.unexplainedSol };
  }

  /**
   * Q30: the trades the expectancy and loss-streak triggers judge. Only positions the auto trader opened (this session's, or recorded as
   * BOUGHT in the journal) that closed since this session started, in this execution mode. Before, every closed trade of every mode and
   * every origin counted, so the old losses that tripped a trigger re-tripped it within seconds of the operator turning auto back on.
   */
  private sessionEvidencePnl(execMode: 'PAPER' | 'LIVE'): number[] {
    const since = this.session?.startedAt ?? 0;
    const owned = new Set<string>(this.session?.positionIds ?? []);
    for (const d of workstationDb.loadDecisions({ outcome: 'BOUGHT', limit: 5000 })) if (d.positionId) owned.add(d.positionId);
    return workstationDb.loadEvidenceClosedTrades(execMode)
      .filter((p) => owned.has(p.id) && (p.lastUpdatedTimestamp ?? 0) >= since)
      .map((p) => p.realizedPnLSol ?? 0);
  }

  /** Clear an all-trading halt and/or the daily-loss latch (3C: separate flags). Does not turn auto trading back on. */
  public resume(opts: { clearHalt?: boolean; clearDailyLossLatch?: boolean } = {}): { halted: boolean; mode: AutoMode } {
    if (opts.clearHalt) executionCoordinator.clearHalt();
    if (opts.clearDailyLossLatch) riskEngine.clearDailyLossLatch();
    return { halted: executionCoordinator.getHaltReason() !== null, mode: this.mode };
  }

  private watchListener: ((r: WatchResult) => void) | null = null;
  /**
   * S4b: a watch release is announced once. One that arrives while another buy is in flight used to be dropped for good. It waits here
   * instead (one per mint, newest 10) and is retried when the buy in flight settles, provided its verdict is still HOT/READY and it is
   * fresh enough to still be a signal.
   */
  private pendingReleases = new Map<string, { candidate: AutoCandidate; queuedAt: number; notBefore: number }>();
  private retryTimer: NodeJS.Timeout | null = null;

  private clearPendingReleases(): void {
    this.pendingReleases.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * Q6f: the watch window is the candidate source. A HOT or READY release becomes a candidate here. Nothing did this before: the window
   * only broadcast its verdicts, and the other two sources submit mints it never watched, so every one of those was dropped as
   * NOT_IN_WATCH_WINDOW and auto could not buy anything. DEAD releases are not candidates. Idempotent.
   */
  public attachWatchWindow(ww: Pick<EventEmitter, 'on' | 'off'> = watchWindow): void {
    if (this.watchListener) return;
    this.watchListener = (r) => {
      if (r.state !== 'HOT' && r.state !== 'READY') return;
      if (this.mode === 'OFF') return; // OFF drops silently here; no journal row per release
      const cfg = memecoinAggregator.getConfig();
      const pool = memecoinAggregator.getPools().find((p) => p.contractAddress === r.metrics.mint);
      void this.submitCandidate({
        mint: r.metrics.mint,
        symbol: pool?.symbol,
        source: 'WATCH_WINDOW',
        provenance: 'REAL_ONCHAIN',
        amountUsd: cfg.defaultSnipeAmountUsd || 5.0,
        slippagePct: cfg.maxSlippagePct || 6.0,
        jitoTipSol: cfg.jitoTipSol,
      }).catch(() => undefined);
    };
    ww.on('release', this.watchListener);
  }

  public detachWatchWindow(ww: Pick<EventEmitter, 'on' | 'off'> = watchWindow): void {
    if (this.watchListener) ww.off('release', this.watchListener);
    this.watchListener = null;
  }

  public startMonitor(intervalMs = MONITOR_INTERVAL_MS): void {
    if (this.monitorTimer) return;
    let running = false;
    this.monitorTimer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        await this.checkTriggers();
        await this.auditWallet();
      } catch (e: any) {
        Logger.error(`[AUTO] monitor tick failed: ${e?.message || e}`);
      } finally {
        running = false;
      }
    }, intervalMs);
    this.monitorTimer.unref?.();
  }

  public stopMonitor(): void {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }

  /**
   * The single door into auto trading. Returns the decision it journaled.
   */
  /** S209: the root span of an auto candidate's trace; everything below it (watch verdict, gates, risk, build, sign, submit, confirm, reconcile) nests inside. */
  public submitCandidate(c: AutoCandidate): Promise<AutoDecision> {
    return traced('auto.candidate', () => this.submitCandidateUntraced(c), { 'apex.source': c.source, 'apex.mode': this.mode });
  }

  private async submitCandidateUntraced(c: AutoCandidate): Promise<AutoDecision> {
    const key = c.mint.toLowerCase();
    // Q27: the 5s candidate loops resubmit the same mints forever. A drop that depends only on the watch verdict (never watched, still
    // watching, dead) cannot change until the verdict does, so a repeat inside DROP_REPEAT_MS gets the earlier decision and no new rows
    // (it used to write a QUEUED and a DROPPED row per mint per tick: about 34k rows a day).
    const v0 = this.mode === 'OFF' ? null : watchWindow.getVerdict(c.mint);
    const repeatKey = `${key}|${c.source}|${this.mode}|${v0?.state ?? 'NONE'}`;
    const prior = this.repeatDrops.get(repeatKey);
    if (prior && Date.now() - prior.ts < DROP_REPEAT_MS) return { ...prior.decision };
    let watchInputs = AutoSnipeController.watchInputs(v0);
    // P4.3: every row of a candidate carries the watch facts (passingSignals among them); a row's own inputs win on a clash
    type Extra = Parameters<AutoSnipeController['record']>[4];
    const rec = (outcome: AutoOutcome, stage: string, reason: string, extra: Extra = {}): AutoDecision =>
      this.record(c, outcome, stage, reason, { ...extra, inputs: { ...watchInputs, ...(extra?.inputs ?? {}) } });
    const remember = (d: AutoDecision): AutoDecision => {
      if (this.repeatDrops.size >= 500) this.repeatDrops.delete(this.repeatDrops.keys().next().value as string);
      this.repeatDrops.set(repeatKey, { ts: Date.now(), decision: d });
      return d;
    };
    workstationDb.logDecision({ autoMode: this.mode, mint: c.mint, symbol: c.symbol, source: c.source, stage: 'queue', outcome: 'QUEUED', reason: 'candidate received', inputs: watchInputs });
    if (this.mode === 'OFF') return rec('DROPPED', 'auto', 'AUTO_OFF');
    const downgraded = this.enforceBudgets();
    if (process.env.AUTO_SNIPE_ENABLED !== 'true') return rec('DROPPED', 'auto', 'AUTO_SNIPE_ENABLED is not true');
    if (this.attempted.has(key)) return rec('DROPPED', 'auto', 'ALREADY_ATTEMPTED_THIS_SESSION');
    if (this.busy) {
      const queued = c.source === 'WATCH_WINDOW' && this.queueRelease(c);
      return rec('DROPPED', 'auto', queued ? 'ANOTHER_CANDIDATE_IN_FLIGHT: queued, retried when the buy in flight settles' : 'ANOTHER_CANDIDATE_IN_FLIGHT');
    }
    const open = workstationDb.loadPositions(undefined, 'ACTIVE');
    if (open.some((p) => p.mint.toLowerCase() === key)) return rec('DROPPED', 'auto', 'POSITION_ALREADY_OPEN');

    // G2b: only watch-window releases get this far. HOT goes on to the execution stages; READY must also show concentration and
    // READY_MIN_SIGNALS strong signals (P4.3) and clear the confluence score (the threshold in force, default 70) at execution;
    // DEAD, still-watching and never-watched candidates are dropped.
    const verdict = traced('watch.release', () => watchWindow.getVerdict(c.mint));
    watchInputs = AutoSnipeController.watchInputs(verdict);
    if (!verdict || verdict.state === 'WATCHING' || verdict.state === 'DEAD') {
      const reason = !verdict ? 'NOT_IN_WATCH_WINDOW' : verdict.state === 'WATCHING' ? 'WATCH_PENDING: still in the watch window' : `WATCH_DEAD: ${verdict.reason}`;
      return remember(rec('DROPPED', 'watch', reason));
    }
    // P4.3 (R1-46, R1-59): the release is the signal. Once it is older than the risk engine's limit it can never be bought; say so here, in every
    // mode alike, without a curve read or a risk call. Final for the session.
    const signalLimitMs = riskEngine.getLimits().maxSignalAgeMs;
    const releaseAgeMs = verdict.releasedAt !== undefined ? Date.now() - verdict.releasedAt : null;
    if (releaseAgeMs !== null && releaseAgeMs > signalLimitMs) {
      this.attempted.add(key);
      return rec('REJECTED', 'risk', `STALE_SIGNAL: the watch release is ${releaseAgeMs} ms old (limit ${signalLimitMs} ms)`);
    }
    // P4.3 (R1-56): a READY release is bought only with concentration passing and at least READY_MIN_SIGNALS strong signals. Final: the verdict is.
    if (verdict.state === 'READY') {
      const g = verdict.metrics ? readyGate(verdict.metrics) : { pass: false, reason: 'READY_TOO_WEAK: the release carries no metrics' };
      if (!g.pass) {
        this.attempted.add(key);
        return remember(rec('REJECTED', 'watch', g.reason));
      }
    }
    // P4.3 (R1-57): the curve measured from the feed now. Above the cap it is not bought (the coordinator checks again on its own fresh read).
    // Review M2: null while the feed has no token reserve for the mint (never a SOL estimate); it passes here, and a LIVE buy is refused on it.
    const progressPct = onChainPoolStats.get(c.mint)?.curveProgressPct ?? null;
    if (isCurveTooFar(progressPct)) {
      return remember(rec('DROPPED', 'curve', curveTooFarReason('CURVE_PROGRESS_TOO_HIGH', progressPct as number), { inputs: { curveProgressPct: progressPct } }));
    }

    const mode = this.mode;
    // The coordinator's mode can change after the auto mode was set (someone arms LIVE, or disarms it). Every candidate
    // re-checks it, so PAPER auto can never place a real trade and DEVNET_LIVE never journals paper fills as wallet deltas.
    const coordMode = executionCoordinator.getExecutionMode();
    const armed = executionCoordinator.isLiveArmed();
    if (mode === 'PAPER' && (coordMode !== 'PAPER' || armed)) {
      return rec('REJECTED', 'mode', `PAPER auto refused: the coordinator is ${coordMode}${armed ? ' and LIVE is armed' : ''}; PAPER auto needs the coordinator in PAPER and disarmed`);
    }
    if (mode === 'DEVNET_LIVE') {
      const dropped = this.dropDevnetLiveIfUnarmed();
      if (dropped) return rec('REJECTED', 'mode', `DEVNET_LIVE auto refused and turned OFF: ${dropped}`, { mode: 'DEVNET_LIVE' });
    }
    if (mode === 'DEVNET_LIVE') {
      // 3B (P3.2, R1-35, R1-47): the slot is real SOL, so only LIVE positions count (an ACTIVE PAPER row no longer blocks it), and not adopted
      // dust (R3). A LIVE buy that was sent and is unresolved (UNCONFIRMED, or landed with an unread fill) counts too: it can land any moment.
      const unresolved = executionCoordinator.getUnresolvedLiveBuys({ includeOwnInFlight: true });
      if (unresolved === null) return rec('DROPPED', 'budget', 'DEVNET_MAX_OPEN_POSITIONS: the unresolved LIVE buys could not be read, so the open count is unknown');
      const liveOpen = open.filter((p) => p.executionMode === 'LIVE' && !isRecoveredPosition(p)).length;
      if (liveOpen + unresolved.mints.length >= DEVNET_MAX_OPEN_POSITIONS) {
        return rec('DROPPED', 'budget', `DEVNET_MAX_OPEN_POSITIONS (${DEVNET_MAX_OPEN_POSITIONS}) reached: ${liveOpen} open LIVE position(s), ${unresolved.mints.length} unresolved LIVE buy(s)`);
      }
    }
    if (downgraded) {
      // already moved to SHADOW by enforceBudgets; carry on as a shadow run
    }

    // Budgets are checked BEFORE spending: a buy that would take the session past its spend limit is refused, not allowed
    // and then noticed on the next candidate.
    // DEVNET_LIVE only: the cap is a real-SOL cap (0.02), a paper $5 order (~0.033 SOL) would never fit it.
    if (this.session && mode === 'DEVNET_LIVE') {
      this.settleUnresolvedSpend();
      const plannedSol = this.orderSol();
      if (this.session.spentSol + plannedSol > this.session.budgets.maxSpendSol) {
        return rec('REJECTED', 'budget', `would exceed the session spend limit (${this.session.spentSol.toFixed(4)} + ${plannedSol.toFixed(4)} > ${this.session.budgets.maxSpendSol} SOL)`);
      }
    }

    this.busy = true;
    let settle!: () => void;
    this.inflight = new Promise<void>((r) => { settle = r; });
    // P4.3 (R1-46): the mint is marked attempted only after a send or a final refusal (below), not before: a cooldown no longer burns it.
    // Q29: kill() and setMode() change this.mode and this.session while the buy below awaits. Its journal rows and its accounting
    // belong to the mode and the session it started in.
    const startMode = this.mode;
    const startSession = this.session;
    const startTs = Date.now();
    let retryable = false;
    try {
      const shadow = startMode === 'SHADOW';
      const solUsd = solPriceService.lastKnownPrice();
      // P4.3 (R1-56): DEVNET_LIVE never buys below the floor, whatever the threshold is set to; the floor turns the execution score gate on for HOT too.
      // It applies to auto buys only: a manual snipe goes through executeSnipe with the plain threshold, LIVE armed or not.
      const threshold = getConfluenceThreshold();
      const minScore = startMode === 'DEVNET_LIVE' ? Math.max(threshold, CONFLUENCE_DEVNET_LIVE_FLOOR) : threshold;
      const scoreGate = verdict.state === 'READY' || minScore > threshold;
      const params: Parameters<typeof memecoinAggregator.executeSnipe>[0] = {
        contractAddress: c.mint,
        amountUsd: c.amountUsd ?? 0,
        platform: 'PUMP_FUN',
        jitoTipSol: c.jitoTipSol,
        slippagePct: c.slippagePct ?? 6.0,
        signalId: c.signalId,
        provenance: c.provenance,
        enforceConfluence: scoreGate ? true : c.enforceConfluence,
        minConfluenceScore: scoreGate ? minScore : undefined,
        // The signal behind an auto buy is the watch window's release; LIVE refuses a trade without one, and (P4.3) SHADOW checks its age too.
        signalTimestamp: verdict.releasedAt,
        // R5: the mode checked above; the coordinator refuses the trade if LIVE was armed or disarmed during the awaits in executeSnipe.
        expectedMode: coordMode,
        noSyntheticPool: true, // S16
      };
      if (shadow) params.dryRun = true;
      const startOrderSol = this.orderSol();
      if (startMode === 'DEVNET_LIVE') {
        if (solUsd === null) { retryable = true; return rec('REJECTED', 'size', 'SOL_PRICE_UNAVAILABLE', { mode: startMode }); }
        params.amountSolOverride = startOrderSol;
      } else if (this.orderSolOverride !== null) {
        params.amountSolOverride = this.orderSolOverride; // S183: PAPER and SHADOW use the operator's size too
      }
      const res = await traced('snipe.execute', () => memecoinAggregator.executeSnipe(params), { 'apex.dryRun': shadow });
      if (!res.success) {
        // R6: a buy that was sent and may have landed (unconfirmed, or landed with an unreadable fill) spent real SOL the cap must count.
        if (startSession && !shadow && /^(UNCONFIRMED|RECONCILIATION FAILED)/.test(res.message)) {
          // 3B (R1-127): counted at its worst case (slippage headroom, token-account and first-buy accumulator rent) until orphan recovery
          // journals what it really took; settleUnresolvedSpend then swaps in that figure.
          const countedSol = startOrderSol * (1 + (params.slippagePct ?? 0) / 100) + (CapitalSizer.SPL_TOKEN_ACCOUNT_RENT_LAMPORTS + PUMP_USER_VOLUME_ACCUMULATOR_RENT_LAMPORTS) / 1e9;
          startSession.spentSol += countedSol;
          if (startMode === 'DEVNET_LIVE') this.unsettledBuys.push({ session: startSession, mint: c.mint, sinceTs: startTs, countedSol });
          workstationDb.logDecision({ autoMode: startMode, mint: c.mint, symbol: c.symbol, source: c.source, stage: 'budget', outcome: 'INFO', reason: `counted ${countedSol.toFixed(6)} SOL against the session cap: the buy was sent and may have landed`, inputs: watchInputs });
        }
        retryable = RETRYABLE_REJECTION.test(res.message || '');
        return rec('REJECTED', classifyRejection(res.message), res.message, { mode: startMode, inputs: { confluenceScore: res.confluenceScore, dryRun: shadow, retryable } });
      }
      if (shadow) return rec('WOULD_BUY', 'fill', res.message, { mode: startMode, amountSol: res.amountSol, inputs: { dryRun: true, confluenceScore: res.confluenceScore, gates: res.gates } });
      if (startSession) {
        startSession.buys += 1;
        // 3B (R1-127): a DEVNET_LIVE buy counts what it took from the wallet (its LIVE_BUY_FILLED row: curve spend, tip, fees and the
        // token-account and accumulator rent). Without that row (the position was not saved; recovery journals it later) the order, fees
        // and both rents are counted, which is never less than the buy took.
        const journaled = startMode === 'DEVNET_LIVE' ? this.journaledBuySpendSol(c.mint, startTs, res.positionId) : null;
        startSession.spentSol += journaled ?? (res.amountSol ?? 0) + (res.feesPaidLamports ?? 0) / 1e9
          + (startMode === 'DEVNET_LIVE' ? (CapitalSizer.SPL_TOKEN_ACCOUNT_RENT_LAMPORTS + PUMP_USER_VOLUME_ACCUMULATOR_RENT_LAMPORTS) / 1e9 : 0);
        if (res.positionId) startSession.positionIds.push(res.positionId);
      }
      const feesSol = (res.feesPaidLamports ?? 0) / 1e9;
      // Q7: a PAPER fill priced by the flat model (the curve could not be read) is not evidence of what a real fill would cost
      const unverified = ((res.gates as any)?.eligibility?.unverified?.length ?? 0) > 0 || (res.gates as any)?.pricing === 'MODEL';
      if (res.quotePriceSol && res.fillPriceSol && res.slippageBps !== undefined) {
        const slipBps = (res.fillPriceSol / res.quotePriceSol - 1) * 10_000;
        if (slipBps > res.slippageBps + 1) this.slippageBreaches += 1;
      }
      const d = rec('BOUGHT', 'fill', res.message, {
        mode: startMode, amountSol: res.amountSol, positionId: res.positionId, feesSol, unverified,
        inputs: { confluenceScore: res.confluenceScore, quotePriceSol: res.quotePriceSol, fillPriceSol: res.fillPriceSol, feesSol, gates: res.gates },
      });
      this.enforceBudgets();
      return d;
    } catch (e: any) {
      return rec('REJECTED', 'execute', `ERROR: ${e?.message || e}`, { mode: startMode });
    } finally {
      if (!retryable) this.attempted.add(key);
      else if (c.source === 'WATCH_WINDOW') this.queueRelease(c, Date.now() + RELEASE_RETRY_MS); // tried again while the release is still fresh
      this.busy = false;
      this.inflight = null;
      settle();
      this.scheduleReleaseDrain();
    }
  }

  /** 3B: auto buys counted at their worst case because they returned unresolved; settled once orphan recovery journals the real spend. */
  private unsettledBuys: Array<{ session: AutoSession; mint: string; sinceTs: number; countedSol: number }> = [];

  /** 3B: SOL the LIVE buy of `mint` took from the wallet, from its LIVE_BUY_FILLED row journaled at or after `sinceTs`. null without one. */
  private journaledBuySpendSol(mint: string, sinceTs: number, positionId?: string): number | null {
    try {
      const rows = workstationDb.loadDecisions({ mint, outcome: LIVE_BUY_FILLED, sinceTs, limit: 20 })
        .filter((r) => r.solDelta !== null && (positionId === undefined || r.positionId === positionId));
      return rows.length > 0 ? -(rows[0].solDelta as number) : null;
    } catch {
      return null;
    }
  }

  /**
   * 3B (R1-127): swap the worst-case figure of an auto buy that returned unresolved for what it really took, once orphan recovery has adopted
   * it and journaled LIVE_BUY_FILLED. A buy that never lands keeps its worst-case figure for the session (the cap errs high, never low).
   */
  private settleUnresolvedSpend(): void {
    this.unsettledBuys = this.unsettledBuys.filter((u) => {
      if (u.session !== this.session) return false; // a later session starts from 0
      const spent = this.journaledBuySpendSol(u.mint, u.sinceTs);
      if (spent === null) return true;
      u.session.spentSol += spent - u.countedSol;
      return false;
    });
  }

  private queueRelease(c: AutoCandidate, notBefore = 0): boolean {
    const key = c.mint.toLowerCase();
    if (!this.pendingReleases.has(key)) {
      if (this.pendingReleases.size >= PENDING_RELEASE_MAX) this.pendingReleases.delete(this.pendingReleases.keys().next().value as string);
      this.pendingReleases.set(key, { candidate: c, queuedAt: Date.now(), notBefore });
    }
    return true;
  }

  private scheduleReleaseDrain(): void {
    if (this.pendingReleases.size === 0) return;
    setImmediate(() => this.drainReleases());
  }

  /**
   * One queued release at a time: the next waits for this buy to settle (its own finally drains again). P4.3: a release older than
   * `pendingReleaseMaxAgeMs` (measured from the release) is refused STALE_SIGNAL here, journaled, with no curve read or risk call, in every mode
   * alike; a release waiting out a retry delay stays queued and a timer comes back for it.
   */
  private drainReleases(): void {
    if (this.busy || this.mode === 'OFF') return;
    const now = Date.now();
    const maxAgeMs = pendingReleaseMaxAgeMs();
    let waitMs: number | null = null;
    for (const [key, p] of this.pendingReleases) {
      const v = watchWindow.getVerdict(p.candidate.mint);
      if (!v || (v.state !== 'HOT' && v.state !== 'READY')) { this.pendingReleases.delete(key); continue; }
      const ageMs = now - (v.releasedAt ?? p.queuedAt);
      if (ageMs > maxAgeMs) {
        this.pendingReleases.delete(key);
        this.attempted.add(key);
        this.record(p.candidate, 'REJECTED', 'risk', `STALE_SIGNAL: the queued watch release is ${ageMs} ms old (a queued release is kept ${maxAgeMs} ms: the ${riskEngine.getLimits().maxSignalAgeMs} ms signal-age limit minus ${RELEASE_READ_ALLOWANCE_MS} ms for the reads)`, { inputs: AutoSnipeController.watchInputs(v) });
        continue;
      }
      if (p.notBefore > now) { waitMs = Math.min(waitMs ?? Infinity, p.notBefore - now); continue; }
      this.pendingReleases.delete(key);
      void this.submitCandidate(p.candidate).catch(() => undefined);
      return;
    }
    if (waitMs !== null && !this.retryTimer) {
      this.retryTimer = setTimeout(() => { this.retryTimer = null; this.drainReleases(); }, waitMs);
      this.retryTimer.unref?.();
    }
  }
}

export const autoSnipeController = new AutoSnipeController();
