import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SnipeAmountView } from '../src/components/SnipeAmountControl';
import { AutoPanelView, AutoBudgetEditor, budgetProblem, type AutoStatusData } from '../src/components/AutoPanel';
import {
  parseSnipeAmount, formatSol, formatUsdEquivalent, usdEquivalent, readSavedAmount, SNIPE_AMOUNT_STORAGE_KEY, FALLBACK_LIMITS, type SnipeLimits,
} from '../src/utils/snipeAmount';
import { calloutSnipeLabel } from '../src/utils/tokenLinks';

const limits: SnipeLimits = { minSol: 0.001, maxSol: 0.02, defaultSol: 0.01, solPriceUsd: 150 };
const view = (text: string, l: SnipeLimits = limits) =>
  renderToStaticMarkup(React.createElement(SnipeAmountView, { state: { text, setText: () => {}, limits: l, parsed: parseSnipeAmount(text, l) } }));

describe('S181 the snipe amount field', () => {
  it('shows the SOL amount with its dollar equivalent at the server price', () => {
    const html = view('0.01');
    expect(html).toContain('value="0.01"');
    expect(html).toContain('≈ $1.50');
    expect(html).toContain('min 0.001 / max 0.02 SOL');
    expect(html).not.toContain('snipe-amount-error');
  });

  it('with no SOL price it says the dollar value is unknown instead of guessing', () => {
    expect(view('0.01', { ...limits, solPriceUsd: null })).toContain('USD unknown (no SOL price)');
    expect(usdEquivalent(0.01, null)).toBeNull();
    expect(formatUsdEquivalent(0.005, 100)).toBe('≈ $0.500');
  });

  it('an amount the server would refuse is shown in red with the reason, and never changed to something else', () => {
    const big = view('0.5');
    expect(big).toContain('data-testid="snipe-amount-error"');
    expect(big).toMatch(/above the 0\.02 SOL maximum position size/);
    expect(big).toContain('value="0.5"'); // not clamped
    expect(view('0.0001')).toMatch(/below the 0\.001 SOL minimum/);
    expect(view('')).toContain('Enter an amount in SOL above 0.');
    expect(view('abc')).toContain('data-testid="snipe-amount-error"');
  });

  it('parseSnipeAmount agrees with the server rules (same bounds, exact cap allowed)', () => {
    expect(parseSnipeAmount('0.02', limits)).toEqual({ ok: true, sol: 0.02 });
    expect(parseSnipeAmount('0.001', limits)).toEqual({ ok: true, sol: 0.001 });
    expect(parseSnipeAmount('0.0209', limits).ok).toBe(false);
    expect(parseSnipeAmount('-0.01', limits).ok).toBe(false);
    expect(FALLBACK_LIMITS.defaultSol).toBeLessThanOrEqual(FALLBACK_LIMITS.maxSol);
  });

  it('the button label names the chosen amount, not a hardcoded dollar figure', () => {
    expect(calloutSnipeLabel(formatSol(0.0173))).toBe('SNIPE (0.0173 SOL)');
    expect(formatSol(0.010000001)).toBe('0.01 SOL');
  });

  it('the saved amount is read per browser and a broken or empty store falls back to the default', () => {
    expect(readSavedAmount({ getItem: (k: string) => (k === SNIPE_AMOUNT_STORAGE_KEY ? '0.004' : null) }, 0.01)).toBe('0.004');
    expect(readSavedAmount({ getItem: () => null }, 0.01)).toBe('0.01');
    expect(readSavedAmount({ getItem: () => { throw new Error('blocked'); } }, 0.01)).toBe('0.01');
    expect(readSavedAmount(null, 0.01)).toBe('0.01');
  });
});

describe('S181 Auto session budget editor', () => {
  const base: AutoStatusData = {
    mode: 'OFF', killed: false, killReason: null, downgradeReason: null, haltReason: null, triggers: [], slippageBreaches: 0, session: null,
    budgets: { maxBuys: 5, maxSpendSol: 0.02, maxLossFraction: 0.15, maxDurationMs: 4 * 3600_000 },
    budgetLimits: { maxSpendSol: 0.06, minSpendSol: 0.005, maxBuys: 50 },
    stats: { seen: 0, rejectedByStage: {}, wouldBuy: 0, bought: 0, open: 0, closed: 0, netPnlSol: 0, feesPaidSol: 0, winRate: null },
  };
  it('the Auto panel shows the current budget in editable fields with the server cap', () => {
    const html = renderToStaticMarkup(React.createElement(AutoPanelView, { status: base }));
    expect(html).toContain('data-testid="auto-budget-editor"');
    expect(html).toMatch(/data-testid="budget-buys"[^>]*value="5"/);
    expect(html).toMatch(/data-testid="budget-spend"[^>]*value="0.02"/);
    expect(html).toContain('Up to 0.06 SOL');
    expect(html).not.toContain('budget-problem');
  });
  it('a budget above the cap or below one order shows the reason and cannot be saved', () => {
    // the rules, for a value the operator typed (S188: the server's own unedited value is a note, not an error; see s188 tests)
    expect(budgetProblem(5, 0.5, base.budgetLimits)).toContain('above the server cap of 0.06 SOL');
    expect(budgetProblem(5, 0.001, base.budgetLimits)).toContain('at least one order (0.005 SOL)');
    expect(budgetProblem(0, 0.02, base.budgetLimits)).toContain('whole number from 1 to 50');
    expect(budgetProblem(5, 0.02, base.budgetLimits)).toBeNull();
    // and an unedited server value that breaks them still cannot be "saved" back
    const over = renderToStaticMarkup(React.createElement(AutoBudgetEditor, { budgets: { ...base.budgets, maxSpendSol: 0.5 }, limits: base.budgetLimits }));
    expect(over).toMatch(/data-testid="budget-save"[^>]*disabled/);
  });
});
