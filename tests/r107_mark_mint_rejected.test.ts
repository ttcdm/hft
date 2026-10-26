import { describe, it, expect, afterEach, vi } from 'vitest';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { RealMarkPriceService } from '../server/execution/reconciliation';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { workstationDb } from '../server/db/database';

// R19: a "mint" whose account is not owned by a token program used to fall through to PumpSwap in the mark path with no alert.
describe('R19: an account that is not a token mint is reported, not quietly re-tried on PumpSwap', () => {
  const account = () => ({ owner: SystemProgram.programId, data: Buffer.alloc(150), lamports: 1, executable: false });
  const conn = () => ({ getMultipleAccountsInfo: vi.fn(async () => [account(), account()]) }) as any;
  afterEach(() => { vi.restoreAllMocks(); PumpCurveService.clearMintRejections(); });

  it('the mark query records the reason and never asks PumpSwap', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const pool = vi.spyOn(PumpSwapVenueService, 'getPoolState');
    const marks = await RealMarkPriceService.queryOnChainMarkPrices(conn(), [mint], 'PAPER');
    expect(marks).toEqual({});
    expect(pool).not.toHaveBeenCalled();
    expect(PumpCurveService.getMintRejection(mint)).toMatch(/not a token program/);
  });

  it('the coordinator raises MARK_MINT_REJECTED for the position and keeps it honestly stale', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const id = `r19-${mint.slice(0, 6)}`;
    const now = Date.now();
    workstationDb.savePosition({
      id, mint, symbol: 'R19', name: 'R19', tokenDecimals: 6, tokenQuantityRaw: '1000000', entryPriceSol: 1e-6, currentPriceSol: 1e-6, currentValueSol: 1e-6,
      costBasisLamports: 1000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE', executionMode: 'PAPER', entryTxSignature: `PAPER:${id}`,
      entryTimestamp: now, lastMarkTimestamp: now, recordUpdatedAt: now, updatedAt: now,
    } as any);
    const c = new ExecutionCoordinator(false);
    (c as any).connection = conn();
    try {
      await c.updatePositionMarkPrices();
      const alert = c.getOperatorAlerts().find((a) => a.code === 'MARK_MINT_REJECTED' && a.positionId === id);
      expect(alert?.message).toMatch(/not a token program/);
    } finally {
      c.cleanup();
      workstationDb.savePosition({ ...workstationDb.loadPositions().find((p) => p.id === id)!, status: 'CLOSED' } as any);
    }
  });
});
