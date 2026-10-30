import React, { useEffect, useState, useCallback } from 'react';
import { authFetch } from '../services/engineClient';
import { fmt } from './TokenBoard';
import { parseThreshold, thresholdWarning } from '../utils/confluenceThreshold';
import { onAuthenticated } from '../utils/authEvents';
import { useTradingMode } from '../utils/tradingMode';
import { parseDecimalText, COMMA_DECIMAL_REASON } from '../utils/numberInput';
import { askConfirm } from './ConfirmDialog';

/** H3: the auto-snipe controller panel. Every number is read from GET /api/auto/status (controller state + decision journal). */
export type AutoMode = 'OFF' | 'SHADOW' | 'PAPER' | 'DEVNET_LIVE';
export interface AutoStatusData {
  /** false: the server was started without AUTO_SNIPE_ENABLED=true, so every mode except OFF is refused (HTTP 409). Absent on an older server. */
  envEnabled?: boolean;
  mode: AutoMode; killed: boolean; killReason: string | null; downgradeReason: string | null; haltReason: string | null;
  triggers: Array<{ code: string; message: string }>; slippageBreaches: number;
  session: null | { buys: number; spentSol: number; sessionPnlSol: number; budgetsLeft: { buys: number; spendSol: number; lossSol: number; msLeft: number } };
  budgets: { maxBuys: number; maxSpendSol: number; maxLossFraction: number; maxDurationMs: number };
  /** S181: bounds the server accepts for the session budget. Absent on an older server. */
  budgetLimits?: { maxSpendSol: number; minSpendSol: number; maxBuys: number; capKind?: 'PAPER' | 'REAL'; capNote?: string };
  /** S189: a PAPER session waiting in SHADOW for readiness to stay green. Absent on an older server. */
  autoRestore?: { greenForMs: number; needMs: number } | null;
  /** S183: size of one auto order in SOL and the bounds the server accepts. Absent on an older server. */
  orderSol?: number;
  orderLimits?: { minSol: number; maxSol: number };
  /** S187: the confluence buy threshold in force. Absent on an older server. */
  confluence?: { value: number; defaultValue: number; source: 'operator' | 'env' | 'default'; warnBelow: number; warning: string | null };
  stats: { seen: number; rejectedByStage: Record<string, number>; wouldBuy: number; bought: number; open: number; closed: number; netPnlSol: number; feesPaidSol: number; winRate: number | null } & StatsWindow;
}

/** R6-3 (server side in another batch): which mode and window the stats cover, and whether the read was cut. Absent on an older server. */
export interface StatsWindow {
  mode?: 'SHADOW' | 'PAPER' | 'DEVNET_LIVE' | null;
  windowStart?: number | null;
  windowEnd?: number;
  rowsCounted?: number;
  rowsRead?: number;
  rowLimit?: number;
  truncated?: boolean;
  pnlSource?: string;
  notes?: string[];
}

/**
 * R6-5: SHADOW's "would buy" is not the test PAPER and DEVNET_LIVE apply: it skips the slot cap, the session budget and the re-entry guard,
 * and uses its own size and a fixed fee estimate, so it overstates what a real session would buy.
 */
export const SHADOW_TEST_NOTE = 'SHADOW is a looser test than a real buy: it skips the open-slot cap, the session budget and the re-entry guard, and uses its own order size and a fixed fee estimate. Do not read it as what PAPER or DEVNET_LIVE would have bought.';

const MODE_STYLE: Record<AutoMode, string> = {
  OFF: 'bg-slate-800 text-slate-300', SHADOW: 'bg-cyan-900/60 text-cyan-200', PAPER: 'bg-emerald-900/60 text-emerald-200', DEVNET_LIVE: 'bg-amber-900/70 text-amber-200',
};

