import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { fetchTokenHolderDistribution, GET_MULTIPLE_ACCOUNTS_MAX_KEYS, PumpCurveService } from '../server/solana/pumpCurve';
import { WatchWindow } from '../server/signals/watchWindow';

/**
 * Devnet run 2026-10-27 (fresh scratch), step (a): QuickNode's plan refuses getMultipleAccounts over 5 keys (HTTP 413), and R2-3 read the
 * owners of up to 20 large holders in ONE call, so every coin with more than 5 large holders had all of them UNKNOWN. The owners are now
 * read GET_MULTIPLE_ACCOUNTS_MAX_KEYS at a time. Unreadable holders are UNKNOWN: one top-10 entry, and (R13-3) counted against the
 * creator cap. Real fetchTokenHolderDistribution; the RPC is a fake with QuickNode's limit.
 */
const SUPPLY = 1_000_000_000_000_000n;
const pk = () => Keypair.generate().publicKey;
const ownerData = (owner: PublicKey) => { const d = Buffer.alloc(165); d.set(pk().toBuffer(), 0); d.set(owner.toBuffer(), 32); return d; };
const amt = (pct: number) => (SUPPLY * BigInt(Math.round(pct * 100))) / 10_000n;
const CURVE = pk();

function quicknodeLike(holders: Array<{ address?: PublicKey; owner: PublicKey; pct: number }>, opts: { allFail?: boolean } = {}) {
  const accounts = holders.map((h) => ({ address: h.address ?? pk(), owner: h.owner, amount: amt(h.pct) }));
  accounts.push({ address: CURVE, owner: CURVE, amount: SUPPLY - accounts.reduce((s, a) => s + a.amount, 0n) }); // R13-1: the curve holds the rest
  accounts.sort((a, b) => (a.amount < b.amount ? 1 : -1));
  const calls: number[] = [];
  return {
    calls,
    conn: {
      getTokenLargestAccounts: async () => ({ value: accounts.slice(0, 20).map((a) => ({ address: a.address, amount: a.amount.toString() })) }),
      getTokenSupply: async () => ({ value: { amount: SUPPLY.toString() } }),
      getTokenAccountBalance: async () => ({ value: { amount: '0' } }),
      getMultipleAccountsInfo: async (keys: PublicKey[]) => {
        calls.push(keys.length);
        if (opts.allFail) throw new Error('429 Too Many Requests');
        if (keys.length > 5) throw new Error('413 Request Entity Too Large: getMultipleAccounts is limited to a 5 range');
        return keys.map((k) => { const a = accounts.find((x) => x.address.equals(k)); return a ? { data: ownerData(a.owner) } : null; });
      },
    } as any,
  };
}

describe('holder-owner reads fit the RPC plan, and a failed read is never taken as independent', () => {
  it('12 large holders on a 5-key plan: read in batches of at most 5, every owner known, the creator-owned account counted as the creator\'s', async () => {
    const creator = pk();
    const ww = new WatchWindow({ publicFunders: [] });
    const others = Array.from({ length: 11 }, pk);
    others.forEach((o, i) => ww.setFunder(o.toBase58(), `independent-funder-${i}`));
    others.forEach((_, i) => ww.setNoFunder(`independent-funder-${i}`)); // R13-4: the second hop was looked up too
    const f = quicknodeLike([{ owner: creator, pct: 8 }, ...others.map((owner) => ({ owner, pct: 1 }))]); // the creator's 8% sits in a non-ATA account
    const d = await fetchTokenHolderDistribution(f.conn, pk(), creator, CURVE, ww);
    expect(f.calls.every((n) => n <= 5)).toBe(true);
    expect(f.calls.reduce((a, b) => a + b, 0)).toBe(12);
    expect(d.unknownHolderBalance).toBe(0n);
    expect(d.devHoldingPct).toBeCloseTo(8, 6);
    expect(d.top10HoldersPct).toBeCloseTo(10, 6);
    expect(GET_MULTIPLE_ACCOUNTS_MAX_KEYS).toBe(5);
  });

  it('every owner read failing: every unread holder is unknown, one top-10 entry, and (R13-3) counted against the creator cap', async () => {
    const creator = pk();
    const mint = pk();
    const creatorAta = PumpCurveService.getAssociatedTokenAddress(mint, creator, TOKEN_PROGRAM_ID);
    const others = Array.from({ length: 12 }, pk);
    const f = quicknodeLike([{ address: creatorAta, owner: creator, pct: 3 }, { owner: creator, pct: 8 }, ...others.map((owner) => ({ owner, pct: 1 }))], { allFail: true });
    const d = await fetchTokenHolderDistribution(f.conn, mint, creator, CURVE, new WatchWindow({ publicFunders: [] }));
    // R13-3: the 8% the creator owns elsewhere is not visible without the owner read; it and the 12 x 1% are UNKNOWN, and any of them may be
    // the creator's, so they count against the creator cap (was 3: the creator's own token account only)
    expect(d.devHoldingPct).toBeCloseTo(3 + 8 + 12, 6);
    expect(d.unknownHolderBalance).toBe(amt(8) + amt(1) * 12n);
    expect(d.top10HoldersPct).toBeCloseTo(20, 6);
  });
});
