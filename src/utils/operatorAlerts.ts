import type { AlertEvent } from '../types';

/**
 * R6-1 / R7-1: the server's operator alerts (GET /api/system/checks, `operatorAlerts`) as entries of the UI alert stack. They are the
 * server's own: they stay while the server lists them and leave when it clears them. A CRITICAL one cannot be dismissed in the browser;
 * a WARNING or INFO one can be hidden until the server raises it again under a new id. A CRITICAL one that reports a past event
 * (`acknowledgeable`: POSITION_GONE, SELL_ADOPTED, ...) has an Acknowledge button that clears it on the server.
 */
export interface ServerOperatorAlert {
  code: string;
  message: string;
  positionId?: string;
  raisedAt: number;
  lastSeenAt: number;
  level: 'CRITICAL' | 'WARNING' | 'INFO';
  acknowledgeable: boolean;
}

export const serverAlertId = (a: Pick<ServerOperatorAlert, 'code' | 'positionId' | 'raisedAt'>) => `server-${a.code}-${a.positionId ?? ''}-${a.raisedAt}`;

const LEVELS = new Set(['CRITICAL', 'WARNING', 'INFO']);

/** The alerts from a /api/system/checks body; [] when it has none. An unknown level is CRITICAL (fail closed). */
export function readServerAlerts(body: any): ServerOperatorAlert[] {
  const list = Array.isArray(body?.operatorAlerts) ? body.operatorAlerts : [];
  return list
    .filter((a: any) => a && typeof a.code === 'string')
    .map((a: any) => ({
      code: a.code,
      message: String(a.message ?? ''),
      positionId: typeof a.positionId === 'string' ? a.positionId : undefined,
      raisedAt: Number.isFinite(a.raisedAt) ? a.raisedAt : 0,
      lastSeenAt: Number.isFinite(a.lastSeenAt) ? a.lastSeenAt : Number.isFinite(a.raisedAt) ? a.raisedAt : 0,
      level: LEVELS.has(a.level) ? a.level : 'CRITICAL',
      acknowledgeable: a.acknowledgeable === true,
    }));
}

/**
 * `acknowledged` holds the ids the server confirmed it cleared (POST /api/system/alerts/acknowledge answered success), so the alert leaves
 * at once instead of at the next poll; a re-raise has a new id and shows again.
 */
export function serverAlertEvents(alerts: ServerOperatorAlert[], hidden: ReadonlySet<string> = new Set(), acknowledged: ReadonlySet<string> = new Set()): AlertEvent[] {
  return alerts
    .filter((a) => !acknowledged.has(serverAlertId(a)))
    .map((a): AlertEvent => ({
      id: serverAlertId(a),
      timestamp: a.lastSeenAt,
      timeStr: new Date(a.raisedAt).toLocaleTimeString(),
      level: a.level,
      title: a.code,
      message: a.message,
      acknowledged: false,
      source: 'server',
      sticky: a.level === 'CRITICAL',
      ...(a.acknowledgeable ? { serverAck: { code: a.code, ...(a.positionId ? { positionId: a.positionId } : {}) } } : {}),
    }))
    .filter((e) => e.sticky || !hidden.has(e.id));
}

/** When the alert list could not be read, the stack says so instead of looking clear. */
export function alertsUnreadableEvent(error: string, since: number): AlertEvent {
  return {
    id: 'server-alerts-unreadable', timestamp: since, timeStr: new Date(since).toLocaleTimeString(), level: 'WARNING',
    title: 'OPERATOR ALERTS NOT READ', message: `The server's operator alerts could not be read (${error}). An exit failure or halt would not show here until it can.`,
    acknowledged: false, source: 'server', sticky: true,
  };
}

const RANK: Record<AlertEvent['level'], number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };

/** R6-19: CRITICAL first, then WARNING, then INFO; newest first within a level. A later INFO can no longer hide a CRITICAL. */
export function orderAlerts(alerts: AlertEvent[]): AlertEvent[] {
  return [...alerts].sort((a, b) => RANK[a.level] - RANK[b.level] || b.timestamp - a.timestamp);
}

