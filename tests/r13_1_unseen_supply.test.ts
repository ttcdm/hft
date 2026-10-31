import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { fetchTokenHolderDistribution, PumpCurveService } from '../server/solana/pumpCurve';
import { EligibilityFilter } from '../server/signals/eligibilityFilter';
import { WatchWindow } from '../server/signals/watchWindow';

/**
 * R13-1 (haiku round 13, HIGH): getTokenLargestAccounts returns at most 20 accounts, and the creator-holding gate only summed accounts in
 * that list. A creator who spreads 20% over 100 wallets of 0.2%, under twenty real holders of 1% or more, read 0.00% and passed
 * MAX_CREATOR_EXPOSURE in LIVE; top-10 passed too. The supply the list does not show now counts as unknown, against the creator cap and in
 * the unknown top-10 entry. Real fetchTokenHolderDistribution and EligibilityFilter; the RPC fake returns the 20 largest, as the RPC does.
 */
const SUPPLY = 1_000_000_000_000_000n;
const pk = () => Keypair.generate().publicKey;
const amt = (pct: number) => (SUPPLY * BigInt(Math.round(pct * 1000))) / 100_000n;
const ownerData = (owner: PublicKey) => { const d = Buffer.alloc(165); d.set(pk().toBuffer(), 0); d.set(owner.toBuffer(), 32); return d; };

function chain(mint: PublicKey, holders: Array<{ owner: PublicKey; pct: number; address?: PublicKey }>, opts: { supplyFails?: boolean } = {}) {
  const accounts = holders.map((h) => ({ address: h.address ?? pk(), owner: h.owner, amount: amt(h.pct) })).sort((a, b) => (a.amount < b.amount ? 1 : -1));
  return {
    getTokenLargestAccounts: async () => ({ value: accounts.slice(0, 20).map((a) => ({ address: a.address, amount: a.amount.toString() })) }),
    getTokenSupply: async () => { if (opts.supplyFails) throw new Error('429 Too Many Requests'); return { value: { amount: SUPPLY.toString() } }; },
    getTokenAccountBalance: async (k: PublicKey) => { const a = accounts.find((x) => x.address.equals(k)); return { value: { amount: (a?.amount ?? 0n).toString() } }; },
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => { const a = accounts.find((x) => x.address.equals(k)); return a ? { data: ownerData(a.owner) } : null; }),
  } as any;
}

function setup(creatorSplit: number) {
  const mint = pk(), creator = pk();
  const [curve] = PumpCurveService.getBondingCurveAddress(mint);
  const curveAta = PumpCurveService.getAssociatedTokenAddress(mint, curve, TOKEN_PROGRAM_ID);
  const ww = new WatchWindow({ publicFunders: [] });
  const real = Array.from({ length: 25 }, pk); // 25 real, looked-up, independent holders of 1.2%
  real.forEach((o, i) => { ww.setFunder(o.toBase58(), `funder-${i}`); ww.setNoFunder(`funder-${i}`); });
  const sybils = Array.from({ length: creatorSplit }, pk); // the creator's split, 0.2% each, never traded (never looked up)
  const curvePct = 100 - 25 * 1.2 - creatorSplit * 0.2;
  const holders = [{ owner: curve, pct: curvePct, address: curveAta }, ...real.map((owner) => ({ owner, pct: 1.2 })), ...sybils.map((owner) => ({ owner, pct: 0.2 }))];
  return { mint, creator, curve, ww, holders };
}
const live = (d: { devHoldingPct: number; top10HoldersPct: number }) => {
  const r = EligibilityFilter.evaluate({ mint: pk().toBase58(), symbol: 'R', name: 'R', devHoldingPct: d.devHoldingPct, top10HoldersPct: d.top10HoldersPct }, 'LIVE');
  const st = (id: string) => r.checks.find((c) => c.ruleId === id)!.status;
  return { creator: st('MAX_CREATOR_EXPOSURE'), top10: st('TOP_10_CONCENTRATION') };
};

describe('R13-1: the supply outside the 20 largest accounts counts against the creator cap', () => {
  it('a creator split of 100 x 0.2% below twenty real 1.2% holders: 20% + the 6 unseen real holders are unseen, and LIVE refuses', async () => {
    const s = setup(100);
    const d = await fetchTokenHolderDistribution(chain(s.mint, s.holders), s.mint, s.creator, s.curve, s.ww);
    expect(d.unseenBalance).toBe(amt(0.2) * 100n + amt(1.2) * 6n); // the list shows the curve and 19 real holders
    expect(d.devHoldingPct).toBeCloseTo(20 + 7.2, 6); // was 0.00
    expect(live(d).creator).toBe('FAIL');
  });

  it('without the split the same real holders still leave 6 x 1.2% unseen: counted (fail closed), so even an honest busy launch needs its unseen tail under the cap', async () => {
    const s = setup(0);
    const d = await fetchTokenHolderDistribution(chain(s.mint, s.holders), s.mint, s.creator, s.curve, s.ww);
    expect(d.unseenBalance).toBe(amt(1.2) * 6n);
    expect(d.devHoldingPct).toBeCloseTo(7.2, 6);
    expect(live(d).creator).toBe('FAIL');
  });

  it('every account visible (fewer than 20) and independent: nothing unseen, and both gates pass', async () => {
    const s = setup(0);
    const few = s.holders.slice(0, 12); // the curve and 11 real holders; the curve holds what the other 14 held
    few[0] = { ...few[0], pct: few[0].pct + 14 * 1.2 };
    const d = await fetchTokenHolderDistribution(chain(s.mint, few), s.mint, s.creator, s.curve, s.ww);
    expect(d.unseenBalance).toBe(0n);
    expect(d.devHoldingPct).toBe(0);
    expect(live(d)).toEqual({ creator: 'PASS', top10: 'PASS' });
  });

  it('the creator ATA read on its own is not counted twice as unseen', async () => {
    const s = setup(0);
    const creatorAta = PumpCurveService.getAssociatedTokenAddress(s.mint, s.creator, TOKEN_PROGRAM_ID);
    const holders = [...s.holders.slice(0, 20), { owner: s.creator, pct: 0.5, address: creatorAta }];
    holders[0] = { ...holders[0], pct: holders[0].pct + 6 * 1.2 - 0.5 };
    const d = await fetchTokenHolderDistribution(chain(s.mint, holders), s.mint, s.creator, s.curve, s.ww);
    expect(d.creatorBalance).toBe(amt(0.5));
    expect(d.unseenBalance).toBe(0n);
    expect(d.devHoldingPct).toBeCloseTo(0.5, 6);
  });

  it('an unreadable supply makes the holder facts unreadable (the caller\'s UNKNOWN, refused in LIVE), not a sum of the visible accounts', async () => {
    const s = setup(100);
    await expect(fetchTokenHolderDistribution(chain(s.mint, s.holders, { supplyFails: true }), s.mint, s.creator, s.curve, s.ww)).rejects.toThrow(/HOLDER_SUPPLY_UNREADABLE/);
  });
});
