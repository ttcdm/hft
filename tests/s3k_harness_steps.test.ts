import { describe, it, expect } from 'vitest';
import {
  hasBudget, sessionSpendMatchesWallet,
  type SessionSpendDeps,
} from '../scripts/devnet_e2e_steps';

/**
 * 3K: the devnet harness step (m) for 3B. The real step function; the app (auto controller, coordinator) and
 * the chain are stubs. What is checked: the step's lines pass against an app that behaves, the 3B line FAILs against an app without
 * the fix, a lost balance read is a SKIP, a failed path still cleans up (refunds) and puts back what it wrapped, and a failed refund is a
 * FAIL line. The steps against the real app and a real chain: `npx tsx scripts/localnet/harness_steps_3k.ts`.
 */
type Rec = { step: string; ok: boolean; detail: string; skip?: true };
const recorder = () => {
  const recs: Rec[] = [];
  return {
    recs,
    rec: (step: string, ok: boolean, detail: string) => { recs.push({ step, ok, detail }); },
    skip: (step: string, detail: string) => { recs.push({ step, ok: true, detail, skip: true }); },
    sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 1))),
  };
};
const fails = (recs: Rec[]) => recs.filter((r) => !r.ok);
const line = (recs: Rec[], part: string) => recs.find((r) => r.step.includes(part));

// ---- (m) ----------------------------------------------------------------------------------------------------------------------------

const RENT = 2_039_280;
const FEE = 5_000;
function fakeSessionApp(o: { countRent?: boolean; refuseAt?: number; loseReadAt?: number; makeThrows?: boolean } = {}) {
  let lamports = 1_000_000_000;
  let reads = 0;
  const state = {
    mode: 'OFF', gating: true, budgets: { maxBuys: 5, maxSpendSol: 0.02 }, order: 0.005,
    session: null as null | { buys: number; spentSol: number }, open: [] as Array<{ id: string; mint: string; status: string }>,
    candidates: 0, cleaned: 0, closes: 0,
  };
  const watch = { getVerdict: (_m: string): any => null };
  const origVerdict = watch.getVerdict;
  const coordinator = {
    executeTrade: async () => ({}) as any,
    syncRealWalletBalance: async () => lamports,
    closePosition: async (id: string) => { state.closes++; state.open = state.open.filter((p) => p.id !== id); lamports += Math.round(state.order * 0.98 * 1e9) + RENT; return { success: true }; },
  };
  const deps: SessionSpendDeps = {
    auto: {
      setMode: async (m) => { state.mode = m; if (m === 'DEVNET_LIVE') state.session = { buys: 0, spentSol: 0 }; else state.session = null; return { ok: true, mode: m }; },
      setBudget: (b) => { state.budgets = { ...b }; return { ok: true }; },
      getStatus: () => ({ mode: state.mode, budgets: { ...state.budgets }, session: state.session ? { ...state.session } : null }),
      orderSol: () => state.order,
      setOrderSol: (sol) => { state.order = sol; return { ok: true }; },
      submitCandidate: async (c) => {
        const i = state.candidates++;
        if (o.refuseAt === i) return { outcome: 'REJECTED', stage: 'eligibility', reason: 'ELIGIBILITY_CHECK_FAILED' };
        const v = watch.getVerdict(c.mint);
        if (v?.state !== 'HOT' || state.gating) return { outcome: 'DROPPED', stage: 'watch', reason: 'not wrapped' };
        const cost = Math.round(state.order * 1e9) + FEE + RENT;
        lamports -= cost;
        state.session!.buys++;
        state.session!.spentSol += (o.countRent === false ? cost - RENT : cost) / 1e9;
        state.open.push({ id: `p${i}`, mint: c.mint, status: 'OPEN' });
        return { outcome: 'BOUGHT', stage: 'fill', reason: 'LIVE Snipe', positionId: `p${i}` };
      },
    },
    watch,
    confluence: { getConfluenceGating: () => state.gating, setConfluenceGating: (on) => { state.gating = on; } },
    balanceLamports: async () => { reads++; if (o.loseReadAt !== undefined && reads > o.loseReadAt * 4 && reads <= o.loseReadAt * 4 + 8) throw new Error('429'); return lamports; },
    haltReason: () => null,
    openLive: () => state.open,
    makeCoins: async (n) => { if (o.makeThrows) throw new Error('create failed'); return Array.from({ length: n }, (_, i) => `MINT${i}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`); },
    cleanupCoins: async () => { state.cleaned++; },
  };
  return { deps, state, watch, origVerdict, coordinator };
}

