import { describe, it, expect } from 'vitest';
import fs from 'fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AutoPanelView, type AutoStatusData } from '../src/components/AutoPanel';

const read = (f: string) => fs.readFileSync(f, 'utf8');
const base: AutoStatusData = {
  mode: 'OFF', killed: false, killReason: null, downgradeReason: null, haltReason: null, triggers: [], slippageBreaches: 0, session: null,
  budgets: { maxBuys: 5, maxSpendSol: 0.02, maxLossFraction: 0.15, maxDurationMs: 4 * 3600_000 },
  stats: { seen: 0, rejectedByStage: {}, wouldBuy: 0, bought: 0, open: 0, closed: 0, netPnlSol: 0, feesPaidSol: 0, winRate: null },
};

describe('S176 UI wiring', () => {
  it('the aggregator row Snipe button calls the by-mint handler; the made-up signal wrapper is gone', () => {
    const src = read('src/components/MemecoinSocialSniperModal.tsx');
    expect(src).toContain('handleSnipePool(pool)');
    expect(src).not.toContain('sig-agg-');
    expect(src).toContain('formatPctChange(pool.priceChange5mPct)');
    expect(src).not.toMatch(/\{pool\.priceChange5mPct\}%/);
  });

  it('callouts show mcap/multiple as measured-or-unknown, label mainnet data, and disable the snipe off mainnet', () => {
    const src = read('src/components/PumpFunHotCalloutsView.tsx');
    expect(src).toContain('formatCalloutMcap(c.token.marketCapAtCalloutUsd)');
    expect(src).toContain('callouts-mainnet-banner');
    expect(src).toContain('calloutSnipeBlock(tradingMode.cluster) !== null');
    expect(src).not.toContain('Callout Mcap');
  });

  it('the link views render "mainnet only" instead of a dead anchor', () => {
    const src = read('src/components/TokenExternalLinksView.tsx');
    expect(src).toContain('mainnet-only-note');
    expect(src).toContain('mainnet-only-link');
    expect(src).toContain("mode.cluster ?? 'unknown'");
  });

  it('the Auto panel says how to enable auto up front when the server env is off, and nothing when it is on', () => {
    const off = renderToStaticMarkup(React.createElement(AutoPanelView, { status: { ...base, envEnabled: false } }));
    expect(off).toContain('data-testid="auto-env-hint"');
    expect(off).toMatch(/AUTO_SNIPE_ENABLED=true<\/strong> in <strong>\.env/);
    expect(renderToStaticMarkup(React.createElement(AutoPanelView, { status: { ...base, envEnabled: true } }))).not.toContain('auto-env-hint');
    expect(renderToStaticMarkup(React.createElement(AutoPanelView, { status: base }))).not.toContain('auto-env-hint'); // an older server that does not say
  });
});
