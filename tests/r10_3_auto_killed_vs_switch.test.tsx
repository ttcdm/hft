import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AutoPanelView, type AutoStatusData } from '../src/components/AutoPanel';

/** R10-3: after a restart the panel said "Killed: operator kill switch" while the header (rightly) said the kill switch was off. */
const status: AutoStatusData = {
  mode: 'OFF', killed: true, killReason: 'operator kill switch', downgradeReason: null, haltReason: null, triggers: [], slippageBreaches: 0, session: null,
  budgets: { maxBuys: 5, maxSpendSol: 0.02, maxLossFraction: 0.15, maxDurationMs: 4 * 3600_000 },
  stats: { seen: 0, rejectedByStage: {}, wouldBuy: 0, bought: 0, open: 0, closed: 0, netPnlSol: 0, feesPaidSol: 0, winRate: null },
};

describe('R10-3: the auto kill line says the kill switch is off when it is', () => {
  it('kill switch off: the line explains it only says why auto stopped', () => {
    const html = renderToStaticMarkup(<AutoPanelView status={status} killSwitch={false} />);
    expect(html).toMatch(/Killed: operator kill switch\. Auto stays OFF until you set a mode\. The kill switch itself is OFF now/);
  });
  it('kill switch on or unknown: no such claim', () => {
    expect(renderToStaticMarkup(<AutoPanelView status={status} killSwitch={true} />)).not.toMatch(/itself is OFF/);
    expect(renderToStaticMarkup(<AutoPanelView status={status} killSwitch={null} />)).not.toMatch(/itself is OFF/);
  });
});
