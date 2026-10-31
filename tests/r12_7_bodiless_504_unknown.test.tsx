import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installDom, removeDom, installFakeServer, flush, click, typeInto, FakeServer } from './helpers/domApp';
import { AutoPanel } from '../src/components/AutoPanel';
import { autoSnipeController } from '../server/auto/controller';

/**
 * R12-7: a Save the server applied was reported as "Request refused (HTTP 504)" when a proxy timed out with no JSON body. The same post()
 * serves the mode, budget, order size and threshold saves.
 */
describe('R12-7: a bodiless 5xx is an unknown outcome, not a refusal', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    server.routes['/api/auto/status'] = () => ({ json: { success: true, ...autoSnipeController.getStatus(), stats: autoSnipeController.getJournalStats(), decisions: [] } });
    const answer = (globalThis as any).fetch;
    const f = vi.fn((input: any, init?: RequestInit) => {
      if (String(input).includes('/api/auto/threshold')) {
        server.calls.push({ url: '/api/auto/threshold', method: 'POST', body: JSON.parse(String(init?.body)) });
        return Promise.resolve(new Response('<html><body>504 Gateway Time-out</body></html>', { status: 504, headers: { 'Content-Type': 'text/html' } }));
      }
      return answer(input, init);
    });
    vi.stubGlobal('fetch', f);
    (window as any).fetch = f;
  });
  afterEach(async () => { await removeDom(); });

  it('says the outcome is unknown and reads the status again at once', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(<AutoPanel />); });
    await flush(10);
    const box = document.querySelector('[data-testid="confluence-box"]');
    expect(box).not.toBeNull();
    const current = Number((box as HTMLInputElement).value);
    await typeInto(box, String(current === 60 ? 61 : 60));
    const reads = server.calls.filter((c) => c.url === '/api/auto/status').length;
    await click(document.querySelector('[data-testid="confluence-save"]'));
    await flush(10);
    const err = document.querySelector('[data-testid="auto-error"]')?.textContent ?? '';
    expect(err).not.toMatch(/Request refused/);
    expect(err).toMatch(/HTTP 504/);
    expect(err).toMatch(/may or may not have been applied/);
    expect(server.calls.filter((c) => c.url === '/api/auto/status').length).toBeGreaterThan(reads);
    await act(async () => root.unmount());
  });
});
