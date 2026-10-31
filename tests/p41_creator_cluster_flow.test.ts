import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { WatchWindow, WATCH_FUNDER_SAMPLE_BUYERS, WATCH_FUNDER_HOP_MAX } from '../server/signals/watchWindow';
import { FunderLookup, wireFunderLookup, FUNDER_LOOKUP_CONCURRENCY, FUNDER_LOOKUP_MAX_PER_MINT, FUNDER_RETRY_DELAYS_MS } from '../server/signals/funderLookup';
import { ConfluenceEngine, type ConfluenceFactorsInput } from '../server/signals/confluenceEngine';
import { creatorRiskScorer, CREATOR_REPORT_TTL_MS, CREATOR_REPORT_GRACE_MS } from '../server/signals/creatorRiskScorer';
import { wireCreatorReportPins } from '../server/signals/watchPins';
import { replay, wallet, type Step } from './fixtures/watch';

/**
 * P4.1 (R1-55, R1-53, R1-54, R1-60): the creator cluster is not demand and its sells are CREATOR_SOLD; a known creator without a
 * report scores 0; an unindexed or CPI-funded buyer is not reported as funderless; the funder queue serves only watched mints.
 * Real WatchWindow, ConfluenceEngine, CreatorRiskScorer and FunderLookup; the only double is a fake Connection.
 */
const T0 = 1_700_000_000_000;
const mintKey = () => Keypair.generate().publicKey.toBase58();
const run = (w: WatchWindow, mint: string, steps: Step[], start = T0) => { for (const { trade, at } of replay(mint, start, steps)) w.onTrade(trade, at); };

const transfer = (source: string, destination: string) => ({ program: 'system', parsed: { type: 'transfer', info: { source, destination, lamports: 50_000_000 } } });
/** A fake Connection: every wallet has one signature, whose transaction funds it from `funderOf(wallet)` at the top level. */
function fakeConn(funderOf: (w: string) => string | null) {
  const served: string[] = [];
  const conn: any = {
    getSignaturesForAddress: async (key: any) => { served.push(key.toBase58()); return [{ signature: `${key.toBase58()}:0`, err: null }]; },
    getParsedTransaction: async (sig: string) => {
      const w = sig.split(':')[0];
      const f = funderOf(w);
      return { transaction: { message: { instructions: f ? [transfer(f, w)] : [] } }, meta: { err: null, innerInstructions: [] } };
    },
  };
  return { conn, served };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  creatorRiskScorer.setPinned(null);
  creatorRiskScorer.clearCache();
});

