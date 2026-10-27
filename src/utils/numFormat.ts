/**
 * UI report fix 6: small amounts were rounded to nothing ("0.0000 SOL", "$0.000000", a red "-0.00000"). These keep the significant digits
 * of a small value and show unknown as a dash. No exponent notation: an operator reads 0.0000023, not 2.3e-6.
 */
const DASH = '—';

/** Fixed notation with at least `minDecimals` and enough decimals for `sig` significant digits (up to 12). */
export function fmtSmall(v: number | null | undefined, minDecimals = 4, sig = 3): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  if (v === 0) return (0).toFixed(minDecimals);
  const a = Math.abs(v);
  const needed = a >= 1 ? 0 : Math.ceil(-Math.log10(a)) + sig - 1;
  return v.toFixed(Math.min(12, Math.max(minDecimals, needed)));
}

export const fmtSol = (v: number | null | undefined, minDecimals = 4): string => (v === null || v === undefined || !Number.isFinite(v) ? DASH : `${fmtSmall(v, minDecimals)} SOL`);

/** A signed SOL amount; "+"/"-" only when the shown digits are not all zero. */
export function fmtSignedSol(v: number | null | undefined, minDecimals = 4): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const t = fmtSmall(Math.abs(v), minDecimals);
  return `${v > 0 ? '+' : v < 0 ? '-' : ''}${t}`;
}

/** A USD token price: $0 is unknown (the feeds send 0 for "no price"), tiny prices keep their digits. */
export const fmtUsdPrice = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) || v <= 0 ? DASH : `$${fmtSmall(v, 4)}`);

/** 'up' / 'down' / 'flat' for colouring a signed number; 0 is flat (neither green nor red). */
export const signTone = (v: number | null | undefined): 'up' | 'down' | 'flat' => (v === null || v === undefined || !Number.isFinite(v) || v === 0 ? 'flat' : v > 0 ? 'up' : 'down');

/** A 1-based rank, or a dash for 0 / unknown (the feeds use 0 for "not ranked"). */
export const fmtRank = (r: number | null | undefined): string => (typeof r === 'number' && Number.isFinite(r) && r >= 1 ? `#${Math.round(r)}` : DASH);
