import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  hasBudget, unreadableReservesRefused, rpcSwitchMovesFeed, sellerWhoNeverBought, lossFloorLatch, msToNextUtcMidnight, bootRefusesBadLimit,
  type HarnessSteps, type ChainKit, type WatchFeed,
} from '../scripts/devnet_e2e_steps';

/**
 * 3I: the Stage 3 devnet harness steps (s), (t) and (u). The real step functions; the app singletons, the chain kit and the RPC are stubs
 * (no network beyond the loopback relays (t) opens and never connects upstream). What is checked: a step refuses to start underfunded and
 * moves no SOL, it refunds every throwaway wallet on a failed path (a failed refund is a FAIL line), it puts back what it wrapped, and its
 * lines FAIL when the app misbehaves. The steps against the real app and a real chain: `npx tsx scripts/localnet/harness_steps.ts`.
 */
type Rec = { step: string; ok: boolean; detail: string };
const recorder = () => {
  const recs: Rec[] = [];
  return { recs, rec: (step: string, ok: boolean, detail: string) => recs.push({ step, ok, detail }), sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 1))), link: (x: string) => x };
};
const line = (recs: Rec[], part: string) => recs.find((r) => r.step.includes(part));

describe('3I hasBudget: an opt-in step refuses to start underfunded', () => {
  it('below the need: one FAIL funding line with the figures, false', async () => {
    const r = recorder();
    expect(await hasBudget(r, '(u) x', async () => 0.05, 0.15, 'DEVNET_SELLER_NEVER_BOUGHT')).toBe(false);
    expect(r.recs).toHaveLength(1);
    expect(r.recs[0]).toMatchObject({ step: '(u) x: funding', ok: false });
    expect(r.recs[0].detail).toMatch(/needs 0\.15 SOL free.*has 0\.0500/);
  });
  it('a balance that cannot be read is not enough', async () => {
    const r = recorder();
    expect(await hasBudget(r, '(t) x', async () => { throw new Error('429'); }, 0.1, 'DEVNET_FEED_SWITCH')).toBe(false);
    expect(r.recs[0].ok).toBe(false);
  });
  it('enough: true and no line', async () => {
    const r = recorder();
    expect(await hasBudget(r, '(t) x', async () => 0.1, 0.1, 'DEVNET_FEED_SWITCH')).toBe(true);
    expect(r.recs).toHaveLength(0);
  });
});

/** A wallet stub with a readable address. */
const wallet = (name: string) => ({ publicKey: { toBase58: () => `${name}1111111111` } });

/** A chain kit stub that records every call in order. `fail` makes one method throw. */
function stubKit(fail: Partial<Record<'create' | 'buy' | 'refund' | 'transferTokens', boolean>> = {}) {
  const calls: string[] = [];
  let n = 0;
  const names = ['creator', 'Wwallet', 'Xwallet', 'extra'];
  const kit = {
    newWallet: () => { const w = wallet(names[n++] ?? `w${n}`); calls.push(`newWallet ${w.publicKey.toBase58().slice(0, 7)}`); return w; },
    transfer: async (_f: any, to: any) => { calls.push(`transfer ${String(to?.toBase58?.() ?? to).slice(0, 7)}`); return 'sigT'; },
    create: async () => { calls.push('create'); if (fail.create) throw new Error('create failed'); return { mint: 'MINT11111111', curve: 'CURVE' }; },
    buy: async () => { calls.push('buy'); if (fail.buy) throw new Error('buy failed'); return 'sigB'; },
    sellAll: async (w: any) => { calls.push(`sellAll ${w.publicKey.toBase58().slice(0, 7)}`); return 'sigS'; },
    transferTokens: async () => { calls.push('transferTokens'); if (fail.transferTokens) throw new Error('no tokens'); return 'sigX'; },
    tokenBalance: async () => 1000n,
    refund: async (w: any) => { calls.push(`refund ${w.publicKey.toBase58().slice(0, 7)}`); if (fail.refund) throw new Error('refund failed'); },
    priceSol: async () => 1, curveState: async () => ({}) as any,
  };
  return { kit: kit as unknown as ChainKit, calls };
}

