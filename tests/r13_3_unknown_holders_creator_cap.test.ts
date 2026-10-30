import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { fetchTokenHolderDistribution } from '../server/solana/pumpCurve';
import { EligibilityFilter } from '../server/signals/eligibilityFilter';
import { WatchWindow } from '../server/signals/watchWindow';

/**
 * R13-3 (haiku round 13): holders whose funder was never looked up are UNKNOWN, and UNKNOWN balance went only into one top-10 entry, not
 * into the creator's share. Funder lookups are only made for wallets that traded in the window, so a creator who transfers 4 x 4.5% to
 * wallets that never trade read 0% creator and 18% top-10, and both LIVE gates passed. UNKNOWN holdings now count against the creator cap
 * too (fail closed; Mike's round 14 fix order: "add unknown holders to it"). Real fetchTokenHolderDistribution and EligibilityFilter.
 */
const SUPPLY = 1_000_000_000_000_000n;
const pk = () => Keypair.generate().publicKey;
const ownerData = (owner: PublicKey) => { const d = Buffer.alloc(165); d.set(pk().toBuffer(), 0); d.set(owner.toBuffer(), 32); return d; };

function conn(holders: Array<{ owner: PublicKey; pct: number }>) {
  const accounts = holders.map((h) => ({ address: pk(), owner: h.owner, amount: (SUPPLY * BigInt(Math.round(h.pct * 100))) / 10_000n }));
  return {
    getTokenLargestAccounts: async () => ({ value: accounts.map((a) => ({ address: a.address, amount: a.amount.toString() })) }),
    getTokenSupply: async () => ({ value: { amount: SUPPLY.toString() } }),
    getTokenAccountBalance: async () => ({ value: { amount: '0' } }),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => { const a = accounts.find((x) => x.address.equals(k)); return a ? { data: ownerData(a.owner) } : null; }),
  } as any;
}
const live = (d: { devHoldingPct: number; top10HoldersPct: number }) => {
  const r = EligibilityFilter.evaluate({ mint: pk().toBase58(), symbol: 'R', name: 'R', devHoldingPct: d.devHoldingPct, top10HoldersPct: d.top10HoldersPct }, 'LIVE');
  return r.checks.find((c) => c.ruleId === 'MAX_CREATOR_EXPOSURE')!.status;
};

describe('R13-3: unknown holders count against the creator cap', () => {
  it('4 x 4.5% in wallets that never traded (never looked up): 18% counts as the creator\'s, and LIVE refuses on creator exposure', async () => {
    const quiet = Array.from({ length: 4 }, pk);
    const d = await fetchTokenHolderDistribution(conn(quiet.map((owner) => ({ owner, pct: 4.5 }))), pk(), pk(), undefined, new WatchWindow({ publicFunders: [] }));
    expect(d.unknownHolderBalance).toBe((SUPPLY * 450n) / 10_000n * 4n);
    expect(d.top10HoldersPct).toBeCloseTo(18, 6);
    expect(d.devHoldingPct).toBeCloseTo(18, 6); // was 0
    expect(live(d)).toBe('FAIL');
  });

  it('the same holders, looked up and independent, are not the creator\'s: 0%, and the creator gate passes', async () => {
    const ww = new WatchWindow({ publicFunders: [] });
    const quiet = Array.from({ length: 4 }, pk);
    quiet.forEach((o, i) => { ww.setFunder(o.toBase58(), `funder-${i}`); ww.setNoFunder(`funder-${i}`); });
    const d = await fetchTokenHolderDistribution(conn(quiet.map((owner) => ({ owner, pct: 4.5 }))), pk(), pk(), undefined, ww);
    expect(d.devHoldingPct).toBe(0);
    expect(live(d)).toBe('PASS');
  });
});
