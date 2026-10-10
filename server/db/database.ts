import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { NormalizedPosition, ExecutionMode } from '../core/types';
import { Logger } from '../middleware/enterprise';

export interface PersistedOrder {
  id: string;
  clientOrderId: string;
  correlationId: string;
  mint: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  amountLamports: number;
  expectedTokensRaw: string;
  slippageBps: number;
  status: 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'FILLED' | 'REJECTED' | 'FAILED' | 'RECONCILED';
  rejectionReason?: string;
  quoteJson?: string;
  executionMode: ExecutionMode;
  createdAt: number;
  updatedAt: number;
  estimatedFeeLamports?: number;
  jitoTipLamports?: number;
  stage?: string;
  orderType?: string;
}

export interface PersistedTransaction {
  signature: string;
  bundleId?: string;
  orderId: string;
  correlationId: string;
  mint: string;
  direction: 'BUY' | 'SELL';
  submissionTransport: 'SOLANA_RPC' | 'JITO' | 'PAPER';
  submissionTime: number;
  landingSlot?: number;
  confirmationTime?: number;
  reconciliationState: 'PENDING' | 'RECONCILED' | 'RECONCILIATION_REQUIRED' | 'REVERTED' | 'TIMED_OUT' | 'ERROR';
  networkFeeLamports: number;
  jitoTipLamports: number;
  executionMode: ExecutionMode;
  error?: string;
}

export class WorkstationDatabase {
  private db: DatabaseSync;
  private dbPath: string;

  constructor(customDbPath?: string) {
    this.dbPath = customDbPath || process.env.TEST_DB_PATH || process.env.APEX_DB_PATH || path.join(process.cwd(), 'apex_workstation.db');
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA busy_timeout = 10000;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.initSchema();
  }

