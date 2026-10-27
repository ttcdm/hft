/**
 * R9-1: what a press of the header KILL SWITCH / RESUME button does.
 *
 * Two quick presses used to end with trading enabled: the first press engaged the switch, the button turned into RESUME, and the
 * second press (meant as "kill") sent the negation of what was shown. Now:
 * - a press while the switch is shown OFF engages it (the intended state, true);
 * - a press on RESUME within RESUME_GUARD_MS of the switch turning on is ignored (a double tap of the emergency stop);
 * - any other press on RESUME asks the operator to confirm first, like PANIC and KILL AUTO do.
 */
export const RESUME_GUARD_MS = 2000;

export const RESUME_CONFIRM_TEXT =
  'RESUME TRADING?\n\nThis turns the kill switch OFF. The server accepts new orders again, and an open circuit breaker is closed if the ' +
  'latest wallet-balance read succeeded. Auto stays OFF and LIVE stays disarmed until you turn them on.';

export type KillSwitchPress =
  | { action: 'ENGAGE'; activate: true }
  | { action: 'RESUME'; activate: false }
  | { action: 'IGNORE'; reason: 'DOUBLE_PRESS' | 'NOT_CONFIRMED' };

export function killSwitchPress(
  shownHalted: boolean,
  haltedSinceMs: number | null,
  nowMs: number,
  confirmResume: (text: string) => boolean,
): KillSwitchPress {
  if (!shownHalted) return { action: 'ENGAGE', activate: true };
  if (haltedSinceMs !== null && nowMs - haltedSinceMs < RESUME_GUARD_MS) return { action: 'IGNORE', reason: 'DOUBLE_PRESS' };
  return confirmResume(RESUME_CONFIRM_TEXT) ? { action: 'RESUME', activate: false } : { action: 'IGNORE', reason: 'NOT_CONFIRMED' };
}
