import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { AutoSnipeController, autoSnipeController, READINESS_RESTORE_GREEN_MS, PAPER_SESSION_BUDGETS } from '../server/auto/controller';
import { executionCoordinator } from '../server/execution/coordinator';
import { executionConfig } from '../server/solana/executionConfig';
import { workstationDb } from '../server/db/database';
import { riskEngine } from '../server/risk/riskEngine';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { solPriceService } from '../server/market/solPriceService';
import { setAutoMode, resetAuto } from './fixtures/auto';
import { budgetProblem } from '../src/components/AutoPanel';

const readiness = (rpcHealthy: boolean) => ({
  ready: rpcHealthy, reasons: rpcHealthy ? [] : ['rpc'], checkedAt: 0,
  components: {
    rpc: { healthy: rpcHealthy, latencyMs: 0, status: rpcHealthy ? 'HEALTHY' : 'DISCONNECTED' }, pumpFeed: { healthy: true, lastEventAgeMs: 0, status: 'HEALTHY' },
    markFeed: { healthy: true, lastMarkAgeMs: 0, status: 'HEALTHY' }, jito: { healthy: true, status: 'HEALTHY' },
    db: { healthy: true, status: 'HEALTHY' }, signer: { healthy: true, status: 'READY' },
  },
}) as any;

