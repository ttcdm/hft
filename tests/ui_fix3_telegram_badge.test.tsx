import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import fs from 'fs';
import { installDom, removeDom, installFakeServer, click, type FakeServer } from './helpers/domApp';
import { mount, buttonByText } from './helpers/mountDom';
import { MemecoinSocialSniperModal } from '../src/components/MemecoinSocialSniperModal';

/** UI status report 2026-10-26, fix 3: the Telegram hub showed a hard-coded "STATUS: POLLING ACTIVE" while nothing polls Telegram. */
describe('UI fix 3: the Telegram hub badge says what is true', () => {
  let server: FakeServer;
  beforeEach(() => { installDom(); server = { calls: [], routes: {}, killSwitchActive: false }; installFakeServer(server); });
  afterEach(async () => { await removeDom(); });

  it('no POLLING ACTIVE claim; the badge says it is a local console', async () => {
    const { container, unmount } = await mount(<MemecoinSocialSniperModal isOpen onClose={() => {}} />);
    await click(buttonByText(container, /Telegram Bot Control Hub/)!);
    expect(container.textContent).toContain('NOT POLLING TELEGRAM (local console)');
    expect(container.textContent).not.toContain('POLLING ACTIVE');
    // nothing it could poll for: the hub sent no Telegram request, and the server has no Telegram polling or webhook registration
    expect(server.calls.some((c) => /telegram/i.test(c.url))).toBe(false);
    expect(fs.readFileSync('server.ts', 'utf8')).not.toMatch(/getUpdates\(|setWebhook\(/);
    await unmount();
  });
});