export function AutoModeBadge({ mode, halted }: { mode: AutoMode | null; halted?: boolean }) {
  if (halted) return <span className="px-2 py-0.5 rounded text-[11px] font-bold font-mono bg-red-900/70 text-red-200" data-testid="auto-badge">AUTO HALTED</span>;
  return (
    <span className={`px-2 py-0.5 rounded text-[11px] font-bold font-mono ${mode ? MODE_STYLE[mode] : 'bg-slate-800 text-slate-500'}`} data-testid="auto-badge">
      AUTO: {mode ?? '—'}
    </span>
  );
}

/** The reason a budget is not acceptable to the server, or null. Mirrors AutoSnipeController.setBudget. */
export function budgetProblem(nBuys: number, nSpend: number, limits?: AutoStatusData['budgetLimits']): string | null {
  if (!Number.isInteger(nBuys) || nBuys < 1 || nBuys > (limits?.maxBuys ?? 50)) return `Max buys must be a whole number from 1 to ${limits?.maxBuys ?? 50}.`;
  if (!Number.isFinite(nSpend) || (limits && nSpend < limits.minSpendSol)) return `Max spend must cover at least one order (${limits?.minSpendSol} SOL).`;
  if (limits && nSpend > limits.maxSpendSol + 1e-9) return `Max spend is above the server cap of ${Number(limits.maxSpendSol.toFixed(6))} SOL (${limits.capNote ?? '3 x MAX_POSITION_SIZE_SOL'}).`;
  return null;
}

/** S181: edit the session budget (buys and spend, in SOL). The server refuses an out-of-bounds value with its reason; nothing is clamped. */
export function AutoBudgetEditor({ budgets, limits, onSave, busy }: { budgets: AutoStatusData['budgets']; limits?: AutoStatusData['budgetLimits']; onSave?: (maxBuys: number, maxSpendSol: number) => void; busy?: boolean }) {
  const [buys, setBuys] = useState(String(budgets.maxBuys));
  const [spend, setSpend] = useState(String(Number(budgets.maxSpendSol.toFixed(6))));
  const pBuys = parseDecimalText(buys), pSpend = parseDecimalText(spend);
  const nBuys = pBuys.ok ? pBuys.value : NaN, nSpend = pSpend.ok ? pSpend.value : NaN;
  // R10-10: a comma decimal is refused as such; the browser number box used to drop the comma, so "2,5" saved 25 buys
  const commaProblem = [pBuys, pSpend].some((p) => !p.ok && p.reason === COMMA_DECIMAL_REASON) ? COMMA_DECIMAL_REASON : null;
  const found = commaProblem ?? budgetProblem(nBuys, nSpend, limits);
  // S188: what the server is running with is shown as it is. A PAPER session defaults to 50 buys and 10 x the paper bankroll (0.7 SOL), which is
  // above the cap on a budget the operator SAVES (3 x MAX_POSITION_SIZE_SOL); flagging the server's own value red read as stale or broken input.
  const unedited = nBuys === budgets.maxBuys && Math.abs(nSpend - Number(budgets.maxSpendSol.toFixed(6))) < 1e-9;
  const problem = unedited ? null : found;
  const runningNote = unedited && found ? `This is what the running session uses (a PAPER session starts with up to 50 buys and 10 x the paper bankroll). ${found} That limit only applies when you save a budget.` : null;
  return (
    <div className="mb-2 font-mono" data-testid="auto-budget-editor">
      <div className="text-slate-500 mb-0.5">Session budget</div>
      <div className="flex items-center gap-1.5">
        <input data-testid="budget-buys" type="text" inputMode="numeric" aria-label="Session budget: max buys" value={buys} onChange={(e) => setBuys(e.target.value)} className="w-14 px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-[11px]" />
        <span className="text-slate-500">buys,</span>
        <input data-testid="budget-spend" type="text" inputMode="decimal" aria-label="Session budget: max spend (SOL)" value={spend} onChange={(e) => setSpend(e.target.value)} className="w-20 px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-[11px]" />
        <span className="text-slate-500">SOL incl. fees</span>
        <button data-testid="budget-save" aria-label="Save session budget" disabled={busy || found !== null || unedited} onClick={() => onSave?.(nBuys, nSpend)} className="ml-auto px-2 py-0.5 rounded border border-slate-600 text-slate-300 hover:text-white disabled:opacity-40">Save</button>
      </div>
      {problem && <p className="text-rose-400 mt-0.5" data-testid="budget-problem">{problem}</p>}
      {runningNote && <p className="text-amber-300/90 mt-0.5" data-testid="budget-running-note">{runningNote}</p>}
      {limits && <p className="text-slate-600 mt-0.5">Up to {Number(limits.maxSpendSol.toFixed(6))} SOL{limits.capKind === 'PAPER' ? ' (PAPER session: paper spends nothing; a real-SOL session is capped lower)' : ''}. Kept until the server restarts.</p>}
    </div>
  );
}

