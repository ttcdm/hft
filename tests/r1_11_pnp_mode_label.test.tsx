import './helpers/domGlobals';
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { installDom, removeDom, installFakeServer, flush, type FakeServer } from './helpers/domApp';
import { mount } from './helpers/mountDom';
import { PlugAndPlayTradingModal } from '../src/components/PlugAndPlayTradingModal';
import { describeTradingMode, plugAndPlayModeView, MODE_STALE_MS } from '../src/utils/tradingMode';

/**
 * Round 1 #11 (haiku-attack 2026-10-26): Plug & Play showed "PAPER TRADING" / "PAPER SNIPE" from its last good read, which never aged out,
 * while the shared banner said MODE UNKNOWN. It now reads the shared useTradingMode() answer.
 */
describe('Round 1 #11: the Plug & Play mode label goes stale with the shared poller', () => {
  const now = 1_000_000;
  it('a PAPER answer older than MODE_STALE_MS reads MODE UNKNOWN, not PAPER TRADING', () => {
    const v = plugAndPlayModeView(describeTradingMode({ mode: 'PAPER', isLiveArmed: false }, now - MODE_STALE_MS - 1, now));
    expect(v.badge).toBe('MODE UNKNOWN');
    expect(v.snipe).toBe('SNIPE (MODE UNKNOWN)');
  });
  it('fresh answers: PAPER and LIVE armed', () => {
    expect(plugAndPlayModeView(describeTradingMode({ mode: 'PAPER', isLiveArmed: false }, now - 1_000, now))).toMatchObject({ badge: 'PAPER TRADING', snipe: 'PAPER SNIPE' });
    expect(plugAndPlayModeView(describeTradingMode({ mode: 'LIVE', isLiveArmed: true }, now - 1_000, now))).toMatchObject({ badge: 'LIVE BROADCAST ACTIVE', snipe: 'LIVE SNIPE' });
  });
  afterEach(async () => { await removeDom(); });
  it('the modal shows the shared poller\'s answer: MODE UNKNOWN before it, the armed LIVE label after it', async () => {
    installDom();
    const server: FakeServer = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    let answer = false;
    server.routes['/api/diagnostics/system'] = () => (answer ? { json: { systemAudit: { mode: 'LIVE', isLiveArmed: true, allowedCluster: 'devnet', killSwitchActive: false } } } : { status: 503, json: { error: 'down' } });
    const { container, unmount } = await mount(<PlugAndPlayTradingModal isOpen onClose={() => {}} />);
    await flush(10);
    expect(container.textContent).toContain('MODE UNKNOWN');
    expect(container.textContent).not.toContain('PAPER TRADING');
    await unmount();
    answer = true;
    const again = await mount(<PlugAndPlayTradingModal isOpen onClose={() => {}} />);
    await flush(10);
    expect(again.container.textContent).toContain('LIVE BROADCAST ACTIVE');
    expect(again.container.textContent).toContain('LIVE SNIPE');
    await again.unmount();
  });
});
