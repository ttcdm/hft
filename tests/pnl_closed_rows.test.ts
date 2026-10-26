import { describe, it, expect } from 'vitest';
import { positionPnlCell } from '../src/utils/positionPnl';

/** The positions table showed +0.0% for CLOSED rows (seen on devnet: realized -0.000118738 SOL showed as +0.0%). */
describe('Plug & Play PnL column', () => {
  it('a CLOSED row shows realized PnL in SOL, not +0.0%', () => {
    const c = positionPnlCell({ status: 'CLOSED', unrealizedPnLPct: 0, realizedPnLSol: -0.000118738 });
    expect(c.text).toBe('-0.000119 SOL realized');
    expect(c.positive).toBe(false);
  });

  it('a profitable CLOSED row is positive', () => {
    expect(positionPnlCell({ status: 'CLOSED', realizedPnLSol: 0.021010009 })).toEqual({ text: '+0.021010 SOL realized', positive: true });
  });

  it('a PARTIALLY_CLOSED row shows the open % and the realized SOL', () => {
    const c = positionPnlCell({ status: 'PARTIALLY_CLOSED', unrealizedPnLPct: -23.4, realizedPnLSol: -0.00158688 });
    expect(c.text).toBe('-23.4% open · -0.001587 SOL realized');
    expect(c.positive).toBe(false);
  });

  it('an OPEN row keeps the unrealized %', () => {
    expect(positionPnlCell({ status: 'OPEN', unrealizedPnLPct: 12.345 })).toEqual({ text: '+12.3%', positive: true });
  });
});
