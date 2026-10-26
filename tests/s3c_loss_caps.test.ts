import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionConfigManager } from '../server/solana/executionConfig';
import { HardenedRiskEngine, RiskEvaluationRequest } from '../server/risk/riskEngine';

/**
 * 3C (P3.3: R1-8, R1-36, N-61..N-65, N-69): loss caps that cannot be switched off or outrun. Real ExecutionConfigManager,
 * HardenedRiskEngine, SolPriceService and the in-memory workstationDb; fetch is the only double. vi.setSystemTime is the clock.
 * Each test runs on its own calendar day, so realized events of one never fall in another's 24 h window.
 */
const mint = () => Keypair.generate().publicKey.toBase58();

const order = (over: Partial<RiskEvaluationRequest> = {}): RiskEvaluationRequest => ({
  mint: mint(), orderSizeSol: 0.005, expectedPriceSol: 0.00001, slippageBps: 300, estimatedFeeLamports: 5_000, jitoTipLamports: 150_000,
  signalTimestamp: Date.now(), marketDataTimestamp: Date.now(), currentOpenPositionsCount: 0, currentTotalExposureSol: 0,
  walletSpendableSol: 1, executionMode: 'LIVE', ...over,
});

afterEach(() => {
  vi.unstubAllEnvs();
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

  it('unset or empty gives the tier default (MICRO_10: 0.02 SOL, $2.50), and a plain value is read as given', () => {
    vi.stubEnv('MAX_POSITION_SIZE_SOL', '');
    vi.stubEnv('MAX_DAILY_LOSS_USD', '');
    vi.stubEnv('CAPITAL_TIER', 'MICRO_10');
    expect(new ExecutionConfigManager().getConfig()).toMatchObject({ maxPositionSizeSol: 0.02, maxDailyLossUsd: 2.5 });
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
