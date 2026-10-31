import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, FakeServer } from './helpers/domApp';
import { describeTradingMode } from '../src/utils/tradingMode';

/**
 * R12-11: a malformed reply was shown as real data. Positions null or missing gave "No positions opened yet" and "Open Positions (0)";
 * a systemAudit with null fields read as PAPER; a malformed /api/board turned the board into a red column of raw JS errors. Each now
 * shows an explicit "reply unreadable" state. (The System checks half, in usePolled and SystemChecksModal, is batch U1's.)
 */
describe('R12-11: a malformed reply is "unreadable", never empty or PAPER', () => {
  it('a systemAudit with null fields is MODE UNKNOWN, not PAPER', () => {
    const m = describeTradingMode({ mode: null, isLiveArmed: null, killSwitchActive: null } as any, Date.now());
    expect(m.label).toBe('MODE UNKNOWN');
    expect(m.known).toBe(false);
    expect(m.problem).toMatch(/unreadable/);
    expect(describeTradingMode({ mode: 'PAPER', isLiveArmed: false, killSwitchActive: false }, Date.now()).label).toBe('PAPER');
  });

  describe('in the real app', () => {
    let server: FakeServer;
    beforeEach(() => {
      installDom();
      server = { calls: [], routes: {}, killSwitchActive: false };
      installFakeServer(server);
      server.routes['/api/auth/session'] = () => ({ json: { success: true } });
    });
    afterEach(async () => { await removeDom(); });

    for (const [label, body] of [['positions null', { success: true, positions: null }], ['positions missing', { success: true }], ['positions a string', { success: true, positions: 'oops' }]] as const) {
      it(`Plug & Play: ${label} is "reply unreadable", not "No positions opened yet"`, async () => {
        server.routes['/api/workstation/positions'] = () => ({ json: body });
        await renderApp();
        await click(document.getElementById('btn-nav-plug-and-play'));
        await flush(10);
        const tab = [...document.querySelectorAll('button')].find((b) => /^Open Positions/.test((b.textContent || '').trim()))!;
        expect(tab.textContent).not.toMatch(/\(0\)/);
        await click(tab);
        expect(document.body.textContent).not.toMatch(/No positions opened yet/);
        expect(document.querySelector('[data-testid="pnp-positions-unread"]')?.textContent).toMatch(/reply unreadable/);
      });
    }

    it('a malformed /api/board shows "board reply unreadable", not raw errors', async () => {
      server.routes['/api/board'] = () => ({ json: { launches: 'x', watching: [{ mint: 'M' }], holding: null } });
      await renderApp();
      await flush(5);
      const b = document.querySelector('[data-testid="token-board"]')!;
      expect(b.textContent).toMatch(/board reply unreadable/i);
      expect(b.textContent).not.toMatch(/TypeError|Cannot read|undefined/);
      expect(document.querySelector('[data-testid="kill-switch"], #btn-kill-switch, button[id*="kill"]')).not.toBeNull();
    });
  });
});
