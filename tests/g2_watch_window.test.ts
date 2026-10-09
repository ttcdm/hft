import { describe, it, expect, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { WatchWindow, WATCH_MAX_CANDIDATES, WATCH_MIN_MS, WATCH_MAX_MS } from '../server/signals/watchWindow';
import { PumpFeedListener } from '../server/solana/pumpFeedListener';
import { replay, buyers, wallet, type Step } from './fixtures/watch';

const T0 = 1_700_000_000_000;
const mintOf = () => Keypair.generate().publicKey.toBase58();

function run(w: WatchWindow, mint: string, steps: Step[]) {
  for (const { trade, at } of replay(mint, T0, steps)) w.onTrade(trade, at);
}
/** 30 buyers over 25s, each with its own funder, and a couple of sells: every signal strong. */
function healthy(w: WatchWindow, mint: string, creator: string) {
  const b = buyers(30, 25);
  b.wallets.forEach((x, i) => w.setFunder(x, `funder-${i}`));
  run(w, mint, [...b.steps, [26, wallet(), 'sell', 0.05], [27, wallet(), 'sell', 0.05]]);
  return b;
}

describe('G2: watch window metrics replayed from trade fixtures', () => {
  it('buckets net inflow per 10s from the first trade and counts buys, sells and unique buyers', () => {
    const w = new WatchWindow();
    const mint = mintOf();
    const a = wallet(), b = wallet(), c = wallet();
    w.watch(mint, wallet(), T0 - 5_000);
    run(w, mint, [[0, a, 'buy', 1], [5, b, 'buy', 0.5], [12, c, 'sell', 0.25], [25, a, 'buy', 1]]);
    const m = w.getSnapshot(T0 + 26_000).watching[0].metrics;
    expect(m.netInflowPer10s).toEqual([1.5, -0.25, 1]);
    expect(m.cumulativeNetInflowSol).toBeCloseTo(2.25, 9);
    expect(m.buyCount).toBe(3);
    expect(m.sellCount).toBe(1);
    expect(m.buySellRatio).toBe(3);
    expect(m.rawUniqueBuyers).toBe(2);
    expect(m.buyVolumeSol).toBeCloseTo(2.5, 9);
    expect(m.largestBuyerShare).toBeCloseTo(2 / 2.5, 9); // wallet a bought 2 of 2.5 SOL
    expect(m.creatorSold).toBe(false);
    expect(m.firstTradeAt).toBe(T0); // measured from the first trade, not from when the watch began
  });

  it('buy:sell ratio is null (not Infinity) with no sells, and a repeated signature is counted once', () => {
    const w = new WatchWindow();
    const mint = mintOf();
    w.watch(mint, wallet());
    const x = wallet();
    const [{ trade, at }] = replay(mint, T0, [[0, x, 'buy', 1]]);
    w.onTrade(trade, at);
    w.onTrade(trade, at);
    const m = w.getSnapshot(T0 + 1000).watching[0].metrics;
    expect(m.tradeCount).toBe(1);
    expect(m.buySellRatio).toBeNull();
  });

  it('wallets with one funder, and everything the creator funded, count as one buyer', () => {
    const w = new WatchWindow();
    const mint = mintOf();
    const creator = wallet();
    w.watch(mint, creator);
    const shared = Array.from({ length: 5 }, wallet);
    const fromCreator = Array.from({ length: 4 }, wallet);
    const honest = Array.from({ length: 3 }, wallet);
    shared.forEach((x) => w.setFunder(x, 'one-funder'));
    fromCreator.forEach((x) => w.setFunder(x, creator));
    honest.forEach((x, i) => w.setFunder(x, `own-${i}`));
    run(w, mint, [creator, ...shared, ...fromCreator, ...honest].map((x, i): Step => [i, x, 'buy', 0.1])); // the creator buys its own token too
    const m = w.getSnapshot(T0 + 20_000).watching[0].metrics;
    expect(m.rawUniqueBuyers).toBe(13);
    expect(m.uniqueBuyers).toBe(1 + 1 + 3); // shared funder + (creator and the wallets it funded) + three independents
    expect(m.funderCoverage).toBe(1);
    expect(m.largestBuyerShare).toBeCloseTo(0.5 / 1.3, 9); // the shared-funder cluster bought 0.5 of 1.3 SOL
  });

  it('a funder that is itself a buyer shares one cluster with the wallets it funded', () => {
    const w = new WatchWindow();
    const mint = mintOf();
    w.watch(mint, wallet());
    const boss = wallet();
    const kids = Array.from({ length: 3 }, wallet);
    kids.forEach((k) => w.setFunder(k, boss));
    run(w, mint, [[0, boss, 'buy', 0.1], ...kids.map((k, i): Step => [i + 1, k, 'buy', 0.1])]);
    expect(w.getSnapshot(T0 + 10_000).watching[0].metrics.uniqueBuyers).toBe(1);
  });
});

describe('G2: release rules', () => {
  afterEach(() => undefined);

  it('a creator sell is an instant DEAD, even at 3s with strong inflow, and frees the slot', () => {
    const w = new WatchWindow();
    const mint = mintOf();
    const creator = wallet();
    w.watch(mint, creator);
    const released: string[] = [];
    w.on('release', (r) => released.push(r.state));
    run(w, mint, [[0, wallet(), 'buy', 2], [1, wallet(), 'buy', 2], [3, creator, 'sell', 0.01]]);
    expect(released).toEqual(['DEAD']);
    expect(w.isWatching(mint)).toBe(false);
    const r = w.evaluate(mint, T0 + 3_000)!;
    expect(r.state).toBe('DEAD');
    expect(r.reason).toMatch(/CREATOR_SOLD/);
    expect(r.metrics.creatorSold).toBe(true);
  });

  it('nothing but a creator sell releases before the 20s minimum, however strong the signals', () => {
    const w = new WatchWindow({ scoreOf: () => 95 });
    const mint = mintOf();
    w.watch(mint, wallet());
    healthy(w, mint, 'x');
    const r = w.evaluate(mint, T0 + WATCH_MIN_MS - 1)!;
    expect(r.state).toBe('WATCHING');
  });

  it('HOT: 25+ de-clustered buyers, small top buyer, rising velocity, buys > sells, and a score of 70+', () => {
    const w = new WatchWindow({ scoreOf: () => 82 });
    const mint = mintOf();
    w.watch(mint, wallet());
    healthy(w, mint, 'x');
    const r = w.evaluate(mint, T0 + 28_000)!;
    expect(r.state, r.reason).toBe('HOT');
    expect(r.score).toBe(82);
    expect(r.metrics.passingSignals).toBe(4);
    expect(r.metrics.signals.velocity?.rising).toBe(true);
    expect(r.metrics.signals.buyers).toMatchObject({ count: 30, pass: true });
  });

  it('a score under 70, or no score at all, never makes a token HOT; it becomes READY when the window ends', () => {
    for (const scoreOf of [() => 69, () => null]) {
      const w = new WatchWindow({ scoreOf });
      const mint = mintOf();
      w.watch(mint, wallet());
      healthy(w, mint, 'x');
      expect(w.evaluate(mint, T0 + 40_000)!.state).toBe('WATCHING');
      const r = w.evaluate(mint, T0 + WATCH_MAX_MS)!;
      expect(r.state).toBe('READY');
    }
  });

  it('30 buyers funded by ONE wallet are one buyer: not HOT, concentration fails', () => {
    const w = new WatchWindow({ scoreOf: () => 90 });
    const mint = mintOf();
    w.watch(mint, wallet());
    const b = buyers(30, 25);
    b.wallets.forEach((x) => w.setFunder(x, 'sybil-funder'));
    run(w, mint, b.steps);
    const m = w.getSnapshot(T0 + 28_000).watching[0].metrics;
    expect(m.rawUniqueBuyers).toBe(30);
    expect(m.uniqueBuyers).toBe(1);
    expect(m.signals.buyers?.pass).toBe(false);
    expect(m.signals.concentration?.pass).toBe(false);
    expect(w.evaluate(mint, T0 + 28_000)!.state).toBe('WATCHING');
  });

  it('with no funder data the buyer count is unverified and cannot count as a strong signal', () => {
    const w = new WatchWindow({ scoreOf: () => 90 });
    const mint = mintOf();
    w.watch(mint, wallet());
    run(w, mint, buyers(30, 25).steps);
    const m = w.getSnapshot(T0 + 28_000).watching[0].metrics;
    expect(m.uniqueBuyers).toBe(30);
    expect(m.funderCoverage).toBe(0);
    expect(m.signals.buyers?.pass).toBe(false);
  });

  it('DEAD when cumulative net inflow is negative once the minimum hold has passed', () => {
    const w = new WatchWindow({ scoreOf: () => 90 });
    const mint = mintOf();
    w.watch(mint, wallet());
    run(w, mint, [[0, wallet(), 'buy', 1], [5, wallet(), 'sell', 1.6], [10, wallet(), 'sell', 0.1]]);
    expect(w.evaluate(mint, T0 + 15_000)!.state).toBe('WATCHING'); // too early to judge
    const r = w.evaluate(mint, T0 + 21_000)!;
    expect(r.state).toBe('DEAD');
    expect(r.reason).toMatch(/NET_OUTFLOW/);
  });

  it('a watched token that never trades is DEAD at the end of the window', () => {
    const w = new WatchWindow();
    const mint = mintOf();
    w.watch(mint, wallet(), T0);
    expect(w.evaluate(mint, T0 + WATCH_MAX_MS - 1)!.state).toBe('WATCHING');
    expect(w.evaluate(mint, T0 + WATCH_MAX_MS)!.reason).toMatch(/NO_TRADES/);
  });

  it('holds at most 10 candidates; a release frees a slot', () => {
    const w = new WatchWindow();
    const mints = Array.from({ length: WATCH_MAX_CANDIDATES + 1 }, mintOf);
    const creators = mints.map(() => wallet());
    const accepted = mints.map((m, i) => w.watch(m, creators[i], T0));
    expect(accepted.filter(Boolean)).toHaveLength(WATCH_MAX_CANDIDATES);
    expect(accepted[WATCH_MAX_CANDIDATES]).toBe(false);
    run(w, mints[0], [[0, creators[0], 'sell', 0.1]]); // creator sell frees one
    expect(w.watch(mints[WATCH_MAX_CANDIDATES], creators[WATCH_MAX_CANDIDATES], T0)).toBe(true);
    expect(w.watch(mints[0], creators[0], T0)).toBe(false); // already released
  });

  it('tick releases everything that is due', () => {
    const w = new WatchWindow({ scoreOf: () => 80 });
    const mint = mintOf();
    w.watch(mint, wallet());
    healthy(w, mint, 'x');
    expect(w.tick(T0 + 10_000)).toEqual([]);
    expect(w.tick(T0 + 28_000).map((r) => r.state)).toEqual(['HOT']);
    expect(w.getSnapshot().released.map((r) => r.state)).toEqual(['HOT']);
  });
});

describe('G2: wired to the real PumpFeedListener', () => {
  it('a create event starts a watch and decoded TradeEvents feed it', () => {
    const w = new WatchWindow();
    const l = new PumpFeedListener();
    w.attach(l);
    const mint = mintOf();
    const creator = wallet();
    const ev = l.parseLogs({ err: null, signature: 'g2', logs: [PumpFeedListener.encodeCreateEventLog({ name: 'W', symbol: 'W', uri: '', mint, creator })] } as any, { slot: 5 })!;
    l.emit('create_event', ev);
    expect(w.isWatching(mint)).toBe(true);
    const [{ trade }] = replay(mint, Date.now(), [[0, wallet(), 'buy', 0.3]]);
    l.ingestTradeEvent(trade);
    expect(w.getSnapshot().watching[0].metrics.tradeCount).toBe(1);
    l.destroy();
  });
});
