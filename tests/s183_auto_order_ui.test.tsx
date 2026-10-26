import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AutoPanelView, AutoOrderSizeEditor, type AutoStatusData } from '../src/components/AutoPanel';

const base: AutoStatusData = {
  mode: 'OFF', killed: false, killReason: null, downgradeReason: null, haltReason: null, triggers: [], slippageBreaches: 0, session: null,
  budgets: { maxBuys: 5, maxSpendSol: 0.02, maxLossFraction: 0.15, maxDurationMs: 4 * 3600_000 },
  budgetLimits: { maxSpendSol: 0.06, minSpendSol: 0.005, maxBuys: 50 },
  orderSol: 0.005, orderLimits: { minSol: 0.001, maxSol: 0.02 },
  stats: { seen: 0, rejectedByStage: {}, wouldBuy: 0, bought: 0, open: 0, closed: 0, netPnlSol: 0, feesPaidSol: 0, winRate: null },
};

describe('S183 Auto order size editor', () => {
  it('the Auto panel shows the current order size with its bounds and where it applies', () => {
    const html = renderToStaticMarkup(React.createElement(AutoPanelView, { status: base }));
    expect(html).toContain('data-testid="auto-order-editor"');
    expect(html).toMatch(/data-testid="order-sol"[^>]*value="0.005"/);
    expect(html).toContain('0.001 to 0.02 SOL');
    expect(html).toContain('Applies to PAPER and DEVNET_LIVE buys from the next order');
    expect(html).not.toContain('order-problem');
  });

  it('an older server without the field shows no editor rather than a guess', () => {
    const { orderSol, orderLimits, ...old } = base;
    expect(renderToStaticMarkup(React.createElement(AutoPanelView, { status: old as AutoStatusData }))).not.toContain('auto-order-editor');
  });

  it('a size the server would refuse shows the reason and cannot be saved', () => {
    const render = (orderSol: number, spendLimitSol = 0.02) => renderToStaticMarkup(React.createElement(AutoOrderSizeEditor, { orderSol, limits: base.orderLimits, spendLimitSol }));
    const big = render(0.5);
    expect(big).toContain('Above the 0.02 SOL maximum position size');
    expect(big).toMatch(/data-testid="order-save"[^>]*disabled/);
    expect(render(0.0001)).toContain('Below the 0.001 SOL minimum');
    expect(render(0.015, 0.01)).toContain('session spend limit');
    expect(render(0)).toContain('above 0');
    expect(render(0.01)).not.toContain('order-problem');
  });
});
