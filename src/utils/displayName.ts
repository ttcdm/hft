/**
 * R12-12: token names and symbols are chosen by the creator. A right-to-left override or a zero-width character made "SOL" display as
 * "$LOS" or a different token display as "$SOL", and a 5000-character name pushed the price and Snipe columns off screen. Every
 * screen that shows a token's name or symbol shows it through here:
 * - bidi controls (embeddings, overrides, isolates, marks) and invisible characters (zero-width, word joiner, BOM, soft hyphen,
 *   control characters) are each replaced by a visible "�", so a name that hides something says so instead of looking clean;
 * - the text is cut to a fixed number of characters, with "…".
 * It only changes what is shown; the mint address is the token's identity and is never touched.
 */
export const HIDDEN_CHAR_MARK = '\uFFFD';
export const SYMBOL_MAX_CHARS = 16;
export const NAME_MAX_CHARS = 40;

// U+202A-U+202E embeddings and overrides, U+2066-U+2069 isolates, U+200E/U+200F/U+061C marks, U+200B-U+200D zero-width, U+2060-U+2064
// word joiner and invisible operators, U+FEFF BOM, U+00AD soft hyphen, U+180E Mongolian vowel separator, U+034F combining grapheme
// joiner, U+115F/U+1160/U+3164/U+FFA0 Hangul fillers, and C0/C1 control characters.
// The control-character and combining-joiner ranges are the point of this class (they are what gets replaced), hence the disables.
// eslint-disable-next-line no-control-regex, no-misleading-character-class
const HIDDEN = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u200B-\u200D\u2060-\u2064\uFEFF\u00AD\u180E\u034F\u115F\u1160\u3164\uFFA0\u0000-\u001F\u007F-\u009F]/g;

/** The text as it may be shown: hidden and reordering characters made visible, cut to `max` characters (code points). */
export function displayText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return raw === null || raw === undefined ? '' : displayText(String(raw), max);
  const visible = raw.replace(HIDDEN, HIDDEN_CHAR_MARK);
  const chars = Array.from(visible);
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('')}\u2026` : visible;
}

/** A token symbol for display (without the "$"). */
export const displaySymbol = (raw: unknown): string => displayText(typeof raw === 'string' ? raw.replace(/^\$/, '') : raw, SYMBOL_MAX_CHARS);
/** A token name for display. */
export const displayName = (raw: unknown): string => displayText(raw, NAME_MAX_CHARS);
/** "$SYMBOL" for display, or `fallback` when there is no symbol. */
export const dollarSymbol = (raw: unknown, fallback = '?'): string => {
  const s = displaySymbol(raw);
  return s ? `$${s}` : fallback;
};
