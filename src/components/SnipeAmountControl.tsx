import React from 'react';
import { useSnipeAmount, formatUsdEquivalent, paperCeilingNote, type SnipeAmountState } from '../utils/snipeAmount';

/** S181: the one snipe amount field. Shown wherever a manual snipe button lives; they all read the same saved value. */
export function SnipeAmountView({ state, compact = false }: { state: Pick<SnipeAmountState, 'text' | 'setText' | 'limits' | 'parsed'>; compact?: boolean }) {
  const { text, setText, limits, parsed } = state;
  return (
    <div className="flex flex-wrap items-center gap-2 font-mono text-xs" data-testid="snipe-amount">
      <label className="text-slate-400 font-bold" htmlFor="snipe-amount-input">Snipe amount (SOL)</label>
      <input
        id="snipe-amount-input"
        data-testid="snipe-amount-input"
        type="text"
        inputMode="decimal"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className={`w-24 bg-[#141B2D] border rounded px-2 py-1 text-white outline-none ${parsed.ok ? 'border-[#1E293B] focus:border-cyan-400' : 'border-rose-500/70'}`}
      />
      <span className="text-slate-400" data-testid="snipe-amount-usd">{parsed.ok ? formatUsdEquivalent(parsed.sol, limits.solPriceUsd) : ''}</span>
      {!compact && <span className="text-slate-600">min {limits.minSol} / max {limits.maxSol} SOL</span>}
      {!parsed.ok && <span className="text-rose-400" data-testid="snipe-amount-error">{parsed.reason}</span>}
      {(() => {
        // R12-9: the PAPER ceiling the server enforces now, below MAX_POSITION_SIZE_SOL
        const note = paperCeilingNote(parsed.ok ? parsed.sol : null, limits);
        return note && (note.over || !compact) ? <span data-testid="snipe-amount-paper-ceiling" className={note.over ? 'text-amber-300' : 'text-slate-500'}>{note.text}</span> : null;
      })()}
    </div>
  );
}

export function SnipeAmountControl({ compact }: { compact?: boolean }) {
  const state = useSnipeAmount();
  return <SnipeAmountView state={state} compact={compact} />;
}
