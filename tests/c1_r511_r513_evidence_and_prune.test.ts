import { describe, it, expect } from 'vitest';
import { WorkstationDatabase } from '../server/db/database';

const DAY = 86_400_000;

/**
 * R5-11: a position closed on a zero balance books its basis as an assumed loss (P2.3), and that loss must reach the closed-trade evidence
 * (loss triggers, Kelly). R5-13: the 90-day decisions prune must keep what auto ownership and evidence read. Real database, in memory.
 */
describe('R5-11 / R5-13: closed-trade evidence and the decisions prune', () => {
  const closedRow = (db: WorkstationDatabase, id: string, realized: number, exitReason: string) => db.savePosition({
    id, mint: 'M'.repeat(43), symbol: 'E', name: 'E', tokenDecimals: 6, tokenQuantityRaw: '0', entryPriceSol: 1e-4, currentPriceSol: 1e-4,
    costBasisLamports: 0, realizedPnLSol: realized, status: 'CLOSED', executionMode: 'LIVE', entryTxSignature: `sig_${id}`, entryTimestamp: Date.now(), exitReason,
  } as any);

  it('R5-11: a RECONCILED_ZERO_BALANCE close with its assumed loss is evidence; an old one with realized 0 and no loss is not', () => {
    const db = new WorkstationDatabase(':memory:');
    closedRow(db, 'assumed', -0.1, 'RECONCILED_ZERO_BALANCE: no tokens in the wallet at startup reconciliation (REALIZED_ASSUMED_LOSS)');
    closedRow(db, 'exitpath', -0.05, 'RECONCILED_ZERO_BALANCE: the wallet held no tokens when the sell was prepared (REALIZED_ASSUMED_LOSS)');
    closedRow(db, 'legacy', 0, 'RECONCILED_ZERO_BALANCE: no tokens in the wallet at startup reconciliation');
    closedRow(db, 'normal', 0.02, 'TAKE_PROFIT_1');
    const ids = db.loadEvidenceClosedTrades('LIVE').map((p) => p.id).sort();
    expect(ids).toEqual(['assumed', 'exitpath', 'normal']);
  });

  it('R5-13: old BOUGHT rows, and the LIVE_BUY_FILLED row of a position still open, survive the prune; other old rows go', () => {
    const NOW = Date.UTC(2026, 9, 27);
    const db = new WorkstationDatabase(':memory:');
    db.savePosition({
      id: 'open1', mint: 'M'.repeat(43), symbol: 'O', name: 'O', tokenDecimals: 6, tokenQuantityRaw: '10', entryPriceSol: 1e-4, currentPriceSol: 1e-4,
      costBasisLamports: 1, realizedPnLSol: 0, status: 'OPEN', executionMode: 'LIVE', entryTxSignature: 'open1', entryTimestamp: NOW - 200 * DAY,
    } as any);
    closedRow(db, 'closed1', -0.01, 'STOP_LOSS');
    const old = NOW - 120 * DAY;
    db.logDecision({ ts: old, autoMode: 'DEVNET_LIVE', mint: 'm', stage: 'fill', outcome: 'BOUGHT', reason: 'auto buy', positionId: 'closed1' });
    db.logDecision({ ts: old, autoMode: 'n/a', mint: 'm', stage: 'fill', outcome: 'LIVE_BUY_FILLED', reason: 'x', positionId: 'open1', solDelta: -0.01 });
    db.logDecision({ ts: old, autoMode: 'n/a', mint: 'm', stage: 'fill', outcome: 'LIVE_BUY_FILLED', reason: 'x', positionId: 'closed1', solDelta: -0.01 });
    db.logDecision({ ts: old, autoMode: 'PAPER', mint: 'm', stage: 'risk', outcome: 'DROPPED', reason: 'old noise' });
    const r = db.pruneOldRows(90, NOW);
    expect(r.decisions).toBe(2);
    const left = db.loadDecisions({ limit: 100 }).map((d) => `${d.outcome}:${d.positionId ?? '-'}`).sort();
    expect(left).toEqual(['BOUGHT:closed1', 'LIVE_BUY_FILLED:open1']);
  });
});