beforeEach(() => { memecoinAggregator.setConfluenceGating(false); solPriceService.setPrice(150, 'TEST_FIXTURE'); vi.spyOn(executionCoordinator, 'getLiveReadiness').mockReturnValue(readiness(true)); });
afterEach(async () => { await resetAuto(); executionCoordinator.clearHalt(); riskEngine.setKillSwitch(false); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('S189 a PAPER session may save a spend limit up to its own ceiling', () => {
  const paperCeiling = () => PAPER_SESSION_BUDGETS.maxSpendBankrollMultiple * executionConfig.getConfig().paperBankrollSol;

  it('in a PAPER session the cap is 10 x the paper bankroll and the server\'s own default can be saved back', async () => {
    await setAutoMode('PAPER');
    const st = autoSnipeController.getStatus();
    expect(st.budgetLimits.capKind).toBe('PAPER');
    expect(st.budgetLimits.maxSpendSol).toBeCloseTo(paperCeiling(), 9);
    expect(st.budgets.maxSpendSol).toBeCloseTo(paperCeiling(), 9);
    expect(autoSnipeController.setBudget({ maxBuys: st.budgets.maxBuys, maxSpendSol: st.budgets.maxSpendSol }).ok).toBe(true); // the 50 / 0.7 default
    const over = autoSnipeController.setBudget({ maxBuys: 10, maxSpendSol: paperCeiling() + 0.01 });
    expect(over.ok).toBe(false);
    expect(over.reason).toMatch(/10 x the paper bankroll/);
  });
  it('outside a PAPER session the real-SOL cap (3 x MAX_POSITION_SIZE_SOL) still applies', () => {
    const c = new AutoSnipeController();
    const st = c.getStatus();
    expect(st.budgetLimits.capKind).toBe('REAL');
    expect(st.budgetLimits.maxSpendSol).toBeCloseTo(executionConfig.getConfig().maxPositionSizeSol * 3, 9);
    expect(c.setBudget({ maxBuys: 5, maxSpendSol: paperCeiling() }).ok).toBe(paperCeiling() <= st.budgetLimits.maxSpendSol);
    const r = c.setBudget({ maxBuys: 5, maxSpendSol: 5 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/3 x MAX_POSITION_SIZE_SOL/);
  });
  it('a spend limit saved for PAPER cannot carry into DEVNET_LIVE: the switch is refused with the reason, and nothing is clamped', async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    const c = new AutoSnipeController();
    (c as any).budgetOverride = { maxBuys: 10, maxSpendSol: 0.7 };
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    const r = await c.setMode('DEVNET_LIVE', { confirmationCode: 'CONFIRM_AUTO_DEVNET' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/saved session spend limit \(0\.7 SOL\) is above the .* real-SOL cap/);
    expect((c as any).budgetOverride.maxSpendSol).toBe(0.7);
  });
  it('the client names the cap the server reports', () => {
    const limits = { maxSpendSol: 0.7, minSpendSol: 0.005, maxBuys: 50, capKind: 'PAPER' as const, capNote: '10 x the paper bankroll, the PAPER session ceiling' };
    expect(budgetProblem(5, 0.8, limits)).toContain('10 x the paper bankroll');
    expect(budgetProblem(5, 0.7, limits)).toBeNull();
  });
});

describe('S189 a PAPER session downgraded only by a flapping readiness check comes back by itself', () => {
  async function dropToShadow() {
    await setAutoMode('PAPER');
    vi.spyOn(executionCoordinator, 'getLiveReadiness').mockReturnValue(readiness(false));
    const t0 = Date.now();
    await autoSnipeController.checkTriggers(t0);
    const hits = await autoSnipeController.checkTriggers(t0 + 11_000);
    expect(hits.map((h) => h.code)).toEqual(['READINESS_RED']);
    expect(autoSnipeController.getMode()).toBe('SHADOW');
    return t0 + 11_000;
  }

  it('restores PAPER after readiness has stayed green for the window, and logs the restore', async () => {
    const log = vi.spyOn(workstationDb, 'logDecision');
    const t = await dropToShadow();
    expect(autoSnipeController.getStatus().autoRestore).toMatchObject({ needMs: READINESS_RESTORE_GREEN_MS });
    vi.spyOn(executionCoordinator, 'getLiveReadiness').mockReturnValue(readiness(true));
    await autoSnipeController.checkTriggers(t + 5_000); // green starts
    await autoSnipeController.checkTriggers(t + 5_000 + READINESS_RESTORE_GREEN_MS - 1);
    expect(autoSnipeController.getMode()).toBe('SHADOW'); // not yet
    await autoSnipeController.checkTriggers(t + 5_000 + READINESS_RESTORE_GREEN_MS);
    expect(autoSnipeController.getMode()).toBe('PAPER');
    const st = autoSnipeController.getStatus();
    expect(st.downgradeReason).toBeNull();
    expect(st.autoRestore).toBeNull();
    const reasons = log.mock.calls.map((c) => String((c[0] as any).reason));
    expect(reasons.some((r) => /kill switch: READINESS_RED/.test(r))).toBe(true); // the downgrade
    expect(reasons.some((r) => /PAPER restored: readiness has been green/.test(r))).toBe(true); // the restore
  });
  it('a red reading during the wait restarts the green window', async () => {
    const t = await dropToShadow();
    const g = vi.spyOn(executionCoordinator, 'getLiveReadiness');
    g.mockReturnValue(readiness(true));
    await autoSnipeController.checkTriggers(t + 1_000);
    g.mockReturnValue(readiness(false));
    await autoSnipeController.checkTriggers(t + 40_000);
    g.mockReturnValue(readiness(true));
    await autoSnipeController.checkTriggers(t + 41_000);
    await autoSnipeController.checkTriggers(t + 41_000 + READINESS_RESTORE_GREEN_MS - 1);
    expect(autoSnipeController.getMode()).toBe('SHADOW');
    await autoSnipeController.checkTriggers(t + 41_000 + READINESS_RESTORE_GREEN_MS);
    expect(autoSnipeController.getMode()).toBe('PAPER');
  });
  it('any other trigger stays sticky: a negative-expectancy style downgrade does not come back by itself', async () => {
    await setAutoMode('PAPER');
    (autoSnipeController as any).slippageBreaches = 2; // SLIPPAGE_BREACHES
    const hits = await autoSnipeController.checkTriggers();
    expect(hits.map((h) => h.code)).toEqual(['SLIPPAGE_BREACHES']);
    expect(autoSnipeController.getStatus().autoRestore).toBeNull();
    const t = Date.now();
    await autoSnipeController.checkTriggers(t);
    await autoSnipeController.checkTriggers(t + 10 * READINESS_RESTORE_GREEN_MS);
    expect(autoSnipeController.getMode()).toBe('SHADOW');
  });
  it('a mixed hit (readiness plus another trigger) stays sticky too', async () => {
    await setAutoMode('PAPER');
    vi.spyOn(executionCoordinator, 'getLiveReadiness').mockReturnValue(readiness(false));
    const t0 = Date.now();
    await autoSnipeController.checkTriggers(t0);
    (autoSnipeController as any).slippageBreaches = 2; // the second trigger arrives while readiness is red
    const hits = await autoSnipeController.checkTriggers(t0 + 11_000);
    expect(hits.map((h) => h.code).sort()).toEqual(['READINESS_RED', 'SLIPPAGE_BREACHES']);
    expect(autoSnipeController.getStatus().autoRestore).toBeNull();
  });
  it('DEVNET_LIVE stays sticky on READINESS_RED', async () => {
    const c = new AutoSnipeController();
    (c as any).mode = 'DEVNET_LIVE';
    vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol').mockReturnValue(5);
    vi.spyOn(executionCoordinator, 'getLiveReadiness').mockReturnValue(readiness(false));
    const t0 = Date.now();
    await c.checkTriggers(t0);
    const hits = await c.checkTriggers(t0 + 11_000);
    expect(hits.map((h) => h.code)).toEqual(['READINESS_RED']);
    expect(c.getMode()).toBe('SHADOW');
    expect(c.getStatus().autoRestore).toBeNull();
    vi.spyOn(executionCoordinator, 'getLiveReadiness').mockReturnValue(readiness(true));
    await c.checkTriggers(t0 + 12_000);
    await c.checkTriggers(t0 + 12_000 + 10 * READINESS_RESTORE_GREEN_MS);
    expect(c.getMode()).toBe('SHADOW');
  });
  it('an operator choice cancels the automatic restore (kill, OFF, or setting a mode again)', async () => {
    const t = await dropToShadow();
    await autoSnipeController.setMode('OFF');
    expect(autoSnipeController.getStatus().autoRestore).toBeNull();
    vi.spyOn(executionCoordinator, 'getLiveReadiness').mockReturnValue(readiness(true));
    await autoSnipeController.checkTriggers(t + 1_000);
    await autoSnipeController.checkTriggers(t + 1_000 + 2 * READINESS_RESTORE_GREEN_MS);
    expect(autoSnipeController.getMode()).toBe('OFF');
  });
});

describe('S189 the replay is no longer capped at 300 and no longer blocks the event loop', () => {
  it('the async replay returns exactly what the sync replay returns, and hands the event loop back while it works', async () => {
    const { replayLaunches, replayLaunchesAsync } = await import('../server/backtest/replay');
    const mk = (i: number) => ({ mint: `M${i}`, events: [{ ts: 1_700_000_000_000 + i, kind: 'CREATE' as const, payload: { mint: `M${i}`, symbol: 'X' } }] });
    const launches = Array.from({ length: 400 }, (_, i) => mk(i));
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 0);
    const a = await replayLaunchesAsync(launches, [], null, { minScore: 40 }, 0); // sliceMs 0: yield after every launch
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0); // timers ran in between, so the loop was not held
    expect(a).toEqual(replayLaunches(launches, [], null, { minScore: 40 }));
    expect(a.summary.launches).toBe(400);
  });
});
