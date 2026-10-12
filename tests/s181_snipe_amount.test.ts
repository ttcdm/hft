import { describe, it, expect, vi, afterEach } from 'vitest';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { executionCoordinator } from '../server/execution/coordinator';
import { pumpFunService } from '../server/pumpfunService';
import { AutoSnipeController, AUTO_DEVNET_ORDER_SOL, SESSION_BUDGETS } from '../server/auto/controller';
import { executionConfig } from '../server/solana/executionConfig';
import { checkSnipeAmountSol, getSnipeLimits, SNIPE_AMOUNT_MIN_SOL, SNIPE_AMOUNT_DEFAULT_SOL } from '../server/execution/snipeAmount';
import { OperatorSnipeSchema, CalloutSnipeSchema, SignalSnipeSchema, AutoBudgetSchema } from '../server/execution/tradeInputs';
import { newPumpPool } from './fixtures/auto';

afterEach(() => { vi.restoreAllMocks(); memecoinAggregator.setConfluenceGating(true); });

describe('S181 the server judges an operator snipe size and never clamps it', () => {
  it('checkSnipeAmountSol: valid, not a number, too small, above the position cap (each with a plain reason naming what to change)', () => {
    expect(checkSnipeAmountSol(0.01, 0.02)).toEqual({ ok: true, amountSol: 0.01 });
    expect(checkSnipeAmountSol(0.02, 0.02).ok).toBe(true); // exactly the cap is allowed
    for (const bad of [NaN, -1, 0, '0.01', null, undefined, Infinity]) expect(checkSnipeAmountSol(bad, 0.02)).toMatchObject({ ok: false, code: 'INVALID' });
    const small = checkSnipeAmountSol(SNIPE_AMOUNT_MIN_SOL / 2, 0.02);
    expect(small).toMatchObject({ ok: false, code: 'BELOW_MINIMUM' });
    expect((small as any).reason).toMatch(/fee and token account rent/);
    const big = checkSnipeAmountSol(0.5, 0.02);
    expect(big).toMatchObject({ ok: false, code: 'ABOVE_POSITION_CAP' });
    expect((big as any).reason).toMatch(/MAX_POSITION_SIZE_SOL/);
  });

  it('the default is smaller than the old $5 default and inside the configured cap', () => {
    expect(SNIPE_AMOUNT_DEFAULT_SOL).toBeLessThanOrEqual(executionConfig.getConfig().maxPositionSizeSol);
    const lim = getSnipeLimits(150);
    expect(lim).toMatchObject({ minSol: SNIPE_AMOUNT_MIN_SOL, defaultSol: SNIPE_AMOUNT_DEFAULT_SOL, solPriceUsd: 150 });
    expect(lim.maxSol).toBe(executionConfig.getConfig().maxPositionSizeSol);
    expect(getSnipeLimits(null).solPriceUsd).toBeNull();
    expect(getSnipeLimits(NaN).solPriceUsd).toBeNull();
  });

  it('the schemas carry amountSol on all three snipe routes and a bad value is a 400-class parse failure', () => {
    const mint = newPumpPool('NONE').mint;
    expect((OperatorSnipeSchema.parse({ contractAddress: mint, amountSol: 0.007 }) as any).amountSol).toBe(0.007);
    expect((CalloutSnipeSchema.parse({ calloutId: 'c1', amountSol: 0.007 }) as any).amountSol).toBe(0.007);
    expect((SignalSnipeSchema.parse({ signalId: 's1', amountSol: 0.007 }) as any).amountSol).toBe(0.007);
    expect((OperatorSnipeSchema.parse({ contractAddress: mint }) as any).amountSol).toBeUndefined();
    expect(OperatorSnipeSchema.safeParse({ contractAddress: mint, amountSol: -1 }).success).toBe(false);
    expect(AutoBudgetSchema.safeParse({ maxBuys: 2.5, maxSpendSol: 0.02 }).success).toBe(false);
  });

  it('executeSnipe sends exactly the chosen size to the coordinator; the old 10% clamp does not touch it', async () => {
    const { mint } = newPumpPool('NONE');
    memecoinAggregator.setConfluenceGating(false);
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('PAPER');
    const trade = vi.spyOn(executionCoordinator, 'executeTrade').mockResolvedValue({ success: true, positionId: 'p1', txHash: 'PAPER-1' } as any);
    const res = await memecoinAggregator.executeSnipe({ contractAddress: mint, amountUsd: 5, operatorAmountSol: 0.0173, provenance: 'REAL_ONCHAIN', signalTimestamp: Date.now() });
    expect(res.success).toBe(true);
    expect(trade).toHaveBeenCalledTimes(1);
    expect(trade.mock.calls[0][0].amountSol).toBe(0.0173);
  });

  it('a refused size never reaches the coordinator and says why', async () => {
    const { mint } = newPumpPool('NONE');
    memecoinAggregator.setConfluenceGating(false);
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('PAPER');
    const trade = vi.spyOn(executionCoordinator, 'executeTrade').mockResolvedValue({ success: true } as any);
    const big = await memecoinAggregator.executeSnipe({ contractAddress: mint, amountUsd: 5, operatorAmountSol: 5, provenance: 'REAL_ONCHAIN' });
    const small = await memecoinAggregator.executeSnipe({ contractAddress: mint, amountUsd: 5, operatorAmountSol: 0.0001, provenance: 'REAL_ONCHAIN' });
    expect(big).toMatchObject({ success: false });
    expect(big.message).toMatch(/SNIPE_AMOUNT_ABOVE_CAP/);
    expect(small.message).toMatch(/SNIPE_AMOUNT_TOO_SMALL/);
    expect(trade).not.toHaveBeenCalled();
  });

  it('a refused callout size is answered before the callout is touched, so it stays snipeable', async () => {
    const marked = vi.spyOn((pumpFunService as any).snipedMints, 'add');
    const r = await pumpFunService.snipeCallout('no-such-callout', 5, undefined, 6, 99);
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/SNIPE_AMOUNT_ABOVE_CAP/); // not "Callout not found": the size was judged first
    expect(marked).not.toHaveBeenCalled();
  });
});

