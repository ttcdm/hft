import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { executionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';
import { solPriceService } from '../server/market/solPriceService';
import { CapitalSizer } from '../server/capital/capitalSizer';
import { LOSS_TRIGGER_ACK_SETTING, MAX_CONSECUTIVE_LOSSES } from '../server/auto/killSwitch';
import { newPumpPool } from './fixtures/auto';

/**
 * R8-8: manual LIVE buys had no expectancy or loss-streak check, and Kelly approval used the lifetime mean, so a recent losing run did not
 * stop buys until the lifetime figures turned. The real aggregator, CapitalSizer and in-memory ledger; executeTrade is the stubbed boundary.
 */
let seq = 0;
function closedLive(pnl: number): void {
  const id = `r88-${Math.random().toString(36).slice(2)}`;
  workstationDb.savePosition({
    id, mint: Keypair.generate().publicKey.toBase58(), symbol: 'L', name: 'L', tokenDecimals: 6, tokenQuantityRaw: '0', costBasisLamports: 5e6,
    entryPriceSol: 1e-7, currentPriceSol: 1e-7, currentValueSol: 0, realizedPnLSol: pnl, entryTxSignature: id, entryTimestamp: Date.now() - 1000,
    executionMode: 'LIVE', status: 'CLOSED', lastUpdatedTimestamp: Date.now() + ++seq,
  } as any);
}

describe('R8-8: LIVE buys are refused on recent results', () => {
  beforeEach(() => {
    solPriceService.setPrice(150, 'TEST_FIXTURE');
    memecoinAggregator.setConfluenceGating(false);
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol').mockReturnValue(1);
  });
  afterEach(() => { vi.restoreAllMocks(); memecoinAggregator.setConfluenceGating(true); });

  const trade = () => vi.spyOn(executionCoordinator, 'executeTrade').mockResolvedValue({ success: true, lifecycleState: 'CONFIRMED', executionMode: 'LIVE', positionId: 'p', correlationId: 'c' } as any);

  it(`a streak of ${MAX_CONSECUTIVE_LOSSES} manual LIVE losses refuses the next manual buy (LOSS_STREAK) until acknowledged`, async () => {
    for (let i = 0; i < MAX_CONSECUTIVE_LOSSES; i++) closedLive(-0.001);
    const t = trade();
    const r = await memecoinAggregator.executeSnipe({ contractAddress: newPumpPool('NONE').mint, amountUsd: 0, operatorAmountSol: 0.01, provenance: 'MANUAL_OPERATOR', signalTimestamp: Date.now() });
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/LOSS_TRIGGERS: LOSS_STREAK/);
    expect(t).not.toHaveBeenCalled();

    workstationDb.setSetting(LOSS_TRIGGER_ACK_SETTING, { ts: Date.now() + seq + 1 }); // POST /api/auto/resume {ackLossTriggers:true}
    const after = await memecoinAggregator.executeSnipe({ contractAddress: newPumpPool('NONE').mint, amountUsd: 0, operatorAmountSol: 0.01, provenance: 'MANUAL_OPERATOR', signalTimestamp: Date.now() });
    expect(after.success, after.message).toBe(true);
  });

  it('past the cold start, a negative Kelly over the recent window refuses even while the lifetime Kelly is positive', async () => {
    // early big wins keep the lifetime Kelly positive; the last 25 trades are a slow bleed (no streak of 8)
    for (let i = 0; i < 10; i++) closedLive(0.05);
    for (let i = 0; i < CapitalSizer.KELLY_RECENT_WINDOW; i++) closedLive(i % 2 ? 0.0001 : -0.002);
    workstationDb.setSetting(LOSS_TRIGGER_ACK_SETTING, { ts: Date.now() + seq + 1 }); // the loss triggers are acknowledged: only Kelly judges
    const life = CapitalSizer.getHistoricalTradeStats('LIVE');
    expect(life.tradeCount).toBeGreaterThanOrEqual(CapitalSizer.SHRINKAGE_PRIOR_WEIGHT);
    expect(CapitalSizer.calculateRawKelly(life.winRate, life.winLossRatio)).toBeGreaterThan(0);
    const t = trade();
    const r = await memecoinAggregator.executeSnipe({ contractAddress: newPumpPool('NONE').mint, amountUsd: 0, operatorAmountSol: 0.01, provenance: 'MANUAL_OPERATOR', signalTimestamp: Date.now() });
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/NEGATIVE_RECENT_EXPECTANCY/);
    expect(t).not.toHaveBeenCalled();
  });
});
