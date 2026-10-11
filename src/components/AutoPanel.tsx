import React, { useEffect, useState, useCallback } from 'react';
import { authFetch } from '../services/engineClient';
import { fmt } from './TokenBoard';

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
  budgetLimits?: { maxSpendSol: number; minSpendSol: number; maxBuys: number };
  stats: { seen: number; rejectedByStage: Record<string, number>; wouldBuy: number; bought: number; open: number; closed: number; netPnlSol: number; feesPaidSol: number; winRate: number | null };
}

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

/** S181: edit the session budget (buys and spend, in SOL). The server refuses an out-of-bounds value with its reason; nothing is clamped. */
export function AutoBudgetEditor({ budgets, limits, onSave, busy }: { budgets: AutoStatusData['budgets']; limits?: AutoStatusData['budgetLimits']; onSave?: (maxBuys: number, maxSpendSol: number) => void; busy?: boolean }) {
  const [buys, setBuys] = useState(String(budgets.maxBuys));
  const [spend, setSpend] = useState(String(Number(budgets.maxSpendSol.toFixed(6))));
  const nBuys = Number(buys), nSpend = Number(spend);
  let problem: string | null = null;
  if (!Number.isInteger(nBuys) || nBuys < 1 || nBuys > (limits?.maxBuys ?? 50)) problem = `Max buys must be a whole number from 1 to ${limits?.maxBuys ?? 50}.`;
  else if (!Number.isFinite(nSpend) || (limits && nSpend < limits.minSpendSol)) problem = `Max spend must cover at least one order (${limits?.minSpendSol} SOL).`;
  else if (limits && nSpend > limits.maxSpendSol + 1e-9) problem = `Max spend is above the server cap of ${Number(limits.maxSpendSol.toFixed(6))} SOL (3 x MAX_POSITION_SIZE_SOL).`;
  return (
    <div className="mb-2 font-mono" data-testid="auto-budget-editor">
      <div className="text-slate-500 mb-0.5">Session budget</div>
      <div className="flex items-center gap-1.5">
        <input data-testid="budget-buys" type="number" step="1" min="1" max={limits?.maxBuys ?? 50} value={buys} onChange={(e) => setBuys(e.target.value)} className="w-14 px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-[11px]" />
        <span className="text-slate-500">buys,</span>
        <input data-testid="budget-spend" type="number" step="0.005" min={limits?.minSpendSol} max={limits?.maxSpendSol} value={spend} onChange={(e) => setSpend(e.target.value)} className="w-20 px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-[11px]" />
        <span className="text-slate-500">SOL incl. fees</span>
        <button data-testid="budget-save" disabled={busy || problem !== null} onClick={() => onSave?.(nBuys, nSpend)} className="ml-auto px-2 py-0.5 rounded border border-slate-600 text-slate-300 hover:text-white disabled:opacity-40">Save</button>
      </div>
      {problem && <p className="text-rose-400 mt-0.5" data-testid="budget-problem">{problem}</p>}
      {limits && <p className="text-slate-600 mt-0.5">Up to {Number(limits.maxSpendSol.toFixed(6))} SOL. Kept until the server restarts.</p>}
    </div>
  );
}

