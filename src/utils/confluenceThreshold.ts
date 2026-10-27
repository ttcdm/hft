/** S187: the client's copy of the confluence threshold rules (server/signals/confluenceThreshold.ts; the client must not import server code, and a test pins the numbers together). */
import { parseDecimalText, COMMA_DECIMAL_REASON } from './numberInput';

export const THRESHOLD_MIN = 0;
export const THRESHOLD_MAX = 100;
export const THRESHOLD_WARN_BELOW = 50;
export const THRESHOLD_DEFAULT = 70;

export type ParsedThreshold = { ok: true; value: number } | { ok: false; reason: string };

/** A whole number from 0 to 100; the same refusal the server gives, so the screen can say no before the request goes out. Nothing is clamped. */
export function parseThreshold(text: string): ParsedThreshold {
  const p = parseDecimalText(text);
  if (!p.ok && p.reason === COMMA_DECIMAL_REASON) return p;
  const n = p.ok ? p.value : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, reason: `Enter a whole number from ${THRESHOLD_MIN} to ${THRESHOLD_MAX}.` };
  if (n < THRESHOLD_MIN || n > THRESHOLD_MAX) return { ok: false, reason: `${n} is outside ${THRESHOLD_MIN} to ${THRESHOLD_MAX}.` };
  return { ok: true, value: n };
}

/** The plain warning under 50, or null. */
export function thresholdWarning(value: number): string | null {
  return value < THRESHOLD_WARN_BELOW ? `Below ${THRESHOLD_WARN_BELOW}: more buys of weaker coins. A lower threshold lets more launches through; it does not make them better.` : null;
}
