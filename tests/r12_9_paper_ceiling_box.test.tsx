import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SnipeAmountView } from '../src/components/SnipeAmountControl';
import { FALLBACK_LIMITS, parseSnipeAmount } from '../src/utils/snipeAmount';

/** R12-9 (screen half): the amount box names the PAPER ceiling the server sends in /api/snipe/limits, and warns above it. */
describe('R12-9: the amount box shows the PAPER ceiling', () => {
  it('the box warns that 0.01 is above the PAPER ceiling, and names the ceiling', () => {
    const limits = { ...FALLBACK_LIMITS, paperCeilingSol: 0.0055 };
    const html = renderToStaticMarkup(<SnipeAmountView state={{ text: '0.01', setText: () => undefined, limits, parsed: parseSnipeAmount('0.01', limits) }} compact />);
    expect(html).toMatch(/data-testid="snipe-amount-paper-ceiling"[^>]*>0\.01 SOL is above the PAPER order ceiling of 0\.0055 SOL/);
    const ok = renderToStaticMarkup(<SnipeAmountView state={{ text: '0.005', setText: () => undefined, limits, parsed: parseSnipeAmount('0.005', limits) }} />);
    expect(ok).toMatch(/PAPER orders are capped at 0\.0055 SOL now/);
  });
});