/** S183: edit the size of one auto order (SOL). Same bounds as the manual snipe amount; the server refuses anything else with its reason. */
export function AutoOrderSizeEditor({ orderSol, limits, spendLimitSol, onSave, busy }: { orderSol: number; limits?: AutoStatusData['orderLimits']; spendLimitSol?: number; onSave?: (sol: number) => void; busy?: boolean }) {
  const [text, setText] = useState(String(Number(orderSol.toFixed(6))));
  const parsed = parseDecimalText(text);
  const n = parsed.ok ? parsed.value : NaN;
  let problem: string | null = null;
  if (!parsed.ok && parsed.reason === COMMA_DECIMAL_REASON) problem = COMMA_DECIMAL_REASON;
  else if (!Number.isFinite(n) || n <= 0) problem = 'Enter an order size in SOL above 0.';
  else if (limits && n < limits.minSol) problem = `Below the ${limits.minSol} SOL minimum: the network fee and token account rent would eat the order.`;
  else if (limits && n > limits.maxSol + 1e-9) problem = `Above the ${limits.maxSol} SOL maximum position size (MAX_POSITION_SIZE_SOL).`;
  else if (spendLimitSol !== undefined && n > spendLimitSol + 1e-9) problem = `Above the ${Number(spendLimitSol.toFixed(6))} SOL session spend limit; raise the session budget first.`;
  return (
    <div className="mb-2 font-mono" data-testid="auto-order-editor">
      <div className="text-slate-500 mb-0.5">Order size (each auto buy)</div>
      <div className="flex items-center gap-1.5">
        <input data-testid="order-sol" type="text" inputMode="decimal" aria-label="Order size (SOL)" value={text} onChange={(e) => setText(e.target.value)} className="w-20 px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-[11px]" />
        <span className="text-slate-500">SOL</span>
        <button data-testid="order-save" aria-label="Save order size" disabled={busy || problem !== null} onClick={() => onSave?.(n)} className="ml-auto px-2 py-0.5 rounded border border-slate-600 text-slate-300 hover:text-white disabled:opacity-40">Save</button>
      </div>
      {problem && <p className="text-rose-400 mt-0.5" data-testid="order-problem">{problem}</p>}
      {limits && <p className="text-slate-600 mt-0.5">{limits.minSol} to {limits.maxSol} SOL. Applies to PAPER and DEVNET_LIVE buys from the next order; kept until the server restarts.</p>}
    </div>
  );
}

/**
 * S187: the confluence buy threshold (0 to 100, default 70): a slider and a number box that move together. It sets the watch window's HOT gate
 * and the execution gate (manual snipes too) as one value, so they cannot diverge. Below 50 the panel warns plainly.
 */
