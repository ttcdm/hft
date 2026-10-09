import { EventEmitter } from 'events';
import { workstationDb } from '../db/database';
import { executionCoordinator } from '../execution/coordinator';
import { memecoinAggregator } from '../memecoinAggregator';
import { solPriceService } from '../market/solPriceService';
import { executionConfig } from '../solana/executionConfig';
import { allowedCluster, assertClusterAllowed } from '../solana/clusterGuard';
import { Logger } from '../middleware/enterprise';
import type { SignalProvenance } from '../core/types';
import { computeJournalStats, type JournalStats } from './journalStats';
import { evaluateKillTriggers, auditWalletChange, type KillTrigger } from './killSwitch';
import { riskEngine } from '../risk/riskEngine';
import { watchWindow, HOT_MIN_SCORE } from '../signals/watchWindow';

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

export interface AutoCandidate {
  mint: string;
  symbol?: string;
  source: 'PUMPFUN_CALLOUT' | 'AGGREGATOR_LOOP' | 'TEST';
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
}

export interface AutoStatus {
  mode: AutoMode;
  killed: boolean;
  killReason: string | null;
  downgradeReason: string | null;
  /** G3: kill-switch triggers that dropped the controller to SHADOW, and the all-trading halt reason if one is set. */
  triggers: KillTrigger[];
  haltReason: string | null;
  slippageBreaches: number;
  session: (AutoSession & { sessionPnlSol: number; budgetsLeft: { buys: number; spendSol: number; lossSol: number; msLeft: number } }) | null;
  budgets: typeof SESSION_BUDGETS;
}

