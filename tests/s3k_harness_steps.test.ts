import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  hasBudget, sessionSpendMatchesWallet, killSurvivesRestart, startSendHoldingRelay, freshMintIfExited, mintNeedsReplacing, reentryBlockedAfterExit,
  creatorClusterOnChain, releaseGatesOnChain,
  type HarnessSteps,
  type SessionSpendDeps, type KillRestartDeps, type ChildApp, type ChainKit,
} from '../scripts/devnet_e2e_steps';

/**
 * 3K: the devnet harness steps (m) for 3B and (o) for 3E. The real step functions; the app (auto controller, coordinator, child servers) and
 * the chain are stubs. What is checked: each step's lines pass against an app that behaves, the 3B and 3E lines FAIL against an app without
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
function fakeSessionApp(o: { countRent?: boolean; refuseAt?: number; loseReadAt?: number; makeThrows?: boolean; lossTriggersPending?: boolean; ackNotSaved?: boolean; recentKellyNegative?: boolean } = {}) {
  let lamports = 1_000_000_000;
  let reads = 0;
  const state = {
    mode: 'OFF', gating: true, budgets: { maxBuys: 5, maxSpendSol: 0.02 }, order: 0.005,
    session: null as null | { buys: number; spentSol: number }, open: [] as Array<{ id: string; mint: string; status: string }>,
    candidates: 0, cleaned: 0, closes: 0, acks: 0, ackedBeforeFirstBuy: false,
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
      resume: (r) => {
        if (!r.ackLossTriggers) return { halted: false, mode: state.mode };
        state.acks++;
        if (state.candidates === 0) state.ackedBeforeFirstBuy = true;
        return { halted: false, mode: state.mode, lossTriggersAcked: !o.ackNotSaved };
      },
      submitCandidate: async (c) => {
        const i = state.candidates++;
        // R8-8: the scratch DB's earlier harness trades trip the loss triggers until the operator acknowledges them
        if (o.lossTriggersPending && !(state.acks > 0 && !o.ackNotSaved)) {
          return { outcome: 'REJECTED', stage: 'execute', reason: 'REJECTED: LOSS_TRIGGERS: LOSS_STREAK (20 losses in a row (bug detector)), over the last LIVE trades (manual and auto). Check them, then acknowledge with POST /api/auto/resume {ackLossTriggers:true}' };
        }
        if (o.recentKellyNegative) return { outcome: 'REJECTED', stage: 'execute', reason: 'REJECTED: Capital sizing failed (NEGATIVE_RECENT_EXPECTANCY: raw Kelly -4.0000 over the last 25 closed LIVE trades, win rate 0.0%, payoff 0.25)' };
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
  it('earlier losing harness trades in the reused scratch DB (R8-8): the step acknowledges the loss triggers first, through the operator route, and every line passes', async () => {
    const r = recorder();
    const f = fakeSessionApp({ lossTriggersPending: true });
    await sessionSpendMatchesWallet({ ...r, coordinator: f.coordinator }, f.deps);
    expect(fails(r.recs), JSON.stringify(r.recs, null, 1)).toEqual([]);
    expect(f.state.ackedBeforeFirstBuy).toBe(true);
    expect(line(r.recs, 'loss triggers acknowledged')?.ok).toBe(true);
    expect(r.recs.filter((x) => x.step.includes('BOUGHT'))).toHaveLength(5);
  });
  it('an acknowledgement that could not be saved: a FAIL line, nothing bought, everything put back', async () => {
    const r = recorder();
    const f = fakeSessionApp({ lossTriggersPending: true, ackNotSaved: true });
    await sessionSpendMatchesWallet({ ...r, coordinator: f.coordinator }, f.deps);
    expect(line(r.recs, 'loss triggers acknowledged')?.ok).toBe(false);
    expect(f.state).toMatchObject({ candidates: 0, gating: true, mode: 'OFF', order: 0.005, cleaned: 1 });
  });
  it('the recent-window Kelly refusal (R8-8, no operator acknowledgement) on the first buy: a SKIP naming it, not a FAIL', async () => {
    const r = recorder();
    const f = fakeSessionApp({ recentKellyNegative: true });
    await sessionSpendMatchesWallet({ ...r, coordinator: f.coordinator }, f.deps);
    expect(fails(r.recs), JSON.stringify(r.recs, null, 1)).toEqual([]);
    const sk = r.recs.find((x) => x.skip);
    expect(sk?.detail).toMatch(/NEGATIVE_RECENT_EXPECTANCY/);
    expect(sk?.detail).toMatch(/APEX_E2E_SCRATCH/);
    expect(f.state).toMatchObject({ candidates: 1, gating: true, mode: 'OFF', cleaned: 1 });
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

// ---- (o) ----------------------------------------------------------------------------------------------------------------------------

/** A server whose saved state lives on a fake disk across boots. `persistBeforeAwait` is 3E's change. */
function fakeServers(o: { persistBeforeAwait: boolean; neverSells?: boolean; cleanupThrows?: boolean }) {
  const disk = { mode: 'OFF', killed: false, killReason: null as string | null, tripped: false, planted: [] as string[], positions: 0, threshold: 70 };
  const log: string[] = [];
  let onSend: (() => void) | null = null;
  let held = false;
  let running: { alive: boolean } | null = null;
  const relay = {
    holdNextSend: () => new Promise<void>((r) => { onSend = () => { held = true; r(); }; }),
    release: () => { held = false; log.push('release'); },
  };
  const boot = async (): Promise<ChildApp> => {
    if (running?.alive) throw new Error('two servers on one DB');
    const me = { alive: true };
    running = me;
    let mode = disk.mode === 'DEVNET_LIVE' ? 'SHADOW' : disk.mode; // S222: a saved DEVNET_LIVE comes back as SHADOW
    let alert = disk.tripped;
    disk.tripped = false;
    const killed = disk.killed;
    const killReason = disk.killReason;
    log.push('boot');
    return {
      async call(method, route, body: any) {
        if (!me.alive) throw new Error('server gone');
        if (route === '/api/execution/can-arm') return { status: 200, json: { allowed: !alert, reasons: alert ? ['The kill switch was on before the restart; clear KILL_SWITCH_WAS_ON with POST /api/auto/resume {clearHalt:true} before arming'] : [] } };
        if (route === '/api/execution/arm') return { status: 200, json: { success: !alert, message: 'armed' } };
        if (route === '/api/auto/threshold') { disk.threshold = body.threshold; return { status: 200, json: { success: true, value: body.threshold } }; } // R5-40: (o) sets 0 before its hand buy
        if (route === '/api/execution/trade' && disk.threshold > 0) return { status: 400, json: { success: false, error: `REJECTED: Confluence score 0/100 failed minimum threshold of ${disk.threshold}` } }; // a fresh coin scores 0
        if (route === '/api/execution/trade') { disk.positions++; return { status: 200, json: { success: true, lifecycleState: 'CONFIRMED', positionId: `pos${disk.positions}` } }; }
        if (route === '/api/auto/mode') { mode = body.mode; disk.mode = mode; return { status: 200, json: { success: true, mode } }; }
        if (route === '/api/auto/status') return { status: 200, json: { success: true, mode, killed, killReason } };
        if (route === '/api/auto/kill') {
          mode = 'OFF';
          if (o.persistBeforeAwait) { disk.mode = 'OFF'; disk.killed = true; disk.killReason = body.reason; }
          if (!o.neverSells && disk.planted.length) onSend?.();
          return new Promise(() => undefined); // the sell's reply is kept back: never answers
        }
        if (route === '/api/execution/kill-switch') { disk.mode = 'OFF'; disk.tripped = true; if (o.persistBeforeAwait) { disk.killed = true; disk.killReason = 'operator kill switch'; } return { status: 200, json: { success: true, killSwitchActive: true } }; }
        if (route === '/api/auto/resume') { if (body.clearHalt) alert = false; return { status: 200, json: { success: true } }; }
        return { status: 404, json: null };
      },
      kill: async () => { me.alive = false; log.push('kill'); },
      stop: async () => { me.alive = false; log.push('stop'); },
    };
  };
  const deps: KillRestartDeps = {
    boot, relay,
    buyBody: { mint: 'MINTo', symbol: 'O3K', name: '3K harness', amountSol: 0.01, confirmLive: true },
    plantAutoOwned: (id) => { if (running?.alive) throw new Error('planted while a server runs'); disk.planted.push(id); },
    fund: async () => { log.push('fund'); },
    cleanup: async () => { log.push('cleanup'); if (o.cleanupThrows) throw new Error('refund failed'); },
  };
  return { deps, disk, log, isHeld: () => held, isRunning: () => !!running?.alive };
}