describe('3I (s): a LIVE buy with unreadable token reserves', () => {
  /** The coordinator, reduced to what (s) watches: it reads the curve through PumpCurveService, then refuses (fixed) or quotes and sends. */
  function harness(fixed: boolean, throws = false) {
    const r = recorder();
    const rows: any[] = [];
    const curve = {
      calculateBuyQuote: () => ({ tokenAmountRaw: '1', maxInputLamports: 1 }),
      fetchPumpMarketState: async (p: any) => ({ mint: p.mint, realSolReserves: 5n, realTokenReserves: 700n }),
    };
    const origFetch = curve.fetchPumpMarketState;
    const origQuote = curve.calculateBuyQuote;
    const coordinator = {
      syncRealWalletBalance: async () => undefined,
      closePosition: async () => ({ success: true }),
      executeTrade: async (req: any) => {
        const st = await curve.fetchPumpMarketState({ connection: {}, mint: { toBase58: () => req.mint }, executionMode: 'LIVE' });
        if (throws) throw new Error('injected');
        if (fixed && st.realTokenReserves === undefined) return { success: false, lifecycleState: 'RISK_REJECTED', error: 'CURVE_PROGRESS_UNREADABLE: unknown' };
        curve.calculateBuyQuote();
        rows.push({ signature: 'sig1', orderId: 'o', direction: 'BUY', reconciliationState: 'CONFIRMED', mint: req.mint });
        return { success: true, lifecycleState: 'CONFIRMED', txSignature: 'sig1' };
      },
    };
    const s = {
      ...r, coordinator, curve, mint: 'MINT11111111',
      db: { loadTransactions: () => rows, loadPositions: () => [] },
      buildBuyRequest: async () => ({ mint: 'MINT11111111' }),
    } as unknown as HarnessSteps;
    return { s, r, curve, origFetch, origQuote };
  }

  it('the app refuses: every line passes and both wrappers are put back', async () => {
    const h = harness(true);
    await unreadableReservesRefused(h.s);
    expect(h.r.recs.map((x) => x.ok)).toEqual([true, true, true, true]);
    expect(h.curve.fetchPumpMarketState).toBe(h.origFetch);
    expect(h.curve.calculateBuyQuote).toBe(h.origQuote);
  });

  it('an app that buys anyway (A1 missing): the refusal and nothing-sent lines FAIL', async () => {
    const h = harness(false);
    await unreadableReservesRefused(h.s);
    expect(line(h.r.recs, 'reserves wrapper used')?.ok).toBe(true);
    expect(line(h.r.recs, 'refused CURVE_PROGRESS_UNREADABLE')?.ok).toBe(false);
    expect(line(h.r.recs, 'nothing quoted or sent')?.ok).toBe(false);
  });

  it('executeTrade throws: the wrappers are still put back', async () => {
    const h = harness(true, true);
    await expect(unreadableReservesRefused(h.s)).rejects.toThrow('injected');
    expect(h.curve.fetchPumpMarketState).toBe(h.origFetch);
    expect(h.curve.calculateBuyQuote).toBe(h.origQuote);
  });
});