describe('P4.1 (R1-55): the creator cluster', () => {
  it('a wallet the creator funded buys, then sells: DEAD CREATOR_SOLD at once', () => {
    const w = new WatchWindow({ publicFunders: [] });
    const mint = mintKey(), creator = wallet(), W = wallet();
    w.watch(mint, creator, T0);
    w.setFunder(W, creator);
    run(w, mint, [[0, wallet(), 'buy', 1], [1, W, 'buy', 0.5], [25, W, 'sell', 0.4]]);
    const v = w.getVerdict(mint)!;
    expect(v.state).toBe('DEAD');
    expect(v.reason).toMatch(/^CREATOR_SOLD/);
    expect(w.isWatching(mint)).toBe(false);
  });

  it('the sell came before its funder was known: the funder arriving releases DEAD CREATOR_SOLD', () => {
    const w = new WatchWindow({ publicFunders: [] });
    const mint = mintKey(), creator = wallet(), W = wallet();
    w.watch(mint, creator, T0);
    run(w, mint, [[0, wallet(), 'buy', 1], [1, W, 'buy', 0.5], [25, W, 'sell', 0.4]]);
    expect(w.getVerdict(mint)!.state).toBe('WATCHING');
    w.setFunder(W, wallet()); // an unrelated funder changes nothing
    expect(w.getVerdict(mint)!.state).toBe('WATCHING');
    w.setFunder(W, creator, T0 + 26_000);
    const r = w.evaluate(mint, T0 + 27_000)!;
    expect(r.state).toBe('DEAD');
    expect(r.reason).toMatch(/^CREATOR_SOLD/);
    expect(r.metrics.creatorSold).toBe(true);
    expect(r.releasedAt).toBe(T0 + 26_000);
  });

  it('a 2 SOL creator buy plus one 0.01 SOL retail buy: at 22 s velocity does not pass and flow counts only the retail buy', () => {
    const w = new WatchWindow({ publicFunders: [] });
    const mint = mintKey(), creator = wallet();
    w.watch(mint, creator, T0);
    run(w, mint, [[0, creator, 'buy', 2], [1, wallet(), 'buy', 0.01]]);
    const m = w.evaluate(mint, T0 + 22_000)!.metrics;
    expect(m.signals.velocity!.pass).toBe(false);
    expect(m.signals.flow!.buyCount).toBe(1);
    expect(m.creatorClusterBuySol).toBeCloseTo(2, 9);
    // the dev buy is no longer two of the HOT signals: of velocity and flow at most the one retail buy's flow can pass
    expect([m.signals.velocity!.pass, m.signals.flow!.pass].filter(Boolean).length).toBeLessThan(2);
  });

  it('with one retail sell as well, neither velocity nor flow passes, and a creator-funded wallet counts as the creator', () => {
    const w = new WatchWindow({ publicFunders: [] });
    const mint = mintKey(), creator = wallet(), sidecar = wallet();
    w.watch(mint, creator, T0);
    w.setFunder(sidecar, creator);
    run(w, mint, [[0, creator, 'buy', 2], [0.5, sidecar, 'buy', 1], [1, wallet(), 'buy', 0.01], [2, wallet(), 'sell', 0.005]]);
    const r = w.evaluate(mint, T0 + 22_000)!;
    expect(r.state).toBe('WATCHING');
    expect(r.metrics.signals.velocity!.pass).toBe(false);
    expect(r.metrics.signals.flow!.pass).toBe(false);
    expect(r.metrics.signals.flow).toMatchObject({ buyCount: 1, sellCount: 1 });
  });

  it('net inflow is organic: retail selling into a creator buy is a NET_OUTFLOW after the minimum hold', () => {
    const w = new WatchWindow({ publicFunders: [] });
    const mint = mintKey(), creator = wallet(), a = wallet();
    w.watch(mint, creator, T0);
    run(w, mint, [[0, creator, 'buy', 2], [1, a, 'buy', 0.1], [5, a, 'sell', 0.3]]);
    const r = w.evaluate(mint, T0 + 20_000)!;
    expect(r.state).toBe('DEAD');
    expect(r.reason).toMatch(/^NET_OUTFLOW/);
    expect(r.metrics.cumulativeNetInflowSol).toBeLessThan(0);
  });
});