describe('3K (m): a 5-buy DEVNET_LIVE session, spentSol against the wallet (3B)', () => {
  it('an app that counts every lamport the buy took: every line passes; verdict, gate, budget, order size and mode are put back; coins cleaned up', async () => {
    const r = recorder();
    const f = fakeSessionApp();
    await sessionSpendMatchesWallet({ ...r, coordinator: f.coordinator }, f.deps);
    expect(fails(r.recs), JSON.stringify(r.recs, null, 1)).toEqual([]);
    expect(r.recs.filter((x) => x.step.includes('BOUGHT'))).toHaveLength(5);
    expect(line(r.recs, "spentSol equals the wallet's drop")?.ok).toBe(true);
    expect(f.watch.getVerdict).toBe(f.origVerdict);
    expect(f.state).toMatchObject({ gating: true, mode: 'OFF', budgets: { maxBuys: 5, maxSpendSol: 0.02 }, order: 0.005, cleaned: 1, closes: 5 });
  });
  it('an app whose spentSol leaves out the token account rent (3B missing): the spentSol line FAILs with the gap', async () => {
    const r = recorder();
    const f = fakeSessionApp({ countRent: false });
    await sessionSpendMatchesWallet({ ...r, coordinator: f.coordinator }, f.deps);
    const l = line(r.recs, "spentSol equals the wallet's drop");
    expect(l?.ok).toBe(false);
    expect(l?.detail).toMatch(/gap 0\.0101/);
  });
  it('a balance read lost around one buy: the comparison is a SKIP, not a FAIL', async () => {
    const r = recorder();
    const f = fakeSessionApp({ loseReadAt: 2 });
    await sessionSpendMatchesWallet({ ...r, coordinator: f.coordinator }, f.deps);
    expect(fails(r.recs)).toEqual([]);
    expect(line(r.recs, "spentSol equals the wallet's drop")?.skip).toBe(true);
  });
  it('an auto buy refused: a FAIL line, no comparison is passed, and everything is still put back and cleaned up', async () => {
    const r = recorder();
    const f = fakeSessionApp({ refuseAt: 2 });
    await sessionSpendMatchesWallet({ ...r, coordinator: f.coordinator }, f.deps);
    expect(fails(r.recs).map((x) => x.step).join('|')).toMatch(/BOUGHT.*buys counted.*spentSol equals/);
    expect(line(r.recs, "spentSol equals the wallet's drop")?.detail).toMatch(/only 2 of 5/);
    expect(f.state).toMatchObject({ gating: true, mode: 'OFF', order: 0.005, cleaned: 1 });
    expect(f.watch.getVerdict).toBe(f.origVerdict);
  });
  it('making the coins throws: a FAIL line, the coins are still cleaned up, nothing left wrapped', async () => {
    const r = recorder();
    const f = fakeSessionApp({ makeThrows: true });
    await sessionSpendMatchesWallet({ ...r, coordinator: f.coordinator }, f.deps);
    expect(fails(r.recs)).toHaveLength(1);
    expect(fails(r.recs)[0].detail).toMatch(/create failed/);
    expect(f.state).toMatchObject({ gating: true, mode: 'OFF', cleaned: 1, candidates: 0 });
  });
  it('underfunded: the budget check refuses before the step makes anything', async () => {
    const r = recorder();
    expect(await hasBudget(r, '(m) 3B: DEVNET_LIVE session spend', async () => 0.1, 0.3, 'DEVNET_SESSION_SPEND')).toBe(false);
    expect(r.recs).toEqual([expect.objectContaining({ step: '(m) 3B: DEVNET_LIVE session spend: funding', ok: false })]);
  });
});

