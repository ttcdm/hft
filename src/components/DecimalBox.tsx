import React, { useEffect, useState } from 'react';
import { parseDecimalText } from '../utils/numberInput';

/**
 * R10-10: a number box for a value kept as a number. The typed text is read strictly (a comma decimal is refused with its reason); only a
 * valid number reaches onValue, and while the text is not one the box says which value is still in use.
 */
export function DecimalBox({ value, onValue, integer, testId, ariaLabel, className }: { value: number; onValue: (n: number) => void; integer?: boolean; testId?: string; ariaLabel: string; className?: string }) {
  const [text, setText] = useState(String(value));
  const parsed = parseDecimalText(text, { integer });
  // a value changed elsewhere (a reset, a load) replaces the text unless the text already says it
  useEffect(() => { setText((t) => { const p = parseDecimalText(t, { integer }); return p.ok && p.value === value ? t : String(value); }); }, [value, integer]);
  return (
    <>
      <input
        type="text"
        inputMode={integer ? 'numeric' : 'decimal'}
        data-testid={testId}
        aria-label={ariaLabel}
        aria-invalid={!parsed.ok}
        value={text}
        onChange={(e) => { setText(e.target.value); const p = parseDecimalText(e.target.value, { integer }); if (p.ok) onValue(p.value); }}
        className={className}
      />
      {!parsed.ok && <span className="text-[10px] text-rose-400 block" data-testid={testId ? `${testId}-problem` : undefined}>{parsed.reason} Still using {value}.</span>}
    </>
  );
}
