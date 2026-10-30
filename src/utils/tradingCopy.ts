import { displaySymbol } from './displayName';

/** Q37: the words on the arm and panic buttons, kept in one place so they can be tested against what the server does. */

export const ARMED_MESSAGE = (cluster?: string): string =>
  `LIVE TRADING ARMED on ${cluster ?? 'the configured cluster'}: snipes now send ordinary transactions from the local signer wallet and spend real SOL on that cluster.`;

export const PANIC_CONFIRM_TEXT =
  'EMERGENCY: close ALL open positions now, trip the kill switch (blocks new entries), disarm live trading and stop auto mode? Positions that fail to close stay open and are listed afterwards.';

/** One open position as a confirm names it. */
export interface ConfirmPositionLite { symbol?: string | null; mint?: string | null; executionMode?: string | null; status?: string | null }

const MAX_NAMED = 8;
const isOpenRow = (p: ConfirmPositionLite) => p.status === undefined || p.status === null || p.status === 'OPEN' || p.status === 'PARTIALLY_CLOSED';
const rowName = (p: ConfirmPositionLite, label: (s: string) => string) => `${p.symbol ? label(`$${p.symbol}`) : p.mint ? `${String(p.mint).slice(0, 8)}…` : '?'} (${p.executionMode || 'mode unknown'})`;

/**
 * R11-7: the PANIC confirm named no count, token or mode. It now lists what this screen last read as open (count, tokens, each one's
 * mode) and the trading mode, and says so when the list could not be read: the server sells every ACTIVE position whatever this shows.
 * `positions` null means the list was not read. `label` cleans a token name for display (R12-12).
 */
export function panicConfirmText(positions: ConfirmPositionLite[] | null, tradingModeLabel: string, label: (s: string) => string = (s) => s): string {
  const head = `Trading mode: ${tradingModeLabel}.`;
  if (positions === null) return `${PANIC_CONFIRM_TEXT}\n\n${head} The open-position list could not be read, so this screen cannot say how many positions will be sold: the server sells every open position it holds.`;
  const open = positions.filter(isOpenRow);
  if (open.length === 0) return `${PANIC_CONFIRM_TEXT}\n\n${head} This screen's last read shows no open position, so nothing may be sold; the kill switch, disarm and auto stop still happen.`;
  const named = open.slice(0, MAX_NAMED).map((p) => rowName(p, label)).join(', ');
  const more = open.length > MAX_NAMED ? ` and ${open.length - MAX_NAMED} more` : '';
  return `${PANIC_CONFIRM_TEXT}\n\n${head} Sells ${open.length} open position${open.length === 1 ? '' : 's'}: ${named}${more}. The server sells every open position it holds, including any opened since this list was read.`;
}

/**
 * R11-7: the KILL AUTO confirm named no count or mode. It now names the auto mode being stopped and how many positions the auto journal
 * counts as open (the status does not carry their tokens), and says that positions opened by hand are not sold.
 */
export function killAutoConfirmText(s: { mode?: string | null; openAutoPositions?: number | null; statsMode?: string | null } | null): string {
  const mode = s?.mode ? `Auto mode now: ${s.mode}.` : 'Auto mode: unknown (status not read).';
  const n = s?.openAutoPositions;
  const count = typeof n === 'number' && Number.isFinite(n) && n >= 0
    ? `The auto journal${s?.statsMode ? ` (${s.statsMode})` : ''} counts ${n} open position${n === 1 ? '' : 's'} it bought; ${n === 0 ? 'nothing may be sold' : `${n === 1 ? 'it is' : 'they are'} sold now`}.`
    : 'How many positions auto holds could not be read; every position it bought is sold.';
  return `KILL AUTO: switch auto to OFF and sell every position it bought. ${mode} ${count} Positions you opened by hand are NOT sold. Continue?`;
}

export interface PanicResponseLite {
  success?: boolean; message?: string; error?: string;
  /** The emergency-stop report. `failed` can hold STILL_OPEN rows (a position still open after the panic) and BUY_IN_FLIGHT rows. */
  data?: { failed?: Array<{ id?: string; symbol?: string; error?: string }> };
}

/** Failures are an error banner that says positions may still be open, not the green/"sent" the old text gave. */
export function panicOutcome(ok: boolean, status: number, data: PanicResponseLite): { text: string; type: 'success' | 'error' } {
  if (!ok) return { text: data.message || data.error || `Panic liquidate failed (HTTP ${status}). Positions may still be open.`, type: 'error' };
  const failed = Array.isArray(data.data?.failed) ? data.data!.failed! : [];
  // a position the server lists as still open (or a buy still in flight) is never a success, whatever `success` says
  const open = failed.filter((f) => /^(STILL_OPEN|BUY_IN_FLIGHT)/.test(String(f?.error ?? '')));
  const openText = open.length ? ` STILL OPEN after the panic: ${open.map((f) => (f.symbol ? displaySymbol(f.symbol) : f.id || '?')).join(', ')}. Run the panic again or close them by hand.` : '';
  if (data.success === false || failed.length > 0) return { text: `${data.message || 'Panic liquidate finished with failures. Some positions may still be open.'}${openText}`, type: 'error' };
  return { text: data.message || 'Panic liquidate finished.', type: 'success' };
}

export interface ArmResponseLite { success?: boolean; message?: string; error?: string; reasons?: string[] }

/** UI-4: a refused arm shows the server's own reason (it sends `message` and `reasons`, not `error`), never a bare "Failed to arm". */
export function armRefusalText(status: number, data: ArmResponseLite | null | undefined): string {
  const why = data?.message || data?.error || (data?.reasons?.length ? data.reasons.join('; ') : `the server answered HTTP ${status} with no reason`);
  return `Arming refused: ${why.replace(/\.+$/, '')}. Live trading is NOT armed.`;
}

/**
 * R13-7: the Memecoin console commands that run the full emergency stop on the server (socialScanner.processTelegramCommand matches
 * them by prefix). Matched here without case so a near-miss also asks first.
 */
export const isConsoleEmergencyCommand = (text: string): boolean => /^\/(panic_sell|dump_all)/i.test(text.trim());

export const CONSOLE_PANIC_CONFIRM_TEXT = (command: string): string =>
  `EMERGENCY STOP from the console (${command.trim().split(/\s+/)[0]}): this is the same as PANIC LIQUIDATE. ${PANIC_CONFIRM_TEXT}`;
