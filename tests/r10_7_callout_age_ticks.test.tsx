import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { installDom, removeDom } from './helpers/domApp';
import { CalloutAge, calloutAgeText, FeedStatusPill } from '../src/components/PumpFunHotCalloutsView';

/** R10-7: callout ages read "0m 2s ago" for 12 minutes, then jumped: they were the server's text from the last sync, not a clock. */
describe('R10-7: callout ages count on screen', () => {
  beforeEach(() => { installDom(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
  afterEach(async () => { await removeDom(); });

  it('the age keeps counting with no new snapshot', async () => {
    const el = document.createElement('div'); document.body.appendChild(el);
    const root = createRoot(el);
    const ts = Date.now() - 2000;
    await act(async () => { root.render(<CalloutAge calloutTimestamp={ts} fallback="0m 2s ago" />); });
    expect(el.textContent).toBe('0m 2s ago');
    await act(async () => { await new Promise((r) => setTimeout(r, 2100)); });
    expect(el.textContent).toBe('0m 4s ago');
    await act(async () => root.unmount());
  });

  it('formats minutes, and falls back to the server text with no timestamp', () => {
    expect(calloutAgeText(1_000, 'x', 1_000 + 17 * 60_000)).toBe('17m 0s ago');
    expect(calloutAgeText(undefined, '5m 1s ago', 0)).toBe('5m 1s ago');
  });

  it('the stale pill names the callout feed, not the Pump.fun event feed', () => {
    expect(renderToStaticMarkup(<FeedStatusPill status="STALE" />)).toMatch(/CALLOUT FEED STALE .*event feed in System checks is separate/);
  });
});
