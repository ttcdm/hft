import { EventEmitter } from 'events';
import { isReadOnly } from '../solana/readOnly';
import { workstationDb } from '../db/database';
import { executionCoordinator, isRecoveredPosition } from '../execution/coordinator';
import { memecoinAggregator } from '../memecoinAggregator';
import { solPriceService } from '../market/solPriceService';
import { executionConfig } from '../solana/executionConfig';
import { checkSnipeAmountSol, SNIPE_AMOUNT_MIN_SOL } from '../execution/snipeAmount';
import { allowedCluster, assertClusterAllowed } from '../solana/clusterGuard';
import { Logger } from '../middleware/enterprise';
import type { SignalProvenance } from '../core/types';
import { computeJournalStats, type JournalStats } from './journalStats';
import { evaluateKillTriggers, auditWalletChange, type KillTrigger } from './killSwitch';
import { riskEngine } from '../risk/riskEngine';
import { watchWindow, type WatchResult } from '../signals/watchWindow';
import { getConfluenceThreshold, setConfluenceThreshold, confluenceThresholdInfo, type ConfluenceThresholdInfo } from '../signals/confluenceThreshold';

/**
 * G1: the only owner of auto trading.
 *
 * Both candidate sources (pumpfunService callouts, the memecoinAggregator sniper loop) hand candidates to
 * `submitCandidate`; neither may call execution directly. The mode is held in memory only, so a restart always
 * comes back OFF. There is no mainnet mode. Open positions stay under the exit engine in every mode.
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
  /** Pipeline stage that decided (G3): queue | auto | watch | budget | eligibility | score | size | risk | execute | fill | exit */
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
export const PENDING_RELEASE_MAX_AGE_MS = 20_000;
const MONITOR_INTERVAL_MS = 5_000;
/** S189: how long readiness must stay green before a PAPER session downgraded by READINESS_RED is put back. */
export const READINESS_RESTORE_GREEN_MS = 60_000;

/** Map a rejection message to the pipeline stage that produced it. */
export function classifyRejection(message: string): string {
  const m = message || '';
  if (/^(REJECTED: )?(ELIGIBILITY|UNSUPPORTED_TOKEN|SAFETY_CHECK|Freeze authority|Creator holds)/.test(m)) return 'eligibility';
  if (/Confluence score/.test(m)) return 'score';
  if (/^(REJECTED: )?(Capital sizing|WALLET_BALANCE_UNKNOWN|SOL_PRICE_UNAVAILABLE)|^(EXCEEDS_CAPITAL_CEILING|INSUFFICIENT_|EXPECTED_EDGE_BELOW|MARKET_DATA_UNAVAILABLE)/.test(m)) return 'size';
  if (/^(CIRCUIT_BREAKER_OPEN|DAILY_LOSS_LIMIT|DUPLICATE_MINT|EXECUTION_DISABLED|FEE_TOO_HIGH|INSUFFICIENT_BALANCE|KILL_SWITCH_ACTIVE|MAX_EXPOSURE|MAX_POSITION_SIZE|PRICE_IMPACT_TOO_HIGH|SLIPPAGE_TOO_HIGH|STALE_MARKET_DATA|STALE_SIGNAL|TRADING_HALTED)/.test(m)) return 'risk';
  return 'execute';
}

export class AutoSnipeController extends EventEmitter {
  private mode: AutoMode = 'OFF'; // never restored from disk: a restart is always OFF
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

  private record(c: AutoCandidate, outcome: AutoOutcome, stage: string, reason: string, extra: Partial<AutoDecision> & { feesSol?: number; inputs?: Record<string, any>; unverified?: boolean } = {}): AutoDecision {
    const { feesSol: _f, inputs: _i, unverified: _u, ...pub } = extra;
    const d: AutoDecision = { ts: Date.now(), mode: this.mode, mint: c.mint, symbol: c.symbol, source: c.source, outcome, stage, reason, ...pub };
    this.decisions.push(d);
    if (this.decisions.length > MAX_DECISIONS) this.decisions.shift();
    // Q8: only DEVNET_LIVE fills move the wallet; a PAPER fill's delta must not enter the wallet audit
    const solDelta = outcome === 'BOUGHT' && d.mode === 'DEVNET_LIVE' && extra.amountSol !== undefined ? -(extra.amountSol + (extra.feesSol ?? 0)) : undefined;
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
      solDelta,
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
    return { ok: true, value: r.value };
  }

