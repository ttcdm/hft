import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fmtSol, fmtSignedSol, fmtUsdPrice, fmtRank, signTone } from '../src/utils/numFormat';
import { positionPnlCell } from '../src/utils/positionPnl';
import { TokenBoardView } from '../src/components/TokenBoard';

/** UI status report 2026-10-26, fix 6: small amounts rounded to 0, a red "-0.00000" next to +40%, "$0.000000" prices, rank "#0". */
describe('UI fix 6: numbers keep their digits and their sign', () => {
  it('small SOL amounts are not shown as 0.0000', () => {
    expect(fmtSol(0.0000231)).toBe('0.0000231 SOL');
    expect(fmtSol(0.0123456)).toBe('0.0123 SOL');
    expect(fmtSol(null)).toBe('—');
  });
  it('a tiny negative PnL keeps its digits; exact zero has no sign and no colour', () => {
    expect(fmtSignedSol(-0.0000023, 5)).toBe('-0.00000230');
    expect(fmtSignedSol(0, 5)).toBe('0.00000');
    expect(signTone(0)).toBe('flat');
  });
  it('a partial with +40% open and a realized loss is "mixed", not red', () => {
    const c = positionPnlCell({ status: 'PARTIALLY_CLOSED', unrealizedPnLPct: 40, realizedPnLSol: -0.0001 });
    expect(c.text).toMatch(/^\+40\.0% open/);
    expect(c.tone).toBe('mixed');
    expect(positionPnlCell({ status: 'OPEN', unrealizedPnLPct: 40 }).tone).toBe('up');
  });
  it('prices: tiny ones keep digits, zero is unknown; rank 0 is a dash', () => {
    expect(fmtUsdPrice(0.0000004567)).toBe('$0.000000457');
    expect(fmtUsdPrice(0)).toBe('—');
    expect(fmtRank(0)).toBe('—');
    expect(fmtRank(3)).toBe('#3');
  });
  it('the Holding row shows a tiny loss with its digits', () => {
    const board = { generatedAt: 0, executionMode: 'PAPER', wallet: { balanceSol: null, reserveSol: 0.015, rentLockedSol: null, spendableSol: null, solUsd: null }, launches: [], watching: [],
      holding: [{ id: 'h', mint: 'So11111111111111111111111111111111111111112', symbol: 'X', mode: 'PAPER', entryPriceSol: 1e-7, markPriceSol: 1.4e-7, markAgeMs: 1000, costSol: 0.001, pnlSol: -0.0000031, nextExit: null }] };
    const html = renderToStaticMarkup(<TokenBoardView board={board as any} tab="holding" onTab={() => {}} />);
    expect(html).toContain('-0.00000310');
    expect(html).not.toContain('>-0.00000<');
  });
});
