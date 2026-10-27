import { describe, it, expect, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { FunderLookup, wireFunderLookup, FUNDER_FULL_HISTORY_MAX } from '../server/signals/funderLookup';
import { WatchWindow, VELOCITY_MIN_DISTINCT_WALLETS, FLOW_MIN_DISTINCT_BUYERS, HOT_MIN_UNIQUE_BUYERS } from '../server/signals/watchWindow';
import { replay, buyers, wallet, type Step } from './fixtures/watch';

/**
 * R2-1 / R8-2 (haiku 2026-10-26): every "distinct buyer" gate came down to a wallet's first funder, read from its oldest transaction. A decoy's
 * dust sent first hid the creator's transfer; self-funded (no-transfer) wallets each looked independent; velocity and flow counted trades and
 * SOL, so one wallet trading many times passed them.
 */
const T0 = 1_700_000_000_000;
const mintKey = () => Keypair.generate().publicKey.toBase58();
const run = (w: WatchWindow, mint: string, steps: Step[], start = T0) => { for (const { trade, at } of replay(mint, start, steps)) w.onTrade(trade, at); };
const transfer = (source: string, destination: string) => ({ program: 'system', parsed: { type: 'transfer', info: { source, destination, lamports: 1_000 } } });

/** A Connection whose wallets have the given histories, newest signature first as the RPC returns them; each tx is [instructions, feePayer?, walletSigned?]. */
function historyConn(histories: Map<string, Array<{ ixs: any[]; payer?: string }>>) {
  const calls = { sigs: 0, tx: 0 };
  const conn: any = {
    getSignaturesForAddress: async (key: any) => {
      calls.sigs++;
      const w = key.toBase58();
      const h = histories.get(w) ?? [];
      return h.map((_, i) => ({ signature: `${w}:${i}`, err: null })).reverse(); // newest first
    },
    getParsedTransaction: async (sig: string) => {
      calls.tx++;
      const [w, i] = sig.split(':');
      const t = histories.get(w)![Number(i)];
      const accountKeys = t.payer ? [{ pubkey: t.payer, signer: true }, { pubkey: w, signer: true }] : [{ pubkey: w, signer: true }];
      return { transaction: { message: { instructions: t.ixs, accountKeys } }, meta: { err: null, innerInstructions: [] } };
    },
  };
  return { conn, calls };
}

afterEach(() => vi.restoreAllMocks());

describe('R2-1: the funder lookup reads a short history in full', () => {
  it('a decoy dust transfer first does not hide the creator\'s transfer behind it', async () => {
    const creator = wallet(), decoy = wallet(), sybil = wallet();
    const { conn, calls } = historyConn(new Map([[sybil, [{ ixs: [transfer(decoy, sybil)] }, { ixs: [transfer(creator, sybil)] }, { ixs: [] }]]]));
    const r = await new FunderLookup(() => conn).lookup(sybil);
    expect(r).toEqual({ funder: decoy, alsoFundedBy: [creator] });
    // RPC cost: one signature page and one read per transaction (3 here; the old lookup read 1)
    expect(calls).toEqual({ sigs: 1, tx: 3 });
  });

  it('another wallet paying the fee of a transaction the wallet signed is a source', async () => {
    const creator = wallet(), sybil = wallet(), funder = wallet();
    const { conn } = historyConn(new Map([[sybil, [{ ixs: [transfer(funder, sybil)] }, { ixs: [], payer: creator }]]]));
    expect(await new FunderLookup(() => conn).lookup(sybil)).toEqual({ funder, alsoFundedBy: [creator] });
  });

  it(`a history longer than ${FUNDER_FULL_HISTORY_MAX} signatures is read at its oldest transaction only and reported partial`, async () => {
    const funder = wallet(), w = wallet();
    const h = Array.from({ length: FUNDER_FULL_HISTORY_MAX + 1 }, (_, i) => ({ ixs: i === 0 ? [transfer(funder, w)] : [] }));
    const { conn, calls } = historyConn(new Map([[w, h]]));
    expect(await new FunderLookup(() => conn).lookup(w)).toEqual({ funder, partial: true });
    expect(calls.tx).toBe(1);
  });

  it('wired to the window: the sybil\'s sell is CREATOR_SOLD (the first-funder rule let it through)', async () => {
    const creator = wallet(), decoy = wallet(), sybil = wallet();
    const { conn } = historyConn(new Map([[sybil, [{ ixs: [transfer(decoy, sybil)] }, { ixs: [transfer(creator, sybil)] }, { ixs: [] }]]]));
    const w = new WatchWindow({ publicFunders: [] });
    wireFunderLookup(w, new FunderLookup(() => conn));
    const mint = mintKey();
    w.watch(mint, creator, Date.now());
    run(w, mint, [[0, sybil, 'buy', 0.5], [1, sybil, 'sell', 0.4]], Date.now());
    await vi.waitFor(() => expect(w.getVerdict(mint)?.state).toBe('DEAD'));
    expect(w.getVerdict(mint)!.reason).toMatch(/^CREATOR_SOLD: a wallet the creator funded/);
  });
});

describe('R8-2: wallets not read in full are not independent buyers', () => {
  it(`${HOT_MIN_UNIQUE_BUYERS + 5} self-funded wallets (no transfer found) count as one buyer`, () => {
    const w = new WatchWindow({ publicFunders: [] });
    const mint = mintKey();
    w.watch(mint, wallet(), T0);
    const b = buyers(HOT_MIN_UNIQUE_BUYERS + 5, 25);
    b.wallets.forEach((x) => w.setNoFunder(x));
    run(w, mint, b.steps);
    const m = w.evaluate(mint, T0 + 26_000)!.metrics;
    expect(m.funderCoverage).toBe(1);
    expect(m.uniqueBuyers).toBe(1);
    expect(m.signals.buyers!.pass).toBe(false);
  });

  it('long-history wallets with distinct funders (partial reads) count as one buyer; the same wallets read in full count each', () => {
    const run2 = (verified: boolean) => {
      const w = new WatchWindow({ publicFunders: [] });
      const mint = mintKey();
      w.watch(mint, wallet(), T0);
      const b = buyers(30, 25);
      b.wallets.forEach((x, i) => w.setFunder(x, `own-funder-${i}`, T0, { verified }));
      run(w, mint, b.steps);
      return w.evaluate(mint, T0 + 26_000)!.metrics;
    };
    expect(run2(false).uniqueBuyers).toBe(1);
    expect(run2(false).signals.buyers!.pass).toBe(false);
    expect(run2(true).uniqueBuyers).toBe(30);
    expect(run2(true).signals.buyers!.pass).toBe(true);
  });

  it('two wallets sharing a later SOL source (not their first funder) are one cluster', () => {
    const w = new WatchWindow({ publicFunders: [] });
    const mint = mintKey();
    w.watch(mint, wallet(), T0);
    const [a, b] = [wallet(), wallet()];
    const shared = wallet();
    w.setFunder(a, wallet(), T0, { alsoFundedBy: [shared] });
    w.setFunder(b, wallet(), T0, { alsoFundedBy: [shared] });
    run(w, mint, [[0, a, 'buy', 0.5], [1, b, 'buy', 0.5]]);
    const m = w.evaluate(mint, T0 + 21_000)!.metrics;
    expect(m.uniqueBuyers).toBe(1);
    expect(m.largestBuyerShare).toBeCloseTo(1, 9);
  });
});

describe('R8-2 / R2-12: velocity and flow count distinct wallets, not trades', () => {
  it(`one wallet making 11 buys in 30 s passes neither velocity nor flow; ${VELOCITY_MIN_DISTINCT_WALLETS} wallets doing the same do`, () => {
    const once = (nWallets: number) => {
      const w = new WatchWindow({ publicFunders: [] });
      const mint = mintKey();
      w.watch(mint, wallet(), T0);
      const ws = Array.from({ length: nWallets }, wallet);
      ws.forEach((x, i) => w.setFunder(x, `f-${i}-${x}`));
      // 11 buys of 0.2 SOL between 25 s and 45 s (2.2 SOL in the last 30 s, less the two sells: 4.36 SOL/min raw), and two other wallets selling once
      const steps: Step[] = Array.from({ length: 11 }, (_, i): Step => [25 + i * 2, ws[i % nWallets], 'buy', 0.2]);
      steps.push([30, wallet(), 'sell', 0.01], [31, wallet(), 'sell', 0.01]);
      run(w, mint, steps);
      return w.evaluate(mint, T0 + 46_000)!.metrics.signals;
    };
    const one = once(1);
    expect(one.velocity!.rawSolPerMin).toBeCloseTo(4.36, 9); // (2.2 - 0.02 sold) x 2
    expect(one.velocity!.distinctWallets).toBe(1);
    expect(one.velocity!.pass).toBe(false);
    expect(one.flow!.buyCount).toBe(11);
    expect(one.flow!.buyWallets).toBe(1);
    expect(one.flow!.pass).toBe(false);
    const many = once(Math.max(VELOCITY_MIN_DISTINCT_WALLETS, FLOW_MIN_DISTINCT_BUYERS) + 1);
    expect(many.velocity!.pass).toBe(true);
    expect(many.flow!.pass).toBe(true);
  });

  it('wallets sharing one funder are one wallet for velocity', () => {
    const w = new WatchWindow({ publicFunders: [] });
    const mint = mintKey();
    w.watch(mint, wallet(), T0);
    const ws = Array.from({ length: 8 }, wallet);
    ws.forEach((x) => w.setFunder(x, 'one-funder'));
    run(w, mint, ws.map((x, i): Step => [25 + i * 2, x, 'buy', 0.3]));
    const v = w.evaluate(mint, T0 + 46_000)!.metrics.signals.velocity!;
    expect(v.distinctWallets).toBe(1);
    expect(v.solPerMin).toBeLessThan(1.5);
    expect(v.pass).toBe(false);
  });
});
