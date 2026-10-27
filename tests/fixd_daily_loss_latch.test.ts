import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { executionConfig } from '../server/solana/executionConfig';
import { HardenedRiskEngine, RiskEvaluationRequest, DAILY_LOSS_LATCH_SETTING } from '../server/risk/riskEngine';
import { solPriceService } from '../server/market/solPriceService';
import { workstationDb } from '../server/db/database';
import { executionCoordinator } from '../server/execution/coordinator';
import { autoSnipeController } from '../server/auto/controller';

/**
 * R3-3, R7-6, R5-15: the daily-loss latch was a plain Map, so a restart released it once the losses left the 24 h window (the docs say it
 * holds until the operator clears it), and clearDailyLossLatch cleared every mode, so a PAPER clear also released a LIVE latch.
 * The real HardenedRiskEngine and the in-memory workstationDb; a persistent engine is what the module singleton is.
 */
const mint = () => Keypair.generate().publicKey.toBase58();
const order = (over: Partial<RiskEvaluationRequest> = {}): RiskEvaluationRequest => ({
  mint: mint(), orderSizeSol: 0.005, expectedPriceSol: 0.00001, slippageBps: 300, estimatedFeeLamports: 5_000, jitoTipLamports: 150_000,
  signalTimestamp: Date.now(), marketDataTimestamp: Date.now(), currentOpenPositionsCount: 0, currentTotalExposureSol: 0,
  walletSpendableSol: 1, executionMode: 'LIVE', ...over,
});
const bookRealized = (sol: number, mode: 'LIVE' | 'PAPER') => workstationDb.savePosition({
  id: `fixd-latch-${Math.random().toString(36).slice(2)}`, mint: mint(), symbol: 'L', name: 'L', tokenDecimals: 6, tokenQuantityRaw: '0',
  costBasisLamports: 10_000_000, entryPriceSol: 0.01, currentPriceSol: 0.01, realizedPnLSol: sol, entryTxSignature: `sig-${Math.random()}`,
  entryTimestamp: Date.now() - 60_000, executionMode: mode, status: 'CLOSED',
} as any);

const usdCapAtStart = executionConfig.getConfig().maxDailyLossUsd;
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  executionConfig.updateConfig({ maxDailyLossUsd: usdCapAtStart });
  solPriceService.reset();
  workstationDb.setSetting(DAILY_LOSS_LATCH_SETTING, null);
});

describe('R3-3 / R7-6: the latch survives a restart', () => {
  it('a latch set before a restart still refuses after the losses have left the 24 h window, until an operator clears it', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2031-03-01T12:00:00Z'));
    solPriceService.setPrice(150, 'TEST');
    const before = new HardenedRiskEngine({ persistent: true });
    bookRealized(-0.05, 'LIVE');
    expect(before.evaluateOrder(order()).reasonCode).toBe('DAILY_LOSS_LIMIT');
    expect(before.getDailyLossLatch('LIVE')).not.toBeNull();

    vi.setSystemTime(new Date('2031-03-03T12:00:00Z')); // two days on: the window is empty
    solPriceService.setPrice(150, 'TEST');
    const restarted = new HardenedRiskEngine({ persistent: true });
    expect(restarted.getDailyTotalPnLSol('LIVE')).toBe(0);
    const r = restarted.evaluateOrder(order());
    expect(r.reasonCode).toBe('DAILY_LOSS_LIMIT');
    expect(r.message).toMatch(/latched at 2031-03-01T12:00:00.000Z/);

    restarted.clearDailyLossLatch('LIVE');
    expect(restarted.evaluateOrder(order()).approved).toBe(true);
    expect(new HardenedRiskEngine({ persistent: true }).getDailyLossLatch('LIVE')).toBeNull(); // the clear is saved too
  });

  it('a non-persistent engine (tests, scripts) neither restores nor saves a latch', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2031-03-10T12:00:00Z'));
    solPriceService.setPrice(150, 'TEST');
    const scratch = new HardenedRiskEngine();
    bookRealized(-0.05, 'LIVE');
    expect(scratch.evaluateOrder(order()).reasonCode).toBe('DAILY_LOSS_LIMIT');
    expect(new HardenedRiskEngine({ persistent: true }).getDailyLossLatch('LIVE')).toBeNull();
  });
});

describe('R5-15: the latch is cleared per mode', () => {
  it('clearing PAPER leaves a LIVE latch in place', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2031-03-20T12:00:00Z'));
    solPriceService.setPrice(150, 'TEST');
    const r = new HardenedRiskEngine({ persistent: true });
    bookRealized(-0.05, 'LIVE');
    bookRealized(-0.05, 'PAPER');
    expect(r.evaluateOrder(order()).reasonCode).toBe('DAILY_LOSS_LIMIT');
    expect(r.evaluateOrder(order({ executionMode: 'PAPER' })).reasonCode).toBe('DAILY_LOSS_LIMIT');
    r.clearDailyLossLatch('PAPER');
    expect(r.getDailyLossLatch('PAPER')).toBeNull();
    expect(r.getDailyLossLatch('LIVE')).not.toBeNull();
    expect(new HardenedRiskEngine({ persistent: true }).getDailyLossLatch('LIVE')).not.toBeNull();
  });

  it('resume({clearDailyLossLatch:true}) clears the mode the coordinator is in, and only that one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2031-03-25T12:00:00Z'));
    solPriceService.setPrice(150, 'TEST');
    const { riskEngine } = await import('../server/risk/riskEngine');
    bookRealized(-0.05, 'LIVE');
    bookRealized(-0.05, 'PAPER');
    riskEngine.evaluateOrder(order());
    riskEngine.evaluateOrder(order({ executionMode: 'PAPER' }));
    expect(riskEngine.getDailyLossLatch('LIVE')).not.toBeNull();
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('PAPER');
    const res = autoSnipeController.resume({ clearDailyLossLatch: true });
    expect(res.dailyLossLatchCleared).toBe('PAPER');
    expect(riskEngine.getDailyLossLatch('PAPER')).toBeNull();
    expect(riskEngine.getDailyLossLatch('LIVE')).not.toBeNull();
    autoSnipeController.resume({ clearDailyLossLatch: 'LIVE' });
    expect(riskEngine.getDailyLossLatch('LIVE')).toBeNull();
  });
});
