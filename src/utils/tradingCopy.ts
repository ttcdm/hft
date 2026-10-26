/** Q37: the words on the arm and panic buttons, kept in one place so they can be tested against what the server does. */

export const ARMED_MESSAGE = (cluster?: string): string =>
  `LIVE TRADING ARMED on ${cluster ?? 'the configured cluster'}: snipes now send ordinary transactions from the local signer wallet and spend real SOL on that cluster.`;

export const PANIC_CONFIRM_TEXT =
  'EMERGENCY: close ALL open positions now, trip the kill switch (blocks new entries), disarm live trading and stop auto mode? Positions that fail to close stay open and are listed afterwards.';

export interface PanicResponseLite { success?: boolean; message?: string; error?: string }

/** Failures are an error banner that says positions may still be open, not the green/"sent" the old text gave. */
export function panicOutcome(ok: boolean, status: number, data: PanicResponseLite): { text: string; type: 'success' | 'error' } {
  if (!ok) return { text: data.message || data.error || `Panic liquidate failed (HTTP ${status}). Positions may still be open.`, type: 'error' };
  if (data.success === false) return { text: data.message || 'Panic liquidate finished with failures. Some positions may still be open.', type: 'error' };
  return { text: data.message || 'Panic liquidate finished.', type: 'success' };
}

export interface ArmResponseLite { success?: boolean; message?: string; error?: string; reasons?: string[] }

/** UI-4: a refused arm shows the server's own reason (it sends `message` and `reasons`, not `error`), never a bare "Failed to arm". */
export function armRefusalText(status: number, data: ArmResponseLite | null | undefined): string {
  const why = data?.message || data?.error || (data?.reasons?.length ? data.reasons.join('; ') : `the server answered HTTP ${status} with no reason`);
  return `Arming refused: ${why.replace(/\.+$/, '')}. Live trading is NOT armed.`;
}
