import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { installDom, removeDom, typeInto } from './helpers/domApp';
import { AutoBudgetEditor, AutoOrderSizeEditor, ConfluenceThresholdEditor } from '../src/components/AutoPanel';
import { ReplayThresholdBox } from '../src/components/BacktestModal';
import { SnipeAmountView } from '../src/components/SnipeAmountControl';
import { DecimalBox } from '../src/components/DecimalBox';
import { parseSnipeAmount, FALLBACK_LIMITS } from '../src/utils/snipeAmount';
import { parseThreshold } from '../src/utils/confluenceThreshold';
import { parseDecimalText } from '../src/utils/numberInput';

/**
 * R10-10 / R9-20: a browser number box drops the comma in "2,5", so the budget saved 25 buys with a 200 and no word. "0,005" became "0005"
 * and was blamed on the 0.02 SOL maximum. Every number box is now a text box that refuses a comma decimal and says why.
 */
const COMMA = /dot for decimals/;

describe('R10-10: the parsers refuse a comma decimal with its reason', () => {
  it('parseDecimalText', () => {
    expect(parseDecimalText('2,5')).toEqual({ ok: false, reason: expect.stringMatching(COMMA) });
    expect(parseDecimalText('2.5')).toEqual({ ok: true, value: 2.5 });
    expect(parseDecimalText('25')).toEqual({ ok: true, value: 25 });
    expect(parseDecimalText('2.5', { integer: true }).ok).toBe(false);
    expect(parseDecimalText('1e3').ok).toBe(false);
    expect(parseDecimalText('9'.repeat(500)).ok).toBe(false);
    expect(parseDecimalText('').ok).toBe(false);
  });
  it('snipe amount and threshold', () => {
    const a = parseSnipeAmount('0,005', FALLBACK_LIMITS);
    expect(a.ok).toBe(false);
    if (!a.ok) { expect(a.reason).toMatch(COMMA); expect(a.reason).not.toMatch(/maximum/); }
    const t = parseThreshold('7,0');
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.reason).toMatch(COMMA);
  });
});

describe('R10-10: the boxes are text boxes and show the comma reason', () => {
  let root: Root; let el: HTMLElement;
  beforeEach(() => { installDom(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el); });
  afterEach(async () => { await act(async () => root.unmount()); await removeDom(); });

  it('session budget: "2,5" buys is refused, Save stays disabled', async () => {
    const saves: unknown[] = [];
    await act(async () => { root.render(<AutoBudgetEditor budgets={{ maxBuys: 5, maxSpendSol: 0.02, maxLossFraction: 0.15, maxDurationMs: 1 }} limits={{ maxBuys: 50, minSpendSol: 0.001, maxSpendSol: 0.06 }} onSave={(...a) => saves.push(a)} />); });
    const buys = el.querySelector('[data-testid="budget-buys"]') as HTMLInputElement;
    expect(buys.type).toBe('text');
    await typeInto(buys, '2,5');
    expect(el.querySelector('[data-testid="budget-problem"]')?.textContent).toMatch(COMMA);
    expect((el.querySelector('[data-testid="budget-save"]') as HTMLButtonElement).disabled).toBe(true);
    const spend = el.querySelector('[data-testid="budget-spend"]') as HTMLInputElement;
    expect(spend.type).toBe('text');
    await typeInto(buys, '5'); await typeInto(spend, '0,03');
    expect(el.querySelector('[data-testid="budget-problem"]')?.textContent).toMatch(COMMA);
  });

  it('order size, confluence, replay threshold and snipe amount', async () => {
    await act(async () => { root.render(<div>
      <AutoOrderSizeEditor orderSol={0.01} limits={{ minSol: 0.001, maxSol: 0.02 }} />
      <ConfluenceThresholdEditor confluence={{ value: 70, defaultValue: 70, source: 'default' } as any} />
      <ReplayThresholdBox value="7,0" onChange={() => {}} />
      <SnipeAmountView state={{ text: '0,005', setText: () => {}, limits: FALLBACK_LIMITS, parsed: parseSnipeAmount('0,005', FALLBACK_LIMITS) }} />
    </div>); });
    for (const id of ['order-sol', 'confluence-box', 'replay-threshold-box', 'snipe-amount-input']) expect((el.querySelector(`[data-testid="${id}"]`) as HTMLInputElement).type).toBe('text');
    await typeInto(el.querySelector('[data-testid="order-sol"]'), '0,005');
    expect(el.querySelector('[data-testid="order-problem"]')?.textContent).toMatch(COMMA);
    expect((el.querySelector('[data-testid="order-save"]') as HTMLButtonElement).disabled).toBe(true);
    await typeInto(el.querySelector('[data-testid="confluence-box"]'), '6,5');
    expect(el.querySelector('[data-testid="confluence-problem"]')?.textContent).toMatch(COMMA);
    expect(el.querySelector('[data-testid="replay-threshold-problem"]')?.textContent).toMatch(COMMA);
    expect(el.querySelector('[data-testid="snipe-amount-error"]')?.textContent).toMatch(COMMA);
  });

  it('DecimalBox (strategy rules, Jito tip): a comma is refused and the last good value is kept', async () => {
    const seen: number[] = [];
    await act(async () => { root.render(<DecimalBox testId="tip" ariaLabel="Jito tip (SOL)" value={0.005} onValue={(n) => seen.push(n)} />); });
    const box = el.querySelector('[data-testid="tip"]') as HTMLInputElement;
    expect(box.type).toBe('text');
    expect(box.getAttribute('aria-label')).toBe('Jito tip (SOL)');
    await typeInto(box, '0,002');
    expect(seen).toEqual([]);
    expect(el.querySelector('[data-testid="tip-problem"]')?.textContent).toMatch(COMMA);
    expect(el.querySelector('[data-testid="tip-problem"]')?.textContent).toMatch(/0\.005/);
    await typeInto(box, '0.002');
    expect(seen).toEqual([0.002]);
    expect(el.querySelector('[data-testid="tip-problem"]')).toBeNull();
  });
});