  private ensureColumn(table: string, column: string, columnDef: string) {
    try {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      const exists = cols.some((c) => c.name === column);
      if (!exists) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnDef}`);
        Logger.info(`Migrated database table ${table}: added column ${column}`);
      }
    } catch (err: any) {
      Logger.warn(`Column check/migration failed for ${table}.${column}: ${err.message}`);
    }
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
        high_water_mark_sol REAL DEFAULT 0.0,
        trailing_stop_sol REAL DEFAULT 0.0,
        exit_stage INTEGER DEFAULT 0,
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

      -- Q3b: one row per change of a position's realized PnL (an exit fill), so "realized today" is the sum of today's fills and not
      -- the whole history of any row a mark tick rewrote today
      CREATE TABLE IF NOT EXISTS realized_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id TEXT NOT NULL,
        execution_mode TEXT NOT NULL,
        delta_lamports INTEGER NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_realized_events_ts ON realized_events (execution_mode, ts);

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

      -- G3: one row per candidate per stage (queue, eligibility, score, size, risk, execute, reconcile, exit)
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        auto_mode TEXT NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT,
        source TEXT,
        stage TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT NOT NULL,
        inputs_json TEXT,
        position_id TEXT,
        sol_delta REAL,
        unverified INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS system_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        correlation_id TEXT,
        execution_mode TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    // Ensure all columns exist for existing databases
    this.ensureColumn('positions', 'base_token_program', "TEXT NOT NULL DEFAULT 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'");
    this.ensureColumn('positions', 'last_mark_timestamp', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('positions', 'last_mark_source', "TEXT NOT NULL DEFAULT 'UNKNOWN'");
    this.ensureColumn('positions', 'venue', "TEXT DEFAULT 'PUMP_BONDING_CURVE'");
    this.ensureColumn('positions', 'pool_address', 'TEXT');
    this.ensureColumn('positions', 'migration_timestamp', 'INTEGER');
    this.ensureColumn('positions', 'high_water_mark_sol', 'REAL DEFAULT 0.0');
    this.ensureColumn('positions', 'trailing_stop_sol', 'REAL DEFAULT 0.0');
    this.ensureColumn('positions', 'exit_stage', 'INTEGER DEFAULT 0');
    this.ensureColumn('positions', 'record_updated_at', 'INTEGER NOT NULL DEFAULT 0');

    // Rows that carry realized PnL from before realized_events existed: one event at their updated_at, which is what the daily figure used.
    try {
      const n = (this.db.prepare('SELECT COUNT(*) AS n FROM realized_events').get() as any).n;
      if (n === 0) {
        this.db.exec(`INSERT INTO realized_events (position_id, execution_mode, delta_lamports, ts)
          SELECT id, execution_mode, realized_pnl_lamports, updated_at FROM positions WHERE realized_pnl_lamports != 0`);
      }
    } catch (err: any) {
      Logger.warn(`realized_events backfill failed: ${err.message}`);
    }

    this.ensureColumn('orders', 'correlation_id', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('orders', 'symbol', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('orders', 'quote_json', 'TEXT');
    this.ensureColumn('orders', 'updated_at', 'INTEGER NOT NULL DEFAULT 0');

    this.ensureColumn('transactions', 'order_id', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('transactions', 'correlation_id', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('transactions', 'submission_transport', "TEXT NOT NULL DEFAULT 'SOLANA_RPC'");
    this.ensureColumn('transactions', 'submission_time', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('transactions', 'landing_slot', 'INTEGER');
    this.ensureColumn('transactions', 'confirmation_time', 'INTEGER');
    this.ensureColumn('transactions', 'reconciliation_state', "TEXT NOT NULL DEFAULT 'PENDING'");
    this.ensureColumn('transactions', 'error', 'TEXT');

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
      CREATE INDEX IF NOT EXISTS idx_positions_mint ON positions(mint);
      CREATE INDEX IF NOT EXISTS idx_tx_reconciliation ON transactions(reconciliation_state);
      CREATE INDEX IF NOT EXISTS idx_journal_created ON system_journal(created_at);
      CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(ts);
      CREATE INDEX IF NOT EXISTS idx_decisions_mint ON decisions(mint);
      CREATE INDEX IF NOT EXISTS idx_tx_order ON transactions(order_id);
      CREATE INDEX IF NOT EXISTS idx_tx_mint ON transactions(mint);
      CREATE INDEX IF NOT EXISTS idx_risk_decisions_created ON risk_decisions(created_at);
    `);
    Logger.info(`SQLite persistence initialized at ${this.dbPath}`);
  }

  public getDbPath(): string {
    return this.dbPath;
  }

  /** The last recorded all-trading halt state: a halt survives a restart until an operator clears it. */
  public getPersistedHaltReason(): string | null {
    try {
      const row = this.db
        .prepare(`SELECT event_type, payload_json FROM system_journal WHERE event_type IN ('TRADING_HALTED','TRADING_HALT_CLEARED') ORDER BY id DESC LIMIT 1`)
        .get() as { event_type: string; payload_json: string } | undefined;
      if (!row || row.event_type !== 'TRADING_HALTED') return null;
      return String(JSON.parse(row.payload_json)?.reason ?? 'halted before restart');
    } catch (err: any) {
      // R8: an unreadable journal is not "no halt". Fail closed: report a halt whose reason says why, so an operator looks before trading.
      Logger.error(`Halt state could not be read: ${err.message}`);
      return `HALT_STATE_UNREADABLE: could not read the persisted halt state (${String(err.message).slice(0, 80)}); clear it explicitly once the database is healthy`;
    }
  }

  /** Returns false when the row could not be written (the error is logged; callers that must know, like halt persistence, check it). */
  public logJournal(eventType: string, correlationId: string, mode: ExecutionMode, payload: Record<string, any>): boolean {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO system_journal (event_type, correlation_id, execution_mode, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const payloadJson = JSON.stringify(payload, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value
      );
      stmt.run(eventType, correlationId, mode, payloadJson, Date.now());
      return true;
    } catch (err: any) {
      Logger.error(`Journal logging failed: ${err.message}`);
      return false;
    }
  }

  // ---- G3: decision journal -------------------------------------------------------------------------------------

  public logDecision(d: {
    ts?: number;
    autoMode: string;
    mint: string;
    symbol?: string;
    source?: string;
    stage: string;
    outcome: string;
    reason: string;
    inputs?: Record<string, any>;
    positionId?: string;
    solDelta?: number;
    unverified?: boolean;
  }): void {
    try {
      this.db
        .prepare(
          `INSERT INTO decisions (ts, auto_mode, mint, symbol, source, stage, outcome, reason, inputs_json, position_id, sol_delta, unverified)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          d.ts ?? Date.now(), d.autoMode, d.mint, d.symbol ?? null, d.source ?? null, d.stage, d.outcome, d.reason,
          d.inputs ? JSON.stringify(d.inputs, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) : null,
          d.positionId ?? null, d.solDelta ?? null, d.unverified ? 1 : 0
        );
    } catch (err: any) {
      Logger.error(`Decision logging failed: ${err.message}`);
    }
  }

  public loadDecisions(opts: { sinceTs?: number; mint?: string; stage?: string; outcome?: string; limit?: number } = {}): Array<{
    id: number; ts: number; autoMode: string; mint: string; symbol: string | null; source: string | null; stage: string;
    outcome: string; reason: string; inputs: any; positionId: string | null; solDelta: number | null; unverified: boolean;
  }> {
    const where: string[] = [];
    const args: any[] = [];
    if (opts.sinceTs !== undefined) { where.push('ts >= ?'); args.push(opts.sinceTs); }
    if (opts.mint) { where.push('mint = ?'); args.push(opts.mint); }
    if (opts.stage) { where.push('stage = ?'); args.push(opts.stage); }
    if (opts.outcome) { where.push('outcome = ?'); args.push(opts.outcome); }
    const sql = `SELECT * FROM decisions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    args.push(opts.limit ?? 200);
    const rows = this.db.prepare(sql).all(...args) as any[];
    return rows.reverse().map((r) => ({
      id: r.id, ts: r.ts, autoMode: r.auto_mode, mint: r.mint, symbol: r.symbol, source: r.source, stage: r.stage,
      outcome: r.outcome, reason: r.reason, inputs: r.inputs_json ? JSON.parse(r.inputs_json) : null,
      positionId: r.position_id, solDelta: r.sol_delta, unverified: !!r.unverified,
    }));
  }

  /** Sum of the SOL each journaled fill moved in or out of the wallet between two timestamps (G3 wallet audit). */
  public sumDecisionSolDelta(fromTs: number, toTs: number): { delta: number; gross: number; count: number } {
    const rows = this.db
      .prepare('SELECT sol_delta FROM decisions WHERE sol_delta IS NOT NULL AND ts > ? AND ts <= ?')
      .all(fromTs, toTs) as Array<{ sol_delta: number }>;
    return {
      delta: rows.reduce((a, r) => a + r.sol_delta, 0),
      gross: rows.reduce((a, r) => a + Math.abs(r.sol_delta), 0),
      count: rows.length,
    };
  }

  /**
   * Closed positions that count as evidence (G3): paper fills with an unverified gate are left out (C5).
   * Oldest first. Both CapitalSizer's win rate / payoff and the kill-switch expectancy read this one list.
   */
  public loadEvidenceClosedTrades(mode?: ExecutionMode): NormalizedPosition[] {
    const closed = this.loadPositions(mode, 'CLOSED');
    const unverified = this.getUnverifiedFillIds();
    // Q2: adopted balances (no known cost) and rows closed because the wallet held nothing (cost 0, realized 0) say nothing about an edge.
    return closed
      .filter((p) => !unverified.has(p.id) && !p.entryTxSignature?.startsWith('RECOVERED:') && !p.exitReason?.startsWith('RECONCILED_ZERO_BALANCE'))
      .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
  }

  /**
   * Order ids of paper fills where at least one safety gate stayed UNKNOWN (C5). Those fills are not evidence
   * of an edge, so closed-trade statistics (CapitalSizer, kill-switch expectancy) leave them out.
   */
  public getUnverifiedFillIds(): Set<string> {
    const ids = new Set<string>();
    try {
      const rows = this.db.prepare("SELECT payload_json FROM system_journal WHERE event_type = 'PAPER_FILL_GATES'").all() as Array<{ payload_json: string }>;
      for (const r of rows) {
        try {
          const p = JSON.parse(r.payload_json);
          if (p?.gates?.eligibility?.unverified?.length > 0 && p.orderId) ids.add(p.orderId);
        } catch { /* skip */ }
      }
    } catch { /* no journal yet */ }
    return ids;
  }

  public saveOrder(order: PersistedOrder) {
    try {
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
    } catch (err: any) {
      Logger.error(`Failed to save order ${order.id}: ${err.message}`);
    }
  }

  /** Returns false when the write failed (it is logged); callers that must not lose the record check it. */
  public saveTransaction(tx: PersistedTransaction): boolean {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO transactions (
          signature, bundle_id, order_id, correlation_id, mint, direction,
          submission_transport, submission_time, landing_slot, confirmation_time,
          reconciliation_state, network_fee_lamports, jito_tip_lamports, execution_mode, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(signature) DO UPDATE SET
          bundle_id = excluded.bundle_id,
          landing_slot = excluded.landing_slot,
          confirmation_time = excluded.confirmation_time,
          reconciliation_state = excluded.reconciliation_state,
          network_fee_lamports = excluded.network_fee_lamports,
          jito_tip_lamports = excluded.jito_tip_lamports,
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
      return true;
    } catch (err: any) {
      Logger.error(`Failed to save transaction ${tx.signature}: ${err.message}`);
      return false;
    }
  }

  /**
   * A submitted transaction is saved PENDING. The BUY path promoted it to RECONCILED after reconciliation but the SELL path
   * never did, so after any restart startup reconciliation re-examined every old sell and flagged the earlier part of a
   * partial-sell sequence as "could not match open position", blocking arming (found by the localnet end-to-end run).
   */
  public markTransactionReconciled(signature: string, landing: { slot?: number; networkFeeLamports?: number } = {}) {
    try {
      this.db
        .prepare(
          `UPDATE transactions SET reconciliation_state = 'RECONCILED', confirmation_time = ?,
             landing_slot = COALESCE(?, landing_slot), network_fee_lamports = COALESCE(?, network_fee_lamports)
           WHERE signature = ?`
        )
        .run(Date.now(), landing.slot || null, landing.networkFeeLamports ?? null, signature);
    } catch (err: any) {
      Logger.error(`Failed to mark transaction ${signature} reconciled: ${err.message}`);
    }
  }

  public getPendingTransactions(): PersistedTransaction[] {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM transactions WHERE reconciliation_state = 'PENDING'
      `);
      const rows = stmt.all() as any[];
      return rows.map((r) => ({
        signature: r.signature,
        bundleId: r.bundle_id || undefined,
        orderId: r.order_id,
        correlationId: r.correlation_id,
        mint: r.mint,
        direction: r.direction as 'BUY' | 'SELL',
        submissionTransport: r.submission_transport as 'SOLANA_RPC' | 'JITO' | 'PAPER',
        submissionTime: r.submission_time,
        landingSlot: r.landing_slot || undefined,
        confirmationTime: r.confirmation_time || undefined,
        reconciliationState: r.reconciliation_state,
        networkFeeLamports: r.network_fee_lamports,
        jitoTipLamports: r.jito_tip_lamports,
        executionMode: r.execution_mode as ExecutionMode,
        error: r.error || undefined,
      }));
    } catch {
      return [];
    }
  }

  /** A LIVE buy of this mint was sent and not yet resolved (PENDING or RECONCILIATION_REQUIRED): it may still become a position. */
  public hasUnresolvedLiveBuy(mint: string): boolean {
    try {
      const row = this.db
        .prepare(`SELECT 1 FROM transactions WHERE mint = ? AND direction = 'BUY' AND execution_mode = 'LIVE' AND reconciliation_state IN ('PENDING', 'RECONCILIATION_REQUIRED') LIMIT 1`)
        .get(mint);
      return !!row;
    } catch {
      return false;
    }
  }

  /**
   * N18: the append-only audit tables (risk_decisions, decisions, system_journal) grew without bound. Rows older than the retention
   * window are deleted. Kept regardless of age because something still reads them: the halt journal (the latest row decides whether
   * trading is halted after a restart) and PAPER_FILL_GATES (marks which old paper fills are unverified, for the closed-trade statistics).
   * Positions, orders and transactions are never pruned. Returns the number of rows deleted per table.
   */
  public pruneOldRows(retentionDays: number, now: number = Date.now()): { riskDecisions: number; decisions: number; journal: number } {
    if (!Number.isFinite(retentionDays) || retentionDays < 1) return { riskDecisions: 0, decisions: 0, journal: 0 };
    const cutoff = now - retentionDays * 86_400_000;
    const run = (sql: string, ...args: number[]) => Number((this.db.prepare(sql).run(...args) as any).changes ?? 0);
    try {
      return {
        riskDecisions: run('DELETE FROM risk_decisions WHERE created_at < ?', cutoff),
        decisions: run('DELETE FROM decisions WHERE ts < ?', cutoff),
        journal: run(`DELETE FROM system_journal WHERE created_at < ? AND event_type NOT IN ('TRADING_HALTED','TRADING_HALT_CLEARED','PAPER_FILL_GATES')`, cutoff),
      };
    } catch (e: any) {
      Logger.error(`Retention prune failed: ${e?.message ?? e}`);
      return { riskDecisions: 0, decisions: 0, journal: 0 };
    }
  }

  public loadTransactions(orderId?: string): PersistedTransaction[] {
    try {
      const stmt = orderId
        ? this.db.prepare('SELECT * FROM transactions WHERE order_id = ?')
        : this.db.prepare('SELECT * FROM transactions');
      return this.mapTransactions((orderId ? stmt.all(orderId) : stmt.all()) as any[]);
    } catch {
      return [];
    }
  }

  /** N18: transactions in the given reconciliation states, read through idx_tx_reconciliation instead of scanning the whole table. */
  public loadTransactionsInStates(states: string[]): PersistedTransaction[] {
    if (states.length === 0) return [];
    try {
      const rows = this.db.prepare(`SELECT * FROM transactions WHERE reconciliation_state IN (${states.map(() => '?').join(',')})`).all(...states) as any[];
      return this.mapTransactions(rows);
    } catch {
      return [];
    }
  }

  private mapTransactions(rows: any[]): PersistedTransaction[] {
    return rows.map((r) => ({
      signature: r.signature,
      bundleId: r.bundle_id || undefined,
      orderId: r.order_id,
      correlationId: r.correlation_id,
      mint: r.mint,
      direction: r.direction as 'BUY' | 'SELL',
      submissionTransport: r.submission_transport as 'SOLANA_RPC' | 'JITO' | 'PAPER',
      submissionTime: r.submission_time,
      landingSlot: r.landing_slot || undefined,
      confirmationTime: r.confirmation_time || undefined,
      reconciliationState: r.reconciliation_state,
      networkFeeLamports: r.network_fee_lamports,
      jitoTipLamports: r.jito_tip_lamports,
      executionMode: r.execution_mode as ExecutionMode,
      error: r.error || undefined,
    }));
  }

  public savePosition(pos: NormalizedPosition) {
    const markTimestamp = pos.lastMarkTimestamp && pos.lastMarkTimestamp > 0
      ? pos.lastMarkTimestamp
      : (pos.entryTimestamp || Date.now());
    const markSource = pos.markSource || 'SOLANA_RPC';
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO positions (
        id, mint, symbol, name, token_decimals, base_token_program, token_quantity_raw,
        cost_basis_lamports, entry_price_sol, current_price_sol, realized_pnl_lamports,
        entry_tx_signature, entry_slot, entry_timestamp, entry_fee_lamports,
        priority_fee_lamports, jito_tip_lamports, execution_mode, status,
        exit_reason, exit_tx_signature, last_mark_timestamp, last_mark_source,
        venue, pool_address, migration_timestamp, high_water_mark_sol, trailing_stop_sol, exit_stage,
        record_updated_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        base_token_program = excluded.base_token_program,
        token_quantity_raw = excluded.token_quantity_raw,
        cost_basis_lamports = excluded.cost_basis_lamports,
        current_price_sol = excluded.current_price_sol,
        realized_pnl_lamports = excluded.realized_pnl_lamports,
        status = excluded.status,
        exit_reason = excluded.exit_reason,
        exit_tx_signature = excluded.exit_tx_signature,
        last_mark_timestamp = CASE WHEN excluded.last_mark_timestamp > 0 THEN excluded.last_mark_timestamp ELSE positions.last_mark_timestamp END,
        last_mark_source = CASE WHEN excluded.last_mark_source != 'UNKNOWN' THEN excluded.last_mark_source ELSE positions.last_mark_source END,
        venue = CASE WHEN excluded.venue IS NOT NULL THEN excluded.venue ELSE positions.venue END,
        pool_address = CASE WHEN excluded.pool_address IS NOT NULL THEN excluded.pool_address ELSE positions.pool_address END,
        migration_timestamp = CASE WHEN excluded.migration_timestamp IS NOT NULL THEN excluded.migration_timestamp ELSE positions.migration_timestamp END,
        high_water_mark_sol = CASE WHEN excluded.high_water_mark_sol > 0 THEN excluded.high_water_mark_sol ELSE positions.high_water_mark_sol END,
        trailing_stop_sol = CASE WHEN excluded.trailing_stop_sol > 0 THEN excluded.trailing_stop_sol ELSE positions.trailing_stop_sol END,
        exit_stage = excluded.exit_stage,
        record_updated_at = excluded.record_updated_at,
        updated_at = excluded.updated_at
    `);

    const realizedLamports = Math.round((pos.realizedPnLSol ?? 0) * 1e9);
    const previous = this.db.prepare('SELECT realized_pnl_lamports AS r FROM positions WHERE id = ?').get(pos.id) as { r: number } | undefined;
    const realizedDelta = realizedLamports - (previous?.r ?? 0);

    stmt.run(
      pos.id,
      pos.mint,
      pos.symbol,
      pos.name,
      pos.tokenDecimals ?? 6,
      pos.baseTokenProgram || 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      pos.tokenQuantityRaw,
      pos.costBasisLamports ?? 0,
      pos.entryPriceSol ?? 0,
      pos.currentPriceSol ?? 0,
      Math.round((pos.realizedPnLSol ?? 0) * 1e9),
      pos.entryTxSignature || `sig-entry-${pos.id}-${now}`,
      pos.entrySlot ?? 0,
      pos.entryTimestamp ?? now,
      pos.entryFeeLamports ?? 0,
      pos.priorityFeeLamports ?? 0,
      pos.jitoTipLamports ?? 0,
      pos.executionMode,
      pos.status,
      pos.exitReason ?? null,
      pos.exitTxSignature ?? null,
      markTimestamp,
      markSource,
      pos.venue || 'PUMP_BONDING_CURVE',
      pos.poolAddress ?? null,
      pos.migrationTimestamp ?? null,
      pos.highWaterMarkSol ?? 0,
      pos.trailingStopSol ?? 0,
      pos.exitStage ?? 0,
      now,
      now
    );
    // Q2: selling an adopted balance returns money with no known cost; it is not a day's profit
    if (realizedDelta !== 0 && !pos.entryTxSignature?.startsWith('RECOVERED:')) {
      this.db.prepare('INSERT INTO realized_events (position_id, execution_mode, delta_lamports, ts) VALUES (?, ?, ?, ?)').run(pos.id, pos.executionMode, realizedDelta, now);
    }
  }

  public loadPositions(mode?: ExecutionMode, status?: 'OPEN' | 'PARTIALLY_CLOSED' | 'CLOSED' | 'ACTIVE'): NormalizedPosition[] {
    let sql = 'SELECT * FROM positions';
    const conditions: string[] = [];
    const params: any[] = [];

    if (mode) {
      conditions.push('execution_mode = ?');
      params.push(mode);
    }
    if (status === 'ACTIVE') {
      conditions.push("(status = 'OPEN' OR status = 'PARTIALLY_CLOSED')");
    } else if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY entry_timestamp DESC';

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];

    return rows.map((r) => {
      const costSol = r.cost_basis_lamports / 1e9;
      const valSol = (Number(r.token_quantity_raw) / Math.pow(10, r.token_decimals)) * r.current_price_sol;
      // Q2: an adopted wallet balance has no known cost (basis 0, entry price = the mark at adoption), so value - 0 is not a gain. Its
      // unrealized PnL is unknown and reported as 0 everywhere (daily loss gate, kill switch, dashboards).
      const adopted = typeof r.entry_tx_signature === 'string' && r.entry_tx_signature.startsWith('RECOVERED:');
      const unrealizedSol = adopted ? 0 : valSol - costSol;
      const unrealizedPct = !adopted && costSol > 0 ? (unrealizedSol / costSol) * 100 : 0;

      const markTs = (r.last_mark_timestamp && r.last_mark_timestamp > 0)
        ? r.last_mark_timestamp
        : (r.updated_at || r.entry_timestamp || Date.now());
      const markAgeMs = Math.max(0, Date.now() - markTs);

      return {
        id: r.id,
        mint: r.mint,
        symbol: r.symbol,
        name: r.name,
        tokenDecimals: r.token_decimals,
        baseTokenProgram: r.base_token_program || 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        tokenQuantityRaw: r.token_quantity_raw,
        costBasisLamports: r.cost_basis_lamports,
        entryPriceSol: r.entry_price_sol,
        currentPriceSol: r.current_price_sol,
        currentValueSol: Number(valSol.toFixed(6)),
        unrealizedPnLSol: Number(unrealizedSol.toFixed(6)),
        unrealizedPnLPct: Number(unrealizedPct.toFixed(2)),
        realizedPnLSol: Number((r.realized_pnl_lamports / 1e9).toFixed(6)),
        entryTxSignature: r.entry_tx_signature,
        entrySlot: r.entry_slot,
        entryTimestamp: r.entry_timestamp,
        entryFeeLamports: r.entry_fee_lamports,
        priorityFeeLamports: r.priority_fee_lamports,
        jitoTipLamports: r.jito_tip_lamports,
        markSource: (r.last_mark_source || 'SOLANA_RPC') as any,
        markAgeMs,
        lastMarkTimestamp: markTs,
        venue: r.venue || 'PUMP_BONDING_CURVE',
        poolAddress: r.pool_address || undefined,
        migrationTimestamp: r.migration_timestamp || undefined,
        executionMode: r.execution_mode as ExecutionMode,
        status: r.status as 'OPEN' | 'PARTIALLY_CLOSED' | 'CLOSED',
        lastUpdatedTimestamp: r.record_updated_at || r.updated_at,
        exitReason: r.exit_reason || undefined,
        exitTxSignature: r.exit_tx_signature || undefined,
        highWaterMarkSol: r.high_water_mark_sol ?? 0,
        trailingStopSol: r.trailing_stop_sol ?? 0,
        exitStage: r.exit_stage ?? 0,
      };
    });
  }

  public saveRiskDecision(record: {
    id: string;
    mint: string;
    approved: boolean;
    reasonCode: string;
    attemptedSizeSol: number;
    currentExposureSol: number;
    dailyLossSol: number;
    executionMode: ExecutionMode;
  }) {
    const stmt = this.db.prepare(`
      INSERT INTO risk_decisions (
        id, mint, approved, reason_code, attempted_size_sol,
        current_exposure_sol, daily_loss_sol, execution_mode, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      record.id,
      record.mint,
      record.approved ? 1 : 0,
      record.reasonCode,
      record.attemptedSizeSol,
      record.currentExposureSol,
      record.dailyLossSol,
      record.executionMode,
      Date.now()
    );
  }

  public getDailyRealizedPnLSol(mode: ExecutionMode = 'LIVE'): number {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();

    const stmt = this.db.prepare(`
      SELECT COALESCE(SUM(delta_lamports), 0) as total_pnl_lamports
      FROM realized_events
      WHERE execution_mode = ? AND ts >= ?
    `);
    const res = stmt.get(mode, startMs) as any;
    return (res?.total_pnl_lamports || 0) / 1e9;
  }

  /**
   * B20: Daily Total PnL (Realized Closed PnL + Open Unrealized PnL - Transaction Fees)
   * Prevents unrealized drawdown blindness by accounting for mark-to-market open position losses.
   */
  public getDailyTotalPnLSol(mode: ExecutionMode = 'LIVE'): number {
    const closedPnL = this.getDailyRealizedPnLSol(mode);
    const openPositions = this.loadPositions().filter(
      (p) => p.executionMode === mode && (p.status === 'OPEN' || p.status === 'PARTIALLY_CLOSED')
    );
    const openUnrealizedPnL = openPositions.reduce(
      (sum, pos) => sum + (pos.unrealizedPnLSol ?? 0),
      0
    );
    // Q3: realized and unrealized PnL already contain every fee, tip and rent of the trades that produced a position (cost basis is the
    // whole wallet delta, proceeds are post-fee). Only the fee of a transaction that landed and failed has no position to sit in.
    const unbookedFeesSol = this.getDailyUnbookedFeesLamports(mode) / 1e9;
    return Number((closedPnL + openUnrealizedPnL - unbookedFeesSol).toFixed(6));
  }

  /**
   * Q3: network fees (not Jito tips: a failed bundle does not pay its tip) of transactions that landed on chain and failed today.
   * Their cost is in no position's basis. Pre-written PENDING rows, rows that never reached the chain and rows that became positions
   * are not counted. A revert path has to record the landing slot for its fee to show up here.
   */
  public getDailyUnbookedFeesLamports(mode: ExecutionMode): number {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    try {
      const res = this.db.prepare(`
        SELECT COALESCE(SUM(network_fee_lamports), 0) as total_fees
        FROM transactions
        WHERE execution_mode = ? AND submission_time >= ? AND reconciliation_state = 'REVERTED' AND landing_slot IS NOT NULL AND landing_slot > 0
      `).get(mode, startOfDay.getTime()) as any;
      return res?.total_fees || 0;
    } catch {
      return 0;
    }
  }

  // Fees of every transaction row today in any state (a display figure; the loss gates use getDailyUnbookedFeesLamports)
  public getDailyFeesPaidLamports(mode: ExecutionMode): number {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();

    try {
      const stmt = this.db.prepare(`
        SELECT COALESCE(SUM(network_fee_lamports + jito_tip_lamports), 0) as total_fees
        FROM transactions
        WHERE execution_mode = ? AND submission_time >= ?
      `);
      const res = stmt.get(mode, startMs) as any;
      return res?.total_fees || 0;
    } catch {
      return 0;
    }
  }

  /** Landed (RECONCILED) trades since UTC midnight, matching getDailyFeesPaidLamports' day boundary. */
  public countReconciledTradesToday(mode: ExecutionMode): number {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    try {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS n FROM transactions WHERE execution_mode = ? AND reconciliation_state = 'RECONCILED' AND submission_time >= ?`)
        .get(mode, startOfDay.getTime()) as any;
      return row?.n || 0;
    } catch {
      return 0;
    }
  }

  /** Confirmation (else submission) time of the newest RECONCILED trade in this mode, or null. */
  public getLastConfirmedTradeTime(mode: ExecutionMode): number | null {
    try {
      const row = this.db
        .prepare(`SELECT MAX(COALESCE(NULLIF(confirmation_time, 0), submission_time)) AS t FROM transactions WHERE execution_mode = ? AND reconciliation_state = 'RECONCILED'`)
        .get(mode) as any;
      return row?.t || null;
    } catch {
      return null;
    }
  }

  public getExecutionMetrics() {
    const totalPositions = (this.db.prepare(`SELECT COUNT(*) as count FROM positions`).get() as any)?.count || 0;
    const openPositions = (this.db.prepare(`SELECT COUNT(*) as count FROM positions WHERE status = 'OPEN' OR status = 'PARTIALLY_CLOSED'`).get() as any)?.count || 0;
    const closedPositions = (this.db.prepare(`SELECT COUNT(*) as count FROM positions WHERE status = 'CLOSED'`).get() as any)?.count || 0;
    const totalPnLLamports = (this.db.prepare(`SELECT COALESCE(SUM(realized_pnl_lamports), 0) as sum FROM positions WHERE status = 'CLOSED' OR status = 'PARTIALLY_CLOSED'`).get() as any)?.sum || 0;
    return {
      totalPositions,
      openPositions,
      closedPositions,
      totalRealizedPnLSol: totalPnLLamports / 1e9,
    };
  }

  public getEvents(limit: number = 50) {
    const stmt = this.db.prepare(`
      SELECT id, event_type as eventType, correlation_id as correlationId, execution_mode as executionMode, payload_json, created_at as timestamp
      FROM system_journal
      ORDER BY id DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as any[];
    return rows.map((r) => {
      let payload = {};
      try {
        payload = JSON.parse(r.payload_json);
      } catch {}
      return {
        id: r.id,
        eventType: r.eventType,
        correlationId: r.correlationId,
        executionMode: r.executionMode,
        payload,
        timestamp: r.timestamp,
      };
    });
  }

  public isWritable(): boolean {
    try {
      this.db.exec('BEGIN IMMEDIATE; ROLLBACK;');
      return true;
    } catch {
      return false;
    }
  }

  public getJournalMode(): string {
    try {
      const row = this.db.prepare('PRAGMA journal_mode;').get() as any;
      return row ? String(row.journal_mode) : 'unknown';
    } catch {
      return 'error';
    }
  }
}

export const workstationDb = new WorkstationDatabase();
