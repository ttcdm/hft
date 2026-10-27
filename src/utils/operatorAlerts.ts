import type { AlertEvent } from '../types';

/**
 * R6-1 / R7-1: the server's operator alerts (GET /api/system/checks, `operatorAlerts`) as entries of the UI alert stack. They are the
 * server's own: they stay while the server lists them and leave when it clears them. A CRITICAL one cannot be dismissed in the browser;
 * a WARNING or INFO one can be hidden until the server raises it again under a new id.
 */
export interface ServerOperatorAlert {
  code: string;
  message: string;
  positionId?: string;
  raisedAt: number;
  lastSeenAt: number;
  level: 'CRITICAL' | 'WARNING' | 'INFO';
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
    }));
}

export function serverAlertEvents(alerts: ServerOperatorAlert[], hidden: ReadonlySet<string> = new Set()): AlertEvent[] {
  return alerts
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
 */
export const KILL_SWITCH_ALERT_ID = 'state-kill-switch';
export function killSwitchStateAlert(on: boolean | null, since: number | null): AlertEvent[] {
  if (on !== true) return [];
  const at = since ?? Date.now();
  return [{
    id: KILL_SWITCH_ALERT_ID, timestamp: at, timeStr: new Date(at).toLocaleTimeString(), level: 'CRITICAL', title: 'KILL SWITCH ENGAGED',
    message: 'The server refuses new orders and has disarmed LIVE trading. Open positions are NOT sold: close them from the Plug & Play panel.',
    acknowledged: false, sticky: true,
  }];
}