describe('3I (t): two quick RPC switches', () => {
  const PROG = 'PumpProgram1111';
  class FakeConn {
    private next = 0;
    constructor(readonly rpcEndpoint: string) {}
    onLogs(_p: unknown, _cb: unknown, _c?: unknown): number { return this.next++; }
    removeOnLogsListener(_id: number): Promise<void> { return Promise.resolve(); }
  }
  const RPC = 'http://127.0.0.1:9';

  function harness(opts: { orphan?: boolean; kit?: ChainKit; failSwitch?: boolean } = {}) {
    const r = recorder();
    const changes = new Set<(c: any) => void>();
    let current: any = new FakeConn(RPC);
    const switched: string[] = [];
    const coordinator = {
      getConnection: () => current,
      onConnectionChange: (fn: (c: any) => void) => { changes.add(fn); return () => { changes.delete(fn); }; },
      setRpcEndpoint: async (url: string) => {
        switched.push(url);
        await Promise.resolve();
        if (opts.failSwitch && url !== RPC) return { success: false, error: 'genesis mismatch' };
        current = new FakeConn(url);
        for (const fn of changes) fn(current);
        return { success: true };
      },
    };
    // A listener that moves its subscription on every notice; with `orphan` it never unsubscribes the old one (the B10 bug's outcome).
    const ee = new EventEmitter();
    let conn: any = null;
    let sub: number | null = null;
    let status = 'DISCONNECTED';
    const listener = {
      on: (e: string, f: any) => ee.on(e, f), off: (e: string, f: any) => ee.off(e, f),
      follow(src: any) {
        src.onConnectionChange((c: any) => { // moves at once, so it never interleaves with itself
          if (sub === null) { conn = c; return; }
          if (!opts.orphan) void conn.removeOnLogsListener(sub);
          conn = c;
          sub = c.onLogs(PROG, () => undefined, 'processed');
          status = 'RECONNECTING';
          ee.emit('feed_gap', { reason: 'ENDPOINT_SWITCH' });
          status = 'ACTIVE';
        });
      },
      start: async () => { conn = coordinator.getConnection(); sub = conn.onLogs(PROG, () => undefined, 'processed'); status = 'ACTIVE'; return true; },
      stop: async () => { if (sub !== null) await conn.removeOnLogsListener(sub); sub = null; status = 'DISCONNECTED'; },
      getTelemetry: () => ({ status, subscriptionId: sub, feedGaps: 0 }),
    };
    const k = stubKit();
    const feed: WatchFeed = { snapshot: () => ({ watching: [{ metrics: { mint: 'MINT11111111' } }], released: [], capacity: { active: 1, max: 10 } }) };
    const origOn = FakeConn.prototype.onLogs;
    const origOff = FakeConn.prototype.removeOnLogsListener;
    const deps = {
      listener, coordinator, Connection: FakeConn, pumpProgramId: PROG, rpcUrl: RPC, feed, kit: opts.kit ?? k.kit, payer: wallet('payer'),
      waitMs: 200, unsubscribeDelayMs: 0,
    };
    return { r, deps, calls: k.calls, switched, current: () => current, origOn, origOff };
  }

  it('a listener that moves its subscription: every line passes, the coordinator ends on its RPC, the creator is refunded', async () => {
    const h = harness();
    await rpcSwitchMovesFeed(h.r, h.deps as any);
    expect(h.r.recs.filter((x) => !x.ok)).toEqual([]);
    expect(line(h.r.recs, 'one live log subscription')?.ok).toBe(true);
    expect(h.current().rpcEndpoint).toBe(RPC);
    expect(h.calls.indexOf('newWallet creator')).toBeLessThan(h.calls.indexOf('transfer creator'));
    expect(h.calls).toContain('refund creator');
    expect(FakeConn.prototype.onLogs).toBe(h.origOn);
    expect(FakeConn.prototype.removeOnLogsListener).toBe(h.origOff);
  }, 30_000);

  it('a listener that leaves a subscription behind (the B10 bug): the subscription lines FAIL', async () => {
    const h = harness({ orphan: true });
    await rpcSwitchMovesFeed(h.r, h.deps as any);
    expect(line(h.r.recs, 'one live log subscription')?.ok).toBe(false);
    expect(line(h.r.recs, 'no subscription left on an old Connection')?.ok).toBe(false);
  }, 30_000);

  it('the launch fails: a FAIL line, the creator is still refunded, the wrappers and the RPC are put back', async () => {
    const k = stubKit({ create: true });
    const h = harness({ kit: k.kit });
    await rpcSwitchMovesFeed(h.r, h.deps as any);
    expect(h.r.recs.some((x) => x.step === '(t) B7/B10: two quick RPC switches' && !x.ok && /create failed/.test(x.detail))).toBe(true);
    expect(k.calls).toContain('refund creator');
    expect(h.current().rpcEndpoint).toBe(RPC);
    expect(FakeConn.prototype.onLogs).toBe(h.origOn);
  }, 30_000);

  it('a refund that fails is a FAIL line naming the wallet', async () => {
    const k = stubKit({ refund: true });
    const h = harness({ kit: k.kit });
    await rpcSwitchMovesFeed(h.r, h.deps as any);
    expect(h.r.recs.some((x) => /refund creator1111111111/.test(x.step) && !x.ok)).toBe(true);
  }, 30_000);
});

