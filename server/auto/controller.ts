import { EventEmitter } from 'events';
import { workstationDb } from '../db/database';
import { executionCoordinator } from '../execution/coordinator';
import { memecoinAggregator } from '../memecoinAggregator';
import { solPriceService } from '../market/solPriceService';
import { executionConfig } from '../solana/executionConfig';
import { allowedCluster, assertClusterAllowed } from '../solana/clusterGuard';
import { Logger } from '../middleware/enterprise';
import type { SignalProvenance } from '../core/types';

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
  /** Stage that decided: AUTO | BUDGET | EXECUTE | DRY_RUN */
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
  session: (AutoSession & { sessionPnlSol: number; budgetsLeft: { buys: number; spendSol: number; lossSol: number; msLeft: number } }) | null;
  budgets: typeof SESSION_BUDGETS;
}

const MAX_DECISIONS = 500;

export class AutoSnipeController extends EventEmitter {
  private mode: AutoMode = 'OFF'; // never restored from disk: a restart is always OFF
  private killed = false;
  private killReason: string | null = null;
  private downgradeReason: string | null = null;
  private session: AutoSession | null = null;
  private decisions: AutoDecision[] = [];
  private attempted = new Set<string>();
  private busy = false;

  public getMode(): AutoMode {
    return this.mode;
  }

  public getDecisions(limit = 100): AutoDecision[] {
    return this.decisions.slice(-limit).map((d) => ({ ...d }));
  }

  private record(c: AutoCandidate, outcome: AutoOutcome, stage: string, reason: string, extra: Partial<AutoDecision> = {}): AutoDecision {
    const d: AutoDecision = { ts: Date.now(), mode: this.mode, mint: c.mint, symbol: c.symbol, source: c.source, outcome, stage, reason, ...extra };
    this.decisions.push(d);
    if (this.decisions.length > MAX_DECISIONS) this.decisions.shift();
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
    return { mode: this.mode, killed: this.killed, killReason: this.killReason, downgradeReason: this.downgradeReason, session, budgets: SESSION_BUDGETS };
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

  /**
   * The single door into auto trading. Returns the decision it journaled.
   */
  public async submitCandidate(c: AutoCandidate): Promise<AutoDecision> {
    const key = c.mint.toLowerCase();
    if (this.mode === 'OFF') return this.record(c, 'DROPPED', 'AUTO', 'AUTO_OFF');
    const downgraded = this.enforceBudgets();
    if (process.env.AUTO_SNIPE_ENABLED !== 'true') return this.record(c, 'DROPPED', 'AUTO', 'AUTO_SNIPE_ENABLED is not true');
    if (this.attempted.has(key)) return this.record(c, 'DROPPED', 'AUTO', 'ALREADY_ATTEMPTED_THIS_SESSION');
    if (this.busy) return this.record(c, 'DROPPED', 'AUTO', 'ANOTHER_CANDIDATE_IN_FLIGHT');
    const open = workstationDb.loadPositions(undefined, 'ACTIVE');
    if (open.some((p) => p.mint.toLowerCase() === key)) return this.record(c, 'DROPPED', 'AUTO', 'POSITION_ALREADY_OPEN');

    const mode = this.mode;
    if (mode === 'DEVNET_LIVE' && open.length >= DEVNET_MAX_OPEN_POSITIONS) {
      return this.record(c, 'DROPPED', 'BUDGET', `DEVNET_MAX_OPEN_POSITIONS (${DEVNET_MAX_OPEN_POSITIONS}) reached`);
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
        enforceConfluence: c.enforceConfluence,
      };
      if (shadow) params.dryRun = true;
      if (this.mode === 'DEVNET_LIVE') {
        if (solUsd === null) return this.record(c, 'REJECTED', 'EXECUTE', 'SOL_PRICE_UNAVAILABLE');
        params.amountSolOverride = AUTO_DEVNET_ORDER_SOL;
      }
      const res = await memecoinAggregator.executeSnipe(params);
      if (!res.success) return this.record(c, 'REJECTED', shadow ? 'DRY_RUN' : 'EXECUTE', res.message);
      if (shadow) return this.record(c, 'WOULD_BUY', 'DRY_RUN', res.message, { amountSol: res.amountSol });
      if (this.session) {
        this.session.buys += 1;
        this.session.spentSol += (res.amountSol ?? 0) + (res.feesPaidLamports ?? 0) / 1e9;
        if (res.positionId) this.session.positionIds.push(res.positionId);
      }
      const d = this.record(c, 'BOUGHT', 'EXECUTE', res.message, { amountSol: res.amountSol, positionId: res.positionId });
      this.enforceBudgets();
      return d;
    } catch (e: any) {
      return this.record(c, 'REJECTED', 'EXECUTE', `ERROR: ${e?.message || e}`);
    } finally {
      this.busy = false;
    }
  }
}

export const autoSnipeController = new AutoSnipeController();
