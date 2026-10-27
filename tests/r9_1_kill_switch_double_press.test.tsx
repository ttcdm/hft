import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, FakeServer } from './helpers/domApp';

describe('R9-1: a double press of KILL SWITCH must not end with trading enabled', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
  });
  afterEach(async () => { await removeDom(); });

  // R10-11: the RESUME confirm is the in-page dialog (the confirm-cancel / confirm-ok buttons), not window.confirm
  const dialogText = () => document.querySelector('[role="alertdialog"]')?.textContent ?? null;

  it('two quick presses leave the kill switch ON', async () => {
    const app = await renderApp();
    const btn = () => document.getElementById('btn-emergency-kill-switch');
    await click(btn());
    expect(server.killSwitchActive).toBe(true);
    await click(btn());
    await flush();
    expect(server.killSwitchActive).toBe(true);
    const posts = server.calls.filter((c) => c.url === '/api/execution/kill-switch');
    expect(posts.map((c) => c.body.activate)).toEqual([true]);
    expect(dialogText()).toBeNull();
    await app.unmount();
  });

  it('RESUME later asks to confirm; a refused confirm sends nothing, an accepted one sends activate:false', async () => {
    await renderApp();
    const btn = () => document.getElementById('btn-emergency-kill-switch');
    await click(btn());
    expect(server.killSwitchActive).toBe(true);
    const realNow = Date.now;
    const later = realNow() + 2500; // past the 2 s double-press guard (RESUME_GUARD_MS)
    vi.spyOn(Date, 'now').mockImplementation(() => later);
    await click(btn());
    expect(dialogText()).toMatch(/RESUME TRADING\?/);
    await click(document.querySelector('[data-testid="confirm-cancel"]'));
    expect(server.killSwitchActive).toBe(true);
    await click(btn());
    await click(document.querySelector('[data-testid="confirm-ok"]'));
    await flush();
    expect(server.killSwitchActive).toBe(false);
    const posts = server.calls.filter((c) => c.url === '/api/execution/kill-switch');
    expect(posts.map((c) => c.body.activate)).toEqual([true, false]);
  });

  it('a switch turned on elsewhere (seen by the poll) is not resumed by a press right after it appeared', async () => {
    server.killSwitchActive = true;
    await renderApp();
    expect(document.getElementById('btn-emergency-kill-switch')?.textContent).toMatch(/RESUME/);
    await click(document.getElementById('btn-emergency-kill-switch'));
    expect(dialogText()).toBeNull();
    expect(server.calls.filter((c) => c.url === '/api/execution/kill-switch')).toEqual([]);
  });
});
