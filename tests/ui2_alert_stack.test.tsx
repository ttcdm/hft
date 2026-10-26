import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AlertSystem, isAlertExpired } from '../src/components/AlertSystem';

/** From the 2026-10-26 click-through (overnight/reports/click-through-2026-10-26). Fails on c47125e without its fix. */
describe('UI-2: alerts do not pile up over the Plug & Play footer', () => {
  const alert = (i: number, level: 'INFO' | 'WARNING' | 'CRITICAL' = 'INFO') => ({ id: `a${i}`, timestamp: 0, timeStr: '', level, title: `TITLE ${i}`, message: `m${i}`, acknowledged: false });
  it('INFO and WARNING expire on their own, CRITICAL stays', () => {
    expect(isAlertExpired(alert(1, 'INFO'), 7_999)).toBe(false);
    expect(isAlertExpired(alert(1, 'INFO'), 8_000)).toBe(true);
    expect(isAlertExpired(alert(1, 'WARNING'), 20_000)).toBe(true);
    expect(isAlertExpired(alert(1, 'CRITICAL'), 10 * 60_000)).toBe(false);
  });
  it('the stack shows the newest alert only, with a "Show all" toggle for the rest', () => {
    const html = renderToStaticMarkup(<AlertSystem alerts={[alert(1), alert(2), alert(3)]} onDismissAlert={() => {}} onClearAll={() => {}} />);
    expect(html).toContain('TITLE 1');
    expect(html).not.toContain('TITLE 2');
    expect(html).toContain('Show all (+2)');
  });
});
