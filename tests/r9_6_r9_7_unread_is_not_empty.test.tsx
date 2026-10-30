import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, FakeServer } from './helpers/domApp';
import { autoSnipeController } from '../server/auto/controller';
import { autoStatusStaleText, AUTO_STATUS_STALE_MS } from '../src/components/AutoPanel';
import { engineClient, WS_QUIET_MS } from '../src/services/engineClient';
import { TradingModeBanner } from '../src/components/TradingModeBanner';

/**
 * R9-6: logged out, or after a 401, screens showed empty data as if it were real ("No positions opened yet", "Public Key: None",
 * "Alpha Signals Detected 0", "Holding (0)"), and after Clear Token the auto panel kept its last values with no marker.
 * R9-7: offline, the green read-only strip, "WS STREAMING" and the auto panel kept looking current.
 */
describe('R9-6: an unread list is never shown as an empty one', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: false, deny: (p) => p !== '/api/auth/session' };
    installFakeServer(server);
    server.routes['/api/auth/session'] = () => ({ json: { success: true } });
  });
  afterEach(async () => { await removeDom(); });

  it('Plug & Play, the Tracker and the board say "not read" on a 401', async () => {
    await renderApp();
    expect(document.querySelector('[data-testid="tab-holding"]')?.textContent).toMatch(/Holding \(—\)/);
    await click(document.getElementById('btn-nav-plug-and-play'));
    await flush(10);
    await click([...document.querySelectorAll('button')].find((b) => /^Signer & Security/.test((b.textContent || '').trim()))!);
    expect(document.body.textContent).toMatch(/unknown \(not read: HTTP 401\)/);
    await click([...document.querySelectorAll('button')].find((b) => /^Open Positions/.test((b.textContent || '').trim()))!);
    expect(document.querySelector('[data-testid="pnp-positions-unread"]')?.textContent).toMatch(/could not be read \(HTTP 401\)\. This is not an empty list/);
    expect(document.body.textContent).not.toMatch(/No positions opened yet/);
    await click(document.getElementById('btn-nav-telegram-tracker'));
    await flush(10);
    expect(document.querySelector('[data-testid="signals-count"]')?.textContent).toBe('not read');
  });

  it('the auto panel marks a status it can no longer read', async () => {
    server.deny = (p) => p !== '/api/auth/session' && p !== '/api/auto/status';
    server.routes['/api/auto/status'] = () => ({ json: { success: true, ...autoSnipeController.getStatus(), stats: autoSnipeController.getJournalStats(), decisions: [] } });
    await renderApp();
    expect(document.querySelector('[data-testid="auto-stale"]')).toBeNull();
    server.deny = (p) => p !== '/api/auth/session'; // the token is cleared: the next poll is refused
    await flush();
    await new Promise((r) => setTimeout(r, 4300));
    await flush();
    expect(document.querySelector('[data-testid="auto-stale"]')?.textContent).toMatch(/STALE: auto status last read \d+s ago \(HTTP 401\)/);
    expect(document.querySelector('[data-testid="auto-badge"]')?.textContent).toMatch(/\(stale\)/);
  }, 15000);
});

describe('R9-7: an old answer stops looking live', () => {
  it('the auto status goes stale by age alone', () => {
    expect(autoStatusStaleText({ at: 1000, error: null }, 1000 + AUTO_STATUS_STALE_MS - 1)).toBeNull();
    expect(autoStatusStaleText({ at: 1000, error: null }, 1000 + AUTO_STATUS_STALE_MS + 5000)).toMatch(/^STALE: auto status last read 20s ago\./);
  });

  it('"WS STREAMING" needs a message within WS_QUIET_MS, not only an open socket', () => {
    const c = engineClient as any;
    c.isConnected = true;
    c.isAuthenticated = true; // R12-8: and the server said AUTHENTICATED on it
    c.lastMessageAt = 10_000;
    expect(engineClient.isWsConnected(10_000 + WS_QUIET_MS - 1)).toBe(true);
    expect(engineClient.isWsConnected(10_000 + WS_QUIET_MS + 1)).toBe(false);
    c.isConnected = false;
    c.isAuthenticated = false;
  });

  it('the read-only strip is amber "LAST KNOWN" once the mode answer is stale', async () => {
    installDom();
    const server: FakeServer = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    server.routes['/api/diagnostics/system'] = () => ({ json: { systemAudit: { readOnly: true, allowedCluster: 'devnet', mode: 'PAPER', isLiveArmed: false } } });
    localStorage.setItem('apex_operator_token', 'test-token');
    const tm = await import('../src/utils/tradingMode');
    const off = tm.subscribeTradingMode(() => undefined);
    await flush(5);
    expect(renderToStaticMarkup(<TradingModeBanner />)).toMatch(/DEVNET · READ-ONLY · PAPER/);
    expect(renderToStaticMarkup(<TradingModeBanner />)).not.toMatch(/LAST KNOWN/);
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => t0 + tm.MODE_STALE_MS + 5000);
    const html = renderToStaticMarkup(<TradingModeBanner />);
    expect(html).toMatch(/LAST KNOWN: DEVNET · READ-ONLY · PAPER/);
    expect(html).not.toMatch(/nothing can be signed or sent/);
    off();
    await removeDom();
  });
});
