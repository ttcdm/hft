import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { fetchTokenHolderDistribution, PumpCurveService } from '../server/solana/pumpCurve';
import { EligibilityFilter } from '../server/signals/eligibilityFilter';
import { MAX_TOP10_HOLDERS_PCT } from '../server/solana/executionConfig';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

const SUPPLY = 1_000_000_000n;
const mint = Keypair.generate().publicKey;
const creator = Keypair.generate().publicKey;
const [curve] = PumpCurveService.getBondingCurveAddress(mint);
const curveAta = PumpCurveService.getAssociatedTokenAddress(mint, curve, TOKEN_PROGRAM_ID);
const creatorAta = PumpCurveService.getAssociatedTokenAddress(mint, creator, TOKEN_PROGRAM_ID);

// Hand-built getTokenLargestAccounts fixtures. Amounts are in % of total supply.
function conn(rows: Array<[PublicKey, number]>) {
  return {
    getTokenLargestAccounts: async () => ({
      value: rows.map(([address, pct]) => ({ address, amount: String((SUPPLY * BigInt(Math.round(pct * 100))) / 10000n) })),
    }),
    getTokenSupply: async () => ({ value: { amount: SUPPLY.toString() } }),
  } as any;
}
const holders = (n: number, pct: number): Array<[PublicKey, number]> =>
  Array.from({ length: n }, () => [Keypair.generate().publicKey, pct]);

async function gate(rows: Array<[PublicKey, number]>) {
  const d = await fetchTokenHolderDistribution(conn(rows), mint, creator, curve);
  const report = EligibilityFilter.evaluate(
    { mint: mint.toBase58(), symbol: 'T', name: 'T', top10HoldersPct: d.top10HoldersPct, devHoldingPct: d.devHoldingPct } as any,
    'PAPER'
  );
  const rule = report.checks.find((c) => c.ruleId === 'TOP_10_CONCENTRATION')!;
  return { d, rule };
}

describe('C1: holder concentration is a share of TOTAL supply', () => {
  it('healthy: curve holds most supply, top 10 hold 12% of total -> passes', async () => {
    const { d, rule } = await gate([[curveAta, 70], ...holders(10, 1.2)]);
    expect(d.top10HoldersPct).toBe(12);
    expect(rule.passed).toBe(true);
  });

  it('old denominator would have flagged this: 12% of total is 40% of the non-curve remainder', async () => {
    const { d } = await gate([[curveAta, 70], ...holders(10, 1.2)]);
    expect(d.top10HoldersPct).not.toBeCloseTo(40, 0);
  });

  it('concentrated: top 10 hold 55% of total -> rejected by the real EligibilityFilter', async () => {
    const { d, rule } = await gate([[curveAta, 30], ...holders(10, 5.5)]);
    expect(d.top10HoldersPct).toBe(55);
    expect(d.top10HoldersPct).toBeGreaterThan(MAX_TOP10_HOLDERS_PCT);
    expect(rule.passed).toBe(false);
    expect(rule.status).toBe('FAIL');
  });

  it('creator is excluded from top 10 and scored separately as devHoldingPct', async () => {
    const { d, rule } = await gate([[curveAta, 50], [creatorAta, 20], ...holders(10, 1)]);
    expect(d.devHoldingPct).toBe(20);
    expect(d.top10HoldersPct).toBe(10);
    expect(rule.passed).toBe(true);
  });

  it('bonding curve account is never counted as a holder', async () => {
    const { d } = await gate([[curveAta, 90], ...holders(3, 1)]);
    expect(d.top10HoldersPct).toBe(3);
    expect(d.topHolders.every((h) => h.address !== curveAta.toBase58())).toBe(true);
  });
});