describe('3I (u): a seller that never bought', () => {
  /** The watch window, reduced: the launch is watched once created, counts X's buy, and is released DEAD CREATOR_SOLD once W sells. */
  function feedFor(calls: string[], sellReleases = true): WatchFeed {
    return {
      snapshot: () => {
        const created = calls.includes('create');
        const bought = calls.includes('buy');
        const wSold = calls.includes('sellAll Wwallet');
        if (!created) return { watching: [], released: [], capacity: { active: 0, max: 10 } };
        const metrics = { mint: 'MINT11111111', tradeCount: bought ? 1 : 0 };
        if (wSold && sellReleases) return { watching: [], released: [{ state: 'DEAD', reason: 'CREATOR_SOLD: a wallet the creator funded (Wwalle) sold, instant reject', metrics }], capacity: { active: 0, max: 10 } };
        return { watching: [{ metrics }], released: [], capacity: { active: 1, max: 10 } };
      },
    };
  }

  it('every key is made before any SOL moves; the app releases CREATOR_SOLD: every line passes; all three wallets refunded', async () => {
    const r = recorder();
    const k = stubKit();
    await sellerWhoNeverBought(r, k.kit, feedFor(k.calls), wallet('payer'), { waitMs: 100 });
    expect(r.recs.filter((x) => !x.ok)).toEqual([]);
    expect(r.recs).toHaveLength(4);
    const firstTransfer = k.calls.findIndex((c) => c.startsWith('transfer'));
    expect(k.calls.slice(0, firstTransfer)).toEqual(['newWallet creator', 'newWallet Wwallet', 'newWallet Xwallet']);
    // W is funded by the creator before X's tokens reach it, so the creator is W's funder
    expect(k.calls.indexOf('transfer Wwallet')).toBeLessThan(k.calls.indexOf('transferTokens'));
    for (const w of ['Wwallet', 'Xwallet', 'creator']) expect(k.calls).toContain(`refund ${w}`);
  });

  it('an app that never looks the seller up (B3 missing): the CREATOR_SOLD line FAILs', async () => {
    const r = recorder();
    const k = stubKit();
    await sellerWhoNeverBought(r, k.kit, feedFor(k.calls, false), wallet('payer'), { waitMs: 100 });
    expect(line(r.recs, 'shows DEAD CREATOR_SOLD')?.ok).toBe(false);
  });

  it('a failed buy: a FAIL line, and W, X and the creator are still sold out and refunded', async () => {
    const r = recorder();
    const k = stubKit({ buy: true });
    await sellerWhoNeverBought(r, k.kit, feedFor(k.calls), wallet('payer'), { waitMs: 100 });
    expect(r.recs.some((x) => x.step === '(u) B3: a seller that never bought' && !x.ok && /buy failed/.test(x.detail))).toBe(true);
    for (const w of ['Wwallet', 'Xwallet', 'creator']) {
      expect(k.calls).toContain(`sellAll ${w}`);
      expect(k.calls).toContain(`refund ${w}`);
    }
  });

  it('refunds that fail are FAIL lines, one per wallet', async () => {
    const r = recorder();
    const k = stubKit({ refund: true });
    await sellerWhoNeverBought(r, k.kit, feedFor(k.calls), wallet('payer'), { waitMs: 100 });
    expect(r.recs.filter((x) => /: refund /.test(x.step) && !x.ok)).toHaveLength(3);
  });
});

