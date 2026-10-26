import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { WatchWindow, WATCH_FUNDER_SAMPLE_BUYERS } from '../server/signals/watchWindow';
import { FunderLookup, wireFunderLookup } from '../server/signals/funderLookup';
import { replay, buyers, wallet, type Step } from './fixtures/watch';

/**
 * B3 (review 2026-10-24, finding 3, second half): look up every seller's funder before a sell counts as organic. Before, a seller outside
 * the 100-buyer funder sample (or one who never bought in the window) was never looked up, so a creator-funded wallet could dump without
 * CREATOR_SOLD, and HOT could be given while that was unknown. Real WatchWindow and FunderLookup; the only double is a fake Connection.
 */

const T0 = 1_700_000_000_000;
const mintKey = () => Keypair.generate().publicKey.toBase58();
const run = (w: WatchWindow, mint: string, steps: Step[], start = T0) => { for (const { trade, at } of replay(mint, start, steps)) w.onTrade(trade, at); };
const transfer = (source: string, destination: string) => ({ program: 'system', parsed: { type: 'transfer', info: { source, destination, lamports: 50_000_000 } } });

/** A fake Connection: a wallet's history is one transaction funding it from `funders[wallet]`; a wallet in `hang` never answers; one in `fail` has no history (ERROR). */
function fakeConn(funders: Record<string, string>) {
  const served: string[] = [];
  const hang = new Map<string, () => void>();
  const fail = new Set<string>();
  const conn: any = {
    getSignaturesForAddress: (key: any) => {
      const w = key.toBase58();
      served.push(w);
      if (fail.has(w)) return Promise.resolve([]);
      const answer = [{ signature: `${w}:0`, err: null }];
      if (hang.has(w)) return new Promise((resolve) => hang.set(w, () => resolve(answer)));
      return Promise.resolve(answer);
    },
    getParsedTransaction: async (sig: string) => {
      const w = sig.split(':')[0];
      const f = funders[w];
      return { transaction: { message: { instructions: f ? [transfer(f, w)] : [] } }, meta: { err: null, innerInstructions: [] } };
    },
  };
  return { conn, served, hang, fail, funders };
}

