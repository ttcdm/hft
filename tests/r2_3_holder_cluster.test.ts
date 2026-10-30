import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { fetchTokenHolderDistribution } from '../server/solana/pumpCurve';
import { EligibilityFilter } from '../server/signals/eligibilityFilter';
import { WatchWindow } from '../server/signals/watchWindow';
import { classifyHolder } from '../server/signals/holderCluster';

/**
 * R2-3 (haiku 2026-10-26, the synthesiser's cheapest break of the sybil-funded rug chain): the holder gates counted only the creator's own
 * wallet. 40 creator-funded wallets at 1.8% each (72% of the supply) read as 0% creator and 18% top-10 and passed LIVE eligibility.
 */
const SUPPLY = 1_000_000_000_000_000n;
const pk = () => Keypair.generate().publicKey;
const ownerData = (owner: PublicKey) => { const d = Buffer.alloc(165); d.set(pk().toBuffer(), 0); d.set(owner.toBuffer(), 32); return d; };
/** The bonding curve: it holds the rest of the supply, and takes one of the 20 slots (R13-1: what the list does not show is unseen). */
const CURVE = pk();

/** getTokenLargestAccounts (the 20 largest, as the RPC returns), getTokenSupply, and the token accounts' owners (null: unreadable). */
function conn(holders: Array<{ owner: PublicKey; pct: number }>, opts: { ownersFail?: boolean } = {}) {
  const accounts = holders.map((h) => ({ address: pk(), owner: h.owner, amount: (SUPPLY * BigInt(Math.round(h.pct * 100))) / 10_000n }));
  accounts.push({ address: CURVE, owner: CURVE, amount: SUPPLY - accounts.reduce((s, a) => s + a.amount, 0n) });
  accounts.sort((a, b) => (a.amount < b.amount ? 1 : -1));
  const top = accounts.slice(0, 20);
  return {
    getTokenLargestAccounts: async () => ({ value: top.map((a) => ({ address: a.address, amount: a.amount.toString() })) }),
    getTokenSupply: async () => ({ value: { amount: SUPPLY.toString() } }),
    getTokenAccountBalance: async () => ({ value: { amount: '0' } }),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      if (opts.ownersFail) throw new Error('429 Too Many Requests');
      return keys.map((k) => { const a = top.find((x) => x.address.equals(k)); return a ? { data: ownerData(a.owner) } : null; });
    },
  } as any;
}
const gate = (d: { devHoldingPct: number; top10HoldersPct: number }) => {
  const r = EligibilityFilter.evaluate({ mint: pk().toBase58(), symbol: 'R', name: 'R', devHoldingPct: d.devHoldingPct, top10HoldersPct: d.top10HoldersPct }, 'LIVE');
  const st = (id: string) => r.checks.find((c) => c.ruleId === id)!.status;
  return { creator: st('MAX_CREATOR_EXPOSURE'), top10: st('TOP_10_CONCENTRATION') };
};

