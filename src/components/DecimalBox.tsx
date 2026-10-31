import React, { useEffect, useState } from 'react';
import { parseDecimalText } from '../utils/numberInput';

/**
 * R10-10: a number box for a value kept as a number. The typed text is read strictly (a comma decimal is refused with its reason); only a
 * valid number reaches onValue, and while the text is not one the box says which value is still in use.
 */
export function DecimalBox({ value, onValue, integer, min, max, onProblem, testId, ariaLabel, className }: {
  value: number; onValue: (n: number) => void; integer?: boolean; testId?: string; ariaLabel: string; className?: string;
  /** R11-9: the server's bounds; a value outside them is refused here with its reason, as a comma is */
  min?: number; max?: number;
  /** R11-9: told the box's problem (null when the text is a valid value), so a form can refuse to save */
  onProblem?: (reason: string | null) => void;
}) {
  const [text, setText] = useState(String(value));
  const opts = { integer, min, max };
  const parsed = parseDecimalText(text, opts);
  // a value changed elsewhere (a reset, a load) replaces the text unless the text already says it
  useEffect(() => { setText((t) => { const p = parseDecimalText(t, { integer, min, max }); return p.ok && p.value === value ? t : String(value); }); }, [value, integer, min, max]);
  const problem = parsed.ok ? null : parsed.reason;
  useEffect(() => { onProblem?.(problem); }, [problem]); // only when the problem changes; a new onProblem each render is the same callback
  return (
    <>
      <input
        type="text"
        inputMode={integer ? 'numeric' : 'decimal'}
        data-testid={testId}
        aria-label={ariaLabel}
        aria-invalid={!parsed.ok}
        value={text}
        onChange={(e) => { setText(e.target.value); const p = parseDecimalText(e.target.value, opts); if (p.ok) onValue(p.value); }}
        className={className}
      />
      {!parsed.ok && <span className="text-[10px] text-rose-400 block" data-testid={testId ? `${testId}-problem` : undefined}>{parsed.reason} Still using {value}.</span>}
    </>
  );
}
