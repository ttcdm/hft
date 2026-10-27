import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installDom, removeDom, click } from './helpers/domApp';
import { AlertSystem } from '../src/components/AlertSystem';

/** R10-9: "Show all (+8)" showed 3 alerts; the rest could only be reached by dismissing newer ones. */
describe('R10-9: "Show all" shows every alert', () => {
  beforeEach(() => { installDom(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
  afterEach(async () => { await removeDom(); });

  it('nine alerts: the toggle says +8 and then all nine are listed, in a scrollable list', async () => {
    const alerts = Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, timestamp: i, timeStr: '', level: 'WARNING' as const, title: `TITLE ${i}`, message: `m${i}`, acknowledged: false }));
    const el = document.createElement('div'); document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(<AlertSystem alerts={alerts} onDismissAlert={() => {}} onClearAll={() => {}} />); });
    const toggle = el.querySelector('[data-testid="alerts-toggle"]')!;
    expect(toggle.textContent).toBe('Show all (+8)');
    await click(toggle);
    for (let i = 0; i < 9; i++) expect(el.textContent).toContain(`TITLE ${i}`);
    expect(el.querySelector('[data-testid="alerts-list"]')?.className).toMatch(/overflow-y-auto/);
    await act(async () => root.unmount());
  });
});