describe('P4.1 (R1-53): the creator report', () => {
  const burnerHistory = () => [{ signature: 'b1', slot: 1, err: null, memo: null, blockTime: Math.floor(Date.now() / 1000) - 30 }];
  const seasonedHistory = () => {
    const nowSec = Math.floor(Date.now() / 1000);
    return Array.from({ length: 60 }, (_, i) => ({ signature: `s${i}`, slot: 1000 - i, err: null, memo: null, blockTime: nowSec - i * 60_000 }));
  };
  const input = (creator: string): ConfluenceFactorsInput => ({
    mint: mintKey(), creatorAddress: creator, priceChange5mPct: null, liquidityUsd: null, top10HoldersPct: null, bondingCurveProgress: 5,
    buys5m: null, sells5m: null, devHoldingPct: 0, hasVerifiedSocialCall: false, socialCallCount: 0,
  });

  it('a burner with no dev buy: once its report expires (+121 s) the creator still scores 0 and is listed as missing', async () => {
    vi.useFakeTimers();
    const creator = wallet();
    const report = await creatorRiskScorer.evaluateCreator({ getSignaturesForAddress: async () => burnerHistory() }, creator);
    expect(report.isBurner).toBe(true);
    expect(ConfluenceEngine.calculate(input(creator)).creatorRiskScore).toBe(0);
    await vi.advanceTimersByTimeAsync(CREATOR_REPORT_TTL_MS + 1_000);
    expect(creatorRiskScorer.getCachedReport(creator)).toBeUndefined();
    const b = ConfluenceEngine.calculate(input(creator));
    expect(b.creatorRiskScore).toBe(0);
    expect(b.explanation).toMatch(/missing data, scored 0: .*creator/);
  });

  it('getSignaturesForAddress throwing: creator score 0, listed as missing, and the failure is cached', async () => {
    const creator = wallet();
    const getSignaturesForAddress = vi.fn(async () => { throw new Error('429 Too Many Requests'); });
    await creatorRiskScorer.evaluateCreator({ getSignaturesForAddress }, creator);
    const b = ConfluenceEngine.calculate(input(creator));
    expect(b.creatorRiskScore).toBe(0);
    expect(b.explanation).toMatch(/missing data, scored 0: .*creator/);
    await creatorRiskScorer.evaluateCreator({ getSignaturesForAddress }, creator);
    expect(getSignaturesForAddress).toHaveBeenCalledTimes(1);
  });

  it('with no creator known, dev holding is still the stand-in', () => {
    const noCreator = { ...input(wallet()), creatorAddress: undefined };
    expect(ConfluenceEngine.calculate(noCreator).creatorRiskScore).toBe(5);
  });

  it('pinned while its launch is watched and kept 60 s after the release, then gone', async () => {
    vi.useFakeTimers();
    const creator = wallet(), mint = mintKey();
    const w = new WatchWindow({ publicFunders: [] });
    wireCreatorReportPins(w, creatorRiskScorer);
    w.watch(mint, creator, Date.now());
    await creatorRiskScorer.evaluateCreator({ getSignaturesForAddress: async () => seasonedHistory() }, creator);
    const full = ConfluenceEngine.calculate(input(creator)).creatorRiskScore;
    expect(full).toBe(5);

    await vi.advanceTimersByTimeAsync(CREATOR_REPORT_TTL_MS + 1_000); // past the old TTL, still watched
    expect(ConfluenceEngine.calculate(input(creator)).creatorRiskScore).toBe(full);
    expect(w.tick(Date.now()).map((r) => r.state)).toEqual(['DEAD']); // NO_TRADES releases it
    await vi.advanceTimersByTimeAsync(CREATOR_REPORT_GRACE_MS - 1_000);
    expect(ConfluenceEngine.calculate(input(creator)).creatorRiskScore).toBe(full);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(creatorRiskScorer.getCachedReport(creator)).toBeUndefined();
    expect(ConfluenceEngine.calculate(input(creator)).creatorRiskScore).toBe(0);
  });
});

describe('P4.1 (R1-54): funder truth', () => {
  it('no signatures yet is an ERROR that is retried, then the funder: coverage stays below 1 meanwhile', async () => {
    vi.useFakeTimers();
    const mint = mintKey(), funder = wallet(), [a, b] = [wallet(), wallet()];
    const indexed = new Set<string>([b]);
    const conn: any = {
      getSignaturesForAddress: vi.fn(async (key: any) => (indexed.has(key.toBase58()) ? [{ signature: `${key.toBase58()}:0`, err: null }] : [])),
      getParsedTransaction: async (sig: string) => ({ transaction: { message: { instructions: [transfer(funder, sig.split(':')[0])] } }, meta: { err: null, innerInstructions: [] } }),
    };
    const lookup = new FunderLookup(() => conn);
    expect(await lookup.lookup(a)).toMatchObject({ funder: null, reason: 'ERROR' });

    const w = new WatchWindow({ publicFunders: [] });
    wireFunderLookup(w, lookup);
    w.watch(mint, wallet(), T0);
    run(w, mint, [[0, a, 'buy', 0.1], [1, b, 'buy', 0.1]]);
    await vi.advanceTimersByTimeAsync(0);
    let m = w.getSnapshot(T0 + 2_000).watching[0].metrics;
    expect(m.funderCoverage).toBeLessThan(1); // a is unknown, not "no funder"
    expect(m.uniqueBuyers).toBe(2);

    indexed.add(a); // the index catches up
    await vi.advanceTimersByTimeAsync(FUNDER_RETRY_DELAYS_MS[0]);
    m = w.getSnapshot(T0 + 2_000).watching[0].metrics;
    expect(m.funderCoverage).toBe(1);
    expect(m.uniqueBuyers).toBe(1); // a and b share the funder
  });

  it('an inner (CPI) system transfer resolves the funder', async () => {
    const funder = wallet(), a = wallet(), program = wallet();
    const conn: any = {
      getSignaturesForAddress: async () => [{ signature: 'cpi:0', err: null }],
      getParsedTransaction: async () => ({
        transaction: { message: { instructions: [{ programId: program, accounts: [funder, a], data: '3Bxs4' }] } },
        meta: { err: null, innerInstructions: [{ index: 0, instructions: [transfer(funder, a)] }] },
      }),
    };
    expect(await new FunderLookup(() => conn).lookup(a)).toEqual({ funder });
  });

  it('createAccount and transferWithSeed into the wallet are funding too (the seed base is the funder)', async () => {
    const funder = wallet(), base = wallet(), a = wallet(), b = wallet();
    const ixFor: Record<string, any> = {
      [a]: { program: 'system', parsed: { type: 'createAccount', info: { source: funder, newAccount: a, lamports: 1, space: 0, owner: wallet() } } },
      [b]: { program: 'system', parsed: { type: 'transferWithSeed', info: { source: wallet(), sourceBase: base, destination: b, lamports: 1, sourceSeed: 's', sourceOwner: wallet() } } },
    };
    const conn: any = {
      getSignaturesForAddress: async (key: any) => [{ signature: `${key.toBase58()}:0`, err: null }],
      getParsedTransaction: async (sig: string) => ({ transaction: { message: { instructions: [ixFor[sig.split(':')[0]]] } }, meta: { err: null, innerInstructions: [] } }),
    };
    const l = new FunderLookup(() => conn);
    expect(await l.lookup(a)).toEqual({ funder });
    expect(await l.lookup(b)).toEqual({ funder: base });
  });
});

