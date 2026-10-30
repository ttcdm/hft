import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installDom, removeDom, installFakeServer, flush, FakeServer } from './helpers/domApp';
import { SystemChecksModal } from '../src/components/SystemChecksModal';

/**
 * R12-11 (System checks half): a 200 whose body is not JSON left System checks on "Reading the server…" forever (usePolled took the null
 * body as no data and no error), and a reply whose rows carry null fields rendered blank rows, as if they said nothing was wrong.
 * The real modal and the real usePolled, with the fetch boundary faked.
 */
describe('R12-11: System checks says when the reply cannot be read', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
  });
  afterEach(async () => { await removeDom(); });

  async function mount() {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(<SystemChecksModal isOpen onClose={() => {}} />); });
    await flush();
    return document.querySelector('[data-testid="system-checks"]')?.textContent ?? '';
  }

  it('a 200 with an unreadable body is an error, not an endless "Reading the server"', async () => {
    server.routes['/api/system/checks'] = () => ({ json: undefined });
    const text = await mount();
    expect(text).not.toMatch(/Reading the server/);
    expect(text).toMatch(/unreadable/i);
  });

  it('a reply with no checks list is unreadable', async () => {
    server.routes['/api/system/checks'] = () => ({ json: { checkedAt: Date.now(), cluster: 'devnet', mode: 'PAPER', checks: null } });
    const text = await mount();
    expect(text).toMatch(/unreadable/i);
  });

  it('a row with a null status or value says UNKNOWN / unreadable, never a blank OK-looking row', async () => {
    server.routes['/api/system/checks'] = () => ({ json: { checkedAt: Date.now(), cluster: 'devnet', mode: 'PAPER', checks: [
      { id: 'kill', label: 'Kill switch', status: null, value: null, detail: null },
    ] } });
    await mount();
    const row = document.querySelector('[data-testid="check-kill"]');
    expect(row?.querySelector('[data-testid="check-status"]')?.textContent).toBe('UNKNOWN');
    expect(row?.textContent).toMatch(/unreadable/i);
  });
});
