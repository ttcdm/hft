import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, FakeServer } from './helpers/domApp';
import { Header } from '../src/components/Header';

/** R10-2: the header started at "not engaged" and ignored a non-200 poll, so logged out (or right after a reload) it said the switch was off. */
describe('R10-2: the header says UNKNOWN until the server has answered', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: true, deny: (p) => p === '/api/diagnostics/system' };
    installFakeServer(server);
  });
  afterEach(async () => { await removeDom(); });

  it('a refused state read (logged out) shows UNKNOWN; a press tries to engage and says it was not confirmed', async () => {
    await renderApp();
    const btn = document.getElementById('btn-emergency-kill-switch')!;
    expect(btn.textContent).toMatch(/UNKNOWN/);
    expect(btn.textContent).not.toMatch(/RESUME/);
    await click(btn);
    // logged out, authFetch answers 401 locally; the press never sends "resume" and says the stop was not confirmed
    expect(server.calls.filter((c) => c.url === '/api/execution/kill-switch' && c.body?.activate === false)).toEqual([]);
    expect(document.getElementById('alerts-notification-panel')?.textContent).toMatch(/KILL SWITCH NOT CONFIRMED/);
  });

  it('before any answer the header is UNKNOWN, not "not engaged"', () => {
    const html = renderToStaticMarkup(<Header kpis={{} as any} isHalted={null} onToggleKillSwitch={() => {}} isOperatorAuthenticated={false} />);
    expect(html).toMatch(/btn-emergency-kill-switch[\s\S]*UNKNOWN/);
  });

  it('a state read that starts failing turns a known state back to UNKNOWN', async () => {
    server.deny = undefined;
    await renderApp();
    expect(document.getElementById('btn-emergency-kill-switch')!.textContent).toMatch(/RESUME/);
    server.deny = (p) => p === '/api/diagnostics/system';
    await new Promise((r) => setTimeout(r, 5300));
    await flush();
    expect(document.getElementById('btn-emergency-kill-switch')!.textContent).toMatch(/UNKNOWN/);
  }, 15000);
});
