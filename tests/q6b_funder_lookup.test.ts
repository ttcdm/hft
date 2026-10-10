import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { FunderLookup, wireFunderLookup, FUNDER_SIGNATURE_PAGE } from '../server/signals/funderLookup';
import { WatchWindow } from '../server/signals/watchWindow';
import { replay, buyers, wallet } from './fixtures/watch';

/** Q6b: nothing looked up funders, so funderCoverage was never 1 and the "unique buyers" signal could never pass. */
const sys = (source: string, destination: string) => ({ transaction: { message: { instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source, destination, lamports: 5_000_000 } } }] } } });

function fakeConn(funderOf: (w: string) => string | null, opts: { fail?: Set<string>; history?: Map<string, number> } = {}) {
  const calls = { sigs: 0, tx: 0 };
  const conn: any = {
    getSignaturesForAddress: async (key: any) => {
      calls.sigs++;
      const w = key.toBase58();
      if (opts.fail?.has(w)) throw new Error('rpc down');
      const n = opts.history?.get(w) ?? 1;
      return Array.from({ length: n }, (_, i) => ({ signature: `${w}:${i}` }));
    },
    getParsedTransaction: async (sig: string) => {
      calls.tx++;
      const w = sig.split(':')[0];
      const f = funderOf(w);
      return f ? sys(f, w) : { transaction: { message: { instructions: [] } } };
    },
  };
  return { conn, calls };
}

describe('Q6b: funder lookup', () => {
  afterEach(() => vi.restoreAllMocks());

  it('finds the sender of the first transfer, caches it, and reports no-transfer / established / error without inventing a funder', async () => {
    const [a, b, c, d] = [wallet(), wallet(), wallet(), wallet()];
    const funder = wallet();
    const { conn, calls } = fakeConn((w) => (w === a ? funder : null), { fail: new Set([d]), history: new Map([[c, FUNDER_SIGNATURE_PAGE]]) });
    const l = new FunderLookup(() => conn);
    expect(await l.lookup(a)).toEqual({ funder });
    expect(await l.lookup(b)).toEqual({ funder: null, reason: 'NO_TRANSFER' });
    expect(await l.lookup(c)).toEqual({ funder: null, reason: 'ESTABLISHED_WALLET' });
    expect(await l.lookup(d)).toMatchObject({ funder: null, reason: 'ERROR' });
    expect(calls.tx).toBe(2); // the established wallet and the failed one never read a transaction
    expect(await new FunderLookup(() => null).lookup(a)).toMatchObject({ reason: 'ERROR' });
  });

  it('30 buyers with 30 different funders: the buyers signal passes once the lookups land, not before, and an RPC error keeps it from passing', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const b = buyers(30, 25);
    const funders = new Map(b.wallets.map((w, i) => [w, `funder-${i}-${wallet()}`]));
    const { conn } = fakeConn((w) => funders.get(w) ?? null);
    const lookup = new FunderLookup(() => conn);
    const ww = new WatchWindow();
    wireFunderLookup(ww, lookup);
    const start = Date.now() - 28_000;
    ww.watch(mint, wallet(), start);
    for (const { trade, at } of replay(mint, start, b.steps)) ww.onTrade(trade, at);

    const before = ww.getSnapshot(start + 28_000).watching[0].metrics;
    expect(before.funderCoverage).toBeLessThan(1);
    expect(before.signals.buyers?.pass).toBe(false);

    await vi.waitFor(() => expect(ww.getSnapshot(start + 28_000).watching[0].metrics.funderCoverage).toBe(1));
    const after = ww.getSnapshot(start + 28_000).watching[0].metrics;
    expect(after.uniqueBuyers).toBe(30);
    expect(after.signals.buyers?.pass).toBe(true);

    // the same buyers when the node is down: unknown stays unknown
    const mint2 = Keypair.generate().publicKey.toBase58();
    const b2 = buyers(30, 25);
    const down = fakeConn(() => null, { fail: new Set(b2.wallets) });
    const ww2 = new WatchWindow();
    wireFunderLookup(ww2, new FunderLookup(() => down.conn));
    ww2.watch(mint2, wallet(), start);
    for (const { trade, at } of replay(mint2, start, b2.steps)) ww2.onTrade(trade, at);
    await vi.waitFor(() => expect(down.calls.sigs).toBe(30));
    const m2 = ww2.getSnapshot(start + 28_000).watching[0].metrics;
    expect(m2.funderCoverage).toBe(0);
    expect(m2.signals.buyers?.pass).toBe(false);
  });

  it('wallets that share a funder are one cluster even through the lookup', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const b = buyers(30, 25);
    const { conn } = fakeConn(() => 'the-one-funder');
    const ww = new WatchWindow();
    wireFunderLookup(ww, new FunderLookup(() => conn));
    const start = Date.now() - 28_000;
    ww.watch(mint, wallet(), start);
    for (const { trade, at } of replay(mint, start, b.steps)) ww.onTrade(trade, at);
    await vi.waitFor(() => expect(ww.getSnapshot(start + 28_000).watching[0].metrics.funderCoverage).toBe(1));
    const m = ww.getSnapshot(start + 28_000).watching[0].metrics;
    expect(m.uniqueBuyers).toBe(1);
    expect(m.signals.buyers?.pass).toBe(false);
    expect(m.largestBuyerShare).toBeCloseTo(1, 9);
  });

  it('asks at most maxPerMint wallets per mint', async () => {
    const { conn, calls } = fakeConn(() => null);
    const l = new FunderLookup(() => conn, { maxPerMint: 5 });
    for (let i = 0; i < 20; i++) l.request(wallet(), 'm');
    await vi.waitFor(() => expect(calls.sigs).toBe(5));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.sigs).toBe(5);
  });
});
