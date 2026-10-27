import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { installDom, removeDom, installFakeServer, click, typeInto, flush, type FakeServer } from './helpers/domApp';
import { mount, buttonByText } from './helpers/mountDom';
import { MemecoinSocialSniperModal } from '../src/components/MemecoinSocialSniperModal';

/**
 * UI status report 2026-10-26, fix 4: two Sniper inputs said "not used". The take-profit box was dead (its value was read only by the box:
 * the modal never posts the config, and exits use the fixed ExitEngine rules), so it is gone. The Jito tip box is NOT dead: every snipe
 * from this screen sends its value, so it stays (flagged for Mike, not removed). The real modal, in a DOM, against a fake server.
 */
describe('UI fix 4: no dead Sniper inputs', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    server.routes['/api/memecoins/trade'] = () => ({ json: { status: 'OK', result: { success: false, message: 'test' } } });
  });
  afterEach(async () => { await removeDom(); });

  const openSniperTab = async () => {
    const m = await mount(<MemecoinSocialSniperModal isOpen onClose={() => {}} />);
    await click(buttonByText(m.container, /Autonomous Sniper & Positions/)!);
    return m;
  };

  it('the take-profit box is gone, and nothing on the screen sends the config it edited', async () => {
    const { container, unmount } = await openSniperTab();
    expect(container.textContent).not.toContain('Take-Profit Target');
    expect(container.querySelector('[data-testid="jito-tip-label"]')).not.toBeNull(); // the tab really is the config panel
    expect(server.calls.filter((c) => c.method === 'POST' && /memecoins\/config/.test(c.url))).toEqual([]);
    await unmount();
  });

  it('the Jito tip box stays because snipes read it', async () => {
    const { container, unmount } = await openSniperTab();
    await typeInto(container.querySelector('[data-testid="sniper-jito-tip"]'), '0.0042');
    await typeInto(container.querySelector('input[placeholder^="e.g. CzLSuj"]'), 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS');
    await click(buttonByText(container, /Instant Snipe/)!);
    await flush();
    const sent = server.calls.filter((c) => c.method === 'POST' && c.url === '/api/memecoins/trade');
    expect(sent).toHaveLength(1);
    expect(sent[0].body.jitoTipSol).toBe(0.0042);
    await unmount();
  });
});
