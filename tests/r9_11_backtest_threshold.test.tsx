import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { installDom, removeDom, installFakeServer, typeInto, flush, FakeServer } from './helpers/domApp';
import { BacktestModal, ReplayThresholdBox } from '../src/components/BacktestModal';

/**
 * R9-11: clearing the box showed 70 on the slider while the replay stayed at the last typed value; an invalid value dropped the slider to
 * 0 while the result stayed; every slider step fired its own replay.
 */
describe('R9-11: the backtest result is for the threshold on screen', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    server.routes['/api/auto/status'] = () => ({ json: { confluence: { value: 70 } } });
    server.routes['/api/backtest/replay'] = () => ({ json: { success: true, report: null, message: 'nothing recorded' } });
  });
  afterEach(async () => { await removeDom(); });

  const replays = () => server.calls.filter((c) => c.url === '/api/backtest/replay').length;
  const lastReplayQuery = () => {
    const f = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0])).filter((u: string) => u.startsWith('/api/backtest/replay'));
    return f[f.length - 1];
  };
  const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

  it('fast typing replays once at the last value; clearing the box replays at the live threshold', async () => {
    const el = document.createElement('div'); document.body.appendChild(el);
    const root = createRoot(el);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => { root.render(<BacktestModal isOpen onClose={() => undefined} />); });
    await flush();
    const before = replays();
    const box = () => el.querySelector('[data-testid="replay-threshold-box"]');
    for (const v of ['5', '50', '55', '56']) await typeInto(box(), v);
    await wait(600);
    expect(replays() - before).toBe(1);
    expect(lastReplayQuery()).toBe('/api/backtest/replay?minScore=56');
    await typeInto(box(), '');
    await wait(600);
    expect(lastReplayQuery()).toBe('/api/backtest/replay');
    await act(async () => root.unmount());
  });

  it('an invalid value keeps the slider at the replayed value and says the result is still at it', () => {
    const html = renderToStaticMarkup(<ReplayThresholdBox value="150" onChange={() => undefined} inForce={70} replayedAt={56} />);
    expect(html).toMatch(/data-testid="replay-threshold-slider"[^>]*value="56"/);
    expect(html).toContain('The replay below is still at 56');
  });
});
