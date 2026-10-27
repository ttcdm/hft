import type { AutoMode } from './controller';

/**
 * G3: kill-switch triggers. Pure functions over a snapshot, so each rule is testable on its own.
 * Triggers PAUSE BUYS only; exits keep running. The one exception is an unexplained wallet change, which halts every buy plus the
 * take-profit and stale exits (stop-loss, trailing stop, manual close and panic still run).
 */
export const EXPECTANCY_WINDOW = 20;
/** One-sided 80% normal quantile (Q30: this was 1.2816, the 90% value). */
export const Z_80 = 0.8416;
export const MAX_CONSECUTIVE_LOSSES = 8;
export const MAX_SLIPPAGE_BREACHES = 2;
export const READINESS_RED_LIMIT_MS = 10_000;
export const WALLET_AUDIT_BASE_TOLERANCE_SOL = 0.0005;
export const WALLET_AUDIT_GROSS_TOLERANCE = 0.05;
/**
 * Each journaled fill may also move the wallet by the rent of the token account it opens or closes (a classic ATA is
 * 0.00203928 SOL, Token-2022 with extensions a little more), which the fill's own amount and fees do not include. Without
 * this allowance the first real buy read as an unexplained 0.002 SOL loss and halted all trading.
 */
export const WALLET_AUDIT_RENT_ALLOWANCE_SOL = 0.0025;

export interface KillTrigger {
  code: string;
  message: string;
}

export interface KillContext {
  mode: AutoMode;
  /** Net PnL per closed trade, oldest first, evidence trades only (unverified paper fills excluded). */
  closedNetPnlSol: number[];
  /** Realized + unrealized + fees for the day, and the day's loss limit. */
  dailyTotalPnlSol: number;
  maxDailyLossSol: number;
  slippageBreaches: number;
  readinessRed: Array<{ name: string; redForMs: number }>;
  /** Wallet checks apply to DEVNET_LIVE only. null balance there counts as red once it has lasted (see walletUnknownForMs). */
  walletSol: number | null;
  /**
   * 3E: how long the balance has been unknown (no good read), in ms. WALLET_UNKNOWN fires only past READINESS_RED_LIMIT_MS, so one failed
   * read does not stop a session. Left out, the caller does not track it and a null balance fires at once (fail-closed).
   */
  walletUnknownForMs?: number;
  reserveSol: number;
  maxTradeSol: number;
}

/** Upper bound of the one-sided 80% confidence interval of the mean. null with fewer than 2 samples. */
export function upperBound80(samples: number[]): number | null {
  const n = samples.length;
  if (n < 2) return null;
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return mean + (Z_80 * Math.sqrt(variance)) / Math.sqrt(n);
}

