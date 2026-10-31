/**
 * R9-1: what a press of the header KILL SWITCH / RESUME button does.
 *
 * Two quick presses used to end with trading enabled: the first press engaged the switch, the button turned into RESUME, and the
 * second press (meant as "kill") sent the negation of what was shown. Now:
 * - a press while the switch is shown OFF engages it (the intended state, true);
 * - a press on RESUME within RESUME_GUARD_MS of the switch turning on is ignored (a double tap of the emergency stop);
 * - any other press on RESUME asks the operator to confirm first, like PANIC and KILL AUTO do (R10-11: in the in-page dialog, where
 *   Enter cannot accept). R12-3: the confirm says what auto will do, from `readAutoMode`.
 */
import type { AutoMode } from '../components/AutoPanel';

export const RESUME_GUARD_MS = 2000;

/**
 * R12-3: what auto does once the switch is off, from its mode as GET /api/auto/status reads it at the press (null: not read). Auto can be
 * set to SHADOW or PAPER while the switch is on, so "Auto stays OFF" was only true for OFF.
 */
export function autoAfterResumeText(mode: AutoMode | null): string {
  switch (mode) {
    case 'OFF': return 'Auto stays OFF until you set a mode.';
    case 'SHADOW': return 'Auto is in SHADOW: it keeps journaling "would buy" and sends nothing.';
    case 'PAPER': return 'Auto is in PAPER: it starts paper buys again as soon as the switch is off.';
    case 'DEVNET_LIVE': return 'Auto is in DEVNET_LIVE: it sends real devnet buys again once LIVE is armed.';
    default: return 'Auto\'s mode could not be read: check the Auto panel. If auto is on, it buys again as soon as the switch is off.';
  }
}

export function resumeConfirmText(autoMode: AutoMode | null): string {
  return 'RESUME TRADING?\n\nThis turns the kill switch OFF. The server accepts new orders again, and an open circuit breaker is closed if the ' +
    `latest wallet-balance read succeeded. ${autoAfterResumeText(autoMode)} LIVE stays disarmed until you arm it.`;
}

export type KillSwitchPress =
  | { action: 'ENGAGE'; activate: true }
  | { action: 'RESUME'; activate: false }
  | { action: 'IGNORE'; reason: 'DOUBLE_PRESS' | 'NOT_CONFIRMED' };

export async function killSwitchPress(
  shownHalted: boolean,
  haltedSinceMs: number | null,
  nowMs: number,
  confirmResume: (text: string) => Promise<boolean>,
  readAutoMode: () => Promise<AutoMode | null> = async () => null,
): Promise<KillSwitchPress> {
  if (!shownHalted) return { action: 'ENGAGE', activate: true };
  if (haltedSinceMs !== null && nowMs - haltedSinceMs < RESUME_GUARD_MS) return { action: 'IGNORE', reason: 'DOUBLE_PRESS' };
  const mode = await readAutoMode().catch(() => null);
  return (await confirmResume(resumeConfirmText(mode))) ? { action: 'RESUME', activate: false } : { action: 'IGNORE', reason: 'NOT_CONFIRMED' };
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