/**
 * R10-1: the "KILL SWITCH ENGAGED" alert is drawn from the server's kill-switch state, not pushed once by the click. It is there while the
 * server says the switch is on (in every tab, through the poll) and gone as soon as it says off; it cannot be dismissed while it holds.
 * R13-5: a failed or too-old read (`on` null) no longer removes it. When the switch was last seen ON the CRITICAL stays, saying the state
 * is not confirmed; when it was last seen OFF (or never read) and the read now fails, a sticky STATE UNKNOWN alert says so. Before the
 * first answer there is nothing to say yet.
 */
export const KILL_SWITCH_ALERT_ID = 'state-kill-switch';
export interface KillStateUnknown { lastKnown: boolean | null; failed: boolean; lastAt?: number | null }
/**
 * R11-4: what the kill switch leaves open, from the open-position count (ACTIVE: open or partly closed), or null when it could not be read.
 * The switch never sells; the text no longer tells the operator to close positions when none is open (for example right after PANIC).
 */
export function killSwitchOpenText(open: number | null | undefined): string {
  if (open === 0) return 'No position is open.';
  if (typeof open === 'number' && open > 0) return `${open} open position${open === 1 ? ' is' : 's are'} NOT sold: close ${open === 1 ? 'it' : 'them'} from the Plug & Play panel (protective exits keep running).`;
  return 'The kill switch does not sell open positions; the position list could not be read, so check the Plug & Play panel.';
}

export function killSwitchStateAlert(on: boolean | null, since: number | null, unknown?: KillStateUnknown, openPositions?: number | null): AlertEvent[] {
  const at = since ?? Date.now();
  const base = { id: KILL_SWITCH_ALERT_ID, timestamp: at, timeStr: new Date(at).toLocaleTimeString(), acknowledged: false, sticky: true } as const;
  if (on === true) {
    return [{
      ...base, level: 'CRITICAL', title: 'KILL SWITCH ENGAGED',
      message: `The server refuses new orders and has disarmed LIVE trading. ${killSwitchOpenText(openPositions)}`,
    }];
  }
  if (on === false || !unknown) return [];
  if (unknown.lastKnown === true) {
    return [{
      ...base, level: 'CRITICAL', title: 'KILL SWITCH ENGAGED (state not confirmed)',
      message: `The kill switch was ON at the last good read, but its current state cannot be read. Treat trading as halted, and do not press RESUME until the header shows the state again. ${killSwitchOpenText(openPositions)}`,
    }];
  }
  if (!unknown.failed && unknown.lastKnown === null) return [];
  const seen = unknown.lastAt ?? at;
  return [{
    ...base, timestamp: seen, timeStr: new Date(seen).toLocaleTimeString(), level: 'WARNING', title: 'KILL SWITCH STATE UNKNOWN',
    message: `The server's kill-switch state cannot be read (not signed in, or not reachable)${unknown.lastAt ? `; it was OFF at the last good read, ${new Date(unknown.lastAt).toLocaleTimeString()}` : ''}. A switch engaged from another tab, by a panic or by the RPC auto-trip would not show here until it can.`,
  }];
}

/** POST /api/system/alerts/acknowledge for one server alert: null when the server cleared it, else the reason it did not. */
export async function acknowledgeServerAlert(
  post: (path: string, init: RequestInit) => Promise<Response>,
  ack: { code: string; positionId?: string },
): Promise<string | null> {
  try {
    const r = await post('/api/system/alerts/acknowledge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ack) });
    const j = await r.json().catch(() => null);
    if (r.ok && j?.success === true) return null;
    return `${j?.error || 'Request refused'} (HTTP ${r.status})`;
  } catch (e: any) {
    return `Could not reach the server (${e?.message || 'network error'})`;
  }
}