export function AutoPanelView({ status, onMode, onKill, onResume, onBudget, code, onCode, busy, error }: {
  status: AutoStatusData | null; onMode?: (m: AutoMode) => void; onKill?: () => void; onResume?: () => void; onBudget?: (maxBuys: number, maxSpendSol: number) => void;
  code?: string; onCode?: (c: string) => void; busy?: boolean; error?: string | null;
}) {
  if (!status) return <section className="rounded-lg border border-slate-800 bg-[#0B0F17] p-3 text-xs text-slate-500" data-testid="auto-panel">Auto-snipe: sign in as operator to read the controller.</section>;
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
          <button key={m} disabled={busy || status.mode === m} onClick={() => onMode?.(m)} data-testid={`mode-${m}`}
            className={`flex-1 px-1 py-1 rounded font-mono font-bold text-[10px] border ${status.mode === m ? 'border-cyan-500 text-cyan-300' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}>{m}</button>
        ))}
      </div>
      <input value={code ?? ''} onChange={(e) => onCode?.(e.target.value)} placeholder="DEVNET_LIVE confirmation code" className="w-full mb-2 px-2 py-1 rounded bg-slate-900 border border-slate-700 font-mono text-[11px]" />
      {error && <p className="text-red-400 mb-2" data-testid="auto-error">{error}</p>}
      {status.haltReason && <p className="text-red-400 mb-2" data-testid="halt-reason">ALL TRADING HALTED: {status.haltReason} <button onClick={onResume} className="underline ml-1">clear halt</button></p>}
      {status.killReason && <p className="text-amber-400 mb-1">Killed: {status.killReason}</p>}
      {status.downgradeReason && <p className="text-amber-400 mb-1" data-testid="downgrade-reason">Dropped to SHADOW: {status.downgradeReason}</p>}
      <React.Fragment key={`${status.budgets.maxBuys}-${status.budgets.maxSpendSol}`}><AutoBudgetEditor budgets={status.budgets} limits={status.budgetLimits} onSave={onBudget} busy={busy} /></React.Fragment>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mb-2 font-mono">
        <span className="text-slate-500">Buys left</span><span className="text-right">{b ? `${b.buys} / ${status.budgets.maxBuys}` : '—'}</span>
        <span className="text-slate-500">Spend left</span><span className="text-right">{b ? `${fmt(b.spendSol, 4)} SOL` : '—'}</span>
        <span className="text-slate-500">Loss room</span><span className="text-right">{b ? `${fmt(b.lossSol, 4)} SOL` : '—'}</span>
        <span className="text-slate-500">Time left</span><span className="text-right">{b ? `${Math.round(b.msLeft / 60000)} min` : '—'}</span>
        <span className="text-slate-500">Slippage breaches</span><span className="text-right">{status.slippageBreaches}</span>
      </div>
      <div className="border-t border-slate-800 pt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono" data-testid="auto-stats">
        <span className="text-slate-500">Seen</span><span className="text-right">{s.seen}</span>
        <span className="text-slate-500">Would buy (shadow)</span><span className="text-right">{s.wouldBuy}</span>
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

export function useAutoStatus(): AutoStatusData | null {
  const [status, setStatus] = useState<AutoStatusData | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await authFetch('/api/auto/status');
        if (r.ok && alive) setStatus(await r.json());
      } catch { /* keep last */ }
    };
    load();
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return status;
}

export function AutoHeaderBadge() {
  const s = useAutoStatus();
  return <AutoModeBadge mode={s?.mode ?? null} halted={!!s?.haltReason} />;
}

export function AutoPanel() {
  const status = useAutoStatus();
  const [local, setLocal] = useState<AutoStatusData | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = local ?? status;
  useEffect(() => { setLocal(null); }, [status]);
  const [error, setError] = useState<string | null>(null);
  const post = useCallback(async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => null);
      // R31: a refusal (400/403/409/429) carries its reason in the body; show it instead of dropping it
      if (!r.ok) setError(`${j?.error || j?.message || 'Request refused'} (HTTP ${r.status})`);
      if (j?.status) setLocal({ ...j.status, stats: shown?.stats });
    } catch (e: any) {
      setError(`Could not reach the server (${e?.message || 'network error'}). Nothing was changed as far as the panel knows; check the status above.`);
    } finally { setBusy(false); }
  }, [shown]);
  return (
    <AutoPanelView status={shown} busy={busy} error={error} code={code} onCode={setCode}
      onMode={(m) => post('/api/auto/mode', { mode: m, confirmationCode: m === 'DEVNET_LIVE' ? code : undefined })}
      onKill={() => {
        // Q45: KILL sells every position the auto trader opened, so it asks first
        if (typeof window !== 'undefined' && !window.confirm('KILL AUTO: switch auto to OFF and sell every position it bought. Continue?')) return;
        void post('/api/auto/kill', { exitAll: true, reason: 'operator kill from panel' });
      }}
      onResume={() => post('/api/auto/resume', { clearHalt: true })}
      onBudget={(maxBuys, maxSpendSol) => post('/api/auto/budget', { maxBuys, maxSpendSol })} />
  );
}
