import { describe, it, expect, vi, afterEach } from 'vitest';
import { walletTrader } from '../server/walletTrader';
import { solPriceService } from '../server/market/solPriceService';
import { executionCoordinator } from '../server/execution/coordinator';

describe('S26: the wallet sync loop does not reach a price host in unit tests', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('APEX_DISABLE_EXTERNAL_FEEDS=true: syncRpcBalance does not call solPriceService.refresh (vitest.config sets it)', async () => {
    expect(process.env.APEX_DISABLE_EXTERNAL_FEEDS).toBe('true');
    vi.spyOn(executionCoordinator, 'syncRealWalletBalance').mockResolvedValue(1);
    const refresh = vi.spyOn(solPriceService, 'refresh').mockResolvedValue(solPriceService.getPrice());
    await walletTrader.syncRpcBalance();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('without the flag the refresh still runs (production behaviour unchanged)', async () => {
    vi.stubEnv('APEX_DISABLE_EXTERNAL_FEEDS', '');
    vi.spyOn(executionCoordinator, 'syncRealWalletBalance').mockResolvedValue(1);
    const refresh = vi.spyOn(solPriceService, 'refresh').mockResolvedValue(solPriceService.getPrice());
    await walletTrader.syncRpcBalance();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
