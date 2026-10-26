import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlugAndPlayTradingModal } from '../src/components/PlugAndPlayTradingModal';
import { MemecoinSocialSniperModal } from '../src/components/MemecoinSocialSniperModal';

/** From the 2026-10-26 click-through (overnight/reports/click-through-2026-10-26). Fails on c47125e without its fix. */
describe('UI-7: no leftover placeholder labels', () => {
  it('no "$10 Micro", "MICRO $10 TIER", "Market Maker" title or fixed Jito tip on the screens', () => {
    const pnp = renderToStaticMarkup(<PlugAndPlayTradingModal isOpen onClose={() => {}} />);
    const sniper = renderToStaticMarkup(<MemecoinSocialSniperModal isOpen onClose={() => {}} />);
    for (const html of [pnp, sniper]) {
      expect(html).not.toMatch(/MICRO \$10 TIER|\$10 Micro Account|Market Maker Intelligence|0\.005 SOL Tip/);
    }
    expect(pnp).not.toMatch(/>0 ms</);
  });
});
