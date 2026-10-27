import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TokenBoardView } from '../src/components/TokenBoard';

/** R10-5: a held position's 6-minute-old mark was shown with a green "+40%" and "next exit TAKE PROFIT 2" as if current. */
const board = (markStale: boolean): any => ({
  launches: [], watching: [],
  holding: [{ id: 'h1', mint: 'M1', symbol: 'FIXD', mode: 'PAPER', entryPriceSol: 1e-8, markPriceSol: 1.4e-8, markAgeMs: markStale ? 380_000 : 2_000, markStale, costSol: 0.001, pnlSol: 0.0004, nextExit: { kind: 'TAKE_PROFIT_2', priceSol: 2e-8 } }],
});

describe('R10-5: a stale mark is not shown as current on the Holding row', () => {
  it('stale: the PnL is amber "at a STALE mark" and the next exit "waits for a fresh mark"', () => {
    const html = renderToStaticMarkup(<TokenBoardView board={board(true)} tab="holding" onTab={() => {}} />);
    expect(html).toMatch(/data-testid="holding-pnl" class="[^"]*text-amber-300[^"]*">\+0\.000400<span[^>]*>at a STALE mark/);
    expect(html).toMatch(/TAKE PROFIT 2 @ [^<]*<span[^>]*>waits for a fresh mark/);
    expect(html).toMatch(/\(STALE\)/);
  });
  it('fresh: no stale note', () => {
    const html = renderToStaticMarkup(<TokenBoardView board={board(false)} tab="holding" onTab={() => {}} />);
    expect(html).not.toMatch(/STALE|fresh mark/);
  });
});
