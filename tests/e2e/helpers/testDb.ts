import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { NormalizedPosition, ExecutionMode } from '../../../server/core/types';
import { PersistedOrder, PersistedTransaction } from '../../../server/db/database';

export class TestDatabase {
  public db: DatabaseSync;
  public dbPath: string;

  constructor(customPath?: string) {
    this.dbPath = customPath || path.join(os.tmpdir(), `apex_e2e_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.db`);
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY,
        mint TEXT NOT NULL,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL,
        token_decimals INTEGER NOT NULL,
        base_token_program TEXT NOT NULL DEFAULT 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        token_quantity_raw TEXT NOT NULL,
        cost_basis_lamports INTEGER NOT NULL,
        entry_price_sol REAL NOT NULL,
        current_price_sol REAL NOT NULL,
        realized_pnl_lamports INTEGER NOT NULL DEFAULT 0,
        entry_tx_signature TEXT NOT NULL,
        entry_slot INTEGER NOT NULL DEFAULT 0,
        entry_timestamp INTEGER NOT NULL,
        entry_fee_lamports INTEGER NOT NULL DEFAULT 0,
        priority_fee_lamports INTEGER NOT NULL DEFAULT 0,
        jito_tip_lamports INTEGER NOT NULL DEFAULT 0,
        execution_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        exit_reason TEXT,
        exit_tx_signature TEXT,
        last_mark_timestamp INTEGER NOT NULL DEFAULT 0,
        last_mark_source TEXT NOT NULL DEFAULT 'UNKNOWN',
        venue TEXT DEFAULT 'PUMP_BONDING_CURVE',
        pool_address TEXT,
        migration_timestamp INTEGER,
        record_updated_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        client_order_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        amount_lamports INTEGER NOT NULL,
        expected_tokens TEXT,
        slippage_bps INTEGER NOT NULL,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        quote_json TEXT,
        execution_mode TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transactions (
        signature TEXT PRIMARY KEY,
        bundle_id TEXT,
        order_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        mint TEXT NOT NULL,
        direction TEXT NOT NULL,
        submission_transport TEXT NOT NULL,
        submission_time INTEGER NOT NULL,
        landing_slot INTEGER,
        confirmation_time INTEGER,
        reconciliation_state TEXT NOT NULL,
        network_fee_lamports INTEGER NOT NULL DEFAULT 0,
        jito_tip_lamports INTEGER NOT NULL DEFAULT 0,
        execution_mode TEXT NOT NULL,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS risk_decisions (
        id TEXT PRIMARY KEY,
        mint TEXT NOT NULL,
        approved INTEGER NOT NULL,
        reason_code TEXT NOT NULL,
        attempted_size_sol REAL NOT NULL,
        current_exposure_sol REAL NOT NULL,
        daily_loss_sol REAL NOT NULL,
        execution_mode TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS system_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        correlation_id TEXT,
        execution_mode TEXT NOT NULL,
        payload_json TEXT,
        created_at INTEGER NOT NULL
      );
    `);
  }

  public savePosition(p: NormalizedPosition) {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO positions (
        id, mint, symbol, name, token_decimals, base_token_program, token_quantity_raw,
        cost_basis_lamports, entry_price_sol, current_price_sol, realized_pnl_lamports,
        entry_tx_signature, entry_slot, entry_timestamp, entry_fee_lamports,
        priority_fee_lamports, jito_tip_lamports, execution_mode, status,
        exit_reason, exit_tx_signature, last_mark_timestamp, last_mark_source,
        venue, pool_address, migration_timestamp, record_updated_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        token_quantity_raw = excluded.token_quantity_raw,
        cost_basis_lamports = excluded.cost_basis_lamports,
        current_price_sol = excluded.current_price_sol,
        realized_pnl_lamports = excluded.realized_pnl_lamports,
        status = excluded.status,
        exit_reason = excluded.exit_reason,
        exit_tx_signature = excluded.exit_tx_signature,
        last_mark_timestamp = excluded.last_mark_timestamp,
        last_mark_source = excluded.last_mark_source,
        venue = excluded.venue,
        pool_address = excluded.pool_address,
        migration_timestamp = excluded.migration_timestamp,
        record_updated_at = excluded.record_updated_at,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      p.id,
      p.mint,
      p.symbol,
      p.name,
      p.tokenDecimals,
      p.baseTokenProgram || 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      p.tokenQuantityRaw,
      p.costBasisLamports,
      p.entryPriceSol,
      p.currentPriceSol,
      Math.round(p.realizedPnLSol * 1e9),
      p.entryTxSignature,
      p.entrySlot || 0,
      p.entryTimestamp,
      p.entryFeeLamports || 0,
      p.priorityFeeLamports || 0,
      p.jitoTipLamports || 0,
      p.executionMode,
      p.status,
      p.exitReason || null,
      p.exitTxSignature || null,
      p.lastMarkTimestamp || p.lastUpdatedTimestamp || now,
      p.markSource || 'UNKNOWN',
      p.venue || 'PUMP_BONDING_CURVE',
      p.poolAddress || null,
      p.migrationTimestamp || null,
      now,
      now
    );
  }

  public loadPositions(mode?: ExecutionMode, status?: string): NormalizedPosition[] {
    let query = 'SELECT * FROM positions WHERE 1=1';
    const params: any[] = [];
    if (mode) {
      query += ' AND execution_mode = ?';
      params.push(mode);
    }
    if (status) {
      if (status === 'ACTIVE') {
        query += " AND status IN ('OPEN', 'PARTIALLY_CLOSED')";
      } else {
        query += ' AND status = ?';
        params.push(status);
      }
    }
    query += ' ORDER BY entry_timestamp DESC';

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map((r) => {
      const tokenQty = Number(r.token_quantity_raw) / Math.pow(10, r.token_decimals);
      const currentValueSol = Number((tokenQty * r.current_price_sol).toFixed(6));
      const costBasisSol = r.cost_basis_lamports / 1e9;
      const unrealizedPnLSol = Number((currentValueSol - costBasisSol).toFixed(6));
      const unrealizedPnLPct = costBasisSol > 0 ? Number(((unrealizedPnLSol / costBasisSol) * 100).toFixed(2)) : 0;
      const now = Date.now();

      return {
        id: r.id,
        mint: r.mint,
        symbol: r.symbol,
        name: r.name,
        tokenDecimals: r.token_decimals,
        baseTokenProgram: r.base_token_program,
        tokenQuantityRaw: r.token_quantity_raw,
        costBasisLamports: r.cost_basis_lamports,
        entryPriceSol: r.entry_price_sol,
        currentPriceSol: r.current_price_sol,
        currentValueSol,
        unrealizedPnLSol,
        unrealizedPnLPct,
        realizedPnLSol: Number((r.realized_pnl_lamports / 1e9).toFixed(6)),
        entryTxSignature: r.entry_tx_signature,
        entrySlot: r.entry_slot,
        entryTimestamp: r.entry_timestamp,
        entryFeeLamports: r.entry_fee_lamports,
        priorityFeeLamports: r.priority_fee_lamports,
        jitoTipLamports: r.jito_tip_lamports,
        executionMode: r.execution_mode as ExecutionMode,
        status: r.status as any,
        exitReason: r.exit_reason,
        exitTxSignature: r.exit_tx_signature,
        markSource: r.last_mark_source,
        markAgeMs: Math.max(0, now - (r.last_mark_timestamp || r.updated_at)),
        lastMarkTimestamp: r.last_mark_timestamp,
        venue: r.venue,
        poolAddress: r.pool_address,
        migrationTimestamp: r.migration_timestamp,
        lastUpdatedTimestamp: r.updated_at,
      };
    });
  }

  public saveOrder(order: PersistedOrder) {
    const stmt = this.db.prepare(`
      INSERT INTO orders (
        id, client_order_id, correlation_id, mint, symbol, side,
        amount_lamports, expected_tokens, slippage_bps, status,
        rejection_reason, quote_json, execution_mode, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        rejection_reason = excluded.rejection_reason,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      order.id,
      order.clientOrderId,
      order.correlationId,
      order.mint,
      order.symbol,
      order.side,
      order.amountLamports,
      order.expectedTokensRaw,
      order.slippageBps,
      order.status,
      order.rejectionReason || null,
      order.quoteJson || null,
      order.executionMode,
      order.createdAt,
      order.updatedAt
    );
  }

  public saveTransaction(tx: PersistedTransaction) {
    const stmt = this.db.prepare(`
      INSERT INTO transactions (
        signature, bundle_id, order_id, correlation_id, mint, direction,
        submission_transport, submission_time, landing_slot, confirmation_time,
        reconciliation_state, network_fee_lamports, jito_tip_lamports,
        execution_mode, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(signature) DO UPDATE SET
        reconciliation_state = excluded.reconciliation_state,
        landing_slot = excluded.landing_slot,
        confirmation_time = excluded.confirmation_time,
        error = excluded.error
    `);
    stmt.run(
      tx.signature,
      tx.bundleId || null,
      tx.orderId,
      tx.correlationId,
      tx.mint,
      tx.direction,
      tx.submissionTransport,
      tx.submissionTime,
      tx.landingSlot || null,
      tx.confirmationTime || null,
      tx.reconciliationState,
      tx.networkFeeLamports,
      tx.jitoTipLamports,
      tx.executionMode,
      tx.error || null
    );
  }

  public logJournal(eventType: string, correlationId: string, executionMode: ExecutionMode, payload: any) {
    const stmt = this.db.prepare(`
      INSERT INTO system_journal (event_type, correlation_id, execution_mode, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(eventType, correlationId, executionMode, JSON.stringify(payload), Date.now());
  }

  public getEvents(limit = 50): Array<{ id: number; eventType: string; correlationId: string; executionMode: string; payload: any; timestamp: number }> {
    const rows = this.db.prepare(`SELECT * FROM system_journal ORDER BY id DESC LIMIT ?`).all(limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      correlationId: r.correlation_id,
      executionMode: r.execution_mode,
      payload: JSON.parse(r.payload_json || '{}'),
      timestamp: r.created_at,
    }));
  }

  public getDailyRealizedPnLSol(mode: ExecutionMode = 'PAPER'): number {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const row = this.db.prepare(`
      SELECT SUM(realized_pnl_lamports) as total_lamports
      FROM positions
      WHERE execution_mode = ? AND status = 'CLOSED' AND updated_at >= ?
    `).get(mode, startOfDay.getTime()) as { total_lamports: number | null };
    return (row?.total_lamports || 0) / 1e9;
  }

  public close() {
    try {
      this.db.close();
    } catch {}
    try {
      if (fs.existsSync(this.dbPath)) fs.unlinkSync(this.dbPath);
      if (fs.existsSync(`${this.dbPath}-wal`)) fs.unlinkSync(`${this.dbPath}-wal`);
      if (fs.existsSync(`${this.dbPath}-shm`)) fs.unlinkSync(`${this.dbPath}-shm`);
    } catch {}
  }
}
