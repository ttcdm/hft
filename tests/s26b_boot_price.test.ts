import { describe, it, expect, vi, afterEach } from 'vitest';
import { SolPriceService } from '../server/market/solPriceService';

describe('S26b: boot price when external feeds are disabled', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('localnet: one refresh resolves LOCALNET_FIXED with no network call and no background timer', async () => {
    vi.stubEnv('ALLOWED_CLUSTER', 'localnet');
    vi.stubEnv('LOCALNET_SOL_PRICE_USD', '150');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const s = new SolPriceService();
    const auto = vi.spyOn(s, 'startAutoRefresh');
    s.startForBoot(true);
    await s.refresh();
    expect(s.requireFreshPrice()).toBe(150);
    expect(s.getPrice().source).toBe('LOCALNET_FIXED');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(auto).not.toHaveBeenCalled();
  });

  it('devnet with feeds disabled: nothing runs, no fetch, no price', async () => {
    vi.stubEnv('ALLOWED_CLUSTER', 'devnet');
    vi.stubEnv('LOCALNET_SOL_PRICE_USD', '150');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const s = new SolPriceService();
    const refresh = vi.spyOn(s, 'refresh');
    s.startForBoot(true);
    expect(refresh).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(s.getPrice().usd).toBeNull();
  });

  it('feeds enabled: starts the background refresh', () => {
    const s = new SolPriceService();
    const auto = vi.spyOn(s, 'startAutoRefresh').mockImplementation(() => undefined as any);
    s.startForBoot(false);
    expect(auto).toHaveBeenCalledTimes(1);
  });
});
