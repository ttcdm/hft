import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionConfigManager, executionConfig } from '../server/solana/executionConfig';
import { HardenedRiskEngine, RiskEvaluationRequest, riskEngine } from '../server/risk/riskEngine';
import { solPriceService } from '../server/market/solPriceService';
import { workstationDb } from '../server/db/database';
import { autoSnipeController } from '../server/auto/controller';
import { AutoResumeSchema } from '../server/execution/tradeInputs';

/**
 * 3C (P3.3: R1-8, R1-36, N-61..N-65, N-69): loss caps that cannot be switched off or outrun. Real ExecutionConfigManager,
 * HardenedRiskEngine and the in-memory workstationDb. vi.setSystemTime is the clock.
 * Each test runs on its own calendar day, so realized events of one never fall in another's 24 h window.
 */
const mint = () => Keypair.generate().publicKey.toBase58();

const order = (over: Partial<RiskEvaluationRequest> = {}): RiskEvaluationRequest => ({
  mint: mint(), orderSizeSol: 0.005, expectedPriceSol: 0.00001, slippageBps: 300, estimatedFeeLamports: 5_000, jitoTipLamports: 150_000,
  signalTimestamp: Date.now(), marketDataTimestamp: Date.now(), currentOpenPositionsCount: 0, currentTotalExposureSol: 0,
  walletSpendableSol: 1, executionMode: 'LIVE', ...over,
});

/** A closed LIVE position whose realized PnL is booked now (savePosition writes the realized event at Date.now()). */
const bookRealized = (sol: number) => workstationDb.savePosition({
  id: `s3c-${Math.random().toString(36).slice(2)}`, mint: mint(), symbol: 'S3C', name: 'S3C', tokenDecimals: 6, tokenQuantityRaw: '0',
  costBasisLamports: 10_000_000, entryPriceSol: 0.01, currentPriceSol: 0.01, realizedPnLSol: sol, entryTxSignature: `sig-${Math.random()}`,
  entryTimestamp: Date.now() - 60_000, executionMode: 'LIVE', status: 'CLOSED',
} as any);

const usdCapAtStart = executionConfig.getConfig().maxDailyLossUsd;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  executionConfig.updateConfig({ maxDailyLossUsd: usdCapAtStart });
  solPriceService.reset();
});

describe('3C R1-8, R1-36: the two limits are numbers above 0 or the server does not start', () => {
  it.each(['$0.02', 'abc', '0', '-1', 'NaN', 'Infinity'])('MAX_POSITION_SIZE_SOL=%s refuses with the variable named', (raw) => {
    vi.stubEnv('MAX_POSITION_SIZE_SOL', raw);
    expect(() => new ExecutionConfigManager()).toThrow(/MAX_POSITION_SIZE_SOL=.*not a number above 0/);
  });

  it.each(['$2.50', 'abc', '0', '-5'])('MAX_DAILY_LOSS_USD=%s refuses with the variable named', (raw) => {
    vi.stubEnv('MAX_DAILY_LOSS_USD', raw);
    expect(() => new ExecutionConfigManager()).toThrow(/MAX_DAILY_LOSS_USD=.*not a number above 0/);
  });

  it('unset or empty gives the tier default (MICRO_10: 0.02 SOL, $7.00), and a plain value is read as given', () => {
    vi.stubEnv('MAX_POSITION_SIZE_SOL', '');
    vi.stubEnv('MAX_DAILY_LOSS_USD', '');
    vi.stubEnv('CAPITAL_TIER', 'MICRO_10');
    expect(new ExecutionConfigManager().getConfig()).toMatchObject({ maxPositionSizeSol: 0.02, maxDailyLossUsd: 7 });
    vi.stubEnv('MAX_POSITION_SIZE_SOL', ' 0.01 ');
    vi.stubEnv('MAX_DAILY_LOSS_USD', '3');
    expect(new ExecutionConfigManager().getConfig()).toMatchObject({ maxPositionSizeSol: 0.01, maxDailyLossUsd: 3 });
  });

  it('updateConfig refuses a NaN or zero limit and keeps the old one', () => {
    const cfg = new ExecutionConfigManager();
    expect(() => cfg.updateConfig({ maxPositionSizeSol: NaN })).toThrow(/maxPositionSizeSol/);
    expect(() => cfg.updateConfig({ maxDailyLossUsd: 0 })).toThrow(/maxDailyLossUsd/);
    expect(cfg.getConfig().maxPositionSizeSol).toBe(0.02);
  });

  it('with the parsed default, a 1 SOL order is refused MAX_POSITION_SIZE', () => {
    const r = new HardenedRiskEngine().evaluateOrder(order({ orderSizeSol: 1 }));
    expect(r.reasonCode).toBe('MAX_POSITION_SIZE');
  });
});

