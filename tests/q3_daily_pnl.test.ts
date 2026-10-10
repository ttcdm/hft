import { describe, it, expect, beforeEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WorkstationDatabase } from '../server/db/database';

/**
 * Q3 / Q3b: the daily-loss figure must not count fees twice, must not count fees of transactions that never landed, and must key
 * "realized today" on when the PnL was realized, not on when a mark tick last rewrote the row. Scratch DB, throwaway keys.
 */
let db: WorkstationDatabase;
const raw = () => (db as any).db;
const mint = () => Keypair.generate().publicKey.toBase58();
const tx = (signature: string, state: string, extra: Record<string, unknown> = {}) => db.saveTransaction({
  signature, orderId: `o-${signature}`, correlationId: `c-${signature}`, mint: mint(), direction: 'BUY', submissionTransport: 'RPC',
  submissionTime: Date.now(), reconciliationState: state as any, networkFeeLamports: 5000, jitoTipLamports: 300_000, executionMode: 'LIVE', ...extra,
} as any);
const pos = (id: string, over: Record<string, unknown> = {}) => ({
  id, mint: mint(), symbol: id, name: id, tokenDecimals: 6, tokenQuantityRaw: '1000000', costBasisLamports: 10_000_000, entryPriceSol: 0.01,
  currentPriceSol: 0.01, realizedPnLSol: 0, entryTxSignature: `sig-${id}`, entryTimestamp: Date.now() - 3600_000, executionMode: 'LIVE', status: 'OPEN', ...over,
}) as any;

beforeEach(() => { db = new WorkstationDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'q3-')), 'q3.db')); });

describe('Q3: fees in the daily total', () => {
  it('a reconciled trade, a pre-written PENDING row and a never-sent REVERTED row add nothing; a landed failure costs its network fee', () => {
    tx('landed-ok', 'RECONCILED', { landingSlot: 10 });
    tx('pre-written', 'PENDING');
    tx('failed_123', 'REVERTED'); // placeholder for a send that never reached the chain: no landing slot
    expect(db.getDailyTotalPnLSol('LIVE')).toBe(0);
    tx('landed-fail', 'REVERTED', { landingSlot: 11 });
    expect(db.getDailyTotalPnLSol('LIVE')).toBeCloseTo(-0.000005, 9); // 5000 lamports, no Jito tip (a failed bundle does not pay it)
    expect(db.getDailyUnbookedFeesLamports('LIVE')).toBe(5000);
  });
});

describe('Q3b: "realized today" is the sum of today\'s fills, not the history of any row rewritten today', () => {
  it('a partial realized yesterday stays out after a mark tick rewrites the row; only today\'s second partial counts, by its own amount', () => {
    db.savePosition(pos('old-partial', { status: 'PARTIALLY_CLOSED', realizedPnLSol: 0.5 }));
    const yesterday = Date.now() - 36 * 3600_000;
    raw().prepare('UPDATE realized_events SET ts = ?').run(yesterday);
    expect(db.getDailyRealizedPnLSol('LIVE')).toBe(0);
    // the 3 s mark tick saves the whole row again with the same realized PnL
    db.savePosition(pos('old-partial', { status: 'PARTIALLY_CLOSED', realizedPnLSol: 0.5, currentPriceSol: 0.0099 }));
    expect(db.getDailyRealizedPnLSol('LIVE')).toBe(0);
    // today's second partial raises realized PnL from 0.5 to 0.7: today's figure is the 0.2 of that fill
    db.savePosition(pos('old-partial', { status: 'PARTIALLY_CLOSED', realizedPnLSol: 0.7 }));
    expect(db.getDailyRealizedPnLSol('LIVE')).toBeCloseTo(0.2, 9);
    // other modes are not mixed in
    expect(db.getDailyRealizedPnLSol('PAPER')).toBe(0);
  });

  it('rows that carried realized PnL before the events table existed keep their updated_at as the time of it', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'q3m-')), 'm.db');
    const first = new WorkstationDatabase(file);
    first.savePosition(pos('legacy', { status: 'CLOSED', realizedPnLSol: -0.2 }));
    (first as any).db.exec('DELETE FROM realized_events');
    (first as any).db.close();
    const again = new WorkstationDatabase(file);
    expect(again.getDailyRealizedPnLSol('LIVE')).toBeCloseTo(-0.2, 9);
  });
});