describe('S181 the Auto session budget is editable within the server cap', () => {
  it('accepts a budget inside the cap, shows it in the status, and applies it to a running session', () => {
    const c = new AutoSnipeController();
    expect(c.getStatus().budgets.maxSpendSol).toBe(SESSION_BUDGETS.maxSpendSol);
    const cap = AutoSnipeController.maxSessionSpendSol();
    expect(cap).toBeCloseTo(executionConfig.getConfig().maxPositionSizeSol * 3, 9);
    expect(c.setBudget({ maxBuys: 3, maxSpendSol: 0.03 })).toEqual({ ok: true });
    expect(c.getStatus().budgets).toMatchObject({ maxBuys: 3, maxSpendSol: 0.03 });
    expect(c.getStatus().budgetLimits).toEqual({ maxSpendSol: cap, minSpendSol: AUTO_DEVNET_ORDER_SOL, maxBuys: 50, capKind: 'REAL', capNote: '3 x MAX_POSITION_SIZE_SOL' });
    // the loss and time limits are not editable
    expect(c.getStatus().budgets.maxLossFraction).toBe(SESSION_BUDGETS.maxLossFraction);
  });

  it('refuses, with the reason and without changing anything, a spend above the cap, below one order, or a bad buy count', () => {
    const c = new AutoSnipeController();
    const cap = AutoSnipeController.maxSessionSpendSol();
    const over = c.setBudget({ maxBuys: 5, maxSpendSol: cap * 2 });
    expect(over.ok).toBe(false);
    expect(over.reason).toMatch(/session cap.*MAX_POSITION_SIZE_SOL/);
    expect(c.setBudget({ maxBuys: 5, maxSpendSol: AUTO_DEVNET_ORDER_SOL / 2 }).reason).toMatch(/at least one order/);
    expect(c.setBudget({ maxBuys: 0, maxSpendSol: 0.02 }).ok).toBe(false);
    expect(c.setBudget({ maxBuys: 51, maxSpendSol: 0.02 }).ok).toBe(false);
    expect(c.setBudget({ maxBuys: 2.5, maxSpendSol: 0.02 }).ok).toBe(false);
    expect(c.getStatus().budgets).toMatchObject({ maxBuys: SESSION_BUDGETS.maxBuys, maxSpendSol: SESSION_BUDGETS.maxSpendSol });
  });
});
