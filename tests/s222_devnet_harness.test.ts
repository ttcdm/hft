import { describe, it, expect } from 'vitest';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { planFunding } from '../scripts/devnet_funding';
import { createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';

describe('S222: the devnet harness fails clearly instead of crashing', () => {
  it('an unfunded wallet says so, with the address and what to do', () => {
    const p = planFunding(0, 'ADDR123');
    expect(p).toMatchObject({ funded: false, unfunded: true, buySol: 0 });
    expect(p.message).toMatch(/wallet unfunded/);
    expect(p.message).toMatch(/ADDR123/);
    expect(planFunding(Number.NaN, 'A').unfunded).toBe(true);
  });

  it('a funded wallet gets a buy of about 8% of the balance, at most 0.01 SOL', () => {
    expect(planFunding(0.2, 'A')).toMatchObject({ funded: true, unfunded: false, buySol: 0.01 });
    expect(planFunding(0.05, 'A')).toMatchObject({ funded: true, buySol: 0.004 });
    expect(planFunding(0.02, 'A')).toMatchObject({ funded: false, unfunded: false });
  });

  it('calculateBuyQuote given the wrong field name throws a clear error, not "NaN cannot be converted to a BigInt"', () => {
    const state = createSimulatedBondingCurveState();
    // the harness once passed solAmountSol; the field is amountSol
    expect(() => PumpCurveService.calculateBuyQuote({ state, solAmountSol: 0.01, slippageBps: 800, executionMode: 'PAPER' } as any)).toThrow(/amountSol/);
    expect(() => PumpCurveService.calculateBuyQuote({ state, amountSol: Number.NaN, slippageBps: 800, executionMode: 'PAPER' } as any)).toThrow(/Order size/);
    expect(() => PumpCurveService.calculateBuyQuote({ state, amountSol: 0, slippageBps: 800, executionMode: 'PAPER' } as any)).toThrow(/Order size/);
  });
});