describe('3C N-61: a rolling 24 h window, latched until an operator clears it', () => {
  it('losses at 23:58 UTC are still refused at 00:01, and after they leave the window the latch holds until cleared', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-10T23:58:00Z'));
    solPriceService.setPrice(150, 'TEST'); // floor: 7 / 150 = 0.0467 SOL
    const r = new HardenedRiskEngine();
    bookRealized(-0.05);
    const first = r.evaluateOrder(order());
    expect(first.reasonCode).toBe('DAILY_LOSS_LIMIT');
    expect(first.message).toMatch(/Net daily PnL floor/);
    expect(first.message).toContain('leaves it at 2030-01-11T23:58:00.000Z');

    vi.setSystemTime(new Date('2030-01-11T00:01:00Z'));
    solPriceService.setPrice(150, 'TEST');
    expect(r.evaluateOrder(order()).reasonCode).toBe('DAILY_LOSS_LIMIT');

    vi.setSystemTime(new Date('2030-01-12T00:30:00Z'));
    solPriceService.setPrice(150, 'TEST');
    expect(r.getDailyTotalPnLSol('LIVE')).toBe(0); // the loss has left the window
    const latched = r.evaluateOrder(order());
    expect(latched.reasonCode).toBe('DAILY_LOSS_LIMIT');
    expect(latched.message).toMatch(/latched at 2030-01-10T23:58:00.000Z.*clearDailyLossLatch/);

    r.clearDailyLossLatch();
    expect(r.evaluateOrder(order()).approved).toBe(true);
  });

  it('the latch is per mode: a LIVE latch does not refuse PAPER', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-20T12:00:00Z'));
    solPriceService.setPrice(150, 'TEST');
    const r = new HardenedRiskEngine();
    bookRealized(-0.05);
    expect(r.evaluateOrder(order()).reasonCode).toBe('DAILY_LOSS_LIMIT');
    expect(r.getDailyLossLatch('LIVE')).not.toBeNull();
    expect(r.evaluateOrder(order({ executionMode: 'PAPER' })).approved).toBe(true);
  });

  it('POST /api/auto/resume keeps clearDailyLossLatch, and resume() clears the latch only with that flag, not with clearHalt', () => {
    expect(AutoResumeSchema.parse({ clearDailyLossLatch: true })).toEqual({ clearDailyLossLatch: true });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-25T12:00:00Z'));
    solPriceService.setPrice(150, 'TEST');
    bookRealized(-0.05);
    expect(riskEngine.evaluateOrder(order()).reasonCode).toBe('DAILY_LOSS_LIMIT');
    autoSnipeController.resume({ clearHalt: true });
    expect(riskEngine.getDailyLossLatch('LIVE')).not.toBeNull();
    autoSnipeController.resume({ clearDailyLossLatch: true });
    expect(riskEngine.getDailyLossLatch('LIVE')).toBeNull();
  });
});