describe('3K (o): the kill survives a restart (3E)', () => {
  it('an app that saves OFF before its awaits: every line passes; the relay is released, no server is left up, the wallet is cleaned up', async () => {
    const r = recorder();
    const f = fakeServers({ persistBeforeAwait: true });
    await killSurvivesRestart(r, f.deps);
    expect(fails(r.recs), JSON.stringify(r.recs, null, 1)).toEqual([]);
    for (const part of ['boot 3 (after a crash mid-kill): auto is OFF', 'killed, and why', 'can-arm lists KILL_SWITCH_WAS_ON', 'takes KILL_SWITCH_WAS_ON off']) expect(line(r.recs, part)?.ok).toBe(true);
    expect(f.disk.planted).toEqual(['pos1']);
    expect(f.log.filter((x) => x === 'kill')).toHaveLength(1);
    expect(f.log.at(-1)).toBe('cleanup');
    expect(f.isHeld()).toBe(false);
    expect(f.isRunning()).toBe(false);
  });
  it('an app that saves the mode only after the sells (3E missing): the OFF and killed lines after the crash FAIL', async () => {
    const r = recorder();
    const f = fakeServers({ persistBeforeAwait: false });
    await killSurvivesRestart(r, f.deps);
    expect(line(r.recs, 'boot 3 (after a crash mid-kill): auto is OFF')).toMatchObject({ ok: false, detail: 'mode SHADOW' });
    expect(line(r.recs, 'killed, and why')?.ok).toBe(false);
    expect(f.log.at(-1)).toBe('cleanup');
  });
  it('the kill never reaches a sell: a FAIL line, no restart checks, the wallet is still cleaned up', async () => {
    const r = recorder();
    const f = fakeServers({ persistBeforeAwait: true, neverSells: true });
    await killSurvivesRestart(r, f.deps);
    expect(line(r.recs, 'the kill reached its sell')?.ok).toBe(false);
    expect(line(r.recs, 'boot 3')).toBeUndefined();
    expect(f.log.at(-1)).toBe('cleanup');
    expect(f.isRunning()).toBe(false);
  });
  it('a refund that fails is a FAIL line pointing at the key files', async () => {
    const r = recorder();
    const f = fakeServers({ persistBeforeAwait: true, cleanupThrows: true });
    await killSurvivesRestart(r, f.deps);
    expect(fails(r.recs)).toEqual([expect.objectContaining({ step: expect.stringContaining('sell out and refund'), detail: expect.stringMatching(/refund failed.*temp-wallets/) })]);
  });
  it('underfunded: the budget check refuses before anything is funded', async () => {
    const r = recorder();
    expect(await hasBudget(r, '(o) 3E: kill survives a restart', async () => 0.2, 0.25, 'DEVNET_KILL_RESTART')).toBe(false);
    expect(r.recs[0]).toMatchObject({ step: '(o) 3E: kill survives a restart: funding', ok: false });
  });
});

