import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildSystemChecks, operatorAlertLevel } from '../server/system/systemChecks';
import { executionCoordinator } from '../server/execution/coordinator';
import { AlertSystem } from '../src/components/AlertSystem';
import { readServerAlerts, serverAlertEvents, orderAlerts, alertsUnreadableEvent } from '../src/utils/operatorAlerts';
import type { AlertEvent } from '../src/types';

/** R6-1 / R7-1 / R6-19 (haiku-attack 2026-10-26): the coordinator's operator alerts reach GET /api/system/checks and the UI alert stack. */
const wire = <T,>(o: T): T => JSON.parse(JSON.stringify(o));
const coord = executionCoordinator as any;
const raised: Array<[string, string | undefined]> = [];
const raise = (code: string, msg: string, pos?: string) => { coord.raiseOperatorAlert(code, msg, pos); raised.push([code, pos]); };
afterEach(() => { for (const [c, p] of raised.splice(0)) coord.clearOperatorAlert(c, p); });

describe('R6-1/R7-1: /api/system/checks carries every open operator alert with a level', () => {
  it('EXIT_FAILING is listed as CRITICAL, ahead of a newer INFO, and the alerts row is FAIL', () => {
    raise('EXIT_FAILING', 'Exit for position abcd1234 failed 3 times in a row', 'pos-r61');
    raise('LATE_BUY_SOLD', 'A LIVE buy was sold at once', 'pos-r61b');
    const res = wire(buildSystemChecks());
    const codes = res.operatorAlerts.map((a) => a.code);
    expect(codes).toEqual(expect.arrayContaining(['EXIT_FAILING', 'LATE_BUY_SOLD']));
    expect(codes.indexOf('EXIT_FAILING')).toBeLessThan(codes.indexOf('LATE_BUY_SOLD'));
    expect(res.operatorAlerts.find((a) => a.code === 'EXIT_FAILING')!.level).toBe('CRITICAL');
    expect(res.operatorAlerts.find((a) => a.code === 'EXIT_FAILING')!.positionId).toBe('pos-r61');
    const row = res.checks.find((c) => c.id === 'alerts')!;
    expect(row.status).toBe('FAIL');
    expect(row.value).toContain('EXIT_FAILING');
  });

  it('a code the table does not know is CRITICAL (fail closed); a cleared alert leaves the list', () => {
    expect(operatorAlertLevel('SOMETHING_NEW')).toBe('CRITICAL');
    raise('POSITION_GONE', 'gone', 'pos-gone');
    expect(buildSystemChecks().operatorAlerts.some((a) => a.code === 'POSITION_GONE')).toBe(true);
    coord.clearOperatorAlert('POSITION_GONE', 'pos-gone');
    expect(buildSystemChecks().operatorAlerts.some((a) => a.code === 'POSITION_GONE')).toBe(false);
    expect(buildSystemChecks().checks.find((c) => c.id === 'alerts')!.status).toBe('OK');
  });
});

describe('R6-1/R6-19: the alert stack shows server alerts, most severe first, and a CRITICAL cannot be dismissed', () => {
  const local = (level: AlertEvent['level'], title: string, ts: number): AlertEvent => ({ id: title, timestamp: ts, timeStr: '', level, title, message: title, acknowledged: false });

  it('a server CRITICAL is the one alert shown even when a local INFO is newer, and it has no dismiss button', () => {
    raise('POSITION_BALANCE_MISSING', 'XYZ was closed without a sell: the wallet held none of it.', 'pos-bal');
    const server = serverAlertEvents(readServerAlerts(wire(buildSystemChecks())));
    const all = [local('INFO', 'OPERATOR AUTHENTICATED', Date.now() + 60_000), ...server];
    const html = renderToStaticMarkup(<AlertSystem alerts={all} onDismissAlert={() => {}} onClearAll={() => {}} />);
    expect(html).toContain('POSITION_BALANCE_MISSING');
    expect(html).toContain('the wallet held none of it');
    expect(html).not.toContain('OPERATOR AUTHENTICATED');
    expect(html).toContain('data-testid="alert-sticky"');
    expect(html).not.toContain('aria-label="Dismiss alert"');
    expect(html).toContain('1 critical');
  });

  it('hiding works for WARNING server alerts only; a CRITICAL stays hidden-proof', () => {
    raise('SELL_ADOPTED', 'A sell landed after its confirmation was missed', 'pos-sa');
    raise('EXIT_NO_SIGNER', 'Exit cannot be signed', 'pos-ns');
    const alerts = readServerAlerts(wire(buildSystemChecks()));
    const ids = new Set(serverAlertEvents(alerts).map((e) => e.id));
    const left = serverAlertEvents(alerts, ids).map((e) => e.title);
    expect(left).toContain('EXIT_NO_SIGNER');
    expect(left).not.toContain('SELL_ADOPTED');
  });

  it('local alerts are ordered CRITICAL > WARNING > INFO, newest first within a level', () => {
    const o = orderAlerts([local('INFO', 'i', 3), local('CRITICAL', 'c-old', 1), local('WARNING', 'w', 2), local('CRITICAL', 'c-new', 2)]);
    expect(o.map((a) => a.title)).toEqual(['c-new', 'c-old', 'w', 'i']);
  });

  it('an unreadable alert list says so instead of looking clear', () => {
    const e = alertsUnreadableEvent('Request refused (HTTP 401)', 0);
    expect(e.sticky).toBe(true);
    expect(renderToStaticMarkup(<AlertSystem alerts={[e]} onDismissAlert={() => {}} onClearAll={() => {}} />)).toContain('could not be read');
  });
});
