import { describe, it, expect, beforeEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WorkstationDatabase } from '../server/db/database';

/**
 * Q2: a RECOVERED (adopted) balance has cost basis 0, so "value - 0" used to read as a gain. It masked a real loss in the daily-loss
 * gate and, once sold, put its proceeds into the win-rate / expectancy evidence. Scratch DB, throwaway mints.
 */
let db: WorkstationDatabase;
beforeEach(() => { db = new WorkstationDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'q2-')), 'q2.db')); });

const base = (id: string, over: Record<string, unknown> = {}) => ({
  id, mint: Keypair.generate().publicKey.toBase58(), symbol: id, name: id, tokenDecimals: 6, tokenQuantityRaw: '1000000', costBasisLamports: 0,
  entryPriceSol: 1, currentPriceSol: 1, realizedPnLSol: 0, entryTxSignature: `sig-${id}`, entryTimestamp: Date.now() - 3600_000,
  executionMode: 'LIVE', status: 'OPEN', ...over,
}) as any;

describe('Q2: adopted balances do not fabricate PnL', () => {
  it('an adopted balance worth 1 SOL does not mask a real -0.03 SOL loss in the daily total', () => {
    db.savePosition(base('recovered-A', { entryTxSignature: 'RECOVERED:A' })); // value 1 SOL, cost 0
    db.savePosition(base('real-loss', { costBasisLamports: 50_000_000, currentPriceSol: 0.02 })); // cost 0.05, value 0.02
    const rows = db.loadPositions('LIVE', 'ACTIVE');
    expect(rows.find((p) => p.id === 'recovered-A')!.unrealizedPnLSol).toBe(0);
    expect(db.getDailyTotalPnLSol('LIVE')).toBeCloseTo(-0.03, 6);
  });

  it('selling an adopted balance adds neither daily realized PnL nor an evidence trade', () => {
    db.savePosition(base('recovered-B', { entryTxSignature: 'RECOVERED:B' }));
    db.savePosition(base('recovered-B', { entryTxSignature: 'RECOVERED:B', status: 'CLOSED', tokenQuantityRaw: '0', realizedPnLSol: 1 }));
    expect(db.getDailyRealizedPnLSol('LIVE')).toBe(0);
    expect(db.loadEvidenceClosedTrades().map((p) => p.id)).not.toContain('recovered-B');
  });

  it('a row closed because the wallet held nothing is not evidence; a normal closed trade still is', () => {
    db.savePosition(base('zero', { status: 'CLOSED', tokenQuantityRaw: '0', exitReason: 'RECONCILED_ZERO_BALANCE: no tokens in the wallet at startup reconciliation' }));
    db.savePosition(base('normal', { status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 10_000_000, realizedPnLSol: -0.004 }));
    expect(db.loadEvidenceClosedTrades().map((p) => p.id)).toEqual(['normal']);
    expect(db.getDailyRealizedPnLSol('LIVE')).toBeCloseTo(-0.004, 9);
  });
});
