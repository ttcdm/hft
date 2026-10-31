import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { WatchWindow, VELOCITY_MIN_DISTINCT_WALLETS, FLOW_MIN_DISTINCT_BUYERS, HOT_MIN_SIGNALS } from '../server/signals/watchWindow';
import { replay, buyers, wallet, type Step } from './fixtures/watch';

/**
 * R13-2 (haiku round 13): the R8-2 rule (wallets that are not independent count as ONE buyer) was applied only by the buyers signal.
 * Velocity and flow counted every cluster key, and a wallet with no known funder was a cluster of its own, so self-funded or long-history
 * sybils could carry two of the three signals HOT needs. Buyers with a pending funder lookup also did not hold the verdict, while pending
 * sellers did. Real WatchWindow; the funder lookup is a requester the test answers by hand.
 */
const T0 = 1_700_000_000_000;
const mintKey = () => Keypair.generate().publicKey.toBase58();
const run = (w: WatchWindow, mint: string, steps: Step[], start = T0) => { for (const { trade, at } of replay(mint, start, steps)) w.onTrade(trade, at); };
/** A window with a lookup wired; `answer(w)` is what the lookup says for a wallet (undefined: still pending). */
function wired(answer: (w: string) => { funder?: string; verified?: boolean } | null | undefined, opts: { score?: number } = {}) {
  const w = new WatchWindow({ publicFunders: [], scoreOf: () => opts.score ?? null });
  w.setFunderRequester((wallet) => {
    const a = answer(wallet);
    if (a === undefined) return true; // pending
    if (a === null) w.setNoFunder(wallet);
    else w.setFunder(wallet, a.funder!, T0, { verified: a.verified });
    return true;
  });
  return w;
}
/** n buyers 0.3 SOL each spread over the last 30 s before 50 s, after a small early buy, so velocity is rising. */
const lateBuys = (ws: string[]): Step[] => [[0, wallet(), 'buy', 0.01], ...ws.map((x, i): Step => [25 + i * (24 / ws.length), x, 'buy', 0.3])];

describe('R13-2: velocity and flow count wallets that are not independent as one buyer', () => {
  it('six self-funded buyers (the lookup found no source): velocity and flow see one distinct buyer, and neither passes', () => {
    const six = Array.from({ length: 6 }, wallet);
    const w = wired(() => null);
    const mint = mintKey();
    w.watch(mint, wallet(), T0);
    run(w, mint, lateBuys(six));
    const m = w.getSnapshot(T0 + 50_000).watching[0].metrics;
    expect(m.signals.velocity!.distinctWallets).toBeLessThanOrEqual(2); // the early buyer and the six together (was 7)
    expect(m.signals.velocity!.pass).toBe(false);
    expect(m.signals.flow!.buyWallets).toBeLessThan(FLOW_MIN_DISTINCT_BUYERS); // was 7
    expect(m.signals.flow!.pass).toBe(false);
  });

  it('six long-history buyers (funder found, history not read in full) are one buyer too', () => {
    const six = Array.from({ length: 6 }, wallet);
    const w = wired((x) => ({ funder: `old-${x}`, verified: false }));
    const mint = mintKey();
    w.watch(mint, wallet(), T0);
    run(w, mint, lateBuys(six));
    const m = w.getSnapshot(T0 + 50_000).watching[0].metrics;
    expect(m.signals.velocity!.pass).toBe(false);
    expect(m.signals.flow!.pass).toBe(false);
  });

  it(`${VELOCITY_MIN_DISTINCT_WALLETS} independent buyers plus three self-funded ones: ${VELOCITY_MIN_DISTINCT_WALLETS + 1} distinct, and both signals pass`, () => {
    const honest = Array.from({ length: VELOCITY_MIN_DISTINCT_WALLETS }, wallet), sybils = Array.from({ length: 3 }, wallet);
    const w = wired((x) => (honest.includes(x) ? { funder: `own-${x}` } : null));
    const mint = mintKey();
    w.watch(mint, wallet(), T0);
    run(w, mint, [[0, honest[0], 'buy', 0.01], ...[...honest, ...sybils].map((x, i): Step => [25 + i * 3, x, 'buy', 0.3])]);
    const m = w.getSnapshot(T0 + 50_000).watching[0].metrics;
    expect(m.signals.velocity!.distinctWallets).toBe(VELOCITY_MIN_DISTINCT_WALLETS + 1);
    expect(m.signals.velocity!.pass).toBe(true);
    expect(m.signals.flow!.buyWallets).toBe(VELOCITY_MIN_DISTINCT_WALLETS + 1);
    expect(m.signals.flow!.pass).toBe(true);
  });

  it('a buyer whose funder lookup is pending holds HOT, like a pending seller, until it answers', () => {
    const b = buyers(30, 25);
    const answered = new Map<string, string>(b.wallets.map((x, i) => [x, `funder-${i}`]));
    const w = wired((x) => (answered.has(x) ? { funder: answered.get(x)! } : undefined), { score: 80 });
    const mint = mintKey();
    w.watch(mint, wallet(), T0);
    const late = wallet(); // its lookup never answers by itself
    run(w, mint, [...b.steps, [26, late, 'buy', 0.05]]);
    const held = w.evaluate(mint, T0 + 28_000)!;
    expect(held.state).toBe('WATCHING');
    expect(held.reason).toMatch(/waiting for the funder of 1 buyer/);
    expect(held.metrics.passingSignals).toBeGreaterThanOrEqual(HOT_MIN_SIGNALS); // it would have been HOT
    w.setFunder(late, 'funder-late');
    expect(w.evaluate(mint, T0 + 29_000)!.state).toBe('HOT');
  });

  it('without a lookup wired (a replay of recordings with no funder history) unknown wallets still count apart, as before', () => {
    const six = Array.from({ length: 6 }, wallet);
    const w = new WatchWindow({ publicFunders: [] });
    const mint = mintKey();
    w.watch(mint, wallet(), T0);
    run(w, mint, lateBuys(six));
    const m = w.getSnapshot(T0 + 50_000).watching[0].metrics;
    expect(m.signals.flow!.buyWallets).toBe(7);
  });
});
