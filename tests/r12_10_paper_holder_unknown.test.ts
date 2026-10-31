import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { EligibilityFilter } from '../server/signals/eligibilityFilter';
import * as pumpCurve from '../server/solana/pumpCurve';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { executionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';
import { curveFixture, STANDARD_CURVE } from './fixtures/curve';

/**
 * R12-10 (haiku round 12): off LIVE an UNKNOWN top-10 passed, so when the PAPER route's holder read failed or hit its 4 s cap, PAPER filled
 * tokens LIVE refuses (FIXC at 52.4% top-10). Holder facts that were asked of the chain and not read now fail the holder rules in PAPER too.
 * A PAPER buy whose curve could not be read at all is still filled on the flat model and recorded unverified (labelled, not refused).
 * Real EligibilityFilter and ExecutionCoordinator; the curve and holder reads (RPC readers) are stubbed.
 */
const token = (over: Record<string, unknown> = {}) => ({ mint: Keypair.generate().publicKey.toBase58(), symbol: 'T', name: 'T', liquidityUsd: 50_000, isMintAuthorityRevoked: true, isFreezeAuthorityRevoked: true, ...over });
const rule = (r: ReturnType<typeof EligibilityFilter.evaluate>, id: string) => r.checks.find((c) => c.ruleId === id)!;

const vSol = 40_000_000_000n;
const vTok = (STANDARD_CURVE.initialVirtualSol * STANDARD_CURVE.initialVirtualTokens) / vSol;
const curveOf = (mint: any) => curveFixture({
  mint, virtualSolReserves: vSol, virtualTokenReserves: vTok, realSolReserves: vSol - STANDARD_CURVE.initialVirtualSol,
  realTokenReserves: vTok - (STANDARD_CURVE.initialVirtualTokens - STANDARD_CURVE.initialRealTokens), marketDataTimestamp: Date.now(),
});
const buy = (mint: string) => executionCoordinator.executeTrade({
  mint, symbol: 'R1210', name: 'R12-10', amountSol: 0.005, jitoTipSol: 0.0001, liquidityUsd: 15_000,
  source: 'AUTO_SNIPER', provenance: 'REAL_ONCHAIN', currentPriceSol: 0.0001,
} as any);

describe('R12-10: PAPER refuses holder facts it asked for and could not read, as LIVE does', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const p of workstationDb.loadPositions('PAPER', 'ACTIVE')) await executionCoordinator.closePosition(p.id, 100, 'MANUAL');
  });

  it('EligibilityFilter: asked-for and unread holder facts fail TOP_10_CONCENTRATION and MAX_CREATOR_EXPOSURE in PAPER', () => {
    const r = EligibilityFilter.evaluate(token({ devHoldingPct: null, top10HoldersPct: null, holderFactsAsked: true }), 'PAPER');
    expect(rule(r, 'TOP_10_CONCENTRATION')).toMatchObject({ status: 'UNKNOWN', passed: false });
    expect(rule(r, 'MAX_CREATOR_EXPOSURE')).toMatchObject({ status: 'UNKNOWN', passed: false });
    expect(r.isEligible).toBe(false);
    // never asked (no curve was read): unverified, as before; LIVE refuses either way
    expect(EligibilityFilter.evaluate(token({ devHoldingPct: null, top10HoldersPct: null }), 'PAPER').isEligible).toBe(true);
    expect(EligibilityFilter.evaluate(token({ devHoldingPct: null, top10HoldersPct: null }), 'LIVE').isEligible).toBe(false);
  });

  it('a PAPER buy whose curve is read but whose holder read fails is refused (was filled, marked unverified)', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockImplementation(async (p: any) => curveOf(p.mint));
    vi.spyOn(pumpCurve, 'fetchTokenHolderDistribution').mockRejectedValue(new Error('429 Too Many Requests'));
    const r = await buy(mint);
    expect(r.success).toBe(false);
    expect(r.lifecycleState).toBe('FILTER_REJECTED');
    expect(r.error).toMatch(/Top 10 holder distribution could not be read/);
  });

  it('the same buy with the holders read and under the caps fills', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockImplementation(async (p: any) => curveOf(p.mint));
    vi.spyOn(pumpCurve, 'fetchTokenHolderDistribution').mockImplementation(async (_c, m) => ({
      mint: m.toBase58(), totalCirculatingSupply: 0n, nonBondingCirculatingSupply: 0n, bondingCurveBalance: 0n, creatorBalance: 0n,
      creatorClusterBalance: 0n, unknownHolderBalance: 0n, unseenBalance: 0n, top10HoldersPct: 10, devHoldingPct: 1, topHolders: [],
    }));
    const r = await buy(mint);
    expect(r.success, r.error).toBe(true);
  });
});
