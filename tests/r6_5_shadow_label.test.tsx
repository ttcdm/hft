import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AutoPanelView, SHADOW_TEST_NOTE, type AutoStatusData } from '../src/components/AutoPanel';

/** R6-5 (haiku-attack 2026-10-26): SHADOW "Would buy" sat next to "Bought" as if it were the same test. */
describe('R6-5: SHADOW would-buy is labelled as a looser test', () => {
  it('the panel says it is a different, looser test and names what it skips', () => {
    const status = { mode: 'SHADOW', killed: false, killReason: null, downgradeReason: null, haltReason: null, triggers: [], slippageBreaches: 0, session: null,
      budgets: { maxBuys: 5, maxSpendSol: 0.02, maxLossFraction: 0.15, maxDurationMs: 1 }, stats: { seen: 9, rejectedByStage: {}, wouldBuy: 4, bought: 1, open: 0, closed: 1, netPnlSol: 0, feesPaidSol: 0, winRate: null } } as AutoStatusData;
    const html = renderToStaticMarkup(<AutoPanelView status={status} />);
    expect(html).toContain('Would buy (SHADOW, looser test)');
    expect(SHADOW_TEST_NOTE).toMatch(/slot cap.*session budget.*re-entry guard/);
    expect(html).toContain(SHADOW_TEST_NOTE.slice(0, 40));
  });
});
