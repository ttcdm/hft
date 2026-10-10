import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
  upperBound80, evaluateKillTriggers, auditWalletChange, EXPECTANCY_WINDOW, MAX_CONSECUTIVE_LOSSES, READINESS_RED_LIMIT_MS, type KillContext,
} from '../server/auto/killSwitch';
import { autoSnipeController, classifyRejection, DEVNET_CONFIRMATION_CODE, AUTO_DEVNET_ORDER_SOL } from '../server/auto/controller';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { executionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';
import { solPriceService } from '../server/market/solPriceService';
import { riskEngine } from '../server/risk/riskEngine';
import { CapitalSizer } from '../server/capital/capitalSizer';
import { setAutoMode, resetAuto, newPumpPool } from './fixtures/auto';

const baseCtx = (over: Partial<KillContext> = {}): KillContext => ({
  mode: 'PAPER', closedNetPnlSol: [], dailyTotalPnlSol: 0, maxDailyLossSol: 0.02, slippageBreaches: 0, readinessRed: [],
  walletSol: 1, reserveSol: 0.015, maxTradeSol: 0.005, ...over,
});
const codes = (c: KillContext) => evaluateKillTriggers(c).map((t) => t.code);

describe('G3: kill-switch triggers (pure rules)', () => {
  it('upperBound80 needs 2+ samples and is mean + z*sd/sqrt(n)', () => {
    expect(upperBound80([])).toBeNull();
    expect(upperBound80([1])).toBeNull();
    expect(upperBound80([1, 1, 1, 1])).toBe(1); // zero variance: the bound is the mean
    const ub = upperBound80([0, 2])!; // mean 1, sd sqrt(2), n 2 -> 1 + 1.2816 * sqrt(2) / sqrt(2)
    expect(ub).toBeCloseTo(1 + 1.2816, 6);
  });

  it('negative expectancy needs a full window and an upper bound below zero', () => {
    const losing = Array.from({ length: EXPECTANCY_WINDOW }, (_, i) => (i % 2 ? -0.00012 : -0.00008));
    expect(codes(baseCtx({ closedNetPnlSol: losing }))).toContain('NEGATIVE_EXPECTANCY');
    expect(codes(baseCtx({ closedNetPnlSol: losing.slice(1) }))).not.toContain('NEGATIVE_EXPECTANCY'); // 19 trades: not enough evidence
    // Noisy but break-even: the upper bound stays above zero, so no trigger
    const noisy = Array.from({ length: EXPECTANCY_WINDOW }, (_, i) => (i % 2 ? 0.01 : -0.01));
    expect(codes(baseCtx({ closedNetPnlSol: noisy }))).not.toContain('NEGATIVE_EXPECTANCY');
    // Only the last 20 count: old losses followed by 20 solid wins
    const recovered = [...Array(10).fill(-0.01), ...Array.from({ length: EXPECTANCY_WINDOW }, (_, i) => 0.01 + i * 1e-5)];
    expect(codes(baseCtx({ closedNetPnlSol: recovered }))).not.toContain('NEGATIVE_EXPECTANCY');
  });

  it('a loss streak of 8 triggers, a win in the middle resets it', () => {
    const streak = Array(MAX_CONSECUTIVE_LOSSES).fill(-0.001);
    expect(codes(baseCtx({ closedNetPnlSol: streak }))).toContain('LOSS_STREAK');
    expect(codes(baseCtx({ closedNetPnlSol: streak.slice(1) }))).not.toContain('LOSS_STREAK');
    expect(codes(baseCtx({ closedNetPnlSol: [...streak, 0.001, -0.001] }))).not.toContain('LOSS_STREAK');
  });

  it('daily loss (unrealized included), slippage breaches and readiness red each trigger on their own', () => {
    expect(codes(baseCtx({ dailyTotalPnlSol: -0.019 }))).toEqual([]);
    expect(codes(baseCtx({ dailyTotalPnlSol: -0.02 }))).toEqual(['DAILY_LOSS_LIMIT']);
    expect(codes(baseCtx({ slippageBreaches: 1 }))).toEqual([]);
    expect(codes(baseCtx({ slippageBreaches: 2 }))).toEqual(['SLIPPAGE_BREACHES']);
    expect(codes(baseCtx({ readinessRed: [{ name: 'rpc', redForMs: READINESS_RED_LIMIT_MS }] }))).toEqual([]);
    expect(codes(baseCtx({ readinessRed: [{ name: 'rpc', redForMs: READINESS_RED_LIMIT_MS + 1 }] }))).toEqual(['READINESS_RED']);
  });

  it('wallet rules apply to DEVNET_LIVE only: low or unknown balance triggers there, not in PAPER', () => {
    expect(codes(baseCtx({ mode: 'PAPER', walletSol: 0 }))).toEqual([]);
    expect(codes(baseCtx({ mode: 'DEVNET_LIVE', walletSol: 1 }))).toEqual([]);
    expect(codes(baseCtx({ mode: 'DEVNET_LIVE', walletSol: 0.019 }))).toEqual(['WALLET_LOW']); // reserve 0.015 + one trade 0.005
    expect(codes(baseCtx({ mode: 'DEVNET_LIVE', walletSol: 0.02 }))).toEqual([]);
    expect(codes(baseCtx({ mode: 'DEVNET_LIVE', walletSol: null }))).toEqual(['WALLET_UNKNOWN']);
  });

  it('wallet audit: a change the journal explains passes; a drain, a surprise deposit, or any change with no fills does not', () => {
    // bought 0.005 SOL (+ fee): wallet fell by that much
    expect(auditWalletChange(1, 0.994, { delta: -0.0055, gross: 0.0055 }).explained).toBe(true);
    // drained 0.3 SOL with only a small fill journaled
    const drain = auditWalletChange(1, 0.7, { delta: -0.0055, gross: 0.0055 });
    expect(drain.explained).toBe(false);
    expect(drain.unexplainedSol).toBeCloseTo(-0.2945, 6);
    // money appearing from nowhere is also unexplained
    expect(auditWalletChange(1, 1.1, { delta: 0, gross: 0 }).explained).toBe(false);
    // no fills, tiny wobble inside the base tolerance
    expect(auditWalletChange(1, 0.9998, { delta: 0, gross: 0 }).explained).toBe(true);
  });

  it('classifyRejection maps real rejection messages to pipeline stages', () => {
    expect(classifyRejection('REJECTED: Freeze authority active. Honeypot risk.')).toBe('eligibility');
    expect(classifyRejection('ELIGIBILITY_CHECK_FAILED: Token failed 1 safety check(s): x')).toBe('eligibility');
    expect(classifyRejection('REJECTED: Confluence score 20/100 failed minimum threshold of 70 (x)')).toBe('score');
    expect(classifyRejection('EXCEEDS_CAPITAL_CEILING: Trade size 1 SOL exceeds 10%')).toBe('size');
    expect(classifyRejection('REJECTED: Capital sizing failed (NEGATIVE_OR_ZERO_EXPECTANCY)')).toBe('size');
    expect(classifyRejection('KILL_SWITCH_ACTIVE: x')).toBe('risk');
    expect(classifyRejection('DAILY_LOSS_LIMIT: x')).toBe('risk');
    expect(classifyRejection('TRADING_HALTED: wallet')).toBe('risk');
    expect(classifyRejection('something else entirely')).toBe('execute');
  });
});

describe('G3: decision journal and kill switch on the real controller', () => {
  beforeEach(() => {
    memecoinAggregator.setConfluenceGating(false);
    solPriceService.setPrice(150, 'TEST_FIXTURE');
    // a healthy system, so readiness never fires unless a test asks for it
    vi.spyOn(executionCoordinator, 'getLiveReadiness').mockReturnValue({
      ready: true, reasons: [], checkedAt: Date.now(),
      components: {
        rpc: { healthy: true, latencyMs: 1, status: 'HEALTHY' }, pumpFeed: { healthy: true, lastEventAgeMs: 0, status: 'HEALTHY' },
        markFeed: { healthy: true, lastMarkAgeMs: 0, status: 'HEALTHY' }, jito: { healthy: true, status: 'HEALTHY' },
        db: { healthy: true, status: 'HEALTHY' }, signer: { healthy: true, status: 'READY' },
      },
    } as any);
  });
  afterEach(async () => {
    await resetAuto();
    executionCoordinator.clearHalt();
    riskEngine.setKillSwitch(false);
    memecoinAggregator.setConfluenceGating(false);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function closedPaper(i: number, pnl: number, unverified: boolean) {
    const id = `g3-${unverified ? 'u' : 'v'}-${i}-${Math.random().toString(36).slice(2, 8)}`;
    workstationDb.savePosition({
      id, mint: Keypair.generate().publicKey.toBase58(), symbol: 'T', name: 'T', tokenDecimals: 6, tokenQuantityRaw: '0',
      entryPriceSol: 1, currentPriceSol: 1, currentValueSol: 0, costBasisLamports: 1e6, realizedPnLSol: pnl, status: 'CLOSED',
      venue: 'PUMP_BONDING_CURVE', executionMode: 'PAPER', entryTxSignature: id, entryTimestamp: Date.now() - 1000,
      recordUpdatedAt: Date.now(), updatedAt: Date.now() + i,
    } as any);
    if (unverified) {
      workstationDb.logJournal('PAPER_FILL_GATES', `c-${id}`, 'PAPER', { mint: 'm', orderId: id, gates: { eligibility: { unverified: ['holders'] } } });
    }
    return id;
  }
  const lose = (i: number) => (i % 2 ? -0.00012 : -0.00008);

  it('every paper reject leaves a decision row with a stage and a reason, after a queue row', async () => {
    await setAutoMode('PAPER');

    const a = newPumpPool();
    a.pool.isFreezeRevoked = false;
    const d1 = await autoSnipeController.submitCandidate({ mint: a.mint, symbol: 'G3', source: 'TEST', amountUsd: 0.7, provenance: 'REAL_ONCHAIN' });
    expect(d1.outcome).toBe('REJECTED');
    expect(d1.stage).toBe('eligibility');

    memecoinAggregator.setConfluenceGating(true);
    const b = newPumpPool();
    const d2 = await autoSnipeController.submitCandidate({ mint: b.mint, symbol: 'G3', source: 'TEST', amountUsd: 0.7, provenance: 'REAL_ONCHAIN' });
    expect(d2.outcome).toBe('REJECTED');
    expect(d2.stage).toBe('score');
    memecoinAggregator.setConfluenceGating(false);

    riskEngine.setKillSwitch(true);
    const c = newPumpPool();
    const d3 = await autoSnipeController.submitCandidate({ mint: c.mint, symbol: 'G3', source: 'TEST', amountUsd: 0.7, provenance: 'REAL_ONCHAIN' });
    expect(d3.outcome).toBe('REJECTED');
    expect(d3.stage).toBe('risk');

    for (const [mint, stage] of [[a.mint, 'eligibility'], [b.mint, 'score'], [c.mint, 'risk']] as const) {
      const rows = workstationDb.loadDecisions({ mint });
      expect(rows.map((r) => r.stage)).toEqual(['queue', stage]);
      expect(rows[1].outcome).toBe('REJECTED');
      expect(rows[1].reason.length).toBeGreaterThan(5);
      expect(rows[1].autoMode).toBe('PAPER');
    }
  });

  it('a bought candidate is journaled, and a close journals the exit; a PAPER trade moves no wallet SOL so it journals no delta (Q8)', async () => {
    await setAutoMode('PAPER');
    const { mint } = newPumpPool();
    const d = await autoSnipeController.submitCandidate({ mint, symbol: 'G3', source: 'TEST', amountUsd: 0.7, provenance: 'REAL_ONCHAIN' });
    expect(d.outcome, d.reason).toBe('BOUGHT');
    const buy = workstationDb.loadDecisions({ mint }).find((r) => r.outcome === 'BOUGHT')!;
    expect(buy.stage).toBe('fill');
    expect(buy.solDelta ?? null).toBeNull(); // Q8: the wallet audit sums solDelta against the real balance; a PAPER fill never touched it
    expect(buy.positionId).toBe(d.positionId);

    const r = await executionCoordinator.closePosition(d.positionId!, 100, 'MANUAL');
    expect(r.success).toBe(true);
    const exit = workstationDb.loadDecisions({ mint, stage: 'exit' });
    expect(exit).toHaveLength(1);
    expect(exit[0].positionId).toBe(d.positionId);
    expect(exit[0].solDelta ?? null).toBeNull();
  });

  it('readiness red for over 10s drops to SHADOW; a brief blip does not', async () => {
    await setAutoMode('PAPER');
    const red = { ready: false, reasons: ['rpc'], checkedAt: 0, components: {
      rpc: { healthy: false, latencyMs: 0, status: 'DISCONNECTED' }, pumpFeed: { healthy: true, lastEventAgeMs: 0, status: 'HEALTHY' },
      markFeed: { healthy: true, lastMarkAgeMs: 0, status: 'HEALTHY' }, jito: { healthy: true, status: 'HEALTHY' },
      db: { healthy: true, status: 'HEALTHY' }, signer: { healthy: true, status: 'READY' },
    } };
    vi.spyOn(executionCoordinator, 'getLiveReadiness').mockReturnValue(red as any);
    const t0 = Date.now();
    expect(await autoSnipeController.checkTriggers(t0)).toEqual([]);
    expect(await autoSnipeController.checkTriggers(t0 + 5_000)).toEqual([]);
    expect(autoSnipeController.getMode()).toBe('PAPER');
    const hits = await autoSnipeController.checkTriggers(t0 + 11_000);
    expect(hits.map((h) => h.code)).toEqual(['READINESS_RED']);
    expect(autoSnipeController.getMode()).toBe('SHADOW');
  });

  it('unverified paper fills are excluded from the evidence list, the CapitalSizer stats and the expectancy trigger', async () => {
    const before = workstationDb.loadEvidenceClosedTrades('PAPER').length;
    const statsBefore = CapitalSizer.getHistoricalTradeStats('PAPER');
    const ids = Array.from({ length: EXPECTANCY_WINDOW + 2 }, (_, i) => closedPaper(i, lose(i), true));
    expect(workstationDb.getUnverifiedFillIds().has(ids[0])).toBe(true);
    expect(workstationDb.loadEvidenceClosedTrades('PAPER')).toHaveLength(before);
    expect(CapitalSizer.getHistoricalTradeStats('PAPER').tradeCount).toBe(statsBefore.tradeCount);

    await setAutoMode('PAPER');
    expect(await autoSnipeController.checkTriggers()).toEqual([]);
    expect(autoSnipeController.getMode()).toBe('PAPER');
  });

  it('a negative-expectancy sequence of verified trades drops PAPER to SHADOW; shadow journals "would buy" and buys nothing', async () => {
    await setAutoMode('PAPER');
    for (let i = 0; i < EXPECTANCY_WINDOW; i++) closedPaper(100 + i, lose(i), false);
    expect(CapitalSizer.getHistoricalTradeStats('PAPER').tradeCount).toBeGreaterThanOrEqual(EXPECTANCY_WINDOW);

    const hits = await autoSnipeController.checkTriggers();
    expect(hits.map((h) => h.code)).toContain('NEGATIVE_EXPECTANCY');
    expect(autoSnipeController.getMode()).toBe('SHADOW');
    const st = autoSnipeController.getStatus();
    expect(st.downgradeReason).toMatch(/NEGATIVE_EXPECTANCY/);
    expect(st.triggers.map((t) => t.code)).toContain('NEGATIVE_EXPECTANCY');
    expect(workstationDb.loadDecisions({ outcome: 'KILL_TRIGGER' }).length).toBeGreaterThan(0);

    const exec = vi.spyOn(executionCoordinator, 'executeTrade');
    const { mint } = newPumpPool();
    const d = await autoSnipeController.submitCandidate({ mint, symbol: 'G3', source: 'TEST', amountUsd: 0.7, provenance: 'REAL_ONCHAIN' });
    expect(d.outcome, d.reason).toBe('WOULD_BUY');
    expect(exec).not.toHaveBeenCalled();
  });

  it('DEVNET_LIVE wallet audit: an explained change passes, an unexplained drain halts ALL trading including exits', async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    vi.stubEnv('ALLOWED_CLUSTER', 'devnet');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    vi.spyOn(executionCoordinator, 'syncRealWalletBalance').mockResolvedValue(null);
    const bal = vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol');
    bal.mockReturnValue(1);
    const ok = await autoSnipeController.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE });
    expect(ok.ok, ok.error).toBe(true);

    const t0 = Date.now();
    expect(await autoSnipeController.auditWallet(t0)).toBeNull(); // first look just records the balance

    // a journaled buy of 0.005 SOL explains a 0.005 SOL fall
    workstationDb.logDecision({ ts: t0 + 1, autoMode: 'DEVNET_LIVE', mint: 'm', stage: 'fill', outcome: 'BOUGHT', reason: 'test', solDelta: -AUTO_DEVNET_ORDER_SOL });
    bal.mockReturnValue(1 - AUTO_DEVNET_ORDER_SOL);
    const fine = await autoSnipeController.auditWallet(t0 + 2);
    expect(fine?.explained).toBe(true);
    expect(autoSnipeController.getMode()).toBe('DEVNET_LIVE');
    expect(executionCoordinator.getHaltReason()).toBeNull();

    // balance falls by 0.3 SOL and no fill explains it
    bal.mockReturnValue(0.695);
    const bad = await autoSnipeController.auditWallet(t0 + 3);
    expect(bad?.explained).toBe(false);
    expect(autoSnipeController.getMode()).toBe('OFF');
    expect(executionCoordinator.getHaltReason()).toMatch(/unexplained/);
    expect(autoSnipeController.getStatus().killReason).toMatch(/unexplained/);
    expect(executionCoordinator.getOperatorAlerts().some((a) => a.code === 'TRADING_HALTED' && !a.cleared)).toBe(true);

    // while halted, discretionary exits are blocked; protective ones (stop-loss, manual, panic) still run. A halt is cleared only on purpose
    const exit = await executionCoordinator.closePosition('anything', 100, 'TAKE_PROFIT_1');
    expect(exit.error).toMatch(/TRADING_HALTED/);
    const stop = await executionCoordinator.closePosition('anything', 100, 'STOP_LOSS');
    expect(stop.error).not.toMatch(/TRADING_HALTED/);
    expect(autoSnipeController.resume({}).halted).toBe(true);
    expect(autoSnipeController.resume({ clearHalt: true })).toEqual({ halted: false, mode: 'OFF' });
  });

  it('wallet audit does nothing outside DEVNET_LIVE', async () => {
    await setAutoMode('PAPER');
    const sync = vi.spyOn(executionCoordinator, 'syncRealWalletBalance');
    expect(await autoSnipeController.auditWallet()).toBeNull();
    expect(sync).not.toHaveBeenCalled();
  });

  it('while halted, new trades are refused as well', async () => {
    executionCoordinator.haltAll('test halt');
    const res = await executionCoordinator.executeTrade({
      mint: Keypair.generate().publicKey.toBase58(), symbol: 'H', name: 'H', amountSol: 0.001, currentPriceSol: 1e-7, slippageBps: 500,
      source: 'MANUAL', provenance: 'MANUAL_OPERATOR',
    } as any);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/TRADING_HALTED/);
  });
});
