import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlugAndPlayTradingModal } from '../src/components/PlugAndPlayTradingModal';
import { MemecoinSocialSniperModal } from '../src/components/MemecoinSocialSniperModal';
import { publishHeaderHeight, HEADER_HEIGHT_VAR, BELOW_HEADER_TOP } from '../src/utils/headerOffset';

/** Follow-up to UI-6: the wrapped header is taller than 64 px on phones, so the modals must start below its real height. */
describe('UI-8: the full-screen modals start below the header', () => {
  it('Plug & Play and the sniper overlay use the measured header height, not a fixed top-16', () => {
    for (const html of [
      renderToStaticMarkup(<PlugAndPlayTradingModal isOpen onClose={() => {}} />),
      renderToStaticMarkup(<MemecoinSocialSniperModal isOpen onClose={() => {}} />),
    ]) {
      expect(html).toContain(BELOW_HEADER_TOP);
      expect(html).not.toMatch(/class="fixed top-16 /);
    }
  });

  it('publishes where the header ends and updates it on resize and scroll', () => {
    const set: Record<string, string> = {};
    const root = { style: { setProperty: (k: string, v: string) => { set[k] = v; } } };
    const listeners: Record<string, () => void> = {};
    let bottom = 107.4;
    let fire = () => {};
    const g = globalThis as any;
    const prev = { ro: g.ResizeObserver, win: g.window };
    g.ResizeObserver = class { constructor(cb: () => void) { fire = cb; } observe() {} disconnect() {} };
    g.window = { addEventListener: (k: string, f: () => void) => { listeners[k] = f; }, removeEventListener: (k: string) => { delete listeners[k]; } };
    try {
      const stop = publishHeaderHeight({ getBoundingClientRect: () => ({ bottom }) }, root);
      expect(set[HEADER_HEIGHT_VAR]).toBe('108px');
      bottom = 175; // the header wrapped onto more rows
      fire();
      expect(set[HEADER_HEIGHT_VAR]).toBe('175px');
      bottom = 131; // the banner above it scrolled away
      listeners.scroll();
      expect(set[HEADER_HEIGHT_VAR]).toBe('131px');
      stop();
      expect(listeners.scroll).toBeUndefined();
    } finally {
      g.ResizeObserver = prev.ro;
      g.window = prev.win;
    }
  });
});