describe('R2-3: the holder gate sums the creator\'s funder cluster', () => {
  it('40 creator-funded wallets at 1.8%: the 19 visible next to the curve are the creator\'s cluster (34.2%), the 21 unseen count too (R13-1), and LIVE refuses on creator exposure', async () => {
    const creator = pk();
    const ww = new WatchWindow({ publicFunders: [] });
    const sybils = Array.from({ length: 40 }, pk);
    sybils.forEach((s) => ww.setFunder(s.toBase58(), creator.toBase58()));
    const d = await fetchTokenHolderDistribution(conn(sybils.map((owner) => ({ owner, pct: 1.8 }))), pk(), creator, CURVE, ww);
    expect(Number(d.creatorClusterBalance * 10_000n / SUPPLY) / 100).toBeCloseTo(34.2, 6);
    expect(d.devHoldingPct).toBeCloseTo(72, 6);
    expect(d.top10HoldersPct).toBeCloseTo(37.8, 6); // the unseen 21 are one unknown entry
    expect(gate(d).creator).toBe('FAIL');
  });

  it('a creator-funded wallet one hop further out (creator -> hop -> holder) is in the cluster too', async () => {
    const creator = pk(), hop = pk(), holder = pk();
    const ww = new WatchWindow({ publicFunders: [] });
    ww.setFunder(hop.toBase58(), creator.toBase58());
    ww.setFunder(holder.toBase58(), hop.toBase58());
    const d = await fetchTokenHolderDistribution(conn([{ owner: holder, pct: 6 }]), pk(), creator, CURVE, ww);
    expect(d.devHoldingPct).toBeCloseTo(6, 6);
    expect(gate(d).creator).toBe('FAIL');
  });

  it('the same 40 wallets with no funder data: all unknown (19 visible, 21 unseen), counted together as one top-10 holder (72%) and (R13-3) against the creator cap, and LIVE refuses on both', async () => {
    const creator = pk();
    const d = await fetchTokenHolderDistribution(conn(Array.from({ length: 40 }, () => ({ owner: pk(), pct: 1.8 }))), pk(), creator, CURVE, new WatchWindow({ publicFunders: [] }));
    expect(d.devHoldingPct).toBeCloseTo(72, 6); // R13-3: was 0, the unknown holders were left out of the creator's share
    expect(d.top10HoldersPct).toBeCloseTo(72, 6); // was 18: ten of them
    expect(gate(d)).toEqual({ creator: 'FAIL', top10: 'FAIL' });
  });

  it('long-history (partly read) owners are unknown, not independent', async () => {
    const ww = new WatchWindow({ publicFunders: [] });
    const owners = Array.from({ length: 20 }, pk);
    owners.forEach((o, i) => ww.setFunder(o.toBase58(), `funder-${i}`, Date.now(), { verified: false }));
    const d = await fetchTokenHolderDistribution(conn(owners.map((owner) => ({ owner, pct: 1.8 }))), pk(), pk(), CURVE, ww);
    expect(d.top10HoldersPct).toBeCloseTo(36, 6); // 19 visible unknown plus the one unseen
    expect(gate(d).top10).toBe('FAIL');
  });

  it('a holder-owner read that fails makes every large holder unknown (fail closed)', async () => {
    const ww = new WatchWindow({ publicFunders: [] });
    const owners = Array.from({ length: 20 }, pk);
    owners.forEach((o, i) => ww.setFunder(o.toBase58(), `funder-${i}`));
    const d = await fetchTokenHolderDistribution(conn(owners.map((owner) => ({ owner, pct: 1.8 })), { ownersFail: true }), pk(), pk(), CURVE, ww);
    expect(d.unknownHolderBalance).toBe((SUPPLY * 180n) / 10_000n * 19n); // the curve takes one of the 20 slots
    expect(d.unseenBalance).toBe((SUPPLY * 180n) / 10_000n);
    expect(gate(d).top10).toBe('FAIL');
  });

  it('nineteen verified independent holders at 1.8% (all visible next to the curve) still pass: top-10 is the ten largest (18%), creator 0%', async () => {
    const ww = new WatchWindow({ publicFunders: [] });
    const owners = Array.from({ length: 19 }, pk);
    owners.forEach((o, i) => ww.setFunder(o.toBase58(), `independent-funder-${i}`));
    owners.forEach((_, i) => ww.setNoFunder(`independent-funder-${i}`)); // R13-4: the second hop was looked up too
    const d = await fetchTokenHolderDistribution(conn(owners.map((owner) => ({ owner, pct: 1.8 }))), pk(), pk(), CURVE, ww);
    expect(d.devHoldingPct).toBe(0);
    expect(d.top10HoldersPct).toBeCloseTo(18, 6);
    expect(gate(d)).toEqual({ creator: 'PASS', top10: 'PASS' });
  });

  it('classifyHolder: no owner, never looked up, or a no-funder wallet is UNKNOWN; the creator is CREATOR', () => {
    const ww = new WatchWindow({ publicFunders: [] });
    const creator = pk().toBase58(), w = pk().toBase58();
    const ins = new Set([creator]);
    expect(classifyHolder(null, ins, ww)).toBe('UNKNOWN');
    expect(classifyHolder(w, ins, ww)).toBe('UNKNOWN');
    ww.setNoFunder(w);
    expect(classifyHolder(w, ins, ww)).toBe('UNKNOWN');
    expect(classifyHolder(creator, ins, ww)).toBe('CREATOR');
  });
});