/** 30 de-clustered buyers (their funders known up front), a score of 80: HOT at T0 + 28 s unless something holds it. */
function hotLaunch(w: WatchWindow, mint: string) {
  w.watch(mint, wallet(), T0);
  const b = buyers(30, 25);
  b.wallets.forEach((x, i) => w.setFunder(x, `fx-funder-${i}`));
  run(w, mint, b.steps);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('B3: every seller\'s funder is looked up', () => {
  it('a creator-funded wallet outside the 100-buyer sample buys small and sells: its funder is looked up and the launch is CREATOR_SOLD', async () => {
    const creator = wallet(), mint = mintKey(), insider = wallet();
    const f = fakeConn({ [insider]: creator });
    const w = new WatchWindow({ publicFunders: [] });
    wireFunderLookup(w, new FunderLookup(() => f.conn));
    w.watch(mint, creator, T0);
    const many = buyers(WATCH_FUNDER_SAMPLE_BUYERS, 10, 0.2);
    run(w, mint, [...many.steps, [11, insider, 'buy', 0.01]]);
    await vi.waitFor(() => expect(f.served.length).toBe(WATCH_FUNDER_SAMPLE_BUYERS));
    expect(f.served).not.toContain(insider); // outside the sample: not looked up as a buyer
    run(w, mint, [[12, insider, 'sell', 0.01]]);
    await vi.waitFor(() => expect(w.getVerdict(mint)?.state).toBe('DEAD'));
    expect(f.served).toContain(insider);
    expect(w.getVerdict(mint)?.reason).toMatch(/^CREATOR_SOLD: a wallet the creator funded/);
  });

  it('a wallet that never bought in the window (tokens passed on by the creator) sells: looked up, CREATOR_SOLD', async () => {
    const creator = wallet(), mint = mintKey(), mule = wallet();
    const f = fakeConn({ [mule]: creator });
    const w = new WatchWindow({ publicFunders: [] });
    wireFunderLookup(w, new FunderLookup(() => f.conn));
    w.watch(mint, creator, T0);
    run(w, mint, [[0, wallet(), 'buy', 0.5], [3, mule, 'sell', 0.4]]);
    await vi.waitFor(() => expect(w.getVerdict(mint)?.reason).toMatch(/^CREATOR_SOLD/));
  });

  it('HOT is held while a seller\'s lookup is outstanding, and given once it answers with an unrelated funder', async () => {
    const mint = mintKey(), seller = wallet();
    const f = fakeConn({ [seller]: wallet() });
    f.hang.set(seller, () => undefined);
    const w = new WatchWindow({ publicFunders: [], scoreOf: () => 80 });
    wireFunderLookup(w, new FunderLookup(() => f.conn));
    hotLaunch(w, mint);
    run(w, mint, [[26, seller, 'sell', 0.05]]);
    const held = w.evaluate(mint, T0 + 28_000)!;
    expect(held.state).toBe('WATCHING');
    expect(held.reason).toMatch(/waiting for the funder of 1 seller/);
    expect(held.metrics.passingSignals).toBeGreaterThanOrEqual(3); // it would be HOT without the hold
    f.hang.get(seller)!();
    await vi.waitFor(() => expect(f.served).toContain(seller));
    await new Promise((r) => setTimeout(r, 0));
    expect(w.evaluate(mint, T0 + 29_000)?.state).toBe('HOT');
  });

  it('a seller whose funder cannot be read (the lookup fails after its retries) costs the buyers signal, not the launch', async () => {
    const mint = mintKey(), seller = wallet();
    const f = fakeConn({});
    f.fail.add(seller);
    const w = new WatchWindow({ publicFunders: [], scoreOf: () => 80 });
    wireFunderLookup(w, new FunderLookup(() => f.conn, { retryDelaysMs: [] }));
    hotLaunch(w, mint);
    expect(w.getSnapshot(T0 + 25_000).watching[0].metrics.signals.buyers!.pass).toBe(true);
    run(w, mint, [[26, seller, 'sell', 0.05]]);
    await vi.waitFor(() => expect(f.served).toContain(seller));
    await new Promise((r) => setTimeout(r, 0));
    const r = w.evaluate(mint, T0 + 28_000)!;
    expect(r.metrics.funderCoverage).toBeLessThan(1);
    expect(r.metrics.signals.buyers!.pass).toBe(false);
    expect(r.metrics.sellCount).toBe(1); // the sell stays organic (the pessimistic side)
    expect(r.state).toBe('HOT'); // velocity, concentration and flow still pass, with the score
    expect(r.reason).toMatch(/^3 strong signals/);
  });

  it('a seller lookup still outstanding when the window ends: judged without it (READY here), the buyers signal failing, never DEAD', async () => {
    const mint = mintKey(), seller = wallet();
    const f = fakeConn({ [seller]: wallet() });
    f.hang.set(seller, () => undefined);
    const w = new WatchWindow({ publicFunders: [] });
    wireFunderLookup(w, new FunderLookup(() => f.conn));
    w.watch(mint, wallet(), T0);
    const b = buyers(10, 15);
    b.wallets.forEach((x, i) => w.setFunder(x, `fx-funder-${i}`));
    run(w, mint, [...b.steps, [16, seller, 'sell', 0.01]]);
    expect(w.evaluate(mint, T0 + 60_000)?.reason).toMatch(/waiting for the funder of 1 seller/);
    const r = w.evaluate(mint, T0 + 120_000)!;
    expect(r.state).toBe('READY');
    expect(r.metrics.funderCoverage).toBeCloseTo(10 / 11);
  });

  it('no Connection (a switch or a reconnect): every seller lookup fails, and no launch is released DEAD for it', async () => {
    const w = new WatchWindow({ publicFunders: [], scoreOf: () => 80 });
    wireFunderLookup(w, new FunderLookup(() => null, { retryDelaysMs: [] }));
    const mints = [mintKey(), mintKey(), mintKey()];
    for (const m of mints) { hotLaunch(w, m); run(w, m, [[26, wallet(), 'sell', 0.05]]); }
    await new Promise((r) => setTimeout(r, 0));
    for (const m of mints) {
      const r = w.evaluate(m, T0 + 28_000)!;
      expect(r.state).toBe('HOT');
      expect(r.metrics.signals.buyers!.pass).toBe(false);
    }
  });

  it('a full queue refuses the seller lookup: the launch is not held and not DEAD, only the buyers signal fails', () => {
    const conn: any = { getSignaturesForAddress: () => new Promise(() => undefined), getParsedTransaction: async () => null };
    const w = new WatchWindow({ publicFunders: [], scoreOf: () => 80 });
    const lookup = new FunderLookup(() => conn, { concurrency: 1, maxQueue: 1 });
    wireFunderLookup(w, lookup);
    const other = mintKey();
    w.watch(other, wallet(), T0); // still watched, so its waiting job is not dropped to make room
    lookup.request(wallet(), other); // in flight
    lookup.request(wallet(), other); // the queue is full
    const mint = mintKey();
    hotLaunch(w, mint);
    run(w, mint, [[26, wallet(), 'sell', 0.05]]);
    expect(lookup.getStats().refusedFull).toBe(1);
    const r = w.evaluate(mint, T0 + 28_000)!;
    expect(r.state).toBe('HOT');
    expect(r.metrics.signals.buyers!.pass).toBe(false);
  });

  it('a seller with a known funder or no funder at all holds nothing; without a lookup wired (replay) nothing waits either', async () => {
    const mint = mintKey(), seller = wallet();
    const f = fakeConn({});
    const w = new WatchWindow({ publicFunders: [], scoreOf: () => 80 });
    wireFunderLookup(w, new FunderLookup(() => f.conn));
    hotLaunch(w, mint);
    w.setNoFunder(seller);
    run(w, mint, [[26, seller, 'sell', 0.05]]);
    expect(f.served).not.toContain(seller);
    expect(w.evaluate(mint, T0 + 28_000)?.state).toBe('HOT');

    const replayed = new WatchWindow({ publicFunders: [], scoreOf: () => 80 });
    const m2 = mintKey();
    hotLaunch(replayed, m2);
    run(replayed, m2, [[26, wallet(), 'sell', 0.05]]);
    expect(replayed.evaluate(m2, T0 + 28_000)?.state).toBe('HOT');
  });
});

describe('B3: seller lookups go first and are not held to the per-mint bound', () => {
  it('a priority request jumps the waiting buyers and is accepted past maxPerMint; a refused request returns false', async () => {
    const order: string[] = [];
    const release: Array<() => void> = [];
    const conn: any = {
      getSignaturesForAddress: (key: any) => { order.push(key.toBase58()); return new Promise((r) => release.push(() => r([{ signature: 'x:0', err: null }]))); },
      getParsedTransaction: async () => ({ transaction: { message: { instructions: [] } }, meta: { err: null, innerInstructions: [] } }),
    };
    const l = new FunderLookup(() => conn, { concurrency: 1, maxPerMint: 2 });
    const [b1, b2, b3, s] = [wallet(), wallet(), wallet(), wallet()];
    expect(l.request(b1, 'M')).toBe(true); // in flight
    expect(l.request(b2, 'M')).toBe(true); // waiting
    expect(l.request(b3, 'M')).toBe(false); // the per-mint bound
    expect(l.request(s, 'M', true)).toBe(true); // a seller: past the bound, ahead of b2
    release.shift()!();
    await vi.waitFor(() => expect(order).toEqual([b1, s]));
    release.shift()!();
    await vi.waitFor(() => expect(order).toEqual([b1, s, b2]));
    release.shift()!();
  });

  it('a seller already waiting as a buyer moves to the front of the queue', async () => {
    const order: string[] = [];
    const release: Array<() => void> = [];
    const conn: any = {
      getSignaturesForAddress: (key: any) => { order.push(key.toBase58()); return new Promise((r) => release.push(() => r([{ signature: 'x:0', err: null }]))); },
      getParsedTransaction: async () => ({ transaction: { message: { instructions: [] } }, meta: { err: null, innerInstructions: [] } }),
    };
    const l = new FunderLookup(() => conn, { concurrency: 1 });
    const [b1, b2, b3] = [wallet(), wallet(), wallet()];
    l.request(b1, 'M'); l.request(b2, 'M'); l.request(b3, 'M');
    l.request(b3, 'M', true);
    release.shift()!();
    await vi.waitFor(() => expect(order).toEqual([b1, b3]));
    release.shift()!();
    await vi.waitFor(() => expect(order).toEqual([b1, b3, b2]));
    release.shift()!();
  });
});

describe('B3b: unread seller funders are counted, so lookup capacity can be judged', () => {
  it('failed, refused and still-pending-at-window-end seller lookups are counted, and a release says its buyers signal was not counted', async () => {
    const w = new WatchWindow({ publicFunders: [] });
    const failing = wallet(), hanging = wallet(), answered = wallet();
    const f = fakeConn({ [answered]: wallet(), [hanging]: wallet() });
    f.fail.add(failing);
    f.hang.set(hanging, () => undefined);
    wireFunderLookup(w, new FunderLookup(() => f.conn, { retryDelaysMs: [] }));
    const mint = mintKey();
    w.watch(mint, wallet(), T0);
    const b = buyers(10, 15);
    b.wallets.forEach((x, i) => w.setFunder(x, `fx-funder-${i}`));
    run(w, mint, [...b.steps, [16, failing, 'sell', 0.01], [17, hanging, 'sell', 0.01], [18, answered, 'sell', 0.01]]);
    await vi.waitFor(() => expect(w.getSellerFunderStats()).toEqual({ asked: 3, unreadable: 1, pendingAtWindowEnd: 0 }));
    const r = w.evaluate(mint, T0 + 120_000)!;
    expect(r.state).toBe('READY');
    expect(r.reason).toMatch(/; 2 seller funder\(s\) unread, buyers signal not counted$/);
    expect(w.getSellerFunderStats()).toEqual({ asked: 3, unreadable: 1, pendingAtWindowEnd: 1 });
  });

  it('a refused seller lookup (full queue) counts as unreadable', () => {
    const conn: any = { getSignaturesForAddress: () => new Promise(() => undefined), getParsedTransaction: async () => null };
    const w = new WatchWindow({ publicFunders: [] });
    const lookup = new FunderLookup(() => conn, { concurrency: 1, maxQueue: 1 });
    wireFunderLookup(w, lookup);
    const mint = mintKey();
    w.watch(mint, wallet(), T0);
    lookup.request(wallet(), mint);
    lookup.request(wallet(), mint);
    run(w, mint, [[0, wallet(), 'buy', 0.5], [1, wallet(), 'sell', 0.1]]);
    expect(w.getSellerFunderStats()).toEqual({ asked: 1, unreadable: 1, pendingAtWindowEnd: 0 });
  });

  it('a launch with every seller funder known gives the plain release reason', () => {
    const w = new WatchWindow({ publicFunders: [], scoreOf: () => 80 });
    wireFunderLookup(w, new FunderLookup(() => fakeConn({}).conn));
    const mint = mintKey(), seller = wallet();
    hotLaunch(w, mint);
    w.setNoFunder(seller);
    run(w, mint, [[26, seller, 'sell', 0.05]]);
    const r = w.evaluate(mint, T0 + 28_000)!;
    expect(r.state).toBe('HOT');
    expect(r.reason).not.toMatch(/unread/);
    expect(w.getSellerFunderStats().asked).toBe(0);
  });
});
