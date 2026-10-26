import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { AutoPanelView, type AutoStatusData } from '../src/components/AutoPanel';
import { ReplayThresholdBox } from '../src/components/BacktestModal';

const status = (value: number, source: 'operator' | 'env' | 'default' = 'default'): AutoStatusData => ({
  mode: 'OFF', killed: false, killReason: null, downgradeReason: null, haltReason: null, triggers: [], slippageBreaches: 0, session: null,
  budgets: { maxBuys: 5, maxSpendSol: 0.05, maxLossFraction: 0.1, maxDurationMs: 3_600_000 },
  stats: { seen: 0, rejectedByStage: {}, wouldBuy: 0, bought: 0, open: 0, closed: 0, netPnlSol: 0, feesPaidSol: 0, winRate: null },
  confluence: { value, defaultValue: 70, source, warnBelow: 50, warning: value < 50 ? 'Below 50: more buys of weaker coins.' : null },
});

describe('S187 the Auto panel control', () => {
  it('shows a slider and a number box with the value in force', () => {
    const html = renderToStaticMarkup(<AutoPanelView status={status(70)} />);
    expect(html).toContain('data-testid="confluence-slider"');
    expect(html).toContain('data-testid="confluence-box"');
    expect(html).toMatch(/in force: 70/);
    expect(html).toMatch(/type="range"[^>]*min="0"[^>]*max="100"|min="0"[^>]*max="100"[^>]*type="range"/);
    expect(html).not.toContain('confluence-warning');
  });
  it('warns plainly below 50 and not at 50', () => {
    expect(renderToStaticMarkup(<AutoPanelView status={status(49, 'operator')} />)).toContain('data-testid="confluence-warning"');
    expect(renderToStaticMarkup(<AutoPanelView status={status(50, 'operator')} />)).not.toContain('confluence-warning');
  });
  it('is absent on an older server that does not send it', () => {
    const s = status(70); delete s.confluence;
    expect(renderToStaticMarkup(<AutoPanelView status={s} />)).not.toContain('confluence-editor');
  });
});

describe('S187 the Backtest what-if box', () => {
  it('has the slider, the box and the 70 / 50 / 40 shortcuts, and warns under 50 or on a bad value', () => {
    const html = renderToStaticMarkup(<ReplayThresholdBox value="40" onChange={() => {}} inForce={70} />);
    for (const id of ['replay-threshold-slider', 'replay-threshold-box', 'replay-threshold-70', 'replay-threshold-50', 'replay-threshold-40', 'replay-threshold-warning']) expect(html).toContain(`data-testid="${id}"`);
    expect(html).toMatch(/live: 70/);
    expect(renderToStaticMarkup(<ReplayThresholdBox value="70" onChange={() => {}} />)).not.toContain('replay-threshold-warning');
    expect(renderToStaticMarkup(<ReplayThresholdBox value="abc" onChange={() => {}} />)).toContain('replay-threshold-problem');
  });
});
