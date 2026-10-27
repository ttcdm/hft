import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { autoSnipeController, DEVNET_CONFIRMATION_CODE, pendingReleaseMaxAgeMs, PENDING_RELEASE_MAX_AGE_MS, RELEASE_RETRY_MS } from '../server/auto/controller';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { executionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';
import { solPriceService } from '../server/market/solPriceService';
import { riskEngine } from '../server/risk/riskEngine';
import { onChainPoolStats, CURVE_INITIAL_REAL_TOKENS } from '../server/market/poolStats';
import { WatchWindow, watchWindow, readyGate, READY_MIN_SIGNALS } from '../server/signals/watchWindow';
import { CurveVelocityEvaluator, ACCELERATION_WINDOW_MS } from '../server/signals/curveVelocityEvaluator';
import { wireWatchPins } from '../server/signals/watchPins';
import { maxCurveProgressPct, MAX_CURVE_PROGRESS_PCT_DEFAULT } from '../server/signals/curveProgressCap';
import { setConfluenceThreshold, resetConfluenceThreshold, CONFLUENCE_DEVNET_LIVE_FLOOR } from '../server/signals/confluenceThreshold';
import { PumpCurveService } from '../server/solana/pumpCurve';
import type { PumpTradeEvent } from '../server/solana/pumpFeedListener';
import { setAutoMode, resetAuto, newPumpPool } from './fixtures/auto';
import { replay, buyers, wallet, type Step } from './fixtures/watch';
import { createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';
import { replayLaunch, type RecordedLaunch } from '../server/backtest/replay';
import { eventToJson } from '../server/backtest/launchRecorder';
import { readyGroupOf, summarizeReadyStrength } from '../scripts/recorder_backtest/ready_strength';

/**
 * P4.3 (R1-56, R1-57, R1-58, R1-46, R1-59): release gates. The real AutoSnipeController, WatchWindow, CurveVelocityEvaluator and OnChainPoolStats;
 * a fake clock (Date only) where an age matters; doubles only for the curve read (PumpCurveService.fetchPumpMarketState, as the Q7 tests do) and,
 * where a buy must be held in flight, the aggregator's executeSnipe.
 */

// This file's own score for the process-wide window (set after the fixture's, so it wins): a mint scores what `scores` says.
const scores = new Map<string, number>();
watchWindow.setScoreFn((m) => scores.get(m) ?? null);

const cand = (mint: string, source: 'TEST' | 'WATCH_WINDOW' = 'TEST') => ({ mint, symbol: 'P43', source, amountUsd: 0.7, provenance: 'REAL_ONCHAIN' as const });

/** Release a mint READY at `now` on the process-wide window: `n` buyers of `sol` each (equal sizes), plus optional extra steps. */
function releaseReady(mint: string, steps: Parameters<typeof replay>[2], score: number, now = Date.now()): void {
  const start = now - 120_000;
  scores.set(mint, score);
  watchWindow.watch(mint, wallet(), start);
  for (const { trade, at } of replay(mint, start, steps)) watchWindow.onTrade(trade, at);
  watchWindow.evaluate(mint, now);
}

/** Release a mint HOT at `now`: 30 buyers with known (distinct) funders over 25 s, two small sells, score 80. */
function releaseHot(mint: string, now = Date.now()): void {
  const start = now - 28_000;
  scores.set(mint, 80);
  watchWindow.watch(mint, wallet(), start);
  const b = buyers(30, 25);
  b.wallets.forEach((w, i) => watchWindow.setFunder(w, `p43-funder-${mint.slice(0, 6)}-${i}`));
  for (const { trade, at } of replay(mint, start, [...b.steps, [26, wallet(), 'sell', 0.05], [27, wallet(), 'sell', 0.05]])) watchWindow.onTrade(trade, at);
  watchWindow.evaluate(mint, now);
}

/** A trade on the measured pool stats that leaves `soldPct` of the curve's tokens sold. */
function tradeAtProgress(mint: string, soldPct: number, sig: string): PumpTradeEvent {
  const remaining = (CURVE_INITIAL_REAL_TOKENS * BigInt(Math.round((100 - soldPct) * 100))) / 10_000n;
  return {
    signature: sig, slot: 5000, mint, solAmountLamports: 100_000_000n, tokenAmount: 1_000_000n, isBuy: true, user: wallet(), timestampSec: Math.floor(Date.now() / 1000),
    virtualSolReserves: 60n * 1_000_000_000n, virtualTokenReserves: remaining + 279_900_000_000_000n, realSolReserves: 30n * 1_000_000_000n, realTokenReserves: remaining,
  };
}

const curveAt = (mint: string, soldPct: number) => createSimulatedBondingCurveState({
  mint: new PublicKey(mint), creator: new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM'),
  realTokenReserves: (CURVE_INITIAL_REAL_TOKENS * BigInt(Math.round((100 - soldPct) * 100))) / 10_000n, marketDataTimestamp: Date.now(),
});

async function until(cond: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
}

describe('P4.3: release gates', () => {
  beforeEach(() => { memecoinAggregator.setConfluenceGating(false); solPriceService.setPrice(150, 'TEST_FIXTURE'); });
  afterEach(async () => {
    vi.useRealTimers();
    await resetAuto();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetConfluenceThreshold();
    memecoinAggregator.setConfluenceGating(true);
    for (const p of workstationDb.loadPositions('PAPER', 'ACTIVE')) await executionCoordinator.closePosition(p.id, 100, 'MANUAL');
  });

  it('R1-56: a READY release with concentration failing and 1 passing signal at score 75 is REJECTED at the watch stage, before any execution call', async () => {
    await setAutoMode('PAPER');
    const snipe = vi.spyOn(memecoinAggregator, 'executeSnipe');
    const { mint } = newPumpPool('NONE');
    // one wallet has 80% of the buy volume; R8-2: flow needs five distinct buying wallets, so five small ones make it the one passing signal
    releaseReady(mint, [[0, wallet(), 'buy', 1.0], ...[2, 4, 6, 8, 10].map((t): Step => [t, wallet(), 'buy', 0.05])], 75);
    const v = watchWindow.getVerdict(mint)!;
    expect([v.state, v.score, v.passingSignals, v.concentrationPass]).toEqual(['READY', 75, 1, false]);
    const d = await autoSnipeController.submitCandidate(cand(mint));
    expect([d.outcome, d.stage]).toEqual(['REJECTED', 'watch']);
    expect(d.reason).toMatch(/^READY_TOO_WEAK: concentration fails/);
    expect(snipe).not.toHaveBeenCalled();
    const rows = workstationDb.loadDecisions({ mint });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.inputs?.passingSignals).toBe(1); // the queue row and the decision row both carry it
  });

  it('R1-56: a READY release with concentration passing and READY_MIN_SIGNALS signals goes on, with the score gate', async () => {
    await setAutoMode('PAPER');
    const snipe = vi.spyOn(memecoinAggregator, 'executeSnipe').mockResolvedValue({ success: false, message: 'stub', txHash: '' });
    const { mint } = newPumpPool('NONE');
    releaseReady(mint, buyers(10, 15).steps, 75);
    const v = watchWindow.getVerdict(mint)!;
    expect(v.passingSignals).toBe(READY_MIN_SIGNALS);
    expect(readyGate(v.metrics!).pass).toBe(true);
    await autoSnipeController.submitCandidate(cand(mint));
    expect(snipe).toHaveBeenCalledTimes(1);
    expect(snipe.mock.calls[0][0].enforceConfluence).toBe(true);
    expect(workstationDb.loadDecisions({ mint }).every((r) => r.inputs?.passingSignals === READY_MIN_SIGNALS)).toBe(true);
  });

  it('R1-56: DEVNET_LIVE never buys below a score of 50, whatever the threshold; PAPER keeps the threshold as set', async () => {
    expect(setConfluenceThreshold(30).ok).toBe(true);
    await setAutoMode('PAPER');
    const paperSnipe = vi.spyOn(memecoinAggregator, 'executeSnipe').mockResolvedValue({ success: false, message: 'stub', txHash: '' });
    const a = newPumpPool('NONE').mint; releaseHot(a);
    await autoSnipeController.submitCandidate(cand(a));
    expect(paperSnipe.mock.calls[0][0].enforceConfluence).toBeFalsy();
    await resetAuto();
    paperSnipe.mockRestore(); // only this spy: the setup file's genesis-hash spy must stay

    vi.stubEnv('ALLOWED_CLUSTER', 'devnet');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    vi.spyOn(executionCoordinator, 'isLiveArmed').mockReturnValue(true); // S236: DEVNET_LIVE needs the coordinator armed
    const armed = await autoSnipeController.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE });
    expect(armed.ok, armed.error).toBe(true);
    const snipe = vi.spyOn(memecoinAggregator, 'executeSnipe').mockResolvedValue({ success: false, message: 'stub', txHash: '' });
    const b = newPumpPool('NONE').mint; releaseHot(b);
    await autoSnipeController.submitCandidate(cand(b));
    expect(snipe.mock.calls[0][0].enforceConfluence).toBe(true);
    expect(snipe.mock.calls[0][0].minConfluenceScore).toBe(CONFLUENCE_DEVNET_LIVE_FLOOR);
  });

  it('R1-57: a HOT release at 85% curve progress is DROPPED at the curve stage with CURVE_PROGRESS and never reaches executeSnipe', async () => {
    await setAutoMode('PAPER');
    const snipe = vi.spyOn(memecoinAggregator, 'executeSnipe');
    const { mint } = newPumpPool('NONE'); // the feed's create event: the pool stats track the mint
    releaseHot(mint);
    expect(onChainPoolStats.record(tradeAtProgress(mint, 85, 'p43-85'))).toBe(true);
    expect(onChainPoolStats.get(mint)!.curveProgressPct).toBeCloseTo(85, 6);
    const d = await autoSnipeController.submitCandidate(cand(mint));
    expect([d.outcome, d.stage]).toEqual(['DROPPED', 'curve']);
    expect(d.reason).toMatch(/^CURVE_PROGRESS_TOO_HIGH: 85\.0% of the curve sold, above the 60% cap/);
    expect(snipe).not.toHaveBeenCalled();
  });

  it('R1-57: the coordinator checks the cap on its own fresh curve read (SHADOW here); APEX_MAX_CURVE_PROGRESS_PCT moves it', async () => {
    await setAutoMode('SHADOW');
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockImplementation(async (p: any) => curveAt(p.mint.toBase58(), 70));
    const a = newPumpPool('NONE').mint; releaseHot(a); // nothing measured on the feed: only the fresh read knows
    const d = await autoSnipeController.submitCandidate(cand(a));
    expect([d.outcome, d.stage]).toEqual(['REJECTED', 'curve']);
    expect(d.reason).toMatch(/^CURVE_PROGRESS_TOO_HIGH: 70\.0%/);

    vi.stubEnv('APEX_MAX_CURVE_PROGRESS_PCT', '80');
    expect(maxCurveProgressPct()).toBe(80);
    const b = newPumpPool('NONE').mint; releaseHot(b);
    const d2 = await autoSnipeController.submitCandidate(cand(b));
    expect(d2.reason).not.toMatch(/CURVE_PROGRESS/);
    vi.stubEnv('APEX_MAX_CURVE_PROGRESS_PCT', 'abc');
    expect(maxCurveProgressPct()).toBe(MAX_CURVE_PROGRESS_PCT_DEFAULT);
  });

  it('R1-57: the watch window releases a launch DEAD with CURVE_TOO_FAR once its measured progress passes the cap, even inside the minimum hold', () => {
    let progress = 40;
    const w = new WatchWindow({ progressOf: () => progress, publicFunders: [] });
    const t0 = 1_700_000_000_000;
    w.watch('M', 'creator', t0);
    for (const { trade, at } of replay('M', t0, [[0, wallet(), 'buy', 0.5]])) w.onTrade(trade, at);
    expect(w.evaluate('M', t0 + 5_000)!.state).toBe('WATCHING');
    progress = 61;
    const r = w.evaluate('M', t0 + 6_000)!;
    expect(r.state).toBe('DEAD');
    expect(r.reason).toMatch(/^CURVE_TOO_FAR: 61\.0% of the curve sold, above the 60% cap/);
  });

  it('R1-58: a same-slot dev buy scores no acceleration, at once or 60 s later; a real pair decays out of the 10 s window', () => {
    const v = new CurveVelocityEvaluator();
    const t0 = 1_700_000_000_000;
    v.recordTransition('m', 100, 0, t0);
    v.recordTransition('m', 100, 1.0, t0);
    expect(v.getMetrics('m', t0).slotAcceleration).toBe(0);
    expect(v.getMetrics('m', t0 + 60_000).slotAcceleration).toBe(0);

    // the create pseudo-transition is never one end of a pair
    v.recordTransition('c', 200, 0, t0, { create: true });
    v.recordTransition('c', 202, 1.0, t0 + 1_000);
    expect(v.getMetrics('c', t0 + 1_000).slotAcceleration).toBe(0);
    v.recordTransition('c', 204, 2.0, t0 + 2_000);
    expect(v.getMetrics('c', t0 + 2_000).slotAcceleration).toBe(0.5); // (2.0 - 1.0) SOL over 2 slots
    expect(v.getMetrics('c', t0 + 2_000 + ACCELERATION_WINDOW_MS + 1).slotAcceleration).toBe(0);
  });

  it('R1-58: a watched mint is pinned in the velocity maps past the 1,000-mint eviction (wired by wireWatchPins)', () => {
    const ww = new WatchWindow();
    const v = new CurveVelocityEvaluator();
    wireWatchPins(ww, { setPoolPinned: () => undefined }, { setPinned: () => undefined }, v);
    ww.watch('PINNED', null);
    v.recordTransition('PINNED', 1, 0.1, 1);
    for (let i = 0; i < 1_100; i++) v.recordTransition(`m${i}`, 1, 0.1, 1);
    expect(v.hasData('PINNED')).toBe(true);
    expect(v.hasData('m0')).toBe(false);
  });

  it('R1-46: an EXECUTION_DISABLED cooldown does not burn the mint; resubmitted 16 s after the failure it reaches execution', async () => {
    const t0 = Date.now() - 120_000; // in the past, so the cooldown is long over once the real clock is back
    vi.useFakeTimers({ toFake: ['Date'], now: t0 });
    riskEngine.recordTradeFailure();
    await setAutoMode('PAPER');
    const { mint } = newPumpPool('NONE');
    vi.setSystemTime(t0 + 10_000);
    releaseHot(mint);
    const d1 = await autoSnipeController.submitCandidate(cand(mint));
    expect([d1.outcome, d1.stage]).toEqual(['REJECTED', 'risk']);
    expect(d1.reason).toMatch(/^EXECUTION_DISABLED/);
    vi.setSystemTime(t0 + 16_000);
    const d2 = await autoSnipeController.submitCandidate(cand(mint));
    expect(d2.outcome, d2.reason).toBe('BOUGHT');
  });

  it('R1-46: a watch release refused for a cooldown is retried by the controller while it is fresh', async () => {
    const t0 = Date.now() - 120_000;
    vi.useFakeTimers({ toFake: ['Date'], now: t0 });
    riskEngine.recordTradeFailure();
    await setAutoMode('PAPER');
    const { mint } = newPumpPool('NONE');
    vi.setSystemTime(t0 + 14_000);
    releaseHot(mint);
    const d1 = await autoSnipeController.submitCandidate(cand(mint, 'WATCH_WINDOW'));
    expect(d1.reason).toMatch(/^EXECUTION_DISABLED/);
    vi.setSystemTime(t0 + 14_000 + RELEASE_RETRY_MS + 500); // the cooldown is over, the release is 2.5 s old
    await until(() => workstationDb.loadDecisions({ mint }).some((r) => r.outcome === 'BOUGHT'));
    expect(workstationDb.loadDecisions({ mint }).some((r) => r.outcome === 'BOUGHT')).toBe(true);
  });

  it('R1-46: a queued release is kept no longer than the signal-age limit minus the read time', () => {
    expect(PENDING_RELEASE_MAX_AGE_MS).toBeLessThanOrEqual(riskEngine.getLimits().maxSignalAgeMs);
    expect(pendingReleaseMaxAgeMs()).toBeLessThan(riskEngine.getLimits().maxSignalAgeMs);
  });

  it('R1-59: SHADOW with a 10 s queue gets STALE_SIGNAL, the same row as PAPER', async () => {
    const rows: Record<string, [string, string, string]> = {};
    for (const mode of ['SHADOW', 'PAPER'] as const) {
      const t0 = Date.now();
      vi.useFakeTimers({ toFake: ['Date'], now: t0 });
      await setAutoMode(mode);
      const a = newPumpPool('NONE').mint; const b = newPumpPool('NONE').mint;
      releaseHot(a); releaseHot(b);
      let finishA!: () => void;
      const gate = new Promise<void>((r) => { finishA = r; });
      const real = memecoinAggregator.executeSnipe.bind(memecoinAggregator);
      vi.spyOn(memecoinAggregator, 'executeSnipe').mockImplementation(async (p: any) => {
        if (p.contractAddress === a) { await gate; return { success: false, message: 'held', txHash: '' }; }
        return real(p);
      });
      const first = autoSnipeController.submitCandidate(cand(a, 'WATCH_WINDOW'));
      await new Promise((r) => setTimeout(r, 10));
      const queued = await autoSnipeController.submitCandidate(cand(b, 'WATCH_WINDOW'));
      expect(queued.reason).toMatch(/queued/);
      vi.setSystemTime(t0 + 10_000);
      finishA();
      await first;
      await until(() => workstationDb.loadDecisions({ mint: b }).some((r) => r.outcome === 'REJECTED'));
      const row = workstationDb.loadDecisions({ mint: b }).find((r) => r.outcome === 'REJECTED')!;
      expect(row.autoMode).toBe(mode);
      rows[mode] = [row.outcome, row.stage, row.reason];
      await resetAuto();
      vi.mocked(memecoinAggregator.executeSnipe).mockRestore();
      vi.useRealTimers();
    }
    expect(rows.SHADOW[2]).toMatch(/^STALE_SIGNAL/);
    expect(rows.SHADOW).toEqual(rows.PAPER);
  });

  it('R1-59: SHADOW passes the release time to previewBuy, which runs the same signal-age check', async () => {
    await setAutoMode('SHADOW');
    const preview = vi.spyOn(executionCoordinator, 'previewBuy');
    const { mint } = newPumpPool('NONE');
    releaseHot(mint);
    await autoSnipeController.submitCandidate(cand(mint));
    expect(preview.mock.calls[0][0].signalTimestamp).toBe(watchWindow.getVerdict(mint)!.releasedAt);

    const other = newPumpPool('NONE').mint;
    const res = await memecoinAggregator.executeSnipe({ contractAddress: other, amountUsd: 0, amountSolOverride: 0.005, platform: 'PUMP_FUN', provenance: 'REAL_ONCHAIN', dryRun: true, signalTimestamp: Date.now() - 9_000 });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/^STALE_SIGNAL/);
  });
});