export function evaluateKillTriggers(ctx: KillContext): KillTrigger[] {
  const out: KillTrigger[] = [];

  if (ctx.maxDailyLossSol > 0 && ctx.dailyTotalPnlSol <= -ctx.maxDailyLossSol) {
    out.push({ code: 'DAILY_LOSS_LIMIT', message: `daily total PnL ${ctx.dailyTotalPnlSol.toFixed(4)} SOL (unrealized included) reached the ${ctx.maxDailyLossSol.toFixed(4)} SOL limit` });
  }

  const window = ctx.closedNetPnlSol.slice(-EXPECTANCY_WINDOW);
  if (window.length >= EXPECTANCY_WINDOW) {
    const ub = upperBound80(window);
    if (ub !== null && ub < 0) {
      out.push({ code: 'NEGATIVE_EXPECTANCY', message: `over the last ${EXPECTANCY_WINDOW} closed trades the upper 80% bound of mean net PnL is ${ub.toFixed(6)} SOL (< 0)` });
    }
  }

  let streak = 0;
  for (let i = ctx.closedNetPnlSol.length - 1; i >= 0 && ctx.closedNetPnlSol[i] < 0; i--) streak++;
  if (streak >= MAX_CONSECUTIVE_LOSSES) {
    out.push({ code: 'LOSS_STREAK', message: `${streak} losses in a row (bug detector)` });
  }

  if (ctx.slippageBreaches >= MAX_SLIPPAGE_BREACHES) {
    out.push({ code: 'SLIPPAGE_BREACHES', message: `${ctx.slippageBreaches} fills worse than the slippage cap this session` });
  }

  for (const r of ctx.readinessRed) {
    if (r.redForMs > READINESS_RED_LIMIT_MS) {
      out.push({ code: 'READINESS_RED', message: `readiness check "${r.name}" red for ${Math.round(r.redForMs / 1000)}s` });
    }
  }

  if (ctx.mode === 'DEVNET_LIVE') {
    if (ctx.walletSol === null) {
      const forMs = ctx.walletUnknownForMs ?? Number.POSITIVE_INFINITY;
      if (!(forMs <= READINESS_RED_LIMIT_MS)) {
        out.push({ code: 'WALLET_UNKNOWN', message: Number.isFinite(forMs) ? `no good wallet balance read for ${Math.round(forMs / 1000)}s` : 'wallet balance is unknown' });
      }
    } else if (ctx.walletSol < ctx.reserveSol + ctx.maxTradeSol) {
      out.push({ code: 'WALLET_LOW', message: `wallet ${ctx.walletSol.toFixed(4)} SOL is below reserve ${ctx.reserveSol} + one max trade ${ctx.maxTradeSol}` });
    }
  }

  return out;
}

/**
 * Compare a real balance change with what the journal says moved. Returns the part that no journaled fill explains.
 *
 * R8-1: only an unexplained OUTFLOW (a drop beyond the tolerance) is a halt reason. SOL arriving that the journal does not explain (a
 * deposit, the operator's own top-up, anyone's 0.0006 SOL transfer, the proceeds of a sell whose row is not written yet) is `explained`
 * with `inflowSol` set, so the caller logs it and decides whether to re-baseline; it used to halt everything, which let anyone stop the bot
 * for the price of one transfer.
 *
 * 3B (P3.2, R1-62): `unresolved` is the LIVE buys that were sent and are not resolved yet (UNCONFIRMED, or landed with an unread fill),
 * at the worst case each can still take. Such a buy may have landed with no journal row yet, so a DROP no larger than that worst case plus
 * one rent allowance per buy (the first-buy accumulator rent is not in the worst case) is held as theirs: explained, with `heldByUnresolved`
 * set so the caller keeps its old mark and the next look, after recovery journals the buy, spans both. A larger drop still is not.
 */
export function auditWalletChange(
  prevSol: number,
  nowSol: number,
  journal: { delta: number; gross: number; count?: number },
  unresolved: { worstCaseSol: number; count: number } = { worstCaseSol: 0, count: 0 }
): { explained: boolean; unexplainedSol: number; toleranceSol: number; heldByUnresolved: boolean; inflowSol: number } {
  const toleranceSol = WALLET_AUDIT_BASE_TOLERANCE_SOL + WALLET_AUDIT_GROSS_TOLERANCE * journal.gross + WALLET_AUDIT_RENT_ALLOWANCE_SOL * (journal.count ?? 0);
  const unexplainedSol = nowSol - prevSol - journal.delta;
  if (Math.abs(unexplainedSol) <= toleranceSol) return { explained: true, unexplainedSol, toleranceSol, heldByUnresolved: false, inflowSol: 0 };
  if (unexplainedSol > 0) return { explained: true, unexplainedSol, toleranceSol, heldByUnresolved: false, inflowSol: unexplainedSol };
  const pendingSol = unresolved.count > 0 ? unresolved.worstCaseSol + WALLET_AUDIT_RENT_ALLOWANCE_SOL * unresolved.count : 0;
  const held = pendingSol > 0 && -unexplainedSol <= pendingSol + toleranceSol;
  return { explained: held, unexplainedSol, toleranceSol, heldByUnresolved: held, inflowSol: 0 };
}
