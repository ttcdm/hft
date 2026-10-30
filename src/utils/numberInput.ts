/**
 * R10-10 / R9-20: the one strict reader for typed numbers. A browser number box drops the comma in "2,5" (it became 25 buys), so every number
 * box is a text box read through here: a comma decimal is refused with its reason instead of being guessed at, and so is anything that is
 * not a plain decimal (no exponent, no thousands separator, nothing that long).
 */
export type ParsedDecimal = { ok: true; value: number } | { ok: false; reason: string };

export const COMMA_DECIMAL_REASON = 'Use a dot for decimals (2.5), not a comma.';
const MAX_CHARS = 18;
const PLAIN = /^-?(\d+(\.\d*)?|\.\d+)$/;

/**
 * R11-9 / R13-19: `min` and `max` are the server's own bounds for the value (inclusive). An out-of-range value used to pass here and be
 * refused by the server with a 400 the screen never showed.
 */
export function parseDecimalText(text: string, opts: { integer?: boolean; min?: number; max?: number } = {}): ParsedDecimal {
  const t = text.trim();
  if (t === '') return { ok: false, reason: 'Enter a number.' };
  if (t.includes(',')) return { ok: false, reason: COMMA_DECIMAL_REASON };
  if (t.length > MAX_CHARS) return { ok: false, reason: 'That number is too long.' };
  if (!PLAIN.test(t)) return { ok: false, reason: `"${t}" is not a number.` };
  const value = Number(t);
  if (!Number.isFinite(value)) return { ok: false, reason: `"${t}" is not a number.` };
  if (opts.integer && !Number.isInteger(value)) return { ok: false, reason: 'Enter a whole number.' };
  if ((opts.min !== undefined && value < opts.min) || (opts.max !== undefined && value > opts.max)) {
    const range = opts.min !== undefined && opts.max !== undefined ? `from ${opts.min} to ${opts.max}` : opts.min !== undefined ? `from ${opts.min} up` : `up to ${opts.max}`;
    return { ok: false, reason: `Enter a value ${range}; the server refuses ${value}.` };
  }
  return { ok: true, value };
}
