import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { PaperExecutionEngine } from '../server/execution/paperEngine';
import { workstationDb } from '../server/db/database';

/**
 * R9-25: a PAPER exit charged a 0.002 SOL tip whenever the position's stored tip was 0 (`|| 2000000`), and the sell's transaction row
 * then recorded a tip of 0. A stored 0 is a tip of 0.
 */
describe('R9-25: a PAPER exit charges the stored tip, 0 included, and records what it charged', () => {
  const seed = (id: string, jitoTipLamports: number | undefined) => workstationDb.savePosition({
    id, mint: Keypair.generate().publicKey.toBase58(), symbol: 'R925', name: id, tokenDecimals: 6, tokenQuantityRaw: '1000000000',
    entryPriceSol: 1e-6, currentPriceSol: 1e-6, currentValueSol: 0.001, unrealizedPnLSol: 0, costBasisLamports: 1_000_000, realizedPnLSol: 0, status: 'OPEN',
    venue: 'PUMP_BONDING_CURVE', executionMode: 'PAPER', entryTxSignature: `sig-${id}`, entryTimestamp: Date.now(), lastMarkTimestamp: Date.now(),
    recordUpdatedAt: Date.now(), updatedAt: Date.now(), ...(jitoTipLamports === undefined ? {} : { jitoTipLamports }),
  } as any);

  it('a zero-tip row: no tip in the proceeds, and the sell row records 0', () => {
    const id = `r925-zero-${Date.now()}`;
    seed(id, 0);
    // flat model: 1000 tokens at 1e-6 SOL * 0.995, less 1% protocol fee and the 0.000015 SOL network fee
    const r = new PaperExecutionEngine().executePaperSell(id, 1e-6, 100, 'test');
    expect(r.success).toBe(true);
    const gross = 1000 * 1e-6 * 0.995;
    expect(r.realizedPnLSol).toBeCloseTo(Number((gross - gross * 0.01 - 0.000015 - 0.001).toFixed(6)), 6);
    const sell = workstationDb.loadTransactions().filter((t) => t.mint === r.position!.mint && t.direction === 'SELL');
    expect(sell.map((t) => t.jitoTipLamports)).toEqual([0]);
  });

  it('a stored tip is charged and recorded on the sell row', () => {
    const id = `r925-tip-${Date.now()}`;
    seed(id, 150_000);
    const r = new PaperExecutionEngine().executePaperSell(id, 1e-6, 100, 'test');
    const gross = 1000 * 1e-6 * 0.995;
    expect(r.realizedPnLSol).toBeCloseTo(Number((gross - gross * 0.01 - 0.000015 - 0.00015 - 0.001).toFixed(6)), 6);
    const sell = workstationDb.loadTransactions().filter((t) => t.mint === r.position!.mint && t.direction === 'SELL');
    expect(sell.map((t) => t.jitoTipLamports)).toEqual([150_000]);
  });
});
