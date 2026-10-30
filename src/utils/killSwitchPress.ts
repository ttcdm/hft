/**
 * R9-1: what a press of the header KILL SWITCH / RESUME button does.
 *
 * Two quick presses used to end with trading enabled: the first press engaged the switch, the button turned into RESUME, and the
 * second press (meant as "kill") sent the negation of what was shown. Now:
 * - a press while the switch is shown OFF engages it (the intended state, true);
 * - a press on RESUME within RESUME_GUARD_MS of the switch turning on is ignored (a double tap of the emergency stop);
 * - any other press on RESUME asks the operator to confirm first, like PANIC and KILL AUTO do (R10-11: in the in-page dialog, where
 *   Enter cannot accept).
 */
export const RESUME_GUARD_MS = 2000;

export const RESUME_CONFIRM_TEXT =
  'RESUME TRADING?\n\nThis turns the kill switch OFF. The server accepts new orders again, and an open circuit breaker is closed if the ' +
  'latest wallet-balance read succeeded. Auto stays OFF and LIVE stays disarmed until you turn them on.';

export type KillSwitchPress =
  | { action: 'ENGAGE'; activate: true }
  | { action: 'RESUME'; activate: false }
  | { action: 'IGNORE'; reason: 'DOUBLE_PRESS' | 'NOT_CONFIRMED' };

export async function killSwitchPress(
  shownHalted: boolean,
  haltedSinceMs: number | null,
  nowMs: number,
  confirmResume: (text: string) => Promise<boolean>,
): Promise<KillSwitchPress> {
  if (!shownHalted) return { action: 'ENGAGE', activate: true };
  if (haltedSinceMs !== null && nowMs - haltedSinceMs < RESUME_GUARD_MS) return { action: 'IGNORE', reason: 'DOUBLE_PRESS' };
  return (await confirmResume(RESUME_CONFIRM_TEXT)) ? { action: 'RESUME', activate: false } : { action: 'IGNORE', reason: 'NOT_CONFIRMED' };
}

/**
 * R12-1: the header's read of the server's kill switch. A read that does not answer within KILL_STATE_TIMEOUT_MS is aborted and counts as
 * failed, and a last good read older than KILL_STATE_MAX_AGE_MS is not shown as current: either way the header says UNKNOWN, never the
 * old state. `value` and `at` keep the last good answer (R13-5 still needs to know the switch was last seen ON).
 */
export const KILL_STATE_TIMEOUT_MS = 4_000;
export const KILL_STATE_MAX_AGE_MS = 10_000;

export interface KillStateRead { value: boolean | null; at: number | null; failed: boolean }

export function killStateIsStale(read: KillStateRead, nowMs: number): boolean {
  return read.at === null || nowMs - read.at > KILL_STATE_MAX_AGE_MS;
}

/** The state the header shows: the server's answer, or null (UNKNOWN) when the latest read failed or the last good one is too old. */
export function shownKillState(read: KillStateRead, stale: boolean): boolean | null {
  return read.failed || stale || read.at === null ? null : read.value;
}
