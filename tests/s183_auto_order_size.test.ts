import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { AutoSnipeController, AUTO_DEVNET_ORDER_SOL, DEVNET_CONFIRMATION_CODE } from '../server/auto/controller';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { executionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';
import { solPriceService } from '../server/market/solPriceService';
import { executionConfig } from '../server/solana/executionConfig';
import { SNIPE_AMOUNT_MIN_SOL } from '../server/execution/snipeAmount';
import { AutoOrderSizeSchema } from '../server/execution/tradeInputs';
import { newPumpPool } from './fixtures/auto';

const cand = (mint: string) => ({ mint, symbol: 'S183', source: 'TEST' as const, amountUsd: 0.7, provenance: 'REAL_ONCHAIN' as const });

beforeEach(() => { memecoinAggregator.setConfluenceGating(false); solPriceService.setPrice(150, 'TEST_FIXTURE'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('S183 the size of one auto order is editable within the manual snipe rules', () => {
  it('defaults to 0.005 SOL and the status shows it with its bounds', () => {
    const c = new AutoSnipeController();
    const st = c.getStatus();
    expect(st.orderSol).toBe(0.005);
    expect(st.orderSol).toBe(AUTO_DEVNET_ORDER_SOL);
    expect(st.orderLimits).toEqual({ minSol: SNIPE_AMOUNT_MIN_SOL, maxSol: executionConfig.getConfig().maxPositionSizeSol });
  });

  it('accepts a size inside the bounds, and refuses (never clamps) under the minimum, over MAX_POSITION_SIZE_SOL, a non-number, or over the session spend limit', () => {
    const c = new AutoSnipeController();
    expect(c.setOrderSol(0.012)).toEqual({ ok: true });
    expect(c.getStatus().orderSol).toBe(0.012);
    const cap = executionConfig.getConfig().maxPositionSizeSol;
    const before = c.getStatus().orderSol;
    expect(c.setOrderSol(SNIPE_AMOUNT_MIN_SOL / 2).reason).toMatch(/SNIPE_AMOUNT_TOO_SMALL/);
    expect(c.setOrderSol(cap * 2).reason).toMatch(/SNIPE_AMOUNT_ABOVE_CAP.*MAX_POSITION_SIZE_SOL/);
    expect(c.setOrderSol(NaN).reason).toMatch(/SNIPE_AMOUNT_INVALID/);
    expect(c.getStatus().orderSol).toBe(before);
    // an order that does not fit the session spend limit is refused until the budget is raised
    expect(c.setBudget({ maxBuys: 5, maxSpendSol: 0.012 })).toEqual({ ok: true });
    expect(c.setOrderSol(0.015).reason).toMatch(/AUTO_ORDER_ABOVE_SESSION_LIMIT/);
    expect(c.setBudget({ maxBuys: 5, maxSpendSol: 0.02 })).toEqual({ ok: true });
    expect(c.setOrderSol(0.015)).toEqual({ ok: true });
  });

  it('the session budget can no longer be set below one order of the new size', () => {
    const c = new AutoSnipeController();
    expect(c.setOrderSol(0.015)).toEqual({ ok: true });
    expect(c.setBudget({ maxBuys: 5, maxSpendSol: 0.01 }).reason).toMatch(/at least one order \(0\.015 SOL\)/);
    expect(c.getStatus().budgetLimits?.minSpendSol).toBe(0.015);
  });

  it('DEVNET_LIVE sends the chosen size to the aggregator and counts it against the session spend', async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    vi.stubEnv('ALLOWED_CLUSTER', 'devnet');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    vi.spyOn(executionCoordinator, 'isLiveArmed').mockReturnValue(true);
    const c = new AutoSnipeController();
    expect(c.setOrderSol(0.012).ok).toBe(true);
    const mode = await c.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE });
    expect(mode.ok, mode.error).toBe(true);
    const snipe = vi.spyOn(memecoinAggregator, 'executeSnipe').mockResolvedValue({ success: false, message: 'UNCONFIRMED: did not confirm. The transaction was sent and may still land', txHash: '' });
    const left = () => c.getStatus().session!.budgetsLeft.spendSol;
    const start = left();
    await c.submitCandidate(cand(newPumpPool('HOT').mint));
    expect(snipe.mock.calls[0][0].amountSolOverride).toBe(0.012);
    // the sent-but-unconfirmed buy is counted from the chosen size, not from 0.005; 3B: at its worst case (slippage headroom and rent on top)
    expect(start - left()).toBeGreaterThan(0.012);
    expect(start - left()).toBeLessThan(0.02);
    await c.setMode('OFF');
    for (const p of workstationDb.loadPositions('LIVE', 'ACTIVE')) await executionCoordinator.closePosition(p.id, 100, 'MANUAL').catch(() => undefined);
  });

  it('PAPER uses the chosen size too once it is set, and keeps its own sizing when it is not', async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('PAPER');
    const plain = new AutoSnipeController();
    expect((await plain.setMode('PAPER')).ok).toBe(true);
    const snipe = vi.spyOn(memecoinAggregator, 'executeSnipe').mockResolvedValue({ success: true, message: 'ok', txHash: 'PAPER-1', amountSol: 0.01, positionId: 'p1', feesPaidLamports: 0 });
    await plain.submitCandidate(cand(newPumpPool('HOT').mint));
    expect(snipe.mock.calls[0][0].amountSolOverride).toBeUndefined();
    await plain.setMode('OFF');

    const sized = new AutoSnipeController();
    expect(sized.setOrderSol(0.007).ok).toBe(true);
    expect((await sized.setMode('PAPER')).ok).toBe(true);
    await sized.submitCandidate(cand(newPumpPool('HOT').mint));
    expect(snipe.mock.calls[1][0].amountSolOverride).toBe(0.007);
    await sized.setMode('OFF');
  });

  it('the route schema takes only a positive number', () => {
    expect(AutoOrderSizeSchema.safeParse({ orderSol: 0.01 }).success).toBe(true);
    expect(AutoOrderSizeSchema.safeParse({ orderSol: -1 }).success).toBe(false);
    expect(AutoOrderSizeSchema.safeParse({}).success).toBe(false);
  });
});