describe('3I (n): the net daily PnL floor step (3C)', () => {
  /** The app reduced to what (n) drives: one realized loss per round trip, gate 10 with its latch, and the resume flags. */
  function harness(opts: { latchWorks?: boolean; throwOn?: number; syncOk?: (n: number) => boolean; bankrollOn?: number[]; priceOn?: number } = {}) {
    const r = recorder();
    const skips: Array<{ step: string; detail: string }> = [];
    let syncs = 0;
    const rows: any[] = [];
    let floorUsd = 7;
    let pnl = 0;
    let latch: { at: number; message: string } | null = null;
    let open: any[] = [];
    let calls = 0;
    const clockSeen: number[] = [];
    const coordinator = {
      syncRealWalletBalance: async () => ((opts.syncOk ?? (() => true))(++syncs) ? 1 : null),
      closePosition: async (id: string) => { open = open.filter((p) => p.id !== id); pnl -= 0.0016; return { success: true }; },
      executeTrade: async () => {
        calls++;
        clockSeen.push(Date.now());
        if (opts.throwOn === calls) throw new Error('injected');
        if (opts.bankrollOn?.includes(calls)) return { success: false, lifecycleState: 'RISK_REJECTED', error: 'INSUFFICIENT_SPENDABLE_BANKROLL: Spendable bankroll is 0.0000 SOL' };
        if (opts.priceOn === calls) return { success: false, lifecycleState: 'RISK_REJECTED', error: 'SOL_PRICE_UNAVAILABLE: stale' };
        const floorSol = floorUsd / 150;
        if (latch && opts.latchWorks !== false) return { success: false, lifecycleState: 'RISK_REJECTED', error: 'DAILY_LOSS_LIMIT: Net daily PnL floor latched at x; the oldest loss in the 24 h window leaves it at y' };
        if (pnl <= -floorSol) { latch = { at: Date.now(), message: 'm' }; return { success: false, lifecycleState: 'RISK_REJECTED', error: 'DAILY_LOSS_LIMIT: Net daily PnL floor: reached; latched until an operator clears it' }; }
        rows.push({ signature: `s${calls}`, orderId: 'o', direction: 'BUY', reconciliationState: 'CONFIRMED', mint: 'MINT11111111' });
        open.push({ id: `p${calls}`, mint: 'MINT11111111', status: 'OPEN' });
        return { success: true, lifecycleState: 'CONFIRMED', txSignature: `s${calls}` };
      },
    };
    const s = {
      ...r, skip: (step: string, detail: string) => skips.push({ step, detail }), coordinator, mint: 'MINT11111111', curve: {} as any,
      db: { loadTransactions: () => rows, loadPositions: () => open },
      riskLimits: () => ({ cooldownAfterFailedTradeMs: 15_000, cooldownPerMintMs: 0 }),
      buildBuyRequest: async () => ({ mint: 'MINT11111111' }),
    } as unknown as HarnessSteps;
    const restamps: number[] = [];
    const d = {
      floorUsd: () => floorUsd, setFloorUsd: (u: number) => { floorUsd = u; },
      price: () => ({ usd: 150, source: 'TEST' }), refreshPrice: async () => { restamps.push(Date.now()); },
      dailyPnlSol: () => pnl, latch: () => latch, clearLatch: () => { latch = null; },
      resume: (o: { clearDailyLossLatch?: boolean }) => { if (o.clearDailyLossLatch) latch = null; return {}; },
      orderSol: 0.01,
    };
    return { s, r, d, skips, calls: () => calls, floor: () => floorUsd, latch: () => latch, open: () => open, clockSeen, restamps };
  }

  it('an app with the floor and latch: every line passes; the floor, latch and clock are put back', async () => {
    const h = harness();
    const realNow = Date.now;
    await lossFloorLatch(h.s, h.d);
    expect(h.r.recs.filter((x) => !x.ok)).toEqual([]);
    expect(h.r.recs.length).toBeGreaterThanOrEqual(9);
    expect(h.floor()).toBe(7);
    expect(h.latch()).toBeNull();
    expect(Date.now).toBe(realNow);
    // one executeTrade ran past the next 00:00 UTC, and the price was read under that clock and again after
    expect(h.clockSeen.some((t) => t - realNow() > msToNextUtcMidnight(realNow()))).toBe(true);
    expect(h.restamps).toHaveLength(2);
  });

  it('an app without the latch: the latched lines FAIL', async () => {
    const h = harness({ latchWorks: false });
    await lossFloorLatch(h.s, h.d);
    expect(line(h.r.recs, 'floor raised back')?.ok).toBe(false);
    expect(h.open()).toEqual([]); // the buy that got through is closed in finally
  });

  it('executeTrade throws mid-step: a FAIL line; floor, latch and clock still put back', async () => {
    const realNow = Date.now;
    const h = harness({ throwOn: 4 }); // the buy under the jumped clock
    await lossFloorLatch(h.s, h.d);
    expect(h.r.recs.some((x) => x.step === '(n) 3C: net daily PnL floor' && !x.ok)).toBe(true);
    expect(Date.now).toBe(realNow);
    expect(h.floor()).toBe(7);
    expect(h.latch()).toBeNull();
  });

  it('msToNextUtcMidnight', () => {
    expect(msToNextUtcMidnight(Date.UTC(2026, 9, 26, 23, 59, 0))).toBe(60_000);
    expect(msToNextUtcMidnight(Date.UTC(2026, 9, 31, 0, 0, 0))).toBe(86_400_000);
  });

  it('boot check: passes on a refusal with no outbound attempt, FAILs when the server got further', () => {
    const r = recorder();
    bootRefusesBadLimit(r, () => ({ status: 1, stdout: '', stderr: 'Error: MAX_POSITION_SIZE_SOL="abc" is not a number above 0. Fix it' }), '/nonexistent/x.db');
    bootRefusesBadLimit(r, () => ({ status: null, stdout: '', stderr: '[devnet-guard] allow   fetch http://127.0.0.1:9' }), '/nonexistent/x.db');
    expect(r.recs.map((x) => x.ok)).toEqual([true, false]);
  });

  it('run 16: a buy refused INSUFFICIENT_SPENDABLE_BANKROLL (balance read lost) is re-synced and retried, then must still latch', async () => {
    // calls: 1 round-trip buy, 2 tight, 3 raised, 4 clock, 5 clearHalt, 6 clearDailyLossLatch (lost balance), 7 its retry
    const h = harness({ bankrollOn: [6] });
    await lossFloorLatch(h.s, h.d);
    expect(h.r.recs.filter((x) => !x.ok)).toEqual([]);
    expect(h.skips).toEqual([]);
    expect(h.calls()).toBe(7);
    expect(line(h.r.recs, 'refused and latched again')?.detail).toMatch(/try 2/);
  });

  it('a balance sync that never recovers: that check is a SKIP with the reason, not a FAIL; nothing is accepted in its place', async () => {
    // syncs: 1 before the round trip, then 2.. for the refusal checks; from the 6th sync on, every read fails
    const h = harness({ syncOk: (n) => n < 6 });
    await lossFloorLatch(h.s, h.d);
    expect(h.r.recs.filter((x) => !x.ok)).toEqual([]);
    expect(h.skips.length).toBeGreaterThan(0);
    expect(h.skips[0].detail).toMatch(/could not be read \(5 tries/);
  });

  it('a refusal that is neither the floor nor a lost balance (a stale price) still FAILs', async () => {
    const h = harness({ priceOn: 6 });
    await lossFloorLatch(h.s, h.d);
    expect(line(h.r.recs, 'refused and latched again')?.ok).toBe(false);
    expect(h.skips).toEqual([]);
  });

  it('INSUFFICIENT_SPENDABLE_BANKROLL on all 3 tries: SKIP, not FAIL', async () => {
    const h = harness({ bankrollOn: [6, 7, 8] });
    await lossFloorLatch(h.s, h.d);
    expect(h.r.recs.filter((x) => !x.ok)).toEqual([]);
    expect(h.skips).toHaveLength(1);
    expect(h.skips[0].detail).toMatch(/all 3 tries/);
  });
});
