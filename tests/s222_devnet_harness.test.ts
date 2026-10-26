import { describe, it, expect } from 'vitest';
import { PumpCurveService } from '../server/solana/pumpCurve';
import fs from 'fs';
import { planFunding, liveBuyRequest } from '../scripts/devnet_funding';
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

  it('S223: the LIVE buy request carries a signal time the coordinator accepts, and both harness calls build it with liveBuyRequest', () => {
    const now = 1_700_000_000_000;
    const r = liveBuyRequest('MINT', 0.01, now);
    // the coordinator refuses LIVE with no signal time, or one in the future (MISSING_SIGNAL_TIMESTAMP)
    expect(Number.isFinite(r.signalTimestamp) && (r.signalTimestamp as number) > 0 && (r.signalTimestamp as number) <= now + 5_000).toBe(true);
    expect(r).toMatchObject({ mint: 'MINT', amountSol: 0.01, source: 'MANUAL', provenance: 'MANUAL_OPERATOR', executionMode: 'LIVE' });
    const t0 = Date.now();
    expect(liveBuyRequest('M', 0.01).signalTimestamp as number).toBeGreaterThanOrEqual(t0);
    const src = fs.readFileSync('scripts/devnet_e2e.ts', 'utf8');
    expect(src.match(/executeTrade\(await buildBuyRequest\(\)\)/g)?.length).toBe(2);
    expect(src).toMatch(/return liveBuyRequest\(/);
    expect(src).not.toMatch(/executeTrade\(\{/);
  });
});
