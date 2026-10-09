import { describe, it, expect, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator, executionCoordinator } from '../server/execution/coordinator';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { solPriceService } from '../server/market/solPriceService';
import { workstationDb } from '../server/db/database';

describe('L9: mark-feed health is real, and a LIVE buy with nothing spendable is refused', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a position with a fresh mark records a position-mark event; an unpriceable one does not and ages from its entry', async () => {
    const c = new ExecutionCoordinator(false);
    const rec = vi.spyOn(c, 'recordPositionMarkEvent');
    vi.spyOn(c as any, 'updatePositionMarkPrices').mockResolvedValue(undefined);
    const pos: any = {
      id: 'l9-fresh', mint: Keypair.generate().publicKey.toBase58(), symbol: 'L9', name: 'L9', tokenDecimals: 6, tokenQuantityRaw: '1000000',
      entryPriceSol: 1e-6, currentPriceSol: 1e-6, currentValueSol: 1e-6, costBasisLamports: 1000, realizedPnLSol: 0, status: 'OPEN',
      venue: 'PUMP_BONDING_CURVE', executionMode: 'PAPER', entryTxSignature: 'l9', entryTimestamp: Date.now(), lastMarkTimestamp: Date.now(),
      recordUpdatedAt: Date.now(), updatedAt: Date.now(),
    };
    workstationDb.savePosition(pos);
    await c.evaluateAndProcessExits();
    expect(rec).toHaveBeenCalled();

    rec.mockClear();
    vi.spyOn(c as any, 'refreshStaleMark').mockResolvedValue(false);
    workstationDb.savePosition({ ...pos, status: 'CLOSED' });
    const old = Date.now() - 10 * 60_000;
    workstationDb.savePosition({ ...pos, id: 'l9-unpriced', mint: Keypair.generate().publicKey.toBase58(), status: 'OPEN', entryTimestamp: old, lastMarkTimestamp: old });
    (c as any).lastPositionMarkTimestamp = 0;
    await c.evaluateAndProcessExits();
    expect(rec).not.toHaveBeenCalled();
    expect((c as any).lastPositionMarkTimestamp).toBe(workstationDb.loadPositions().find((p) => p.id === 'l9-unpriced')!.entryTimestamp);
    c.cleanup();
  });

  it('a LIVE snipe with zero spendable bankroll is rejected, not sent at the full requested size', async () => {
    solPriceService.setPrice(150, 'TEST_FIXTURE');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol').mockReturnValue(0.01); // below the 0.015 reserve: spendable is 0
    const trade = vi.spyOn(executionCoordinator, 'executeTrade');
    const res = await memecoinAggregator.executeSnipe({ contractAddress: Keypair.generate().publicKey.toBase58(), amountUsd: 5, platform: 'PUMP_FUN', provenance: 'REAL_ONCHAIN', signalTimestamp: Date.now() } as any);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/NO_SPENDABLE_BANKROLL|WALLET_BALANCE|Capital sizing/);
    expect(trade).not.toHaveBeenCalled();
  });
});
