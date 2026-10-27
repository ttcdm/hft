import { useEffect, useState } from 'react';
import { authFetch } from '../services/engineClient';
import { parseDecimalText, COMMA_DECIMAL_REASON } from './numberInput';

/** S181: the one snipe size every manual snipe button uses, in SOL. Saved per browser; the server still judges every request. */
export interface SnipeLimits { minSol: number; maxSol: number; defaultSol: number; solPriceUsd: number | null }

export const SNIPE_AMOUNT_STORAGE_KEY = 'apex.snipeAmountSol';
/** Used until the server's limits arrive: the same numbers as server/execution/snipeAmount.ts. */
export const FALLBACK_LIMITS: SnipeLimits = { minSol: 0.001, maxSol: 0.02, defaultSol: 0.01, solPriceUsd: null };

export type ParsedAmount = { ok: true; sol: number } | { ok: false; reason: string };

/** The same rules as the server's checkSnipeAmountSol, so the screen can say no before the request goes out. Nothing is clamped. */
export function parseSnipeAmount(text: string, limits: SnipeLimits): ParsedAmount {
  const p = parseDecimalText(text);
  if (!p.ok && p.reason === COMMA_DECIMAL_REASON) return p;
  const n = p.ok ? p.value : NaN;
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: 'Enter an amount in SOL above 0.' };
  if (n < limits.minSol) return { ok: false, reason: `${n} SOL is below the ${limits.minSol} SOL minimum: the network fee and token account rent would eat the order.` };
  if (n > limits.maxSol + 1e-9) return { ok: false, reason: `${n} SOL is above the ${limits.maxSol} SOL maximum position size (MAX_POSITION_SIZE_SOL).` };
  return { ok: true, sol: n };
}

/** "0.01 SOL"; never more than 6 decimals, no trailing zeros. */
export function formatSol(sol: number): string {
  return `${Number(sol.toFixed(6))} SOL`;
}

/** The dollar value at the server's last known SOL price, or null when it has none (the screen then says so, it does not guess). */
export function usdEquivalent(sol: number, solPriceUsd: number | null): number | null {
  return solPriceUsd !== null && solPriceUsd > 0 ? sol * solPriceUsd : null;
}

export function formatUsdEquivalent(sol: number, solPriceUsd: number | null): string {
  const usd = usdEquivalent(sol, solPriceUsd);
  return usd === null ? 'USD unknown (no SOL price)' : `≈ $${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

export function readSavedAmount(storage: Pick<Storage, 'getItem'> | null, fallback: number): string {
  try {
    const v = storage?.getItem(SNIPE_AMOUNT_STORAGE_KEY);
    return v !== null && v !== undefined && v !== '' ? v : String(fallback);
  } catch { return String(fallback); }
}

// One value shared by every component, saved per browser.
let text: string | null = null;
const subscribers = new Set<() => void>();
const browserStorage = (): Storage | null => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };

export function setSnipeAmountText(next: string): void {
  text = next;
  try { browserStorage()?.setItem(SNIPE_AMOUNT_STORAGE_KEY, next); } catch { /* the setting just does not survive a reload */ }
  subscribers.forEach((fn) => fn());
}

let limitsCache: SnipeLimits | null = null;
const limitSubs = new Set<() => void>();
let limitsLoading = false;
async function loadLimits(): Promise<void> {
  if (limitsLoading) return;
  limitsLoading = true;
  try {
    const r = await authFetch('/api/snipe/limits');
    const j = await r.json().catch(() => null);
    if (r.ok && j?.success) { limitsCache = { minSol: j.minSol, maxSol: j.maxSol, defaultSol: j.defaultSol, solPriceUsd: j.solPriceUsd ?? null }; limitSubs.forEach((fn) => fn()); }
  } catch { /* keep the fallback limits; the server judges the request anyway */ } finally { limitsLoading = false; }
}

export interface SnipeAmountState {
  text: string;
  setText: (t: string) => void;
  limits: SnipeLimits;
  /** true once the server's own limits have arrived */
  limitsKnown: boolean;
  parsed: ParsedAmount;
}

export function useSnipeAmount(): SnipeAmountState {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    subscribers.add(fn); limitSubs.add(fn);
    void loadLimits();
    const t = setInterval(() => void loadLimits(), 30_000);
    return () => { subscribers.delete(fn); limitSubs.delete(fn); clearInterval(t); };
  }, []);
  const limits = limitsCache ?? FALLBACK_LIMITS;
  if (text === null) text = readSavedAmount(browserStorage(), limits.defaultSol);
  return { text, setText: setSnipeAmountText, limits, limitsKnown: limitsCache !== null, parsed: parseSnipeAmount(text, limits) };
}
