import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installDom, removeDom, installFakeServer, flush, FakeServer } from './helpers/domApp';
import { SystemChecksModal } from '../src/components/SystemChecksModal';

/**
 * R11-1: with the server unreachable, System checks showed the error line and kept all nine green OK rows under it, although its own
 * subtitle says a check that cannot be read says UNKNOWN, never OK.
 */
describe('R11-1: System checks never shows OK for a read that failed', () => {
  let server: FakeServer;
  let offline = false;
  beforeEach(() => {
    installDom();
    offline = false;
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    server.routes['/api/system/checks'] = () => {
      if (offline) throw new TypeError('Failed to fetch');
      return { json: { checkedAt: Date.now(), cluster: 'devnet', mode: 'PAPER', checks: [
        { id: 'kill', label: 'Kill switch', status: 'OK', value: 'off', detail: '' },
        { id: 'marks', label: 'Position marks', status: 'OK', value: 'fresh', detail: '' },
      ] } };
    };
  });
  afterEach(async () => { await removeDom(); });

  it('goes UNKNOWN (with the last value and its age) when the server stops answering', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(<SystemChecksModal isOpen onClose={() => {}} />); });
    await flush();
    const chip = (id: string) => document.querySelector(`[data-testid="check-${id}"] span`)?.textContent;
    expect(chip('kill')).toBe('OK');
    offline = true;
    await new Promise((r) => setTimeout(r, 5300));
    await flush();
    expect(document.querySelector('[data-testid="system-checks-error"]')?.textContent).toMatch(/Could not reach/);
    expect(chip('kill')).toBe('UNKNOWN');
    expect(chip('marks')).toBe('UNKNOWN');
    expect(document.querySelector('[data-testid="check-kill"]')?.textContent).toMatch(/last read .*s ago: OK/);
    await act(async () => root.unmount());
  }, 15000);
});
