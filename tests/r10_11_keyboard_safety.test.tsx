import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, FakeServer } from './helpers/domApp';
import { autoSnipeController } from '../server/auto/controller';
import { AutoPanelView, type AutoStatusData } from '../src/components/AutoPanel';
import { TokenBoardView } from '../src/components/TokenBoard';

/**
 * R10-11: modals had no role=dialog and no focus trap (Tab walked to the header and KILL AUTO behind an open modal), and PANIC and KILL AUTO
 * used window.confirm, where Enter accepts "sell everything". The confirm is now an in-page dialog that opens on Cancel, refuses Enter on its
 * confirm button and takes a click there; Tab stays inside an open dialog.
 */
const key = async (el: Element, k: string, shift = false): Promise<KeyboardEvent> => {
  const ev = new (window as any).KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true });
  await act(async () => { el.dispatchEvent(ev); });
  await flush(2);
  return ev;
};
const dialog = () => document.querySelector('[role="alertdialog"]') as HTMLElement | null;
const posted = (server: FakeServer, url: string) => server.calls.filter((c) => c.url === url && c.method === 'POST').length;

describe('R10-11: PANIC and KILL AUTO need a deliberate click; dialogs hold focus', () => {
  let server: FakeServer;
  beforeEach(() => {
    const win = installDom();
    win.confirm = () => { throw new Error('window.confirm must not be used for PANIC or KILL AUTO'); };
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    server.routes['/api/auth/session'] = () => ({ json: { success: true } });
    server.routes['/api/auto/status'] = () => ({ json: { success: true, ...autoSnipeController.getStatus(), stats: autoSnipeController.getJournalStats(), decisions: [] } });
    server.routes['/api/auto/kill'] = () => ({ json: { success: true, status: autoSnipeController.getStatus(), exits: { attempted: 0, closed: 0, failed: [] } } });
    server.routes['/api/wallet/panic-liquidate'] = () => ({ json: { success: true, closed: 0, results: [] } });
  });
  afterEach(async () => { await removeDom(); });

  it('KILL AUTO: the dialog opens on Cancel, Enter on confirm does nothing, Escape cancels, a click sells', async () => {
    await renderApp();
    await click(document.querySelector('[data-testid="auto-kill"]'));
    expect(dialog()).not.toBeNull();
    expect(dialog()!.getAttribute('aria-modal')).toBe('true');
    expect(dialog()!.textContent).toMatch(/sell every position it bought/);
    expect(document.activeElement?.getAttribute('data-testid')).toBe('confirm-cancel');
    const ok = document.querySelector('[data-testid="confirm-ok"]')!;
    const enter = await key(ok, 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(posted(server, '/api/auto/kill')).toBe(0);
    await key(dialog()!, 'Escape');
    expect(dialog()).toBeNull();
    expect(posted(server, '/api/auto/kill')).toBe(0);
    await click(document.querySelector('[data-testid="auto-kill"]'));
    await click(document.querySelector('[data-testid="confirm-ok"]'));
    await flush(5);
    expect(dialog()).toBeNull();
    expect(posted(server, '/api/auto/kill')).toBe(1);
  });

  it('PANIC: the same dialog, Cancel sends nothing, a click on confirm sends it', async () => {
    await renderApp();
    await click(document.getElementById('btn-nav-plug-and-play'));
    await flush(10);
    const panic = document.querySelector('[data-testid="pnp-panic"]');
    await click(panic);
    expect(dialog()?.textContent).toMatch(/kill switch/i);
    await click(document.querySelector('[data-testid="confirm-cancel"]'));
    expect(dialog()).toBeNull();
    expect(posted(server, '/api/wallet/panic-liquidate')).toBe(0);
    await click(panic);
    await click(document.querySelector('[data-testid="confirm-ok"]'));
    await flush(5);
    expect(posted(server, '/api/wallet/panic-liquidate')).toBe(1);
  });

  it('an open modal is a dialog and Tab wraps inside it (Plug & Play also reaches the header KILL SWITCH)', async () => {
    await renderApp();
    await click(document.getElementById('btn-unit-tests'));
    await flush(10);
    const modal = document.querySelector('[role="dialog"][aria-modal="true"]') as HTMLElement;
    expect(modal).not.toBeNull();
    expect(modal.getAttribute('aria-label') || modal.getAttribute('aria-labelledby')).toBeTruthy();
    const inside = Array.from(modal.querySelectorAll<HTMLElement>('button:not([disabled]), input, a[href]'));
    expect(inside.length).toBeGreaterThan(0);
    inside[inside.length - 1].focus();
    const tab = await key(inside[inside.length - 1], 'Tab');
    expect(tab.defaultPrevented).toBe(true);
    expect(modal.contains(document.activeElement)).toBe(true);
    inside[0].focus();
    await key(inside[0], 'Tab', true);
    expect(modal.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.querySelector('[data-testid="auto-kill"]'));
    await key(modal, 'Escape');

    await click(document.getElementById('btn-nav-plug-and-play'));
    await flush(10);
    const pnp = document.querySelector('[role="dialog"][aria-modal="true"]') as HTMLElement;
    expect(pnp).not.toBeNull();
    const pnpInside = Array.from(pnp.querySelectorAll<HTMLElement>('button:not([disabled]), input, a[href]'));
    pnpInside[pnpInside.length - 1].focus();
    await key(pnpInside[pnpInside.length - 1], 'Tab');
    expect(document.activeElement?.id).toBe('btn-emergency-kill-switch');
    await key(document.activeElement!, 'Tab');
    expect(pnp.contains(document.activeElement)).toBe(true);
  });
});

describe('R10-11: the selected mode and tab are announced, and every Save says what it saves', () => {
  const status: AutoStatusData = {
    mode: 'PAPER', killed: false, killReason: null, downgradeReason: null, haltReason: null, triggers: [], slippageBreaches: 0, session: null,
    budgets: { maxBuys: 5, maxSpendSol: 0.02, maxLossFraction: 0.15, maxDurationMs: 4 * 3600_000 }, orderSol: 0.005, orderLimits: { minSol: 0.001, maxSol: 0.02 },
    confluence: { value: 70, defaultValue: 70, source: 'default', warnBelow: 50, warning: null },
    stats: { seen: 0, rejectedByStage: {}, wouldBuy: 0, bought: 0, open: 0, closed: 0, netPnlSol: 0, feesPaidSol: 0, winRate: null },
  };
  it('auto modes carry aria-pressed; the Save buttons and number boxes have names', () => {
    const html = renderToStaticMarkup(<AutoPanelView status={status} />);
    expect(html).toMatch(/data-testid="mode-PAPER"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-testid="mode-PAPER"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-testid="mode-OFF"|data-testid="mode-OFF"[^>]*aria-pressed="false"/);
    for (const name of ['Save session budget', 'Save order size', 'Save confluence threshold']) expect(html).toContain(`aria-label="${name}"`);
    for (const id of ['budget-buys', 'budget-spend', 'order-sol', 'confluence-box']) expect(html).toMatch(new RegExp(`data-testid="${id}"[^>]*aria-label="[^"]+"|aria-label="[^"]+"[^>]*data-testid="${id}"`));
  });
  it('board tabs are a tablist with aria-selected', () => {
    const html = renderToStaticMarkup(<TokenBoardView board={null} tab="watching" onTab={() => {}} onSelect={() => {}} />);
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*data-testid="tab-watching"/);
    expect(html).toMatch(/role="tab"[^>]*aria-selected="false"[^>]*data-testid="tab-launches"/);
  });
});
