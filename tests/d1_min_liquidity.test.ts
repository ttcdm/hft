import { describe, it, expect, afterEach, vi } from 'vitest';
import { minLiquidityUsd, DEFAULT_MIN_LIQUIDITY_USD } from '../server/solana/executionConfig';
import { EligibilityFilter } from '../server/signals/eligibilityFilter';

function liquidityCheck(liquidityUsd: number) {
  const report = EligibilityFilter.evaluate(
    { mint: 'D1Mint11111111111111111111111111111111111111', symbol: 'D1', name: 'D1', liquidityUsd } as any,
    'PAPER'
  );
  return report.checks.find((c) => c.ruleId === 'MIN_LIQUIDITY_DEPTH')!;
}

describe('D1: minimum liquidity is cluster-scoped config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('defaults to 2000 USD when no override is set', () => {
    expect(minLiquidityUsd({ ALLOWED_CLUSTER: 'devnet' } as NodeJS.ProcessEnv)).toBe(2000);
    expect(DEFAULT_MIN_LIQUIDITY_USD).toBe(2000);
  });

  it('honours MIN_LIQUIDITY_USD on devnet and localnet', () => {
    expect(minLiquidityUsd({ ALLOWED_CLUSTER: 'devnet', MIN_LIQUIDITY_USD: '1' } as NodeJS.ProcessEnv)).toBe(1);
    expect(minLiquidityUsd({ ALLOWED_CLUSTER: 'localnet', MIN_LIQUIDITY_USD: '0' } as NodeJS.ProcessEnv)).toBe(0);
  });

  it('ignores MIN_LIQUIDITY_USD on mainnet-beta, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(minLiquidityUsd({ ALLOWED_CLUSTER: 'mainnet-beta', MIN_LIQUIDITY_USD: '1' } as NodeJS.ProcessEnv)).toBe(2000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored on mainnet-beta'));
  });

  it('falls back to the default for a malformed or negative override', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(minLiquidityUsd({ ALLOWED_CLUSTER: 'devnet', MIN_LIQUIDITY_USD: 'abc' } as NodeJS.ProcessEnv)).toBe(2000);
    expect(minLiquidityUsd({ ALLOWED_CLUSTER: 'devnet', MIN_LIQUIDITY_USD: '-5' } as NodeJS.ProcessEnv)).toBe(2000);
  });

  it('the real EligibilityFilter uses the override on devnet and the default on mainnet', () => {
    vi.stubEnv('ALLOWED_CLUSTER', 'devnet');
    vi.stubEnv('MIN_LIQUIDITY_USD', '5');
    expect(liquidityCheck(11).status).toBe('PASS');

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('ALLOWED_CLUSTER', 'mainnet-beta');
    expect(liquidityCheck(11).status).toBe('FAIL');
  });
});
