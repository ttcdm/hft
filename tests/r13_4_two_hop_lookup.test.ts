import { describe, it, expect, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { fetchTokenHolderDistribution } from '../server/solana/pumpCurve';
import { FunderLookup, wireFunderLookup } from '../server/signals/funderLookup';
import { WatchWindow, WATCH_FUNDER_HOP_MAX } from '../server/signals/watchWindow';
import { classifyHolder } from '../server/signals/holderCluster';
import { replay, wallet } from './fixtures/watch';

/**
 * R13-4 (haiku round 13): classifyHolder asks for the funder of a holder's funder (the second hop), but production never looked that up,
 * so creator -> hop -> holder read INDEPENDENT. The two-hop R2-3 test passed only because it seeded the hop by hand. Now the watch window
 * asks the real FunderLookup for the hop, and a hop that was never looked up makes the holder UNKNOWN, not INDEPENDENT.
 * Real WatchWindow, FunderLookup and fetchTokenHolderDistribution; only the RPC is a fake.
 */
const SUPPLY = 1_000_000_000_000_000n;
const pk = () => Keypair.generate().publicKey;
const sys = (source: string, destination: string) => ({ transaction: { message: { instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source, destination, lamports: 5_000_000 } } }] } } });

/** History RPC: one transaction per wallet, a transfer from `funderOf(wallet)` (none when null). */
function historyConn(funderOf: (w: string) => string | null) {
  const asked: string[] = [];
  const conn: any = {
    getSignaturesForAddress: async (key: PublicKey) => { asked.push(key.toBase58()); return [{ signature: `${key.toBase58()}:0` }]; },
    getParsedTransaction: async (sig: string) => {
      const w = sig.split(':')[0];
      const f = funderOf(w);
      return f ? sys(f, w) : { transaction: { message: { instructions: [] } } };
    },
  };
  return { conn, asked };
}

/** Holder RPC: the given holders as the largest accounts, with their owners. */
function holderConn(holders: Array<{ owner: PublicKey; pct: number }>) {
  const accounts = holders.map((h) => ({ address: pk(), owner: h.owner, amount: (SUPPLY * BigInt(Math.round(h.pct * 100))) / 10_000n }));
  const ownerData = (owner: PublicKey) => { const d = Buffer.alloc(165); d.set(pk().toBuffer(), 0); d.set(owner.toBuffer(), 32); return d; };
  return {
    getTokenLargestAccounts: async () => ({ value: accounts.map((a) => ({ address: a.address, amount: a.amount.toString() })) }),
    getTokenSupply: async () => ({ value: { amount: SUPPLY.toString() } }),
    getTokenAccountBalance: async () => ({ value: { amount: '0' } }),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => { const a = accounts.find((x) => x.address.equals(k)); return a ? { data: ownerData(a.owner) } : null; }),
  } as any;
}

describe('R13-4: the holder gate\'s second hop is looked up in production, and an unread hop is UNKNOWN', () => {
  it('creator -> hop -> holder: the holder buys in the window, the window asks the lookup for the hop, and the holder\'s 6% counts as the creator\'s', async () => {
    const creator = pk().toBase58(), hop = wallet(), holder = pk();
    const mint = Keypair.generate().publicKey.toBase58();
    const funders = new Map<string, string>([[holder.toBase58(), hop], [hop, creator]]);
    const h = historyConn((w) => funders.get(w) ?? null);
    const ww = new WatchWindow({ publicFunders: [] });
    wireFunderLookup(ww, new FunderLookup(() => h.conn, { retryDelaysMs: [] }));
    const start = Date.now();
    ww.watch(mint, creator, start);
    for (const { trade, at } of replay(mint, start, [[0, holder.toBase58(), 'buy', 0.1]])) ww.onTrade(trade, at);

    await vi.waitFor(() => expect(ww.funderFacts(hop)).not.toBeNull());
    expect(h.asked).toEqual([holder.toBase58(), hop]);
    const d = await fetchTokenHolderDistribution(holderConn([{ owner: holder, pct: 6 }]), new PublicKey(mint), new PublicKey(creator), undefined, ww);
    expect(d.topHolders[0].holderClass).toBe('CREATOR_CLUSTER');
    expect(d.devHoldingPct).toBeCloseTo(6, 6); // was 0: the hop was never looked up, so the holder read INDEPENDENT
  });

  it('a verified holder whose funder was never looked up is UNKNOWN, not INDEPENDENT; a looked-up or allowlisted funder resolves it', () => {
    const creator = wallet(), funder = wallet(), holder = wallet();
    const ins = new Set([creator]);
    const ww = new WatchWindow({ publicFunders: [] });
    ww.setFunder(holder, funder);
    expect(classifyHolder(holder, ins, ww)).toBe('UNKNOWN'); // was INDEPENDENT
    ww.setNoFunder(funder); // looked up: an established wallet, no creator source
    expect(classifyHolder(holder, ins, ww)).toBe('INDEPENDENT');

    const exchange = wallet();
    const ww2 = new WatchWindow({ publicFunders: [exchange] });
    ww2.setFunder(holder, exchange);
    expect(classifyHolder(holder, ins, ww2)).toBe('INDEPENDENT');
  });

  it('hop lookups are bounded per mint (WATCH_FUNDER_HOP_MAX), never go a third hop, and skip public funders and insiders', async () => {
    const creator = wallet(), exchange = wallet();
    const mint = Keypair.generate().publicKey.toBase58();
    const n = WATCH_FUNDER_HOP_MAX + 10;
    const buyersList = Array.from({ length: n }, wallet);
    const funders = new Map<string, string>();
    buyersList.forEach((b, i) => funders.set(b, i === 0 ? exchange : i === 1 ? creator : wallet()));
    const h = historyConn((w) => funders.get(w) ?? wallet()); // every hop has a funder of its own: a third hop is never asked for
    const ww = new WatchWindow({ publicFunders: [exchange] });
    wireFunderLookup(ww, new FunderLookup(() => h.conn, { retryDelaysMs: [], maxPerMint: 1_000 }));
    const start = Date.now();
    ww.watch(mint, creator, start);
    for (const { trade, at } of replay(mint, start, buyersList.map((b, i) => [i * 0.1, b, 'buy', 0.01] as [number, string, 'buy', number]))) ww.onTrade(trade, at);

    await vi.waitFor(() => expect(h.asked.length).toBe(n + WATCH_FUNDER_HOP_MAX));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.asked.length).toBe(n + WATCH_FUNDER_HOP_MAX);
    expect(h.asked).not.toContain(exchange);
    expect(h.asked).not.toContain(creator);
  });
});