describe('P4.1 (R1-60): the funder queue and the coverage sample', () => {
  it('1,000 wallets across 20 mints with 19 released: only the watched mint is served', async () => {
    const funders = new Map<string, string>();
    const { conn, served } = fakeConn((w) => funders.get(w) ?? null);
    const lookup = new FunderLookup(() => conn);
    const w = new WatchWindow({ publicFunders: [] });
    wireFunderLookup(w, lookup);
    const mints = Array.from({ length: 20 }, mintKey);
    const creators = mints.map(() => wallet());
    const buyersOf = mints.map(() => Array.from({ length: 50 }, wallet));
    mints.forEach((m, i) => w.watch(m, creators[i], T0));
    // interleaved, as a busy feed delivers them; every buyer has a funder of its own
    for (let k = 0; k < 50; k++) {
      mints.forEach((m, i) => {
        const b = buyersOf[i][k];
        funders.set(b, wallet());
        run(w, m, [[k * 0.1, b, 'buy', 0.1]]);
      });
    }
    const inFlightBeforeRelease = served.length;
    expect(inFlightBeforeRelease).toBe(FUNDER_LOOKUP_CONCURRENCY);
    // 19 creators sell: 19 instant releases, before any lookup has answered
    mints.slice(0, 19).forEach((m, i) => run(w, m, [[6, creators[i], 'sell', 0.01]]));
    expect(mints.filter((m) => w.isWatching(m))).toEqual([mints[19]]);

    const watched = new Set(buyersOf[19]);
    // R13-4: the watched buyers' funders are looked up too (the holder gate's second hop), up to WATCH_FUNDER_HOP_MAX per mint
    const watchedHops = new Set(buyersOf[19].map((b) => funders.get(b)!));
    await vi.waitFor(() => expect(served.filter((x) => watched.has(x)).length).toBe(50));
    await vi.waitFor(() => expect(served.filter((x) => watchedHops.has(x)).length).toBe(Math.min(50, WATCH_FUNDER_HOP_MAX)));
    await new Promise((r) => setTimeout(r, 20));
    expect(served.slice(inFlightBeforeRelease).every((x) => watched.has(x) || watchedHops.has(x))).toBe(true);
    expect(served.length).toBe(inFlightBeforeRelease + 50 + Math.min(50, WATCH_FUNDER_HOP_MAX));
    expect(lookup.getStats().dropped).toBe(19 * 50 - inFlightBeforeRelease);
    expect(w.getSnapshot(T0 + 10_000).watching[0].metrics.funderCoverage).toBe(1);
  });

  it(`more buyers than the per-mint lookup cap: coverage is sampled over the largest ${WATCH_FUNDER_SAMPLE_BUYERS}, and a late large buyer joins the sample`, async () => {
    const funders = new Map<string, string>();
    const { conn, served } = fakeConn((x) => funders.get(x) ?? null);
    const w = new WatchWindow({ publicFunders: [] });
    wireFunderLookup(w, new FunderLookup(() => conn));
    const mint = mintKey();
    w.watch(mint, wallet(), T0);
    const n = FUNDER_LOOKUP_MAX_PER_MINT + 50;
    const small = Array.from({ length: n }, wallet);
    small.forEach((b) => funders.set(b, wallet()));
    run(w, mint, small.map((b, i): Step => [(i * 20) / n, b, 'buy', 0.05]));
    const smallSet = new Set(small);
    // R13-4: the second-hop lookups (the buyers' funders) come on top and do not use up the per-mint bound
    await vi.waitFor(() => expect(served.filter((x) => smallSet.has(x)).length).toBe(WATCH_FUNDER_SAMPLE_BUYERS));
    let m = w.evaluate(mint, T0 + 21_000)!.metrics;
    expect(m.rawUniqueBuyers).toBe(n);
    expect(m.funderCoverage).toBe(1);
    expect(m.signals.buyers!.pass).toBe(true);

    const whale = wallet();
    funders.set(whale, wallet());
    run(w, mint, [[21.5, whale, 'buy', 3]]);
    expect(served).not.toContain(whale); // the arrival sample is full
    m = w.evaluate(mint, T0 + 22_000)!.metrics; // the whale is now one of the largest: asked for here
    expect(m.funderCoverage).toBeLessThan(1);
    await vi.waitFor(() => expect(served).toContain(whale));
    await vi.waitFor(() => expect(w.getSnapshot(T0 + 22_000).watching[0].metrics.funderCoverage).toBe(1));
  });

  it('S264 (review 2026-10-24): buyers outside the sample with no known funder count as one cluster toward uniqueBuyers, so a small-wallet swarm cannot pass the gate', () => {
    const F = wallet();
    const big = Array.from({ length: WATCH_FUNDER_SAMPLE_BUYERS }, wallet); // the sample: all funded by F, one cluster
    const swarm = Array.from({ length: 60 }, wallet); // small buys outside the sample, funders never looked up
    const funderOf = (x: string) => (big.includes(x) ? F : undefined);
    const w = new WatchWindow({ publicFunders: [], funderOf });
    const mint = mintKey();
    w.watch(mint, wallet(), T0);
    run(w, mint, [...big.map((b, i): Step => [i * 0.1, b, 'buy', 0.5]), ...swarm.map((b, i): Step => [11 + i * 0.1, b, 'buy', 0.01])]);
    const m = w.evaluate(mint, T0 + 21_000)!.metrics;
    expect(m.rawUniqueBuyers).toBe(WATCH_FUNDER_SAMPLE_BUYERS + 60);
    expect(m.funderCoverage).toBe(1); // over the sample
    expect(m.uniqueBuyers).toBe(2); // F's cluster, plus one for every unknown buyer outside the sample (was 61)
    expect(m.signals.buyers!.pass).toBe(false);
  });

  it('a full queue drops the jobs of released mints first, then refuses', () => {
    let pending = 0;
    const conn: any = { getSignaturesForAddress: () => { pending++; return new Promise(() => undefined); }, getParsedTransaction: async () => null };
    const watching = new Set(['A', 'B']);
    const l = new FunderLookup(() => conn, { concurrency: 1, maxQueue: 3 });
    l.setWanted((m) => watching.has(m));
    for (let i = 0; i < 4; i++) l.request(wallet(), 'A'); // 1 in flight, 3 waiting
    l.request(wallet(), 'B');
    expect(l.getStats()).toMatchObject({ queued: 3, refusedFull: 1 });
    watching.delete('A');
    l.request(wallet(), 'B');
    expect(l.getStats()).toMatchObject({ queued: 1, dropped: 3, refusedFull: 1 });
    expect(pending).toBe(1);
  });
});
