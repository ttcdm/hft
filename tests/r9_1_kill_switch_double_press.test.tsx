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

  it('two quick presses leave the kill switch ON', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const app = await renderApp();
    const btn = () => document.getElementById('btn-emergency-kill-switch');
    await click(btn());
    expect(server.killSwitchActive).toBe(true);
    await click(btn());
    await flush();
    expect(server.killSwitchActive).toBe(true);
    const posts = server.calls.filter((c) => c.url === '/api/execution/kill-switch');
    expect(posts.map((c) => c.body.activate)).toEqual([true]);
    expect(confirmSpy).not.toHaveBeenCalled();
    await app.unmount();
  });

  it('RESUME later asks to confirm; a refused confirm sends nothing, an accepted one sends activate:false', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderApp();
    const btn = () => document.getElementById('btn-emergency-kill-switch');
    await click(btn());
    expect(server.killSwitchActive).toBe(true);
    const realNow = Date.now;
    const later = realNow() + 2500; // past the 2 s double-press guard (RESUME_GUARD_MS)
    vi.spyOn(Date, 'now').mockImplementation(() => later);
    await click(btn());
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0][0])).toMatch(/RESUME TRADING\?/);
    expect(server.killSwitchActive).toBe(true);
    confirmSpy.mockReturnValue(true);
    await click(btn());
    expect(server.killSwitchActive).toBe(false);
    const posts = server.calls.filter((c) => c.url === '/api/execution/kill-switch');
    expect(posts.map((c) => c.body.activate)).toEqual([true, false]);
  });

  it('a switch turned on elsewhere (seen by the poll) is not resumed by a press right after it appeared', async () => {
    server.killSwitchActive = true;
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderApp();
    expect(document.getElementById('btn-emergency-kill-switch')?.textContent).toMatch(/RESUME/);
    await click(document.getElementById('btn-emergency-kill-switch'));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(server.calls.filter((c) => c.url === '/api/execution/kill-switch')).toEqual([]);
  });
});