describe('P4.3: the replay applies the READY rule, and the offline study prices what it refuses', () => {
  /** A hand-built launch (not recorded): a constant-product curve, 2 buyers (one holds 60% of the buy volume), then a late trade to fill at. */
  function weakReadyLaunch(): RecordedLaunch {
    const mint = wallet(), creator = wallet(), t0 = 1_700_000_000_000;
    let vSol = 30, vTok = 1_073_000_000, rSol = 0, rTok = 793_100_000;
    const trade = (i: number, user: string, sol: number) => {
      const newVSol = vSol + sol; const newVTok = (vSol * vTok) / newVSol; const tok = vTok - newVTok;
      vSol = newVSol; vTok = newVTok; rSol += sol; rTok -= tok;
      return eventToJson({ signature: `rs-${i}`, slot: 100 + i, mint, solAmountLamports: BigInt(Math.round(sol * 1e9)), tokenAmount: BigInt(Math.round(tok * 1e6)), isBuy: true, user, timestampSec: 0,
        virtualSolReserves: BigInt(Math.round(vSol * 1e9)), virtualTokenReserves: BigInt(Math.round(vTok * 1e6)), realSolReserves: BigInt(Math.round(rSol * 1e9)), realTokenReserves: BigInt(Math.round(rTok * 1e6)) } as any);
    };
    const a = wallet(), b = wallet();
    return { mint, events: [
      { ts: t0, kind: 'CREATE', payload: { ...eventToJson({ signature: 'c', slot: 1, mint, creator, user: creator, bondingCurve: wallet(), name: 'R', symbol: 'R', uri: '', virtualTokenReserves: 1_073_000_000_000_000n, virtualSolReserves: 30_000_000_000n, realTokenReserves: 793_100_000_000_000n, realSolReserves: 0n, tokenTotalSupply: 1_000_000_000_000_000n, initialPriceSol: 30 / 1_073_000_000, initialMarketCapSol: 28, receivedAt: t0, parsedAt: t0, parseLatencyMs: 0, source: 'TEST_FEED' } as any), solUsd: 150 } },
      { ts: t0 + 1_000, kind: 'TRADE', payload: trade(0, a, 0.3) },
      { ts: t0 + 10_000, kind: 'TRADE', payload: trade(1, b, 0.2) },
      { ts: t0 + 130_000, kind: 'TRADE', payload: trade(2, wallet(), 0.01) },
    ] };
  }

  it('a weak READY release is not entered by the replay; with the rule off the study counts it as refused, apart from HOT', () => {
    const launch = weakReadyLaunch();
    const gated = replayLaunch(launch, [], 150, { minScore: 0 });
    expect(gated.verdict).toBe('READY');
    expect(gated.entered).toBe(false);
    expect(gated.noEntryReason).toMatch(/^READY_TOO_WEAK: concentration fails/);
    const open = replayLaunch(launch, [], 150, { minScore: 0, readyGate: false });
    expect(open.entered).toBe(true);
    expect(readyGroupOf(open)).toBe('READY_FAILS_CONCENTRATION');
    const s = summarizeReadyStrength([open, gated]);
    expect([s.readyEntries, s.refusedNow, s.groups.READY_FAILS_CONCENTRATION.entries, s.groups.HOT.entries]).toEqual([1, 1, 1, 0]);
  });
});
