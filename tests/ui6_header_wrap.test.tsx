import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Header } from '../src/components/Header';

/** From the 2026-10-26 click-through (overnight/reports/click-through-2026-10-26). Fails on c47125e without its fix. */
describe('UI-6: the header wraps on narrow screens', () => {
  it('the header wraps instead of overflowing (R9-8: at every width, not only below lg)', () => {
    const html = renderToStaticMarkup(<Header kpis={{} as any} isHalted={false} onToggleKillSwitch={() => {}} isOperatorAuthenticated={false} />);
    expect(html).toMatch(/id="apex-header"[^>]*class="[^"]*\bflex-wrap\b/);
    expect(html).not.toMatch(/id="apex-header"[^>]*class="[^"]*nowrap/);
  });
});