describe('3K startSendHoldingRelay', () => {
  it('forwards a sendTransaction at once but keeps its reply back until release; other calls pass straight through', async () => {
    const seen: string[] = [];
    const upstream = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => { const m = JSON.parse(b).method; seen.push(m); res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: m })); });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const relay = await startSendHoldingRelay(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`);
    const post = (method: string) => fetch(relay.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }) }).then((r) => r.json());
    try {
      expect((await post('getSlot')).result).toBe('getSlot');
      const held = relay.holdNextSend();
      let answered = false;
      const send = post('sendTransaction').then((j) => { answered = true; return j; });
      await held;
      await new Promise((r) => setTimeout(r, 50));
      expect(seen).toContain('sendTransaction'); // it reached upstream (it can land)
      expect(answered).toBe(false); // but the caller has no answer
      expect((await post('getBalance')).result).toBe('getBalance'); // other calls still answer
      relay.release();
      expect((await send).result).toBe('sendTransaction');
      expect((await post('sendTransaction')).result).toBe('sendTransaction'); // not armed again: answered at once
    } finally {
      await relay.close();
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  });
});

// ---- 3F: a fresh harness coin for each step that buys after an exit ----

describe('3K 3F: freshMintIfExited', () => {
  const fakeKit = (o: { createThrows?: boolean; refundThrows?: boolean } = {}) => {
    const log: string[] = [];
    const kit = {
      newWallet: () => ({ publicKey: { toBase58: () => 'CREATOR' } }),
      transfer: async (_f: any, _t: any, sol: number) => { log.push(`lend ${sol}`); return 'sig'; },
      create: async () => { log.push('create'); if (o.createThrows) throw new Error('create failed'); return { mint: 'FRESH', curve: 'C' }; },
      refund: async () => { log.push('refund'); if (o.refundThrows) throw new Error('refund failed'); },
    } as unknown as ChainKit;
    return { kit, log };
  };
  const payer = { publicKey: { toBase58: () => 'PAYER' } };
  it('mintNeedsReplacing: any closed position, a loss, or an unreadable answer', () => {
    expect(mintNeedsReplacing({ lastExit: null, loss: null })).toBe(false);
    expect(mintNeedsReplacing({ lastExit: { positionId: 'p', exitedAt: 1 }, loss: null })).toBe(true);
    expect(mintNeedsReplacing({ lastExit: { positionId: 'p', exitedAt: 1 }, loss: { positionId: 'p', realizedLamports: -1 } })).toBe(true);
    expect(mintNeedsReplacing(null)).toBe(true);
  });
  it('a mint never closed: kept, nothing lent or made', async () => {
    const r = recorder(); const k = fakeKit();
    expect(await freshMintIfExited(r, '(g)', { mint: 'OLD', exits: () => ({ lastExit: null, loss: null }), kit: k.kit, creator: () => k.kit.newWallet(), payer })).toBe('OLD');
    expect(k.log).toEqual([]);
    expect(r.recs).toEqual([]);
  });
  it('a closed mint: a fresh coin, the creator lent before the create and refunded after', async () => {
    const r = recorder(); const k = fakeKit();
    expect(await freshMintIfExited(r, '(g)', { mint: 'OLD', exits: () => ({ lastExit: { positionId: 'p', exitedAt: 1 }, loss: null }), kit: k.kit, creator: () => k.kit.newWallet(), payer })).toBe('FRESH');
    expect(k.log).toEqual(['lend 0.012', 'create', 'refund']);
    expect(r.recs).toEqual([]);
  });
  it('the create fails: a FAIL line, null, and the creator is still refunded', async () => {
    const r = recorder(); const k = fakeKit({ createThrows: true });
    expect(await freshMintIfExited(r, '(n)', { mint: 'OLD', exits: () => null, kit: k.kit, creator: () => k.kit.newWallet(), payer })).toBeNull();
    expect(fails(r.recs)).toEqual([expect.objectContaining({ step: '(n): a fresh harness coin (3F)', detail: expect.stringMatching(/could not be read.*create failed/) })]);
    expect(k.log).toEqual(['lend 0.012', 'create', 'refund']);
  });
  it('the refund fails: a FAIL line naming the key, and the fresh coin is still used', async () => {
    const r = recorder(); const k = fakeKit({ refundThrows: true });
    expect(await freshMintIfExited(r, '(l)', { mint: 'OLD', exits: () => ({ lastExit: null, loss: { positionId: 'p', realizedLamports: -5 } }), kit: k.kit, creator: () => k.kit.newWallet(), payer })).toBe('FRESH');
    expect(fails(r.recs)).toEqual([expect.objectContaining({ step: '(l): refund CREATOR', detail: expect.stringMatching(/temp-wallets/) })]);
  });
});

describe('3K (p): no re-entry after an exit (3F)', () => {
  const fakeApp = (o: { blocks: boolean; noCoin?: boolean }) => {
    const r = recorder();
    const positions: Array<{ id: string; mint: string; status: string; realizedPnLSol?: number }> = [];
    const txs: Array<{ signature: string; orderId: string; direction: string; reconciliationState: string; mint: string }> = [];
    let lamports = 1_000_000_000;
    const modes: string[] = [];
    const steps: HarnessSteps = {
      coordinator: {
        syncRealWalletBalance: async () => lamports,
        executeTrade: async (req: any) => {
          if (positions.some((p) => p.mint === req.mint && p.status !== 'CLOSED')) return { success: false, lifecycleState: 'RISK_REJECTED', error: 'POSITION_ALREADY_OPEN' } as any;
          if (o.blocks && positions.some((p) => p.mint === req.mint)) return { success: false, lifecycleState: 'RISK_REJECTED', error: 'MINT_RECENTLY_EXITED: closed at a loss' } as any;
          const n = txs.length;
          txs.push({ signature: `sig${n}`, orderId: `o${n}`, direction: 'BUY', reconciliationState: 'CONFIRMED', mint: req.mint });
          positions.push({ id: `p${n}`, mint: req.mint, status: 'OPEN' });
          lamports -= 12_000_000;
          return { success: true, lifecycleState: 'CONFIRMED', txSignature: `sig${n}` } as any;
        },
        closePosition: async (id: string) => { const p = positions.find((x) => x.id === id)!; p.status = 'CLOSED'; p.realizedPnLSol = -0.002; lamports += 9_000_000; return { success: true }; },
      },
      curve: { calculateBuyQuote: () => null },
      db: { loadTransactions: () => txs, loadPositions: () => positions },
      riskLimits: () => ({ cooldownAfterFailedTradeMs: 0, cooldownPerMintMs: 0 }),
      chainErr: async () => null, mint: '', buildBuyRequest: async () => ({}) as any,
      rec: r.rec, skip: r.skip, sleep: r.sleep, link: (x) => x,
    };
    const prevAuto = process.env.AUTO_SNIPE_ENABLED;
    const deps = {
      makeCoin: async () => (o.noCoin ? null : 'COINP'),
      buildBuyRequestFor: async (m: string) => ({ mint: m }) as any,
      position: (id: string) => positions.find((p) => p.id === id),
      balanceLamports: async () => lamports,
      auto: { setMode: async (m: 'OFF' | 'DEVNET_LIVE') => { modes.push(`${m}:${process.env.AUTO_SNIPE_ENABLED}`); return { ok: true, mode: m }; } },
    };
    return { r, steps, deps, positions, modes, prevAuto };
  };
  it('an app with 3F: every line passes; auto ends OFF and AUTO_SNIPE_ENABLED is put back', async () => {
    const f = fakeApp({ blocks: true });
    await reentryBlockedAfterExit(f.steps, f.deps);
    expect(fails(f.r.recs), JSON.stringify(f.r.recs, null, 1)).toEqual([]);
    expect(f.r.recs.filter((x) => x.step.includes('refused MINT_RECENTLY_EXITED'))).toHaveLength(2);
    expect(f.modes).toEqual(['DEVNET_LIVE:true', 'OFF:true', `OFF:${f.prevAuto}`]);
    expect(process.env.AUTO_SNIPE_ENABLED).toBe(f.prevAuto);
  });
  it('an app without 3F: the re-buy goes through, its lines FAIL, and the cleanup sells it', async () => {
    const f = fakeApp({ blocks: false });
    await reentryBlockedAfterExit(f.steps, f.deps);
    expect(line(f.r.recs, 'after the cooldown: refused')?.ok).toBe(false);
    expect(line(f.r.recs, 'after the cooldown: wallet unchanged')?.ok).toBe(false);
    expect(f.positions.every((p) => p.status === 'CLOSED')).toBe(true);
    expect(line(f.r.recs, 'cleanup close 100%')?.ok).toBe(true);
  });
  it('no coin could be made: no buy, nothing else recorded by the step', async () => {
    const f = fakeApp({ blocks: true, noCoin: true });
    await reentryBlockedAfterExit(f.steps, f.deps);
    expect(f.positions).toEqual([]);
    expect(f.r.recs).toEqual([]);
  });
});

// ---- run 27: (i) sends a 429'd buyer buy again; (k) makes a pair again after a feed gap ---------------------------------------------------

/** (i) against a feed that judges everything as expected; buyer `slow`'s first buy of coin B is refused with the RPC's 429. */
function clusterKit(o: { heldAfter429: bigint }) {
  const buys: string[] = [];
  let n = 0;
  const kit = {
    newWallet: () => { const id = ++n; return { publicKey: { toBase58: () => `w${id}` }, id }; },
    transfer: async () => 'sig',
    create: async (_c: any, symbol: string) => ({ mint: symbol === 'P41A' ? 'A' : 'B', curve: 'c' }),
    buy: async (w: any, mint: string) => {
      buys.push(`${w.id}:${mint}`);
      if (mint === 'B' && w.id === 5 && buys.filter((b) => b === '5:B').length === 1) throw new Error('429 Too Many Requests: {"error":{"code":-32429}}');
      return 'sig';
    },
    sellAll: async () => null,
    tokenBalance: async () => o.heldAfter429,
    refund: async () => undefined,
  } as unknown as ChainKit;
  const feed = {
    snapshot: () => ({
      watching: [{ metrics: { mint: 'B', tradeCount: 5, rawUniqueBuyers: 5, funderCoverage: 1, uniqueBuyers: 1 } }],
      released: [{ state: 'DEAD', reason: 'CREATOR_SOLD: a wallet the creator funded sold', metrics: { mint: 'A', tradeCount: 1 } }],
      capacity: { active: 1, max: 60 },
    }),
  };
  return { kit, feed, buys };
}

describe('run 27: (i) sends a buyer buy that got a 429 again, only when the wallet holds none of the coin', () => {
  it('the buyer holds nothing after the 429: the buy is sent again and 5/5 land', async () => {
    const r = recorder();
    const { kit, feed, buys } = clusterKit({ heldAfter429: 0n });
    await creatorClusterOnChain({ ...r, link: (x: string) => x } as unknown as HarnessSteps, kit, feed as any, { publicKey: { toBase58: () => 'payer' } }, { sellAfterMs: 0, waitMs: 1_000 });
    expect(line(r.recs, '5 wallets from one funder bought together')).toMatchObject({ ok: true, detail: '5/5 buys confirmed' });
    expect(buys.filter((b) => b === '5:B')).toHaveLength(2);
    expect(fails(r.recs)).toEqual([]);
  });

  it('the buyer already holds the coin (the buy landed under the 429): not sent again, counted as landed', async () => {
    const r = recorder();
    const { kit, feed, buys } = clusterKit({ heldAfter429: 1_000n });
    await creatorClusterOnChain({ ...r, link: (x: string) => x } as unknown as HarnessSteps, kit, feed as any, { publicKey: { toBase58: () => 'payer' } }, { sellAfterMs: 0, waitMs: 1_000 });
    expect(line(r.recs, '5 wallets from one funder bought together')?.ok).toBe(true);
    expect(buys.filter((b) => b === '5:B')).toHaveLength(1);
  });
});

/** (k) with launches that a feed gap releases DEAD `gaps` times before they are released READY. */
function gatesHarness(gaps: number) {
  const r = recorder();
  let made = 0;
  let gapLeft = gaps;
  const verdict = new Map<string, { state: string; reason: string }>();
  const kit = {
    newWallet: () => ({ publicKey: { toBase58: () => 'w' } }),
    transfer: async () => 'sig',
    create: async () => {
      const mint = `M${++made}`;
      // a pair is two creates; a gap releases both of the pair
      const gapped = gapLeft > 0;
      verdict.set(mint, gapped ? { state: 'DEAD', reason: 'FEED_GAP: the log stream had a gap (SLOT_SILENCE); trades in it may be missing' } : { state: 'READY', reason: 'READY: 4 signals' });
      if (gapped && made % 2 === 0) gapLeft--;
      return { mint, curve: 'c' };
    },
    buy: async () => 'sig',
    sellAll: async () => null,
    refund: async () => undefined,
  } as unknown as ChainKit;
  const feed = { snapshot: () => ({ watching: [], released: [...verdict].map(([mint, v]) => ({ ...v, metrics: { mint } })), capacity: { active: 0, max: 60 } }) };
  const rows = (m: string) => verdict.get(m)?.state === 'READY' ? [{ autoMode: 'X', stage: 'execute', outcome: 'WOULD_BUY', reason: 'ok', inputs: { passingSignals: 4 } }] : [{ autoMode: 'X', stage: 'watch', outcome: 'DROPPED', reason: 'WATCH_DEAD: FEED_GAP', inputs: { passingSignals: 0 } }];
  const s = {
    ...r, link: (x: string) => x,
    stop: { arm: () => ({ success: true, message: '' }), auto: { setMode: async (mode: string) => ({ ok: true, mode }), getStatus: () => ({ mode: 'OFF' }) } },
  } as unknown as HarnessSteps;
  const deps = { decisions: rows, curveState: async () => null, progressPct: () => null, capPct: 60, buildBuyRequestFor: async () => ({}) as any, balanceSol: async () => 10, isLiveArmed: () => false };
  return { r, s, kit, feed, deps, made: () => made };
}

describe('run 27: (k) makes a pair again when a feed gap released it, and SKIPs after a second gap', () => {
  it('one gap in SHADOW: the pair is made again, then SHADOW and PAPER are judged and match', async () => {
    const h = gatesHarness(1);
    await releaseGatesOnChain(h.s, h.kit, h.feed as any, {}, h.deps as any, { buyers: 2, waitMs: 1_000 });
    expect(h.made()).toBe(6); // SHADOW twice, PAPER once
    expect(line(h.r.recs, 'SHADOW and PAPER decision rows match')?.ok).toBe(true);
    expect(fails(h.r.recs)).toEqual([]);
  });

  it('a gap twice in SHADOW: a SKIP, not a FAIL, and PAPER is not run', async () => {
    const h = gatesHarness(2);
    await releaseGatesOnChain(h.s, h.kit, h.feed as any, {}, h.deps as any, { buyers: 2, waitMs: 1_000 });
    expect(h.made()).toBe(4);
    expect(h.r.recs.find((x) => x.skip)?.detail).toMatch(/a feed gap again: .*FEED_GAP/);
    expect(fails(h.r.recs)).toEqual([]);
  });
});

describe('(k) a buy from a temp wallet that fails says why', () => {
  it('9/10 confirmed names the first failure, so a devnet run tells a rate limit or a refused read from a lost confirm', async () => {
    const h = gatesHarness(0);
    let n = 0;
    (h.kit as any).buy = async () => { if (n++ === 1) throw new Error('no curve state for M1'); return 'sig'; };
    await releaseGatesOnChain(h.s, h.kit, h.feed as any, {}, h.deps as any, { buyers: 2, waitMs: 1_000 });
    const l = h.r.recs.find((x) => /equal buys/.test(x.step) && !x.ok);
    expect(l?.detail).toMatch(/^1\/2 confirmed; first failure: no curve state for M1/);
  });
});
