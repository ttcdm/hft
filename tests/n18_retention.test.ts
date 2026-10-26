import { describe, it, expect } from 'vitest';
import { WorkstationDatabase } from '../server/db/database';

const DAY = 86_400_000;

describe('N18: retention for the audit tables, and indexed transaction lookups', () => {
  const NOW = Date.UTC(2026, 9, 10);
  const mint = 'M'.repeat(43);

  const seed = (db: WorkstationDatabase) => {
    const raw = (db as any).db;
    for (const [id, age] of [['old', 120], ['mid', 60], ['new', 1]] as const) {
      raw.prepare('INSERT INTO risk_decisions (id, mint, approved, reason_code, attempted_size_sol, current_exposure_sol, daily_loss_sol, execution_mode, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, mint, 1, 'OK', 0.01, 0, 0, 'PAPER', NOW - age * DAY);
      raw.prepare('INSERT INTO decisions (ts, auto_mode, mint, stage, outcome, reason) VALUES (?,?,?,?,?,?)').run(NOW - age * DAY, 'PAPER', mint, 'risk', 'ACCEPTED', id);
    }
    for (const type of ['PAPER_FILL_GATES', 'TRADING_HALTED', 'TRADING_HALT_CLEARED', 'SOME_OLD_EVENT']) {
      raw.prepare('INSERT INTO system_journal (event_type, correlation_id, execution_mode, payload_json, created_at) VALUES (?,?,?,?,?)').run(type, 'c', 'PAPER', '{}', NOW - 400 * DAY);
    }
    raw.prepare('INSERT INTO system_journal (event_type, correlation_id, execution_mode, payload_json, created_at) VALUES (?,?,?,?,?)').run('SOME_NEW_EVENT', 'c', 'PAPER', '{}', NOW - DAY);
  };
  const count = (db: WorkstationDatabase, t: string) => Number(((db as any).db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n);

  it('deletes rows past the window from the three audit tables and keeps the ones something still reads', () => {
    const db = new WorkstationDatabase(':memory:');
    seed(db);
    const r = db.pruneOldRows(90, NOW);
    expect(r).toEqual({ riskDecisions: 1, decisions: 1, journal: 1 });
    expect((db as any).db.prepare('SELECT id FROM risk_decisions ORDER BY id').all().map((x: any) => x.id)).toEqual(['mid', 'new']);
    expect(count(db, 'decisions')).toBe(2);
    const kinds = (db as any).db.prepare('SELECT event_type FROM system_journal ORDER BY id').all().map((x: any) => x.event_type);
    expect(kinds).toEqual(['PAPER_FILL_GATES', 'TRADING_HALTED', 'TRADING_HALT_CLEARED', 'SOME_NEW_EVENT']); // old halt and paper-gate rows survive, the old plain event is gone
  });

  it('a persisted halt older than the window still restores', () => {
    const db = new WorkstationDatabase(':memory:');
    db.logJournal('TRADING_HALTED', 'c', 'LIVE', { reason: 'wallet drain' });
    (db as any).db.prepare('UPDATE system_journal SET created_at = ?').run(NOW - 400 * DAY);
    db.pruneOldRows(30, NOW);
    expect(db.getPersistedHaltReason()).toMatch(/wallet drain/);
  });

  it('never touches positions or transactions, and a nonsense window deletes nothing', () => {
    const db = new WorkstationDatabase(':memory:');
    seed(db);
    db.saveTransaction({ signature: 's1', orderId: 'o1', correlationId: 'c', mint, direction: 'BUY', submissionTransport: 'PAPER', submissionTime: NOW - 900 * DAY, reconciliationState: 'RECONCILED', networkFeeLamports: 0, jitoTipLamports: 0, executionMode: 'PAPER' } as any);
    db.pruneOldRows(1, NOW);
    expect(db.loadTransactions().map((t) => t.signature)).toEqual(['s1']);
    const before = [count(db, 'risk_decisions'), count(db, 'decisions'), count(db, 'system_journal')];
    for (const bad of [0, -5, NaN]) expect(db.pruneOldRows(bad, NOW)).toEqual({ riskDecisions: 0, decisions: 0, journal: 0 });
    expect([count(db, 'risk_decisions'), count(db, 'decisions'), count(db, 'system_journal')]).toEqual(before);
  });

  it('loadTransactionsInStates returns exactly the rows in those states, through the index', () => {
    const db = new WorkstationDatabase(':memory:');
    const base = { orderId: 'o', correlationId: 'c', mint, direction: 'BUY' as const, submissionTransport: 'JITO' as const, submissionTime: 1, networkFeeLamports: 0, jitoTipLamports: 0, executionMode: 'LIVE' as const };
    for (const [sig, st] of [['a', 'PENDING'], ['b', 'RECONCILED'], ['c', 'RECONCILIATION_REQUIRED'], ['d', 'REVERTED']] as const) db.saveTransaction({ ...base, signature: sig, reconciliationState: st } as any);
    expect(db.loadTransactionsInStates(['PENDING', 'RECONCILIATION_REQUIRED']).map((t) => t.signature).sort()).toEqual(['a', 'c']);
    expect(db.loadTransactionsInStates([])).toEqual([]);
    const plan = (db as any).db.prepare("EXPLAIN QUERY PLAN SELECT * FROM transactions WHERE reconciliation_state IN (?, ?)").all('PENDING', 'X').map((r: any) => r.detail).join(' ');
    expect(plan).toMatch(/idx_tx_reconciliation/);
    const orderPlan = (db as any).db.prepare('EXPLAIN QUERY PLAN SELECT * FROM transactions WHERE order_id = ?').all('o').map((r: any) => r.detail).join(' ');
    expect(orderPlan).toMatch(/idx_tx_order/);
  });
});
