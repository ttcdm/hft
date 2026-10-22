import { describe, it, expect, afterEach, vi } from 'vitest';
import { WalletConfigSchema } from '../server/middleware/enterprise';
import { walletTrader } from '../server/walletTrader';
import { executionCoordinator } from '../server/execution/coordinator';
import { solPriceService } from '../server/market/solPriceService';

/**
 * Audit 2026-10-22, wallet config cleanup (approved by Mike): the wallet config and state carry nothing that looks like a setting or a
 * wallet figure but is not one. `enabledStrategies` (four strategy toggles) was accepted and echoed back, and nothing read it.
 * `allocatedSol` was a constant per capital tier (0.07 or 5 SOL) that the state echoed as `allocatedSol` and `availableSol` next to the
 * real `solBalance`, and `totalPortfolioValueUsd` was built from it. Now the portfolio value comes from the real balance.
 */
afterEach(() => {
  vi.restoreAllMocks();
  solPriceService.reset();
});

const withBalanceAndPositions = (walletSolBalance: number | null, active: Array<{ currentValueSol: number }>) => {
  const real = executionCoordinator.getDiagnostics.bind(executionCoordinator);
  vi.spyOn(executionCoordinator, 'getDiagnostics').mockImplementation(() => ({ ...real(), walletSolBalance }));
  vi.spyOn(executionCoordinator, 'getPositions').mockImplementation((_mode?: any, status?: any) => (status === 'ACTIVE' ? (active as any) : []));
};

describe('audit 2026-10-22: the wallet config has no do-nothing settings', () => {
  it('the request schema drops enabledStrategies and allocatedSol instead of accepting them', () => {
    const parsed = WalletConfigSchema.parse({ enabledStrategies: { pumpFunSniper: false, marketMaking: true }, allocatedSol: 3, riskLimits: {} }) as any;
    expect(parsed.enabledStrategies).toBeUndefined();
    expect(parsed.allocatedSol).toBeUndefined();
    expect(Object.keys(parsed).sort()).toEqual(['capitalTier', 'jitoBlockEngineUrl', 'riskLimits', 'slippageToleranceBps']);
  });

  it('the stored config carries neither field, and a save naming them does not bring them back', async () => {
    vi.spyOn(walletTrader, 'syncRpcBalance').mockResolvedValue(null);
    const updated = await walletTrader.updateConfig({ enabledStrategies: { marketMaking: true }, allocatedSol: 3 } as any);
    for (const cfg of [updated, walletTrader.getConfig()]) {
      expect((cfg as any).enabledStrategies).toBeUndefined();
      expect((cfg as any).allocatedSol).toBeUndefined();
    }
  });
});

describe('audit 2026-10-22: the wallet state shows the real balance, not a constant', () => {
  it('has no allocatedSol or availableSol', () => {
    const s = walletTrader.getState() as any;
    expect(s.allocatedSol).toBeUndefined();
    expect(s.availableSol).toBeUndefined();
    expect(s).toHaveProperty('solBalance');
  });

  it('totalPortfolioValueUsd is null until the real balance has been read, even with a SOL price', () => {
    solPriceService.setPrice(150, 'TEST_FIXTURE');
    withBalanceAndPositions(null, [{ currentValueSol: 0.5 }]);
    const s = walletTrader.getState();
    expect(s.solBalance).toBeNull();
    expect(s.totalPortfolioValueUsd).toBeNull();
  });

  it('totalPortfolioValueUsd is the real balance plus the open positions, at the SOL price', () => {
    solPriceService.setPrice(150, 'TEST_FIXTURE');
    withBalanceAndPositions(2, [{ currentValueSol: 0.5 }]);
    const s = walletTrader.getState();
    expect(s.solBalance).toBe(2);
    expect(s.totalPortfolioValueUsd).toBe(375); // (2 + 0.5) * 150; before, (0.07 - cost) * 150 whatever the wallet held
  });

  it('with no SOL price yet the dollar figure is null, whatever the balance', () => {
    vi.spyOn(solPriceService, 'lastKnownPrice').mockReturnValue(null); // the test harness keeps a fixture price; a cold start has none
    withBalanceAndPositions(2, []);
    expect(walletTrader.getState().totalPortfolioValueUsd).toBeNull();
  });
});
