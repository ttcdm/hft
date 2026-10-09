import { describe, it, expect } from 'vitest';
import { PaperExecutionEngine } from '../server/execution/paperEngine';

describe('K5 #10: paper buy accounting', () => {
  it('charges the 1% protocol fee, puts fee and tip in the cost basis, and reports no invented latency', () => {
    const r = new PaperExecutionEngine().executePaperBuy({
      mint: 'K5PaperMint1111111111111111111111111111111',
      symbol: 'K5',
      name: 'K5',
      amountSol: 0.01,
      currentPriceSol: 0.00000003,
      slippageBps: 500,
      jitoTipSol: 0.0001,
      liquidityUsd: 1_000_000,
      solPriceUsd: 150,
    });
    expect(r.success).toBe(true);
    const gross = 0.01 / r.fillPriceSol;
    expect(r.tokensReceived).toBeCloseTo(gross * 0.99, 6);
    expect(r.position!.costBasisLamports).toBe(10_000_000 + 5000 + 100_000);
    expect(r.simulatedLatencyMs).toBe(0);
  });
});
