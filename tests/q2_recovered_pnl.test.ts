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

/** S9: paper trades priced by the flat model (the curve could not be read) are not evidence either, on the entry or on the exit. */
describe('S9: model-priced paper fills stay out of the evidence set', () => {
  const closed = (id: string) => base(id, { executionMode: 'PAPER', status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 10_000_000, realizedPnLSol: 0.002 });

  it('a MODEL-priced entry and a MODEL-priced exit are excluded; a curve-quoted round trip is kept', () => {
    for (const id of ['entry-model', 'exit-model', 'quoted']) db.savePosition(closed(id));
    db.logJournal('PAPER_FILL_GATES', 'c1', 'PAPER', { mint: 'm', orderId: 'entry-model', gates: { pricing: 'MODEL', eligibility: { unverified: [] } } });
    db.logJournal('PAPER_FILL_GATES', 'c2', 'PAPER', { mint: 'm', orderId: 'exit-model', gates: { pricing: 'CURVE_QUOTE', eligibility: { unverified: [] } } });
    db.logJournal('PAPER_FILL_GATES', 'c3', 'PAPER', { mint: 'm', orderId: 'quoted', gates: { pricing: 'CURVE_QUOTE', eligibility: { unverified: [] } } });
    db.logJournal('PAPER_SELL_FILLED', 'exit-model', 'PAPER', { positionId: 'exit-model', pricing: 'MODEL' });
    db.logJournal('PAPER_SELL_FILLED', 'quoted', 'PAPER', { positionId: 'quoted', pricing: 'CURVE_QUOTE' });
    expect(db.loadEvidenceClosedTrades('PAPER').map((p) => p.id)).toEqual(['quoted']);
  });

  it('the C5 rule still applies (an UNKNOWN gate), and retention keeps both journal kinds', () => {
    db.savePosition(closed('unknown-gate'));
    db.logJournal('PAPER_FILL_GATES', 'c', 'PAPER', { mint: 'm', orderId: 'unknown-gate', gates: { pricing: 'CURVE_QUOTE', eligibility: { unverified: ['liquidity'] } } });
    db.savePosition(closed('exit-only'));
    db.logJournal('PAPER_SELL_FILLED', 'exit-only', 'PAPER', { positionId: 'exit-only', pricing: 'MODEL' });
    expect(db.loadEvidenceClosedTrades('PAPER')).toEqual([]);
    db.pruneOldRows(1, Date.now() + 10 * 86_400_000); // everything is "old"
    expect([...db.getUnverifiedFillIds()].sort()).toEqual(['exit-only', 'unknown-gate']);
  });
});
