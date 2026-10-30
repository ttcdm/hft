import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installDom, removeDom, installFakeServer, flush, FakeServer } from './helpers/domApp';
import { BacktestModal } from '../src/components/BacktestModal';

/**
 * R9-11 leftover (round 11): a slow drag of the backtest slider (about 400 ms per step) still fired one replay per step, since the
 * debounce window (REPLAY_DEBOUNCE_MS = 400) was no longer than a step. A drag now replays once, when the slider is let go, and a replay
 * still out when a newer value is applied is cancelled (its request is aborted, its answer never shown).
 */
describe('R9-11: a slow slider drag replays once, and a superseded replay is cancelled', () => {
  let server: FakeServer;
  const signals: Array<{ url: string; signal: AbortSignal | undefined }> = [];
  beforeEach(() => {
    installDom();
    signals.length = 0;
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    server.routes['/api/auto/status'] = () => ({ json: { confluence: { value: 70 } } });
    server.routes['/api/backtest/replay'] = () => ({ json: { success: true, recorded: { launches: 0, events: 0, oldestTs: null, newestTs: null }, report: null, message: 'nothing recorded' } });
    const realFetch = (window as any).fetch;
    const f = async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith('/api/backtest/replay')) signals.push({ url, signal: init?.signal ?? undefined });
      return realFetch(input, init);
    };
    (window as any).fetch = f;
    (globalThis as any).fetch = f;
  });
  afterEach(async () => { await removeDom(); });

  const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
  const setSlider = async (el: HTMLInputElement, v: string) => {
    let proto = Object.getPrototypeOf(el); let setter: any;
    while (proto && !setter) { setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set; proto = Object.getPrototypeOf(proto); }
    await act(async () => { setter.call(el, v); el.dispatchEvent(new (window as any).Event('input', { bubbles: true })); el.dispatchEvent(new (window as any).Event('change', { bubbles: true })); });
  };
  const pointer = async (el: Element, type: string) => { await act(async () => { el.dispatchEvent(new (window as any).Event(type, { bubbles: true })); }); };

  it('four steps 450 ms apart while held: no replay until the slider is let go, then one at the last value', async () => {
    const el = document.createElement('div'); document.body.appendChild(el);
    const root = createRoot(el);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => { root.render(<BacktestModal isOpen onClose={() => undefined} />); });
    await flush();
    const before = signals.length;
    const slider = el.querySelector('[data-testid="replay-threshold-slider"]') as HTMLInputElement;
    await pointer(slider, 'pointerdown');
    for (const v of ['60', '55', '50', '45']) { await setSlider(slider, v); await wait(450); }
    expect(signals.length - before).toBe(0);
    await pointer(slider, 'pointerup');
    await wait(900);
    const after = signals.slice(before).map((s) => s.url);
    expect(after).toEqual(['/api/backtest/replay?minScore=45']);
    await act(async () => root.unmount());
  });

  it('a replay still out when a newer value is applied is aborted', async () => {
    const el = document.createElement('div'); document.body.appendChild(el);
    const root = createRoot(el);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => { root.render(<BacktestModal isOpen onClose={() => undefined} />); });
    await flush();
    const slider = el.querySelector('[data-testid="replay-threshold-slider"]') as HTMLInputElement;
    await setSlider(slider, '40');
    await wait(900);
    const first = signals.find((s) => s.url.endsWith('minScore=40'));
    expect(first?.signal).toBeDefined();
    await setSlider(slider, '30');
    await wait(900);
    expect(signals.some((s) => s.url.endsWith('minScore=30'))).toBe(true);
    expect(first!.signal!.aborted).toBe(true);
    await act(async () => root.unmount());
  });
});