export function ConfluenceThresholdEditor({ confluence, onSave, busy }: { confluence: NonNullable<AutoStatusData['confluence']>; onSave?: (value: number) => void; busy?: boolean }) {
  const [text, setText] = useState(String(confluence.value));
  const parsed = parseThreshold(text);
  const shown = parsed.ok ? parsed.value : confluence.value;
  const warning = thresholdWarning(shown);
  const dirty = parsed.ok && parsed.value !== confluence.value;
  return (
    <div className="mb-2 font-mono" data-testid="confluence-editor">
      <div className="text-slate-500 mb-0.5">Confluence buy threshold <span className="text-slate-300" data-testid="confluence-current">in force: {confluence.value}</span> <span className="text-slate-600">(of 100)</span></div>
      <div className="flex items-center gap-1.5">
        <input data-testid="confluence-slider" type="range" min={0} max={100} step={1} value={shown} onChange={(e) => setText(e.target.value)} className="flex-1" aria-label="Confluence buy threshold" />
        <input data-testid="confluence-box" type="text" inputMode="numeric" aria-label="Confluence buy threshold (0 to 100)" value={text} onChange={(e) => setText(e.target.value)} className="w-14 px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-[11px]" />
        <button data-testid="confluence-save" aria-label="Save confluence threshold" disabled={busy || !parsed.ok || !dirty} onClick={() => parsed.ok && onSave?.(parsed.value)} className="px-2 py-0.5 rounded border border-slate-600 text-slate-300 hover:text-white disabled:opacity-40">Save</button>
      </div>
      {!parsed.ok && <p className="text-rose-400 mt-0.5" data-testid="confluence-problem">{parsed.reason}</p>}
      {warning && <p className="text-amber-300 mt-0.5" data-testid="confluence-warning">{warning}</p>}
      <p className="text-slate-600 mt-0.5">One value for the watch window and the buy gate (manual snipes too). {confluence.source === 'operator' ? `Default is ${confluence.defaultValue}.` : confluence.source === 'env' ? `Set by CONFLUENCE_MIN_SCORE (${confluence.defaultValue}).` : 'Default.'} Saved on the server: a restart keeps it (it does not go back to the default).</p>
    </div>
  );
}

/**
 * R6-4: what KILL AUTO did, from the POST /api/auto/kill reply. "Sell what it bought" is reported as done only when every sell was;
 * a refused or failed one is counted and named, since those positions are still open. R12-5: it also says manual positions stay open.
 */
export interface KillReport { ok: boolean; text: string }
export function killReportFor(j: any): KillReport | null {
  if (!j || typeof j !== 'object') return null;
  // Two server shapes: { attempted, closed, failed[] } and { closed, refused[], failed[], stillOpen } (no `attempted`). Anything else is
  // not a kill report.
  const hasAttempted = typeof j.attempted === 'number';
  const hasStillOpen = typeof j.stillOpen === 'number';
  if (!hasAttempted && !hasStillOpen) return null;
  const list = (x: unknown): Array<{ symbol?: string; mint?: string; error?: string }> => (Array.isArray(x) ? x : []);
  const failed = [...list(j.refused).map((f) => ({ ...f, error: f.error ?? 'refused, nothing sent' })), ...list(j.failed)];
  const closed = typeof j.closed === 'number' ? j.closed : 0;
  const stillOpen = hasStillOpen ? j.stillOpen : 0;
  const ok = failed.length === 0 && stillOpen === 0 && j.success !== false;
  // R12-5: KILL AUTO sells only what auto bought. The reply's `manualOpen` (when the server sends it) counts the positions opened by hand.
  const manual = typeof j.manualOpen === 'number'
    ? j.manualOpen > 0 ? ` ${j.manualOpen} position(s) you opened by hand stay open: KILL AUTO does not sell them (close them from Plug & Play, or PANIC sells everything).` : ' No position opened by hand is open.'
    : ' Manual positions are not sold by KILL AUTO: close them from Plug & Play.';
  if (ok) {
    if (closed === 0 && (!hasAttempted || j.attempted === 0)) return { ok: true, text: `Auto is OFF. It had no open position to sell.${manual}` };
    return { ok: true, text: (hasAttempted ? `Auto is OFF. Sold ${closed} of ${j.attempted} position(s) it bought.` : `Auto is OFF. Sold ${closed} position(s) it bought; none is still open.`) + manual };
  }
  const names = failed.map((f) => `${f.symbol ?? (f.mint ? `${f.mint.slice(0, 6)}...` : '?')} (${f.error ?? 'refused'})`).join('; ');
  const sold = hasAttempted ? `only ${closed} of ${j.attempted} position(s) were sold` : `${closed} position(s) were sold`;
  const open = hasStillOpen ? ` ${stillOpen} auto position(s) are still open.` : '';
  const why = failed.length ? `; ${failed.length} refused or failed and are STILL OPEN: ${names}.` : '; some are STILL OPEN.';
  return { ok: false, text: `Auto is OFF, but ${sold}${why}${open} Close them by hand.${manual}` };
}