const MAX_DECISIONS = 500;
const MONITOR_INTERVAL_MS = 5_000;

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
    const solDelta = outcome === 'BOUGHT' && extra.amountSol !== undefined ? -(extra.amountSol + (extra.feesSol ?? 0)) : undefined;
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

  public getStatus(): AutoStatus {
    this.enforceBudgets();
    let session: AutoStatus['session'] = null;
    if (this.session) {
      const pnl = this.sessionPnlSol();
      session = {
        ...this.session,
        sessionPnlSol: pnl,
        budgetsLeft: {
          buys: Math.max(0, SESSION_BUDGETS.maxBuys - this.session.buys),
          spendSol: Math.max(0, SESSION_BUDGETS.maxSpendSol - this.session.spentSol),
          lossSol: Math.max(0, SESSION_BUDGETS.maxLossFraction * this.session.startingBankrollSol + pnl),
          msLeft: Math.max(0, SESSION_BUDGETS.maxDurationMs - (Date.now() - this.session.startedAt)),
        },
      };
    }
    return {
      mode: this.mode, killed: this.killed, killReason: this.killReason, downgradeReason: this.downgradeReason,
      triggers: [...this.triggers], haltReason: executionCoordinator.getHaltReason(), slippageBreaches: this.slippageBreaches,
      session, budgets: SESSION_BUDGETS,
    };
  }

  /** Drop to SHADOW when any session budget has run out. Called before every decision and status read. */
  private enforceBudgets(): string | null {
    if (!this.session || (this.mode !== 'PAPER' && this.mode !== 'DEVNET_LIVE')) return null;
    const s = this.session;
    let reason: string | null = null;
    if (s.buys >= SESSION_BUDGETS.maxBuys) reason = `max buys per session (${SESSION_BUDGETS.maxBuys}) used`;
    else if (s.spentSol >= SESSION_BUDGETS.maxSpendSol) reason = `max spend per session (${SESSION_BUDGETS.maxSpendSol} SOL incl. fees) used`;
    else if (Date.now() - s.startedAt >= SESSION_BUDGETS.maxDurationMs) reason = 'session time limit (4h) reached';
    else if (this.sessionPnlSol() <= -SESSION_BUDGETS.maxLossFraction * s.startingBankrollSol) {
      reason = `session loss reached ${SESSION_BUDGETS.maxLossFraction * 100}% of the starting bankroll`;
    }
    if (reason) {
      this.mode = 'SHADOW';
      this.downgradeReason = reason;
      Logger.warn(`[AUTO] budget exhausted: ${reason}. Dropped to SHADOW.`);
      this.emit('mode', { mode: this.mode, reason });
    }
    return reason;
  }

  public async setMode(next: AutoMode, opts: { confirmationCode?: string } = {}): Promise<{ ok: boolean; mode: AutoMode; error?: string }> {
    if (!['OFF', 'SHADOW', 'PAPER', 'DEVNET_LIVE'].includes(next)) return { ok: false, mode: this.mode, error: `unknown mode ${next}` };
    if (next === 'OFF') {
      this.mode = 'OFF';
      this.session = null;
      this.downgradeReason = null;
      this.emit('mode', { mode: this.mode });
      return { ok: true, mode: this.mode };
    }
    if (process.env.AUTO_SNIPE_ENABLED !== 'true') {
      return { ok: false, mode: this.mode, error: 'AUTO_SNIPE_ENABLED is not true: auto trading stays OFF' };
    }
    const coordMode = executionCoordinator.getExecutionMode();
    if (next === 'PAPER' && coordMode !== 'PAPER') {
      return { ok: false, mode: this.mode, error: 'PAPER auto mode needs the execution coordinator in PAPER' };
    }
    if (next === 'DEVNET_LIVE') {
      if (allowedCluster() !== 'devnet') return { ok: false, mode: this.mode, error: 'DEVNET_LIVE is refused: ALLOWED_CLUSTER is not devnet. There is no mainnet auto mode.' };
      if (coordMode !== 'LIVE') return { ok: false, mode: this.mode, error: 'DEVNET_LIVE needs the coordinator armed LIVE (on devnet)' };
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
    this.mode = next;
    if (next === 'PAPER' || next === 'DEVNET_LIVE') {
      const bankroll = executionCoordinator.getRealWalletBalanceSol() ?? executionConfig.getConfig().paperBankrollSol;
      this.session = { startedAt: Date.now(), startingBankrollSol: bankroll, buys: 0, spentSol: 0, positionIds: [] };
    } else {
      this.session = null;
    }
    this.emit('mode', { mode: this.mode });
    return { ok: true, mode: this.mode };
  }

  /** Kill switch for auto trading: back to OFF now, optionally selling everything the session opened. Exits keep running otherwise. */
  public async kill(opts: { exitAll?: boolean; reason?: string } = {}): Promise<{ mode: AutoMode; closed: number }> {
    this.mode = 'OFF';
    this.killed = true;
    this.killReason = opts.reason || 'operator kill';
    const ids = this.session?.positionIds ?? [];
    this.session = null;
    let closed = 0;
    if (opts.exitAll) {
      for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) {
        if (ids.length && !ids.includes(p.id)) continue;
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
   * journaled as "would buy", and exits keep running. Only an operator setting the mode again brings buys back.
   */
  public async checkTriggers(now = Date.now()): Promise<KillTrigger[]> {
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
      closedNetPnlSol: workstationDb.loadEvidenceClosedTrades(execMode).map((p) => p.realizedPnLSol ?? 0),
      dailyTotalPnlSol: riskEngine.getDailyTotalPnLSol(execMode),
      maxDailyLossSol: riskEngine.effectiveMaxDailyLossSol(),
      slippageBreaches: this.slippageBreaches,
      readinessRed: [...this.redSince.entries()].map(([name, since]) => ({ name, redForMs: now - since })),
      walletSol: executionCoordinator.getRealWalletBalanceSol(),
      reserveSol: 0.015,
      maxTradeSol: AUTO_DEVNET_ORDER_SOL,
    };
    const hits = evaluateKillTriggers(ctx);
    if (hits.length === 0) return [];

    const reason = `kill switch: ${hits.map((h) => `${h.code} (${h.message})`).join('; ')}`;
    const from = this.mode;
    this.triggers = hits;
    this.mode = 'SHADOW';
    this.downgradeReason = reason;
    workstationDb.logDecision({ autoMode: from, mint: '-', stage: 'risk', outcome: 'KILL_TRIGGER', reason, inputs: { triggers: hits } });
    Logger.warn(`[AUTO] ${reason}. Dropped ${from} -> SHADOW; exits keep running.`);
    this.emit('mode', { mode: this.mode, reason });
    return hits;
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
    await executionCoordinator.syncRealWalletBalance();
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

  /** Clear an all-trading halt. Does not turn auto trading back on: the operator still sets a mode. */
  public resume(opts: { clearHalt?: boolean } = {}): { halted: boolean; mode: AutoMode } {
    if (opts.clearHalt) executionCoordinator.clearHalt();
    return { halted: executionCoordinator.getHaltReason() !== null, mode: this.mode };
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
    workstationDb.logDecision({ autoMode: this.mode, mint: c.mint, symbol: c.symbol, source: c.source, stage: 'queue', outcome: 'QUEUED', reason: 'candidate received' });
    if (this.mode === 'OFF') return this.record(c, 'DROPPED', 'auto', 'AUTO_OFF');
    const downgraded = this.enforceBudgets();
    if (process.env.AUTO_SNIPE_ENABLED !== 'true') return this.record(c, 'DROPPED', 'auto', 'AUTO_SNIPE_ENABLED is not true');
    if (this.attempted.has(key)) return this.record(c, 'DROPPED', 'auto', 'ALREADY_ATTEMPTED_THIS_SESSION');
    if (this.busy) return this.record(c, 'DROPPED', 'auto', 'ANOTHER_CANDIDATE_IN_FLIGHT');
    const open = workstationDb.loadPositions(undefined, 'ACTIVE');
    if (open.some((p) => p.mint.toLowerCase() === key)) return this.record(c, 'DROPPED', 'auto', 'POSITION_ALREADY_OPEN');

    // G2b: only watch-window releases get this far. HOT goes straight to the execution stages; READY must also clear
    // the confluence score (>= 70) here; DEAD, still-watching and never-watched candidates are dropped.
    const verdict = watchWindow.getVerdict(c.mint);
    if (!verdict) return this.record(c, 'DROPPED', 'watch', 'NOT_IN_WATCH_WINDOW');
    if (verdict.state === 'WATCHING') return this.record(c, 'DROPPED', 'watch', 'WATCH_PENDING: still in the watch window');
    if (verdict.state === 'DEAD') return this.record(c, 'DROPPED', 'watch', `WATCH_DEAD: ${verdict.reason}`);

    const mode = this.mode;
    if (mode === 'DEVNET_LIVE' && open.length >= DEVNET_MAX_OPEN_POSITIONS) {
      return this.record(c, 'DROPPED', 'budget', `DEVNET_MAX_OPEN_POSITIONS (${DEVNET_MAX_OPEN_POSITIONS}) reached`);
    }
    if (downgraded) {
      // already moved to SHADOW by enforceBudgets; carry on as a shadow run
    }

    this.busy = true;
    this.attempted.add(key);
    try {
      const shadow = this.mode === 'SHADOW';
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
        minConfluenceScore: verdict.state === 'READY' ? HOT_MIN_SCORE : undefined,
      };
      if (shadow) params.dryRun = true;
      if (this.mode === 'DEVNET_LIVE') {
        if (solUsd === null) return this.record(c, 'REJECTED', 'size', 'SOL_PRICE_UNAVAILABLE');
        params.amountSolOverride = AUTO_DEVNET_ORDER_SOL;
      }
      const res = await memecoinAggregator.executeSnipe(params);
      if (!res.success) return this.record(c, 'REJECTED', classifyRejection(res.message), res.message, { inputs: { confluenceScore: res.confluenceScore, dryRun: shadow } });
      if (shadow) return this.record(c, 'WOULD_BUY', 'fill', res.message, { amountSol: res.amountSol, inputs: { dryRun: true, confluenceScore: res.confluenceScore, gates: res.gates } });
      if (this.session) {
        this.session.buys += 1;
        this.session.spentSol += (res.amountSol ?? 0) + (res.feesPaidLamports ?? 0) / 1e9;
        if (res.positionId) this.session.positionIds.push(res.positionId);
      }
      const feesSol = (res.feesPaidLamports ?? 0) / 1e9;
      const unverified = ((res.gates as any)?.eligibility?.unverified?.length ?? 0) > 0;
      if (res.quotePriceSol && res.fillPriceSol && res.slippageBps !== undefined) {
        const slipBps = (res.fillPriceSol / res.quotePriceSol - 1) * 10_000;
        if (slipBps > res.slippageBps + 1) this.slippageBreaches += 1;
      }
      const d = this.record(c, 'BOUGHT', 'fill', res.message, {
        amountSol: res.amountSol, positionId: res.positionId, feesSol, unverified,
        inputs: { confluenceScore: res.confluenceScore, quotePriceSol: res.quotePriceSol, fillPriceSol: res.fillPriceSol, feesSol, gates: res.gates },
      });
      this.enforceBudgets();
      return d;
    } catch (e: any) {
      return this.record(c, 'REJECTED', 'execute', `ERROR: ${e?.message || e}`);
    } finally {
      this.busy = false;
    }
  }
}

export const autoSnipeController = new AutoSnipeController();
