import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WorkstationDatabase } from '../server/db/database';

const mk = () => new WorkstationDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 's11-')), 's11.db'));
const base = (over: Record<string, unknown> = {}) => ({
  id: 'p1', mint: Keypair.generate().publicKey.toBase58(), symbol: 'P1', name: 'P1', tokenDecimals: 6, tokenQuantityRaw: '1000000', costBasisLamports: 50_000_000,
  entryPriceSol: 1, currentPriceSol: 1, realizedPnLSol: 0, entryTxSignature: 'sig-p1', entryTimestamp: Date.now() - 3600_000,
  executionMode: 'LIVE', status: 'OPEN', ...over,
}) as any;

describe('S11 / Q14: a stale mark refresh cannot undo a close', () => {
  it('saveMark updates the mark of an open row and nothing else', () => {
    const db = mk();
    db.savePosition(base());
    const stale = db.loadPositions('LIVE')[0];
    expect(db.saveMark({ ...stale, currentPriceSol: 2, markSource: 'SOLANA_RPC', highWaterMarkSol: 2, lastMarkTimestamp: Date.now() } as any)).toBe(true);
    const after = db.loadPositions('LIVE')[0];
    expect(after.currentPriceSol).toBe(2);
    expect(after.highWaterMarkSol).toBe(2);
    expect(after.tokenQuantityRaw).toBe('1000000');
  });

  it('a mark saved from a copy taken before a manual close leaves the row CLOSED, with realized and the ledger unchanged', () => {
    const db = mk();
    db.savePosition(base());
    const stale = db.loadPositions('LIVE')[0]; // the refresh loaded this before its awaits
    db.savePosition(base({ status: 'CLOSED', tokenQuantityRaw: '0', realizedPnLSol: -0.01, currentPriceSol: 0.8 })); // the manual close commits meanwhile
    const realizedBefore = db.getDailyRealizedPnLSol('LIVE');
    expect(db.saveMark({ ...stale, currentPriceSol: 1.1, markSource: 'SOLANA_RPC', lastMarkTimestamp: Date.now() } as any)).toBe(false);
    const row = db.loadPositions('LIVE')[0];
    expect(row.status).toBe('CLOSED');
    expect(row.tokenQuantityRaw).toBe('0');
    expect(row.currentPriceSol).toBe(0.8);
    expect(db.getDailyRealizedPnLSol('LIVE')).toBeCloseTo(realizedBefore, 12);
    expect(realizedBefore).toBeCloseTo(-0.01, 9);
  });

  it('the stale whole-row save is what used to corrupt it (documents the failure the fix avoids)', () => {
    const db = mk();
    db.savePosition(base());
    const stale = db.loadPositions('LIVE')[0];
    db.savePosition(base({ status: 'CLOSED', tokenQuantityRaw: '0', realizedPnLSol: -0.01 }));
    db.savePosition({ ...stale, currentPriceSol: 1.1 } as any);
    expect(db.loadPositions('LIVE')[0].status).toBe('OPEN'); // resurrected: this is why marks no longer use savePosition
  });
});