  public getStatus(): AutoStatus {
    this.enforceBudgets();
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
    this.downgradeReason = null;
    this.triggers = [];
    this.slippageBreaches = 0;
    this.redSince.clear();
    this.walletMark = null;
    this.attempted.clear();
    this.pendingReleases.clear();
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
   * A change nothing in the journal explains (a drain, or an unknown spend) halts ALL trading, exits included.
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
    const prev = this.walletMark;
    this.walletMark = { sol: bal, ts: now };
    if (!prev) return null;
    const audit = auditWalletChange(prev.sol, bal, workstationDb.sumDecisionSolDelta(prev.ts, now));
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

  /** Clear an all-trading halt. Does not turn auto trading back on: the operator still sets a mode. */
  public resume(opts: { clearHalt?: boolean } = {}): { halted: boolean; mode: AutoMode } {
    if (opts.clearHalt) executionCoordinator.clearHalt();
    return { halted: executionCoordinator.getHaltReason() !== null, mode: this.mode };
  }

  private watchListener: ((r: WatchResult) => void) | null = null;
  /**
   * S4b: a watch release is announced once. One that arrives while another buy is in flight used to be dropped for good. It waits here
   * instead (one per mint, newest 10) and is retried when the buy in flight settles, provided its verdict is still HOT/READY and it is
   * fresh enough to still be a signal.
   */
  private pendingReleases = new Map<string, { candidate: AutoCandidate; queuedAt: number }>();

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
  public async submitCandidate(c: AutoCandidate): Promise<AutoDecision> {
    const key = c.mint.toLowerCase();
    // Q27: the 5s candidate loops resubmit the same mints forever. A drop that depends only on the watch verdict (never watched, still
    // watching, dead) cannot change until the verdict does, so a repeat inside DROP_REPEAT_MS gets the earlier decision and no new rows
    // (it used to write a QUEUED and a DROPPED row per mint per tick: about 34k rows a day).
    const v0 = this.mode === 'OFF' ? null : watchWindow.getVerdict(c.mint);
    const repeatKey = `${key}|${c.source}|${this.mode}|${v0?.state ?? 'NONE'}`;
    const prior = this.repeatDrops.get(repeatKey);
    if (prior && Date.now() - prior.ts < DROP_REPEAT_MS) return { ...prior.decision };
    workstationDb.logDecision({ autoMode: this.mode, mint: c.mint, symbol: c.symbol, source: c.source, stage: 'queue', outcome: 'QUEUED', reason: 'candidate received' });
    if (this.mode === 'OFF') return this.record(c, 'DROPPED', 'auto', 'AUTO_OFF');
    const downgraded = this.enforceBudgets();
    if (process.env.AUTO_SNIPE_ENABLED !== 'true') return this.record(c, 'DROPPED', 'auto', 'AUTO_SNIPE_ENABLED is not true');
    if (this.attempted.has(key)) return this.record(c, 'DROPPED', 'auto', 'ALREADY_ATTEMPTED_THIS_SESSION');
    if (this.busy) {
      const queued = c.source === 'WATCH_WINDOW' && this.queueRelease(c);
      return this.record(c, 'DROPPED', 'auto', queued ? 'ANOTHER_CANDIDATE_IN_FLIGHT: queued, retried when the buy in flight settles' : 'ANOTHER_CANDIDATE_IN_FLIGHT');
    }
    const open = workstationDb.loadPositions(undefined, 'ACTIVE');
    if (open.some((p) => p.mint.toLowerCase() === key)) return this.record(c, 'DROPPED', 'auto', 'POSITION_ALREADY_OPEN');

    // G2b: only watch-window releases get this far. HOT goes straight to the execution stages; READY must also clear
    // the confluence score (the threshold in force, default 70) here; DEAD, still-watching and never-watched candidates are dropped.
    const verdict = watchWindow.getVerdict(c.mint);
    if (!verdict || verdict.state === 'WATCHING' || verdict.state === 'DEAD') {
      const reason = !verdict ? 'NOT_IN_WATCH_WINDOW' : verdict.state === 'WATCHING' ? 'WATCH_PENDING: still in the watch window' : `WATCH_DEAD: ${verdict.reason}`;
      const dropped = this.record(c, 'DROPPED', 'watch', reason);
      if (this.repeatDrops.size >= 500) this.repeatDrops.delete(this.repeatDrops.keys().next().value as string);
      this.repeatDrops.set(repeatKey, { ts: Date.now(), decision: dropped });
      return dropped;
    }

    const mode = this.mode;
    // The coordinator's mode can change after the auto mode was set (someone arms LIVE, or disarms it). Every candidate
    // re-checks it, so PAPER auto can never place a real trade and DEVNET_LIVE never journals paper fills as wallet deltas.
    const coordMode = executionCoordinator.getExecutionMode();
    const armed = executionCoordinator.isLiveArmed();
    if (mode === 'PAPER' && (coordMode !== 'PAPER' || armed)) {
      return this.record(c, 'REJECTED', 'mode', `PAPER auto refused: the coordinator is ${coordMode}${armed ? ' and LIVE is armed' : ''}; PAPER auto needs the coordinator in PAPER and disarmed`);
    }
    if (mode === 'DEVNET_LIVE' && (coordMode !== 'LIVE' || !armed)) {
      return this.record(c, 'REJECTED', 'mode', `DEVNET_LIVE auto refused: the coordinator is ${coordMode} and LIVE is ${armed ? 'armed' : 'not armed'}; it must be LIVE and armed`);
    }
    if (mode === 'DEVNET_LIVE' && open.filter((p) => !isRecoveredPosition(p)).length >= DEVNET_MAX_OPEN_POSITIONS) { // R3: adopted dust does not take the slot
      return this.record(c, 'DROPPED', 'budget', `DEVNET_MAX_OPEN_POSITIONS (${DEVNET_MAX_OPEN_POSITIONS}) reached`);
    }
    if (downgraded) {
      // already moved to SHADOW by enforceBudgets; carry on as a shadow run
    }

    // Budgets are checked BEFORE spending: a buy that would take the session past its spend limit is refused, not allowed
    // and then noticed on the next candidate.
    // DEVNET_LIVE only: the cap is a real-SOL cap (0.02), a paper $5 order (~0.033 SOL) would never fit it.
    if (this.session && mode === 'DEVNET_LIVE') {
      const plannedSol = this.orderSol();
      if (this.session.spentSol + plannedSol > this.session.budgets.maxSpendSol) {
        return this.record(c, 'REJECTED', 'budget', `would exceed the session spend limit (${this.session.spentSol.toFixed(4)} + ${plannedSol.toFixed(4)} > ${this.session.budgets.maxSpendSol} SOL)`);
      }
    }

    this.busy = true;
    let settle!: () => void;
    this.inflight = new Promise<void>((r) => { settle = r; });
    this.attempted.add(key);
    // Q29: kill() and setMode() change this.mode and this.session while the buy below awaits. Its journal rows and its accounting
    // belong to the mode and the session it started in.
    const startMode = this.mode;
    const startSession = this.session;
    try {
      const shadow = startMode === 'SHADOW';
      const solUsd = solPriceService.lastKnownPrice();
      const params: Parameters<typeof memecoinAggregator.executeSnipe>[0] = {
        contractAddress: c.mint,
        amountUsd: c.amountUsd ?? 0,
        platform: 'PUMP_FUN',
        jitoTipSol: c.jitoTipSol,
        slippagePct: c.slippagePct ?? 6.0,
        signalId: c.signalId,
        provenance: c.provenance,
        enforceConfluence: verdict.state === 'READY' ? true : c.enforceConfluence,
        minConfluenceScore: verdict.state === 'READY' ? getConfluenceThreshold() : undefined,
        // The signal behind an auto buy is the watch window's release; LIVE refuses a trade without one.
        signalTimestamp: verdict.releasedAt,
        // R5: the mode checked above; the coordinator refuses the trade if LIVE was armed or disarmed during the awaits in executeSnipe.
        expectedMode: coordMode,
        noSyntheticPool: true, // S16
      };
      if (shadow) params.dryRun = true;
      const startOrderSol = this.orderSol();
      if (startMode === 'DEVNET_LIVE') {
        if (solUsd === null) return this.record(c, 'REJECTED', 'size', 'SOL_PRICE_UNAVAILABLE', { mode: startMode });
        params.amountSolOverride = startOrderSol;
      } else if (this.orderSolOverride !== null) {
        params.amountSolOverride = this.orderSolOverride; // S183: PAPER and SHADOW use the operator's size too
      }
      const res = await memecoinAggregator.executeSnipe(params);
      if (!res.success) {
        // R6: a buy that was sent and may have landed (unconfirmed, or landed with an unreadable fill) spent real SOL the cap must count.
        if (startSession && !shadow && /^(UNCONFIRMED|RECONCILIATION FAILED)/.test(res.message)) {
          startSession.spentSol += startOrderSol;
          workstationDb.logDecision({ autoMode: startMode, mint: c.mint, symbol: c.symbol, source: c.source, stage: 'budget', outcome: 'INFO', reason: `counted ${startOrderSol} SOL against the session cap: the buy was sent and may have landed` });
        }
        return this.record(c, 'REJECTED', classifyRejection(res.message), res.message, { mode: startMode, inputs: { confluenceScore: res.confluenceScore, dryRun: shadow } });
      }
      if (shadow) return this.record(c, 'WOULD_BUY', 'fill', res.message, { mode: startMode, amountSol: res.amountSol, inputs: { dryRun: true, confluenceScore: res.confluenceScore, gates: res.gates } });
      if (startSession) {
        startSession.buys += 1;
        startSession.spentSol += (res.amountSol ?? 0) + (res.feesPaidLamports ?? 0) / 1e9;
        if (res.positionId) startSession.positionIds.push(res.positionId);
      }
      const feesSol = (res.feesPaidLamports ?? 0) / 1e9;
      // Q7: a PAPER fill priced by the flat model (the curve could not be read) is not evidence of what a real fill would cost
      const unverified = ((res.gates as any)?.eligibility?.unverified?.length ?? 0) > 0 || (res.gates as any)?.pricing === 'MODEL';
      if (res.quotePriceSol && res.fillPriceSol && res.slippageBps !== undefined) {
        const slipBps = (res.fillPriceSol / res.quotePriceSol - 1) * 10_000;
        if (slipBps > res.slippageBps + 1) this.slippageBreaches += 1;
      }
      const d = this.record(c, 'BOUGHT', 'fill', res.message, {
        mode: startMode, amountSol: res.amountSol, positionId: res.positionId, feesSol, unverified,
        inputs: { confluenceScore: res.confluenceScore, quotePriceSol: res.quotePriceSol, fillPriceSol: res.fillPriceSol, feesSol, gates: res.gates },
      });
      this.enforceBudgets();
      return d;
    } catch (e: any) {
      return this.record(c, 'REJECTED', 'execute', `ERROR: ${e?.message || e}`, { mode: startMode });
    } finally {
      this.busy = false;
      this.inflight = null;
      settle();
      this.scheduleReleaseDrain();
    }
  }

  private queueRelease(c: AutoCandidate): boolean {
    const key = c.mint.toLowerCase();
    if (!this.pendingReleases.has(key)) {
      if (this.pendingReleases.size >= PENDING_RELEASE_MAX) this.pendingReleases.delete(this.pendingReleases.keys().next().value as string);
      this.pendingReleases.set(key, { candidate: c, queuedAt: Date.now() });
    }
    return true;
  }

  private scheduleReleaseDrain(): void {
    if (this.pendingReleases.size === 0) return;
    setImmediate(() => {
      if (this.busy || this.mode === 'OFF') return;
      for (const [key, p] of this.pendingReleases) {
        this.pendingReleases.delete(key);
        const v = watchWindow.getVerdict(p.candidate.mint);
        if (Date.now() - p.queuedAt > PENDING_RELEASE_MAX_AGE_MS || !v || (v.state !== 'HOT' && v.state !== 'READY')) continue;
        void this.submitCandidate(p.candidate).catch(() => undefined);
        return; // one at a time: the next waits for this buy to settle (its own finally drains again)
      }
    });
  }
}

export const autoSnipeController = new AutoSnipeController();
