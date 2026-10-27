import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Header } from '../src/components/Header';

/**
 * R9-8: at 1024 px the header did not wrap (`lg:flex-nowrap`) and KILL SWITCH sat at x=1104 on a 1238 px wide page, reachable only by
 * scrolling sideways; the PnL pill was hidden below 1500 px. happy-dom does no layout, so this checks the classes that decide it: the
 * header and its right-hand group wrap at every width, KILL SWITCH never shrinks or wraps its text, and the pill shows from sm up.
 * The Chromium click-through (scripts/visual) is the layout check.
 */
describe('R9-8: KILL SWITCH stays on screen at every width', () => {
  const html = renderToStaticMarkup(<Header kpis={{} as any} isHalted={false} onToggleKillSwitch={() => {}} isOperatorAuthenticated={false} />);
  const classOf = (attr: string) => html.match(new RegExp(`${attr}[^>]*class="([^"]*)"`))?.[1] ?? '';

  it('the header and its right-hand group wrap at every width', () => {
    expect(classOf('id="apex-header"')).toMatch(/\bflex-wrap\b/);
    expect(classOf('id="apex-header"')).not.toMatch(/nowrap|lg:h-16/);
    expect(classOf('data-testid="header-right"')).toMatch(/\bflex-wrap\b/);
    expect(classOf('data-testid="header-right"')).toMatch(/\bmin-w-0\b/);
  });

  it('KILL SWITCH does not shrink; the PnL pill is not hidden on a laptop', () => {
    expect(classOf('id="btn-emergency-kill-switch"')).toMatch(/\bflex-shrink-0\b/);
    expect(classOf('id="btn-auto-profit-ticker"')).not.toMatch(/min-\[1500px\]/);
    expect(classOf('id="btn-auto-profit-ticker"')).toMatch(/\bsm:flex\b/);
  });
});
