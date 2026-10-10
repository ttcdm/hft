import { describe, it, expect, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator, executionCoordinator } from '../server/execution/coordinator';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { solPriceService } from '../server/market/solPriceService';
import { workstationDb } from '../server/db/database';

describe('L9: mark-feed health is real, and a LIVE buy with nothing spendable is refused', () => {
  afterEach(() => vi.restoreAllMocks());

  const livePos = (id: string, mode: 'LIVE' | 'PAPER', ageMs: number): any => ({
    id, mint: Keypair.generate().publicKey.toBase58(), symbol: 'L9', name: 'L9', tokenDecimals: 6, tokenQuantityRaw: '1000000',
    entryPriceSol: 1e-6, currentPriceSol: 1e-6, currentValueSol: 1e-6, costBasisLamports: 1000, realizedPnLSol: 0, status: 'OPEN',
    venue: 'PUMP_BONDING_CURVE', executionMode: mode, entryTxSignature: id, entryTimestamp: Date.now() - ageMs, lastMarkTimestamp: Date.now() - ageMs,
    recordUpdatedAt: Date.now(), updatedAt: Date.now(),
  });

  it('the mark feed turns STALE for an unpriceable LIVE position and recovers once it is closed; a PAPER one never turns it red (R11, R4)', async () => {
    {
      const c = new ExecutionCoordinator(false);
      vi.spyOn(c as any, 'updatePositionMarkPrices').mockResolvedValue(undefined); // no network
      vi.spyOn(c as any, 'refreshStaleMark').mockResolvedValue(false); // nobody can price it
      const markReason = () => c.canExecuteLive().reasons.filter((r) => /mark feed/i.test(r));

      workstationDb.savePosition(livePos('l9-paper-unpriced', 'PAPER', 10 * 60_000));
      await c.evaluateAndProcessExits();
      expect(markReason(), 'a PAPER position must not turn the LIVE mark feed red').toEqual([]);

      workstationDb.savePosition(livePos('l9-live-unpriced', 'LIVE', 10 * 60_000));
      await c.evaluateAndProcessExits();
      expect(markReason().join(' ')).toMatch(/Position mark feed is/);

      // the position closes: nothing is left to be stale, so the feed must recover without a restart
      workstationDb.savePosition({ ...livePos('l9-live-unpriced', 'LIVE', 10 * 60_000), status: 'CLOSED' });
      workstationDb.savePosition({ ...livePos('l9-paper-unpriced', 'PAPER', 10 * 60_000), status: 'CLOSED' });
      await c.evaluateAndProcessExits();
      expect(markReason()).toEqual([]);
      c.cleanup();
    }
  });

  it('a LIVE snipe with zero spendable bankroll is rejected, not sent at the full requested size', async () => {
    solPriceService.setPrice(150, 'TEST_FIXTURE');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol').mockReturnValue(0.01); // below the 0.015 reserve: spendable is 0
    const trade = vi.spyOn(executionCoordinator, 'executeTrade');
    const res = await memecoinAggregator.executeSnipe({ contractAddress: Keypair.generate().publicKey.toBase58(), amountUsd: 5, platform: 'PUMP_FUN', provenance: 'REAL_ONCHAIN', signalTimestamp: Date.now() } as any);
    expect(res.success).toBe(false);
    // T2: the refusal is the sizer's own (spendable <= 0 never returns approved), which comes before the aggregator's NO_SPENDABLE_BANKROLL branch
    expect(res.message).toMatch(/Capital sizing failed \(INSUFFICIENT_SPENDABLE_BANKROLL\)/);
    expect(trade).not.toHaveBeenCalled();
  });

  it('control: with a funded wallet the same snipe gets past the spendable check and is stopped by the next gate (market data), so the refusal above is the spendable check', async () => {
    solPriceService.setPrice(150, 'TEST_FIXTURE');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol').mockReturnValue(1.0);
    const trade = vi.spyOn(executionCoordinator, 'executeTrade');
    const res = await memecoinAggregator.executeSnipe({ contractAddress: Keypair.generate().publicKey.toBase58(), amountUsd: 5, platform: 'PUMP_FUN', provenance: 'REAL_ONCHAIN', signalTimestamp: Date.now() } as any);
    expect(res.success).toBe(false);
    expect(res.message).not.toMatch(/NO_SPENDABLE_BANKROLL|Capital sizing|INSUFFICIENT/);
    expect(res.message).toMatch(/MARKET_DATA_UNAVAILABLE/); // the stub RPC has no curve: the later gate answers
    expect(trade).not.toHaveBeenCalled();
  });
});
