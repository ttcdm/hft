import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TokenBoardView, type BoardData } from '../src/components/TokenBoard';

/**
 * R10-5 (board half) / R11-11: a launch row showed its price and curve % as current, with no age, beside a Holding row whose mark said
 * STALE, and for a mint whose curve panel said "No market data (503)". The figures are from the last feed trade; the row now says how
 * old that trade is and marks the figures STALE past the mark age limit, and says when no trade has been seen at all.
 */
const launch = (priceAgeMs: number | null | undefined) => ({
  mint: 'So11111111111111111111111111111111111111112', symbol: 'AGE', name: 'Age', priceSol: 1.2e-8, priceUsd: null, curveProgressPct: 12.5,
  top10HoldersPct: null, creatorHoldingPct: null, mintRevoked: null, freezeRevoked: null, createdAgo: '40s', priceAgeMs,
});
const render = (priceAgeMs: number | null | undefined) => renderToStaticMarkup(<TokenBoardView tab="launches" onTab={() => undefined} board={{
  generatedAt: 1, executionMode: 'PAPER', wallet: { balanceSol: null, reserveSol: 0.015, rentLockedSol: null, spendableSol: null, solUsd: null },
  launches: [launch(priceAgeMs)], watching: [], holding: [],
} as BoardData} />);

describe('R10-5 / R11-11: a launch price says how old it is', () => {
  it('a 6-minute-old trade: price and curve are marked STALE', () => {
    const html = render(380_000);
    expect(html).toMatch(/data-testid="launch-price-age"[^>]*text-amber-300[^>]*>last trade [^<]*\(STALE\)/);
    expect(html).toMatch(/data-testid="launch-curve"[^>]*text-amber-300/);
  });
  it('a fresh trade has its age and no marker', () => {
    const html = render(2_000);
    expect(html).toMatch(/last trade 2s ago/);
    expect(html).not.toMatch(/STALE/);
  });
  it('no trade seen says the figures are from the create event', () => {
    expect(render(null)).toMatch(/no trade seen/);
  });
});
