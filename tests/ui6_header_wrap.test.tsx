import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Header } from '../src/components/Header';

/** From the 2026-10-26 click-through (overnight/reports/click-through-2026-10-26). Fails on c47125e without its fix. */
describe('UI-6: the header wraps on narrow screens', () => {
  it('the header wraps below lg instead of overflowing', () => {
    const html = renderToStaticMarkup(<Header kpis={{} as any} isHalted={false} onToggleKillSwitch={() => {}} isOperatorAuthenticated={false} />);
    expect(html).toMatch(/id="apex-header"[^>]*class="[^"]*\bflex-wrap\b[^"]*\blg:flex-nowrap\b/);
  });
});