describe('3C N-62: the order and the open positions must fit above the floor at a total loss', () => {
  it('MICRO defaults at $150, 2 open at 0.04, net -0.01: a 0.02 order is refused and nothing latches', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-02-01T12:00:00Z'));
    solPriceService.setPrice(150, 'TEST');
    const r = new HardenedRiskEngine();
    bookRealized(-0.01);
    const res = r.evaluateOrder(order({ orderSizeSol: 0.02, currentOpenPositionsCount: 2, currentTotalExposureSol: 0.04 }));
    expect(res.reasonCode).toBe('DAILY_LOSS_LIMIT');
    expect(res.message).toMatch(/went to zero/);
    expect(r.getDailyLossLatch('LIVE')).toBeNull();
  });

  it('MICRO defaults at $150 with no loss: one open 0.02 plus a 0.02 order passes, two open plus one more does not', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-02-05T12:00:00Z'));
    solPriceService.setPrice(150, 'TEST');
    const r = new HardenedRiskEngine();
    expect(r.evaluateOrder(order({ orderSizeSol: 0.02, currentOpenPositionsCount: 1, currentTotalExposureSol: 0.02 })).approved).toBe(true);
    expect(r.evaluateOrder(order({ orderSizeSol: 0.02, currentOpenPositionsCount: 2, currentTotalExposureSol: 0.04 })).reasonCode).toBe('DAILY_LOSS_LIMIT');
  });

  it('a floor smaller than one order says MAX_DAILY_LOSS_USD is too small', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-02-10T12:00:00Z'));
    solPriceService.setPrice(150, 'TEST');
    executionConfig.updateConfig({ maxDailyLossUsd: 2.5 }); // 0.0167 SOL, below one 0.02 order
    const res = new HardenedRiskEngine().evaluateOrder(order({ orderSizeSol: 0.02 }));
    expect(res.reasonCode).toBe('DAILY_LOSS_LIMIT');
    expect(res.message).toMatch(/MAX_DAILY_LOSS_USD .* is smaller than this .* order/);
  });

  it('an open position marked down is charged at its current value, not its cost plus its loss', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-02-15T12:00:00Z'));
    solPriceService.setPrice(150, 'TEST');
    const id = `s3c-open-${Math.random().toString(36).slice(2)}`;
    const open = {
      id, mint: mint(), symbol: 'O', name: 'O', tokenDecimals: 6, tokenQuantityRaw: '1000000', costBasisLamports: 20_000_000,
      entryPriceSol: 0.02, currentPriceSol: 0.01, realizedPnLSol: 0, entryTxSignature: `sig-${id}`, entryTimestamp: Date.now() - 60_000,
      executionMode: 'LIVE', status: 'OPEN',
    } as any;
    workstationDb.savePosition(open);
    try {
      const r = new HardenedRiskEngine();
      expect(r.getDailyTotalPnLSol('LIVE')).toBeCloseTo(-0.01, 9);
      // worst case -0.01 - (0.02 cost - 0.01 unrealized + 0.020155 order) = -0.040155, inside the -0.0467 floor
      const res = r.evaluateOrder(order({ orderSizeSol: 0.02, currentOpenPositionsCount: 1, currentTotalExposureSol: 0.02 }));
      expect(res.approved).toBe(true);
    } finally {
      workstationDb.savePosition({ ...open, status: 'CLOSED', tokenQuantityRaw: '0' });
    }
  });
});

describe('3C N-65: a stale price can only tighten the floor', () => {
  it('a 61-minute-old price of 150 with $2.50: the floor is at most 0.0167 SOL, not 3 x 0.02', () => {
    executionConfig.updateConfig({ maxDailyLossUsd: 2.5 });
    solPriceService.setPrice(150, 'TEST', Date.now() - 61 * 60_000);
    expect(new HardenedRiskEngine().effectiveMaxDailyLossSol()).toBeLessThanOrEqual(0.0167);
  });

  it('with no price at all the fallback follows the position cap set through updateLimits', () => {
    solPriceService.reset(); // tests/setup pins 150 before each test
    const r = new HardenedRiskEngine();
    r.updateLimits({ maxPositionSol: 0.01 });
    expect(r.effectiveMaxDailyLossSol()).toBeCloseTo(0.03, 12);
  });
});
