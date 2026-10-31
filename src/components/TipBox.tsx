import React, { useEffect, useState } from 'react';
import { parseDecimalText } from '../utils/numberInput';

/** The server's bound on an operator tip (tradeInputs.ts jitoTipSol and AutoSnipeRulesSchema.jitoPriorityTipSol). */
export const TIP_MAX_SOL = 0.1;

/**
 * R11-8: the Jito tip boxes. The server config carries no tip when none was chosen (C6: the dynamic tip policy decides), and loading
 * it put `undefined` in the box, overwrote a typed tip within 5 s, and sent no tip while one was shown. A tip is now either a number
 * the operator typed (kept until they change it, and sent with every snipe from that screen) or empty, which means "auto": nothing is
 * sent and the server's dynamic policy picks the tip. The box shows which. Either way the server bounds the tip to its floor and ceiling.
 */
export type TipCheck = { ok: true; value: number | null } | { ok: false; reason: string };

export function parseTipText(text: string): TipCheck {
  if (text.trim() === '') return { ok: true, value: null };
  const p = parseDecimalText(text);
  if (!p.ok) return p;
  if (p.value <= 0) return { ok: false, reason: 'A tip must be above 0 SOL; leave the box empty for the automatic tip.' };
  if (p.value > TIP_MAX_SOL) return { ok: false, reason: `A tip above ${TIP_MAX_SOL} SOL is refused by the server.` };
  return { ok: true, value: p.value };
}

export const tipInUseText = (v: number | null): string =>
  v === null ? 'auto: no tip is sent; the server picks a dynamic tip for each order' : `${v} SOL is sent with each snipe (the server keeps it within its floor and ceiling)`;

export function TipBox({ value, onValue, onProblem, testId, ariaLabel, className }: { value: number | null; onValue: (v: number | null) => void; onProblem?: (reason: string | null) => void; testId: string; ariaLabel: string; className?: string }) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const parsed = parseTipText(text);
  const problem = parsed.ok ? null : parsed.reason;
  useEffect(() => { onProblem?.(problem); }, [problem]); // only when the problem changes
  // a value changed elsewhere (a save's answer) replaces the text unless the text already says it
  useEffect(() => { setText((t) => { const p = parseTipText(t); return p.ok && p.value === value ? t : value === null ? '' : String(value); }); }, [value]);
  return (
    <>
      <input type="text" inputMode="decimal" data-testid={testId} aria-label={ariaLabel} aria-invalid={!parsed.ok} placeholder="auto" value={text}
        onChange={(e) => { setText(e.target.value); const p = parseTipText(e.target.value); if (p.ok) onValue(p.value); }} className={className} />
      {parsed.ok
        ? <span className="text-[10px] text-slate-500 block" data-testid={`${testId}-in-use`}>{tipInUseText(value)}</span>
        : <span className="text-[10px] text-rose-400 block" data-testid={`${testId}-problem`}>{parsed.reason} Still using: {tipInUseText(value)}.</span>}
    </>
  );
}
