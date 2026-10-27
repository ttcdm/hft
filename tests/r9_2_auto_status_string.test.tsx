import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installDom, removeDom, installFakeServer, renderApp, click, typeInto, flush, middlewareAnswer, FakeServer } from './helpers/domApp';
import { validateTradeBody, AutoModeSchema } from '../server/execution/tradeInputs';
import { autoSnipeController } from '../server/auto/controller';
import { PanelErrorBoundary, RootErrorBoundary } from '../src/components/ErrorBoundaries';

/**
 * R9-2: a 400 from the auto routes carries `status: "REJECTED"` (a string). The panel spread it into its state and then read
 * status.budgets.maxBuys, which threw; with no error boundary the whole app went blank, KILL SWITCH included.
 */
describe('R9-2: a refused auto request never blanks the app', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    // The body GET /api/auto/status answers (server.ts), from the real controller.
    server.routes['/api/auto/status'] = () => ({ json: { success: true, ...autoSnipeController.getStatus(), stats: autoSnipeController.getJournalStats(), decisions: autoSnipeController.getDecisions(100) } });
    // The real validation middleware of POST /api/auto/mode answers the over-long code.
    server.routes['/api/auto/mode'] = (body) => middlewareAnswer(validateTradeBody(AutoModeSchema), body);
  });
  afterEach(async () => { await removeDom(); });

  it('a 65-character DEVNET_LIVE code: the panel shows the refusal and the header and KILL SWITCH stay', async () => {
    const refusal = middlewareAnswer(validateTradeBody(AutoModeSchema), { mode: 'DEVNET_LIVE', confirmationCode: 'x'.repeat(65) });
    expect(refusal?.status).toBe(400);
    expect(refusal?.json.status).toBe('REJECTED'); // the string that used to be spread into the panel state
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await renderApp();
    expect(document.querySelector('[data-testid="mode-DEVNET_LIVE"]')).not.toBeNull();
    await typeInto(document.querySelector('input[placeholder="DEVNET_LIVE confirmation code"]'), 'x'.repeat(65));
    await click(document.querySelector('[data-testid="mode-DEVNET_LIVE"]'));
    await flush();
    expect(document.getElementById('btn-emergency-kill-switch')).not.toBeNull();
    expect(document.querySelector('[data-testid="auto-error"]')?.textContent).toMatch(/HTTP 400/);
    expect(document.querySelector('[data-testid="mode-OFF"]')).not.toBeNull();
    errors.mockRestore();
  });

  it('a status poll that answers a non-object is ignored, not rendered', async () => {
    server.routes['/api/auto/status'] = () => ({ json: 'REJECTED' });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await renderApp();
    expect(document.getElementById('btn-emergency-kill-switch')).not.toBeNull();
    expect(document.querySelector('[data-testid="panel-error"]')).toBeNull();
    errors.mockRestore();
  });
});

describe('R9-2: error boundaries', () => {
  beforeEach(() => { installDom(); installFakeServer({ calls: [], routes: {}, killSwitchActive: false }); });
  afterEach(async () => { await removeDom(); });
  function Boom(): React.ReactElement { throw new Error('render failed'); }

  it('a panel that throws is replaced by a notice; its siblings keep rendering', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const el = document.createElement('div'); document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(<div><button id="sibling">KILL SWITCH</button><PanelErrorBoundary name="Auto panel"><Boom /></PanelErrorBoundary></div>); });
    expect(el.querySelector('#sibling')).not.toBeNull();
    expect(el.querySelector('[data-testid="panel-error"]')?.textContent).toMatch(/Auto panel.*render failed/s);
    await act(async () => root.unmount());
    errors.mockRestore();
  });

  it('if the whole app throws, the root fallback still offers a working KILL SWITCH', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server: FakeServer = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    const el = document.createElement('div'); document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(<RootErrorBoundary><Boom /></RootErrorBoundary>); });
    const btn = el.querySelector('[data-testid="fallback-kill-switch"]');
    expect(btn).not.toBeNull();
    await click(btn);
    expect(server.killSwitchActive).toBe(true);
    expect(server.calls.find((c) => c.url === '/api/execution/kill-switch')?.body).toEqual({ activate: true });
    expect(el.textContent).toMatch(/kill switch is ON/i);
    await act(async () => root.unmount());
    errors.mockRestore();
  });
});