/**
 * R10-3: after a restart the auto kill is saved (auto stays OFF, killed) but the risk-engine kill switch is memory-only and comes back
 * off, so the panel said "Killed: operator kill switch" next to a header that said the switch was off. Say which is which.
 */
export function autoKillText(reason: string, mode: AutoMode, killSwitch: boolean | null | undefined): string {
  const base = `Killed: ${reason}.${mode === 'OFF' ? ' Auto stays OFF until you set a mode.' : ''}`;
  if (killSwitch === false && /kill switch|panic/i.test(reason)) return `${base} The kill switch itself is OFF now (it is held in memory, so a reset or a restart clears it); this only says why auto was stopped.`;
  return base;
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/** The label over the stats: their mode and window, "truncated" when the read hit its row limit, and the server's notes. */
export function StatsWindowLabel({ s }: { s: StatsWindow }) {
  if (s.mode === undefined && s.windowStart === undefined && s.truncated === undefined) return null;
  const window = s.windowStart ? `${hhmm(s.windowStart)} to ${hhmm(s.windowEnd ?? Date.now())} UTC` : 'no rows yet';
  const rows = typeof s.rowsCounted === 'number' && typeof s.rowsRead === 'number' ? ` (${s.rowsCounted} of ${s.rowsRead} rows read)` : '';
  return (
    <div className="border-t border-slate-800 pt-2 text-[10px] text-slate-500" data-testid="auto-stats-window">
      <p>Stats below: {s.mode ? `${s.mode} only` : 'auto has not run'}, {window}{rows}{s.pnlSource ? `; PnL from the ${s.pnlSource}` : ''}.</p>
      {s.truncated && <p className="text-amber-300 font-bold" data-testid="auto-stats-truncated">TRUNCATED: the read hit its {s.rowLimit ?? ''} row limit, so older rows of this window are not counted.</p>}
      {(s.notes ?? []).map((n) => <p key={n}>{n}</p>)}
    </div>
  );
}

export function AutoPanelView({ status, onMode, onKill, onResume, onBudget, onOrderSize, onThreshold, code, onCode, busy, error, killReport, staleText, killSwitch }: {
  status: AutoStatusData | null; onMode?: (m: AutoMode) => void; onKill?: () => void; onResume?: () => void; onBudget?: (maxBuys: number, maxSpendSol: number) => void; onOrderSize?: (sol: number) => void; onThreshold?: (value: number) => void;
  code?: string; onCode?: (c: string) => void; busy?: boolean; error?: string | null; killReport?: KillReport | null; staleText?: string | null;
  /** R10-3: the risk-engine kill switch as the header reads it (null: unknown) */
  killSwitch?: boolean | null;
}) {
  if (!status) return <section className="rounded-lg border border-slate-800 bg-[#0B0F17] p-3 text-xs text-slate-500" data-testid="auto-panel">{staleText ?? 'Auto-snipe: sign in as operator to read the controller.'}</section>;
  const s = status.stats;
  const b = status.session?.budgetsLeft;
  const rejected = Object.entries(s.rejectedByStage);
  return (
    <section className="rounded-lg border border-slate-800 bg-[#0B0F17] p-3 text-xs" data-testid="auto-panel">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[11px] uppercase tracking-wider text-slate-400 font-bold">Auto-snipe</h3>
        <AutoModeBadge mode={status.mode} halted={!!status.haltReason} />
      </div>
      {status.envEnabled === false && (
        <p className="text-amber-300 mb-2 font-mono" data-testid="auto-env-hint">
          Auto trading is switched off at the server. To enable it, set <strong>AUTO_SNIPE_ENABLED=true</strong> in <strong>.env</strong> and restart the server (<code>npm start</code>). Until then SHADOW, PAPER and DEVNET_LIVE are refused.
        </p>
      )}
      <div className="flex gap-1 mb-2">
        {(['OFF', 'SHADOW', 'PAPER', 'DEVNET_LIVE'] as AutoMode[]).map((m) => (
          <button key={m} disabled={busy || status.mode === m} onClick={() => onMode?.(m)} aria-pressed={status.mode === m} data-testid={`mode-${m}`}
            className={`flex-1 px-1 py-1 rounded font-mono font-bold text-[10px] border ${status.mode === m ? 'border-cyan-500 text-cyan-300' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}>{m}</button>
        ))}
      </div>
      <input value={code ?? ''} onChange={(e) => onCode?.(e.target.value)} aria-label="DEVNET_LIVE confirmation code" placeholder="DEVNET_LIVE confirmation code" className="w-full mb-2 px-2 py-1 rounded bg-slate-900 border border-slate-700 font-mono text-[11px]" />
      {staleText && <p className="text-amber-300 font-bold mb-2" data-testid="auto-stale">{staleText}</p>}
      {error && <p className="text-red-400 mb-2" data-testid="auto-error">{error}</p>}
      {killReport && <p className={`${killReport.ok ? 'text-emerald-300' : 'text-red-300 font-bold'} mb-2`} data-testid="auto-kill-report">{killReport.text}</p>}
      {status.haltReason && <p className="text-red-400 mb-2" data-testid="halt-reason">ALL TRADING HALTED: {status.haltReason} <button onClick={onResume} className="underline ml-1">clear halt</button></p>}
      {status.killReason && <p className="text-amber-400 mb-1" data-testid="auto-kill-reason">{autoKillText(status.killReason, status.mode, killSwitch)}</p>}
      {status.downgradeReason && <p className="text-amber-400 mb-1" data-testid="downgrade-reason">Dropped to SHADOW: {status.downgradeReason}</p>}
      {status.autoRestore && (
        <p className="text-cyan-300 mb-1" data-testid="auto-restore">PAPER comes back by itself once readiness has stayed green for {Math.round(status.autoRestore.needMs / 1000)}s (green for {Math.round(status.autoRestore.greenForMs / 1000)}s so far).</p>
      )}
      {status.confluence && (
        <React.Fragment key={`confluence-${status.confluence.value}`}><ConfluenceThresholdEditor confluence={status.confluence} onSave={onThreshold} busy={busy} /></React.Fragment>
      )}
      {status.orderSol !== undefined && (
        <React.Fragment key={`order-${status.orderSol}`}><AutoOrderSizeEditor orderSol={status.orderSol} limits={status.orderLimits} spendLimitSol={status.budgets.maxSpendSol} onSave={onOrderSize} busy={busy} /></React.Fragment>
      )}
      <React.Fragment key={`${status.budgets.maxBuys}-${status.budgets.maxSpendSol}`}><AutoBudgetEditor budgets={status.budgets} limits={status.budgetLimits} onSave={onBudget} busy={busy} /></React.Fragment>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mb-2 font-mono">
        <span className="text-slate-500">Buys left</span><span className="text-right">{b ? `${b.buys} / ${status.budgets.maxBuys}` : '—'}</span>
        <span className="text-slate-500">Spend left</span><span className="text-right">{b ? `${fmt(b.spendSol, 4)} SOL` : '—'}</span>
        <span className="text-slate-500">Loss room</span><span className="text-right">{b ? `${fmt(b.lossSol, 4)} SOL` : '—'}</span>
        <span className="text-slate-500">Time left</span><span className="text-right">{b ? `${Math.round(b.msLeft / 60000)} min` : '—'}</span>
        <span className="text-slate-500">Slippage breaches</span><span className="text-right">{status.slippageBreaches}</span>
      </div>
      <StatsWindowLabel s={s} />
      <div className="border-t border-slate-800 pt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono" data-testid="auto-stats">
        <span className="text-slate-500">Seen</span><span className="text-right">{s.seen}</span>
        <span className="text-slate-500" data-testid="shadow-would-buy" title={SHADOW_TEST_NOTE}>Would buy (SHADOW, looser test)</span><span className="text-right">{s.wouldBuy}</span>
        <span className="text-slate-500">Bought</span><span className="text-right">{s.bought}</span>
        <span className="text-slate-500">Open / closed</span><span className="text-right">{s.open} / {s.closed}</span>
        <span className="text-slate-500">Net PnL after fees</span><span className={`text-right ${s.closed === 0 ? '' : s.netPnlSol >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{s.closed === 0 ? '—' : `${s.netPnlSol.toFixed(5)} SOL`}</span>
        <span className="text-slate-500">Fees paid</span><span className="text-right">{s.bought === 0 ? '—' : `${s.feesPaidSol.toFixed(5)} SOL`}</span>
        <span className="text-slate-500">Win rate</span><span className="text-right">{s.winRate === null ? '—' : `${(s.winRate * 100).toFixed(0)}%`}</span>
      </div>
      <p className="mt-2 text-slate-500">Dropped / rejected by stage: {rejected.length === 0 ? '—' : rejected.map(([k, v]) => `${k} ${v}`).join(' · ')}</p>
      <button onClick={onKill} data-testid="auto-kill" className="mt-2 w-full px-2 py-1.5 rounded bg-red-900/70 hover:bg-red-800 text-red-100 font-bold">KILL AUTO (to OFF, sell what it bought)</button>
    </section>
  );
}

/**
 * R9-2: only an object with the fields the panel reads is a status. A refusal (400) carries `status: "REJECTED"`, a string, and
 * spreading it into the panel state made the next render throw.
 */
export function asAutoStatus(x: unknown): AutoStatusData | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const o = x as any;
  if (typeof o.mode !== 'string' || !o.budgets || typeof o.budgets !== 'object' || typeof o.budgets.maxBuys !== 'number') return null;
  return o as AutoStatusData;
}

/** R9-6 / R9-7: how old the panel's status is, and why the last read failed (null when it succeeded). */
export interface AutoStatusRead { status: AutoStatusData | null; at: number | null; error: string | null }
export const AUTO_STATUS_STALE_MS = 15_000;

/** `reload` reads the status at once (R12-7: after a save whose outcome is not known). */
export function useAutoStatusRead(): AutoStatusRead & { reload: () => void } {
  const [read, setRead] = useState<AutoStatusRead>({ status: null, at: null, error: null });
  const reloadRef = React.useRef<() => void>(() => {});
  const reload = useCallback(() => reloadRef.current(), []);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await authFetch('/api/auto/status');
        if (!alive) return;
        // R9-6: a refused read (401 after Clear Token) keeps the last status, marked with why it is old
        if (!r.ok) { setRead((p) => ({ ...p, error: `HTTP ${r.status}` })); return; }
        const j = asAutoStatus(await r.json());
        if (j && j.stats && typeof j.stats === 'object') setRead({ status: j, at: Date.now(), error: null });
        else setRead((p) => ({ ...p, error: 'unreadable answer' }));
      } catch (e: any) {
        if (alive) setRead((p) => ({ ...p, error: `server not reachable (${e?.message || 'network error'})` }));
      }
    };
    reloadRef.current = () => { void load(); };
    load();
    const t = setInterval(load, 4000);
    const off = onAuthenticated(load); // UI-5
    return () => { alive = false; reloadRef.current = () => {}; clearInterval(t); off(); };
  }, []);
  return { ...read, reload };
}

export function useAutoStatus(): AutoStatusData | null {
  return useAutoStatusRead().status;
}

/** R9-6 / R9-7: the status is old when its last read failed or it is older than AUTO_STATUS_STALE_MS. */
export function autoStatusStaleText(read: Pick<AutoStatusRead, 'at' | 'error'>, now: number): string | null {
  if (read.at === null) return read.error ? `Auto status could not be read (${read.error}).` : null;
  const age = now - read.at;
  if (!read.error && age <= AUTO_STATUS_STALE_MS) return null;
  return `STALE: auto status last read ${Math.round(age / 1000)}s ago${read.error ? ` (${read.error})` : ''}. The mode and figures below may have changed.`;
}

export function AutoHeaderBadge() {
  const r = useAutoStatusRead();
  const stale = autoStatusStaleText(r, Date.now());
  if (stale && r.status) return <span title={stale} className="px-2 py-0.5 rounded text-[11px] font-bold font-mono bg-amber-950 text-amber-200 border border-amber-500/50" data-testid="auto-badge">AUTO: {r.status.mode}? (stale)</span>;
  return <AutoModeBadge mode={r.status?.mode ?? null} halted={!!r.status?.haltReason} />;
}

/**
 * `killSwitch`: the kill-switch state the header shows (App passes it, R11-3), so the panel and the header say the same thing and both
 * re-read it right after a PANIC or KILL reply. Without it the panel falls back to the shared mode poller.
 */
export function AutoPanel({ killSwitch }: { killSwitch?: boolean | null } = {}) {
  const read = useAutoStatusRead();
  const tradingMode = useTradingMode();
  const status = read.status;
  const [local, setLocal] = useState<AutoStatusData | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = local ?? status;
  useEffect(() => { setLocal(null); }, [status]);
  const [error, setError] = useState<string | null>(null);
  const [killReport, setKillReport] = useState<KillReport | null>(null);
  const reloadStatus = read.reload;
  const post = useCallback(async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => null);
      if (path === '/api/auto/kill') setKillReport(killReportFor(j));
      // R31: a refusal (400/403/409/429) carries its reason in the body; show it instead of dropping it.
      // R12-7: a non-2xx with no reason in it (a proxy's bodiless or HTML 502/504) is not a refusal from the server: the request may
      // have been applied. Say the outcome is unknown and read the status again.
      const reason = j && typeof j === 'object' ? (j.error || j.message) : null;
      if (!r.ok && reason) setError(`${reason} (HTTP ${r.status})`);
      else if (!r.ok) { setError(`No readable answer from the server (HTTP ${r.status}): the change may or may not have been applied. Reading the status again; check it before you retry.`); reloadStatus(); }
      const next = asAutoStatus(j?.status);
      if (next && shown?.stats) setLocal({ ...next, stats: shown.stats });
    } catch (e: any) {
      // the request may have reached the server before the connection failed (R12-7)
      setError(`Could not reach the server (${e?.message || 'network error'}). The change may or may not have been applied; reading the status again, check it before you retry.`);
      reloadStatus();
    } finally { setBusy(false); }
  }, [shown, reloadStatus]);
  return (
    <AutoPanelView status={shown} busy={busy} error={error} killReport={killReport} code={code} onCode={setCode} staleText={autoStatusStaleText(read, Date.now())} killSwitch={killSwitch !== undefined ? killSwitch : tradingMode.killSwitch}
      onMode={(m) => post('/api/auto/mode', { mode: m, confirmationCode: m === 'DEVNET_LIVE' ? code : undefined })}
      onKill={async () => {
        // Q45: KILL sells every position the auto trader opened, so it asks first. R10-11: in a dialog Enter cannot accept.
        if (!(await askConfirm({ title: 'KILL AUTO', body: 'KILL AUTO: switch auto to OFF and sell every position it bought. Continue?', confirmLabel: 'Kill auto and sell' }))) return;
        void post('/api/auto/kill', { exitAll: true, reason: 'operator kill from panel' });
      }}
      onResume={() => post('/api/auto/resume', { clearHalt: true })}
      onBudget={(maxBuys, maxSpendSol) => post('/api/auto/budget', { maxBuys, maxSpendSol })}
      onOrderSize={(orderSol) => post('/api/auto/order-size', { orderSol })}
      onThreshold={(threshold) => post('/api/auto/threshold', { threshold })} />
  );
}
