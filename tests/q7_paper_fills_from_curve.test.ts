import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { executionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';
import { autoSnipeController } from '../server/auto/controller';
import { createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';
import { newPumpPool, setAutoMode, resetAuto } from './fixtures/auto';

/**
 * Q7: PAPER fills used the caller's price (a WS pool's came from the create event) and invented fees (1% in, 0.5% concession and 1% out).
 * With a readable curve the fill is the curve's own: reserves, price impact, protocol and creator fee. The reference numbers below
 * are the constant-product formulas written out here, not read back from the code under test.
 */
const V_SOL = 38_000_000_000n;
const V_TOK = 800_000_000_000_000n;
const PROTO = 95;
const CREATOR = 30;

const curveFor = (mint: string) =>
  createSimulatedBondingCurveState({
    mint: new PublicKey(mint), creator: new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM'),
    virtualSolReserves: V_SOL, virtualTokenReserves: V_TOK, realTokenReserves: 520_000_000_000_000n, realSolReserves: 8_000_000_000n,
    protocolFeeBps: PROTO, creatorFeeBps: CREATOR, marketDataTimestamp: Date.now(),
  });

const refBuyTokens = (inLamports: bigint) => {
  const net = ((inLamports - 1n) * 10000n) / (10000n + BigInt(PROTO + CREATOR));
  return V_TOK - ((V_SOL * V_TOK) / (V_SOL + net) + 1n);
};
const refSellNet = (tokens: bigint) => {
  const gross = V_SOL - ((V_SOL * V_TOK) / (V_TOK + tokens) + 1n);
  const ceil = (bps: number) => (gross * BigInt(bps) + 9999n) / 10000n;
  return gross - ceil(PROTO) - ceil(CREATOR);
};

describe('Q7: PAPER fills are priced from the curve', () => {
  beforeEach(() => memecoinAggregator.setConfluenceGating(false));
  afterEach(async () => {
    memecoinAggregator.setConfluenceGating(true);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await resetAuto();
  });

  it('a buy gets the curve\'s token amount and a sell gets its net proceeds; the pool\'s stale price does not matter', async () => {
    const { mint, pool } = newPumpPool('NONE');
    pool.priceNative = 1e-9; // a create-event price far from the curve's: the old fill used this
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockImplementation(async (p: any) => curveFor(p.mint.toBase58()));

    const res = await memecoinAggregator.executeSnipe({ contractAddress: mint, amountUsd: 0, amountSolOverride: 0.0055, platform: 'PUMP_FUN', provenance: 'REAL_ONCHAIN', slippagePct: 6 });
    expect(res.success, res.message).toBe(true);
    const pos = workstationDb.loadPositions('PAPER').find((p) => p.id === res.positionId)!;
    const expectedTokens = refBuyTokens(5_500_000n);
    expect(BigInt(pos.tokenQuantityRaw)).toBe(expectedTokens);
    const spot = Number(V_SOL) / Number(V_TOK) / 1000;
    expect(pos.currentPriceSol).toBeCloseTo(spot, 12); // marked at the curve's spot, not the pool's 1e-9
    expect(pos.entryPriceSol).toBeCloseTo(0.0055 / (Number(expectedTokens) / 1e6), 12);
    expect(pos.entryPriceSol).toBeGreaterThan(spot * 1.0124); // the 1.25% in fees alone put the price paid above spot
    expect(res.gates?.pricing).toBe('CURVE_QUOTE');
    expect(res.quotePriceSol).toBeCloseTo(pos.entryPriceSol, 12);
    expect(res.fillPriceSol).toBeCloseTo(res.quotePriceSol!, 12); // a paper fill is the quote: no invented slippage breach

    const cost = pos.costBasisLamports;
    const tip = pos.jitoTipLamports;
    const closed = await executionCoordinator.closePosition(pos.id, 100, 'MANUAL');
    expect(closed.success, closed.error).toBe(true);
    const net = refSellNet(expectedTokens);
    const expectedPnl = (Number(net) - 15_000 - tip) / 1e9 - cost / 1e9;
    expect(closed.pnlSol).toBeCloseTo(expectedPnl, 6);
    // the whole round trip at an unchanged curve loses the fees, both impacts and the tips: about 3% plus the tips, never a gain
    expect(closed.pnlSol).toBeLessThan(0);
  });

  it('without a readable curve the fill is the flat model and the auto journal marks it unverified', async () => {
    await setAutoMode('PAPER');
    const { mint } = newPumpPool('HOT');
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(null as any);
    const d = await autoSnipeController.submitCandidate({ mint, symbol: 'Q7', source: 'TEST', amountUsd: 5, provenance: 'REAL_ONCHAIN' });
    expect(d.outcome, d.reason).toBe('BOUGHT');
    const row = workstationDb.loadDecisions({ mint }).find((r) => r.outcome === 'BOUGHT')!;
    expect(row.unverified).toBeTruthy();
    expect((row.inputs as any).gates.pricing).toBe('MODEL');
  });

  it('a buy larger than the curve can quote is refused, not filled by the model', async () => {
    const { mint } = newPumpPool('NONE');
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockImplementation(async (p: any) => ({ ...curveFor(p.mint.toBase58()), virtualSolReserves: 1n, virtualTokenReserves: 1n }));
    const res = await memecoinAggregator.executeSnipe({ contractAddress: mint, amountUsd: 0, amountSolOverride: 0.0055, platform: 'PUMP_FUN', provenance: 'REAL_ONCHAIN', slippagePct: 6 });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/PAPER_QUOTE_FAILED|quote/i);
  });
});
