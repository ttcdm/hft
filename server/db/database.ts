import { DatabaseSync } from 'node:sqlite';
import { statfsSync } from 'node:fs';
import path from 'node:path';
import { resolveDbPath } from './dbPath';
import { NormalizedPosition, ExecutionMode } from '../core/types';
import { Logger } from '../middleware/enterprise';
import { recordedCreatorReport, type RecordedCreatorReport } from '../backtest/launchRecorder';

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
  /** P2.1: the last block height at which this transaction's blockhash is valid. Past it, a signature with no status never landed. */
  lastValidBlockHeight?: number;
  /** SELL rows: the exit reason it was sent for (TAKE_PROFIT_1, STOP_LOSS, ...), so a restart that applies a landed sell can advance the take-profit stage. */
  exitReason?: string;
}

/** 5B: the launch-recording kinds that belong to a launch (FUNDER rows have mint '' and are kept for good). */
const LAUNCH_ROW_KINDS = ['CREATE', 'TRADE', 'END', 'CREATOR'] as const;
interface LaunchRecordingCounts { byKind: Record<string, number>; dataVersion: number; oldestTs: number | null; newestTs: number | null; newestCreateTs: number | null }
export interface LaunchRecordingStatus {
  launches: number;
  events: number;
  launchRows: number;
  funderRows: number;
  endedLaunches: number;
  oldestTs: number | null;
  newestTs: number | null;
  newestCreateTs: number | null;
}

export class WorkstationDatabase {
  private db: DatabaseSync;
  private dbPath: string;
  /** 5B: the launch recording's counts, read once when the database opens and kept by recordLaunchEvent and pruneLaunchRecording, so the
   *  status that System checks polls every 15 s runs no query. Null only if that first read failed (it is retried on the next status read). */
  private recCounts: LaunchRecordingCounts | null = null;

  constructor(customDbPath?: string) {
    this.dbPath = resolveDbPath(customDbPath);
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA busy_timeout = 10000;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    // P2.2 (R1-96): FULL, not NORMAL. Under WAL, NORMAL can lose the last commits on an OS crash or power loss, and the last commit before a
    // broadcast is the PENDING row that lets startup recovery find a transaction that was sent.
    this.db.exec('PRAGMA synchronous = FULL;');
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

      -- S178: what the watch window saw, so the auto trader's rules can be replayed over real launches. One row per create event, trade,
      -- or funder fact for a mint the watch window was scoring. kind: CREATE | TRADE | FUNDER (mint is '' for a funder fact) | END (5B: why
      -- the launch's recording stopped, payload.reason TRADE_CAP | WINDOW | CURVE_COMPLETE; a launch with no END row is unresolved).
      CREATE TABLE IF NOT EXISTS launch_recording (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        mint TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS system_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        correlation_id TEXT,
        execution_mode TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      -- DBW: one row that isWritable() rewrites, so the writable check is a real committed write
      CREATE TABLE IF NOT EXISTS db_health (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        probe_seq INTEGER NOT NULL,
        probed_at INTEGER NOT NULL
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
    this.ensureColumn('positions', 'exit_claim', 'TEXT'); // P1.1: which process is selling this position (claimExit)
    this.ensureColumn('positions', 'exit_claim_at', 'INTEGER');

    // Rows that carry realized PnL from before realized_events existed: one event at their updated_at, which is what the daily figure used.
    try {
      const n = (this.db.prepare('SELECT COUNT(*) AS n FROM realized_events').get() as any).n;
      if (n === 0) {
        this.db.exec(`INSERT INTO realized_events (position_id, execution_mode, delta_lamports, ts)
          SELECT id, execution_mode, realized_pnl_lamports, updated_at FROM positions WHERE realized_pnl_lamports != 0 AND entry_tx_signature NOT LIKE 'RECOVERED:%'`);
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
    this.ensureColumn('transactions', 'last_valid_block_height', 'INTEGER');
    this.ensureColumn('transactions', 'exit_reason', 'TEXT');

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
      CREATE INDEX IF NOT EXISTS idx_launch_rec_mint ON launch_recording(mint, ts);
      CREATE INDEX IF NOT EXISTS idx_launch_rec_ts ON launch_recording(ts);
      -- 5B (R1-93, R1-107): the journal is read by event_type (getUnverifiedFillIds every 5 s, the halt and kill-switch rows), and the
      -- recorder's per-kind counts and oldest/newest reads go through (kind, ts) instead of scanning the table.
      CREATE INDEX IF NOT EXISTS idx_journal_event_type ON system_journal(event_type);
      CREATE INDEX IF NOT EXISTS idx_launch_rec_kind_ts ON launch_recording(kind, ts);
    `);
    this.recCounts = this.countLaunchRecording();
    Logger.info(`SQLite persistence initialized at ${this.dbPath}`);
  }

  /** S222: a small operator setting that survives a restart (the confluence threshold and the auto mode). null when unset or unreadable. */
  public getSetting<T = unknown>(key: string): T | null {
    try {
      const row = this.db.prepare(`SELECT value_json FROM app_settings WHERE key = ?`).get(key) as { value_json: string } | undefined;
      return row ? (JSON.parse(row.value_json) as T) : null;
    } catch (err: any) {
      Logger.warn(`Setting ${key} could not be read: ${err.message}`);
      return null;
    }
  }

  /** Returns false when the value could not be saved (logged); the in-memory setting still applies until restart. */
  public setSetting(key: string, value: unknown): boolean {
    try {
      this.db.prepare(`INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
        .run(key, JSON.stringify(value), Date.now());
      return true;
    } catch (err: any) {
      Logger.warn(`Setting ${key} could not be saved: ${err.message}`);
      return false;
    }
  }

  public getDbPath(): string {
    return this.dbPath;
  }

  /**
   * P2.2 (R1-89): the cluster this database's ledger belongs to, by genesis hash. The first verified RPC stamps it (`cluster_genesis_hash`
   * in app_settings); after that an RPC on another genesis is refused, so a devnet ledger is never reconciled against another cluster.
   * An in-memory database (tests, scratch tools) is never stamped. `ok: false` carries the stored hash.
   */
  public checkClusterStamp(genesisHash: string): { ok: true; stamped: boolean } | { ok: false; stored: string; unreadable?: string } {
    if (!genesisHash || this.dbPath === ':memory:') return { ok: true, stamped: false };
    // S255 follow-up: not getSetting, which answers null for a failed read too. A failed read is not "unstamped": taking it for one wrote
    // this RPC's genesis over the real stamp, and a ledger of another cluster then passed. Unreadable refuses, like a mismatch.
    const read = (): { stored: string | null } | { unreadable: string } => {
      try {
        const row = this.db.prepare(`SELECT value_json FROM app_settings WHERE key = 'cluster_genesis_hash'`).get() as { value_json: string } | undefined;
        if (!row) return { stored: null };
        const v = JSON.parse(row.value_json);
        return typeof v === 'string' && v ? { stored: v } : { unreadable: 'the stamp row holds no genesis hash' };
      } catch (err: any) {
        return { unreadable: String(err?.message ?? err) };
      }
    };
    let r = read();
    if ('stored' in r && r.stored === null) {
      // insert only, so a stamp another process wrote meanwhile is compared below and never overwritten
      try {
        const res = this.db.prepare(`INSERT INTO app_settings (key, value_json, updated_at) VALUES ('cluster_genesis_hash', ?, ?) ON CONFLICT(key) DO NOTHING`)
          .run(JSON.stringify(genesisHash), Date.now());
        if (Number(res.changes) > 0) return { ok: true, stamped: true };
      } catch (err: any) {
        Logger.warn(`Cluster stamp could not be saved: ${err.message}`);
        return { ok: true, stamped: false };
      }
      r = read();
    }
    if ('unreadable' in r) return { ok: false, stored: '', unreadable: r.unreadable };
    if (r.stored === null || r.stored === genesisHash) return { ok: true, stamped: false };
    return { ok: false, stored: r.stored };
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

  /** The reason of the last kill-switch trip when the switch was still on at the last journal row (it is off after a restart), else null. */
  public getKillSwitchTripBeforeRestart(): string | null {
    try {
      const row = this.db
        .prepare(`SELECT event_type, payload_json FROM system_journal WHERE event_type IN ('KILL_SWITCH_TRIPPED','KILL_SWITCH_RESET') ORDER BY id DESC LIMIT 1`)
        .get() as { event_type: string; payload_json: string } | undefined;
      if (!row || row.event_type !== 'KILL_SWITCH_TRIPPED') return null;
      return String(JSON.parse(row.payload_json)?.reason ?? 'no reason given');
    } catch (err: any) {
      Logger.error(`Kill-switch state could not be read: ${err.message}`);
      return null;
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
      .sort((a, b) => (a.lastUpdatedTimestamp ?? 0) - (b.lastUpdatedTimestamp ?? 0)); // Q30: this sorted on a field that does not exist, so "the last 20" were the oldest 20
  }

  /**
   * Ids of paper positions whose result is not evidence of an edge, so closed-trade statistics (CapitalSizer, kill-switch expectancy) leave
   * them out: (C5) a fill where at least one safety gate stayed UNKNOWN; (S9) a fill priced by the flat MODEL because the curve could not be
   * read (the controller already flagged these as unverified on the decision row, but the evidence query did not); and a position whose
   * EXIT was model-priced (PAPER_SELL_FILLED, keyed by the position id).
   */
  public getUnverifiedFillIds(): Set<string> {
    const ids = new Set<string>();
    try {
      const rows = this.db.prepare("SELECT payload_json FROM system_journal WHERE event_type = 'PAPER_FILL_GATES'").all() as Array<{ payload_json: string }>;
      for (const r of rows) {
        try {
          const p = JSON.parse(r.payload_json);
          if ((p?.gates?.eligibility?.unverified?.length > 0 || p?.gates?.pricing === 'MODEL') && p.orderId) ids.add(p.orderId);
        } catch { /* skip */ }
      }
      const sells = this.db.prepare("SELECT payload_json FROM system_journal WHERE event_type = 'PAPER_SELL_FILLED'").all() as Array<{ payload_json: string }>;
      for (const r of sells) {
        try {
          const p = JSON.parse(r.payload_json);
          if (p?.pricing === 'MODEL' && p.positionId) ids.add(p.positionId);
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
          reconciliation_state, network_fee_lamports, jito_tip_lamports, execution_mode, error, last_valid_block_height, exit_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(signature) DO UPDATE SET
          submission_transport = excluded.submission_transport,
          bundle_id = excluded.bundle_id,
          landing_slot = excluded.landing_slot,
          confirmation_time = excluded.confirmation_time,
          reconciliation_state = excluded.reconciliation_state,
          network_fee_lamports = excluded.network_fee_lamports,
          jito_tip_lamports = excluded.jito_tip_lamports,
          error = excluded.error,
          last_valid_block_height = COALESCE(excluded.last_valid_block_height, transactions.last_valid_block_height),
          exit_reason = COALESCE(excluded.exit_reason, transactions.exit_reason)
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
        tx.error || null,
        tx.lastValidBlockHeight ?? null,
        tx.exitReason ?? null
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

  /**
   * S258: a landed sell booked on its position (savePosition: realized PnL, quantity, status, exitTxSignature) and its ledger row marked
   * RECONCILED, in one transaction. Written separately, a crash between the two left the row PENDING with the PnL already on the position;
   * startup reconciliation matches a PENDING sell to its position by exitTxSignature only, so once a later sell had replaced that it booked
   * the same sell again. Throws (nothing written) when either write fails.
   */
  public saveSellBooking(pos: NormalizedPosition, signature: string, landing: { slot?: number; networkFeeLamports?: number } = {}): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.savePosition(pos);
      this.db
        .prepare(
          `UPDATE transactions SET reconciliation_state = 'RECONCILED', confirmation_time = ?,
             landing_slot = COALESCE(?, landing_slot), network_fee_lamports = COALESCE(?, network_fee_lamports)
           WHERE signature = ?`
        )
        .run(Date.now(), landing.slot || null, landing.networkFeeLamports ?? null, signature);
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  public getPendingTransactions(): PersistedTransaction[] {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM transactions WHERE reconciliation_state = 'PENDING'
      `);
      // the shared mapper: the hand-written copy here dropped exit_reason and last_valid_block_height, which startup recovery reads
      return this.mapTransactions(stmt.all() as any[]);
    } catch {
      return [];
    }
  }

  /** A LIVE buy of this mint was sent and not yet resolved (PENDING or RECONCILIATION_REQUIRED): it may still become a position. */
  /**
   * P1.1 (N-52): claim the right to sell a position, across processes. `owner` is `<pid>:<nonce>`. Succeeds when the row has no claim,
   * the claim is older than `staleBeforeTs`, or the claiming process is dead. Returns false while another live claim stands (another
   * process, or another coordinator in this process, is selling it). The caller clears its claim in a `finally` (releaseExitClaim).
   */
  public claimExit(positionId: string, owner: string, now: number, staleBeforeTs: number, isOwnerAlive: (owner: string) => boolean): boolean {
    const tryClaim = (extra: string, ...args: Array<string | number>) => Number((this.db
      .prepare(`UPDATE positions SET exit_claim = ?, exit_claim_at = ? WHERE id = ? AND (${extra})`)
      .run(owner, now, positionId, ...args) as any).changes) > 0;
    if (tryClaim('exit_claim IS NULL OR exit_claim_at IS NULL OR exit_claim_at < ?', staleBeforeTs)) return true;
    const row = this.db.prepare('SELECT exit_claim AS c FROM positions WHERE id = ?').get(positionId) as { c: string | null } | undefined;
    if (!row?.c || isOwnerAlive(row.c)) return false;
    return tryClaim('exit_claim = ?', row.c); // the holder died mid-sell: take it, unless someone else just did
  }

  public releaseExitClaim(positionId: string, owner: string): void {
    try {
      this.db.prepare('UPDATE positions SET exit_claim = NULL, exit_claim_at = NULL WHERE id = ? AND exit_claim = ?').run(positionId, owner);
    } catch (err: any) {
      Logger.error(`Failed to release the exit claim on ${positionId}: ${err.message}`);
    }
  }

  /**
   * P1.1 (N-57): write the PENDING row of a LIVE BUY only if no other unresolved LIVE BUY of that mint exists, in one BEGIN IMMEDIATE
   * transaction so two processes cannot both pass the check. False: another buy of the mint is unresolved (nothing written).
   */
  public savePendingBuyIfNoneUnresolved(tx: PersistedTransaction): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const other = this.db
        .prepare(`SELECT 1 FROM transactions WHERE mint = ? AND direction = 'BUY' AND execution_mode = 'LIVE' AND reconciliation_state IN ('PENDING', 'RECONCILIATION_REQUIRED') AND order_id != ? LIMIT 1`)
        .get(tx.mint, tx.orderId);
      if (other) {
        this.db.exec('ROLLBACK');
        return false;
      }
      if (!this.saveTransaction(tx)) throw new Error(`could not record the PENDING buy ${tx.signature}`);
      this.db.exec('COMMIT');
      return true;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  public hasUnresolvedLiveBuy(mint: string): boolean {
    try {
      const row = this.db
        .prepare(`SELECT 1 FROM transactions WHERE mint = ? AND direction = 'BUY' AND execution_mode = 'LIVE' AND reconciliation_state IN ('PENDING', 'RECONCILIATION_REQUIRED') LIMIT 1`)
        .get(mint);
      return !!row;
    } catch (err: any) {
      // P3.1 (R1-15): fail closed. A query that cannot run cannot say there is no unresolved buy, so the caller refuses the buy.
      Logger.error(`hasUnresolvedLiveBuy could not read the transactions table (${err?.message || err}); answering "unresolved" so the buy is refused`);
      return true;
    }
  }

  /**
   * 3B (P3.2): every LIVE BUY that was sent and is not resolved (PENDING or RECONCILIATION_REQUIRED), with its order's amount and quote
   * when the order row exists. Such a buy may still become a position, so callers count it as an open slot and as reserved SOL.
   * null when the query cannot run: the caller cannot know nothing is unresolved, so it must refuse (fail closed).
   */
  public loadUnresolvedLiveBuys(): Array<{ signature: string; mint: string; orderId: string; submissionTime: number; jitoTipLamports: number; amountLamports: number | null; quoteJson: string | null }> | null {
    try {
      const rows = this.db
        .prepare(
          `SELECT t.signature, t.mint, t.order_id, t.submission_time, t.jito_tip_lamports, o.amount_lamports, o.quote_json
             FROM transactions t LEFT JOIN orders o ON o.id = t.order_id
            WHERE t.direction = 'BUY' AND t.execution_mode = 'LIVE' AND t.reconciliation_state IN ('PENDING', 'RECONCILIATION_REQUIRED')`
        )
        .all() as any[];
      return rows.map((r) => ({
        signature: r.signature,
        mint: r.mint,
        orderId: r.order_id,
        submissionTime: r.submission_time,
        jitoTipLamports: r.jito_tip_lamports ?? 0,
        amountLamports: r.amount_lamports ?? null,
        quoteJson: r.quote_json ?? null,
      }));
    } catch (err: any) {
      Logger.error(`loadUnresolvedLiveBuys could not read the transactions table (${err?.message || err}); callers refuse buys`);
      return null;
    }
  }

  /**
   * 3F (R1-9): the closed positions of `mint` in `mode`, for the re-entry block. `lastExit` is the most recently closed one (its
   * `updated_at` is when the close was written); `loss` is the most recent one closed with a negative realized PnL, if any.
   * null when the query cannot run: the caller cannot know the mint was never exited, so it must refuse (fail closed).
   */
  public loadMintExits(mint: string, mode: ExecutionMode): { lastExit: { positionId: string; exitedAt: number } | null; loss: { positionId: string; realizedLamports: number } | null } | null {
    try {
      const rows = this.db
        .prepare(`SELECT id, realized_pnl_lamports, updated_at FROM positions WHERE mint = ? AND execution_mode = ? AND status = 'CLOSED' ORDER BY updated_at DESC`)
        .all(mint, mode) as any[];
      const loss = rows.find((r) => r.realized_pnl_lamports < 0);
      return {
        lastExit: rows.length > 0 ? { positionId: rows[0].id, exitedAt: Number(rows[0].updated_at) } : null,
        loss: loss ? { positionId: loss.id, realizedLamports: loss.realized_pnl_lamports } : null,
      };
    } catch (err: any) {
      Logger.error(`loadMintExits could not read the positions table (${err?.message || err}); the buy is refused`);
      return null;
    }
  }

  /**
   * N18: the append-only audit tables (risk_decisions, decisions, system_journal) grew without bound. Rows older than the retention
   * window are deleted. Kept regardless of age because something still reads them: the halt journal (the latest row decides whether
   * trading is halted after a restart) and PAPER_FILL_GATES / PAPER_SELL_FILLED (mark which old paper fills and exits are unverified or model-priced, for the closed-trade statistics).
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
        journal: run(`DELETE FROM system_journal WHERE created_at < ? AND event_type NOT IN ('TRADING_HALTED','TRADING_HALT_CLEARED','KILL_SWITCH_TRIPPED','KILL_SWITCH_RESET','PAPER_FILL_GATES','PAPER_SELL_FILLED')`, cutoff),
      };
    } catch (e: any) {
      Logger.error(`Retention prune failed: ${e?.message ?? e}`);
      return { riskDecisions: 0, decisions: 0, journal: 0 };
    }
  }

  /** S178: append one recorded event. Never throws: a recording failure must not touch trading. */
  /** R2-2: MARKER rows (mint '') are the recorder's gap and restart markers (server/backtest/launchRecorder.ts, `RecordingMarkerReason`). */
  public recordLaunchEvent(ts: number, mint: string, kind: 'CREATE' | 'TRADE' | 'FUNDER' | 'END' | 'CREATOR' | 'MARKER', payload: Record<string, unknown>): boolean {
    try {
      this.db.prepare('INSERT INTO launch_recording (ts, mint, kind, payload_json) VALUES (?, ?, ?, ?)').run(ts, mint, kind, JSON.stringify(payload));
      const c = this.recCounts;
      if (c) {
        c.byKind[kind] = (c.byKind[kind] ?? 0) + 1;
        if (kind !== 'FUNDER' && kind !== 'MARKER') { c.oldestTs = c.oldestTs === null ? ts : Math.min(c.oldestTs, ts); c.newestTs = c.newestTs === null ? ts : Math.max(c.newestTs, ts); }
        if (kind === 'CREATE') c.newestCreateTs = c.newestCreateTs === null ? ts : Math.max(c.newestCreateTs, ts);
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Recorded events of the `limit` most recently created launches, oldest event first, plus every funder fact. */
  /**
   * 5B: a launch with an END row carries `endTs` (when its recording stopped) and `endReason` (TRADE_CAP, WINDOW or CURVE_COMPLETE); the
   * replay's coverage then follows the recording that was really made, not the window the server runs with now. A launch without one is
   * unresolved and has neither.
   * R2-2: `markers` are the recorder's MARKER rows (restarts and feed gaps), oldest first; the replay bounds a launch's coverage at the
   * first one inside its recording. R6-11: a read error throws (the replay route answers 500); it used to read as an empty recording.
   */
  public loadLaunchRecording(limit = 500): { launches: Array<{ mint: string; events: Array<{ ts: number; kind: 'CREATE' | 'TRADE'; payload: any }>; endTs?: number; endReason?: string; creatorReports?: RecordedCreatorReport[] }>; funders: Array<{ ts: number; wallet: string; funder: string | null }>; markers: Array<{ ts: number; reason: string; detail?: string }> } {
    try {
      const mints = (this.db.prepare(`SELECT mint FROM launch_recording WHERE kind = 'CREATE' ORDER BY ts DESC LIMIT ?`).all(limit) as any[]).map((r) => r.mint as string).reverse();
      const q = this.db.prepare(`SELECT ts, kind, payload_json FROM launch_recording WHERE mint = ? AND kind IN ('CREATE','TRADE','END','CREATOR') ORDER BY ts ASC, id ASC`);
      const launches = mints.map((mint) => {
        const rows = q.all(mint) as any[];
        const end = rows.find((r) => r.kind === 'END');
        const creatorReports = rows.filter((r) => r.kind === 'CREATOR').map((r) => recordedCreatorReport(r.ts, JSON.parse(r.payload_json)));
        return {
          mint,
          events: rows.filter((r) => r.kind === 'CREATE' || r.kind === 'TRADE').map((r) => ({ ts: r.ts as number, kind: r.kind as 'CREATE' | 'TRADE', payload: JSON.parse(r.payload_json) })),
          ...(end ? { endTs: end.ts as number, endReason: String(JSON.parse(end.payload_json).reason) } : {}),
          ...(creatorReports.length ? { creatorReports } : {}),
        };
      });
      const funders = (this.db.prepare(`SELECT ts, payload_json FROM launch_recording WHERE kind = 'FUNDER' ORDER BY ts ASC, id ASC`).all() as any[])
        .map((r) => ({ ts: r.ts as number, ...JSON.parse(r.payload_json) }));
      const markers = (this.db.prepare(`SELECT ts, payload_json FROM launch_recording WHERE kind = 'MARKER' ORDER BY ts ASC, id ASC`).all() as any[])
        .map((r) => { const p = JSON.parse(r.payload_json); return { ts: r.ts as number, reason: String(p?.reason), ...(p?.detail !== undefined ? { detail: String(p.detail) } : {}) }; });
      return { launches, funders, markers };
    } catch (err: any) {
      throw new Error(`the launch recording could not be read: ${err?.message || err}`, { cause: err });
    }
  }

  /**
   * The recording's size, from the in-memory counts (5B: no table is read unless another connection wrote to the file). `events` is every row; `launchRows` the CREATE, TRADE and END rows the
   * row limit applies to; `funderRows` the FUNDER rows, which are never pruned; `endedLaunches` the END rows (a launch without one is
   * unresolved). `oldestTs` / `newestTs` span the launch rows only, because funder rows are kept for good. `newestCreateTs` keys the replay cache.
   */
  public getLaunchRecordingStatus(): LaunchRecordingStatus {
    try {
      const c = this.launchCounts();
      const k = (kind: string) => c.byKind[kind] ?? 0;
      const events = Object.values(c.byKind).reduce((a, b) => a + b, 0);
      return { launches: k('CREATE'), events, launchRows: events - k('FUNDER') - k('MARKER'), funderRows: k('FUNDER'), endedLaunches: k('END'), oldestTs: c.oldestTs, newestTs: c.newestTs, newestCreateTs: c.newestCreateTs };
    } catch {
      return { launches: 0, events: 0, launchRows: 0, funderRows: 0, endedLaunches: 0, oldestTs: null, newestTs: null, newestCreateTs: null };
    }
  }

  /** 5B: the kept counts, read again from the table first if another connection (a script, a test seeding the file) committed since. SQLite's
   *  data_version does not change for this connection's own writes, which keep the counts themselves. */
  private launchCounts(): LaunchRecordingCounts {
    if (this.recCounts && this.dataVersion() !== this.recCounts.dataVersion) this.recCounts = null;
    this.recCounts ??= this.countLaunchRecording();
    return this.recCounts;
  }

  /** 5B: the counts read from the table: per kind through idx_launch_rec_kind_ts, and the launch rows' oldest, newest and newest CREATE ts as index probes. */
  private countLaunchRecording(): LaunchRecordingCounts {
    const dataVersion = this.dataVersion();
    const byKind: Record<string, number> = {};
    for (const r of this.db.prepare('SELECT kind, COUNT(*) AS n FROM launch_recording GROUP BY kind').all() as Array<{ kind: string; n: number }>) byKind[r.kind] = Number(r.n);
    return { byKind, dataVersion, ...this.launchRecordingSpan() };
  }

  /** SQLite's PRAGMA data_version: changes when another connection commits to this database file (no table is read). */
  private dataVersion(): number {
    return Number((this.db.prepare('PRAGMA data_version').get() as any).data_version);
  }

  private launchRecordingSpan(): Pick<LaunchRecordingCounts, 'oldestTs' | 'newestTs' | 'newestCreateTs'> {
    const lo = this.db.prepare('SELECT MIN(ts) AS v FROM launch_recording WHERE kind = ?');
    const hi = this.db.prepare('SELECT MAX(ts) AS v FROM launch_recording WHERE kind = ?');
    const pick = (st: typeof lo, f: (a: number, b: number) => number) => {
      const vs = LAUNCH_ROW_KINDS.map((k) => (st.get(k) as any)?.v).filter((v): v is number => typeof v === 'number');
      return vs.length ? vs.reduce((a, b) => f(a, b)) : null;
    };
    const createHi = (hi.get('CREATE') as any)?.v;
    return { oldestTs: pick(lo, Math.min), newestTs: pick(hi, Math.max), newestCreateTs: typeof createHi === 'number' ? createHi : null };
  }

  /** S190: rows written in the last `windowMs` (uses the ts index). The recorder's measured rate, for System checks. */
  public getLaunchRecordingRows(sinceTs: number): number {
    try {
      return Number((this.db.prepare('SELECT COUNT(*) AS n FROM launch_recording WHERE ts >= ?').get(sinceTs) as any).n);
    } catch {
      return 0;
    }
  }

  /**
   * Keep the recording bounded: launch rows older than `retentionDays`, then the oldest launch rows beyond `maxRows`. Returns rows deleted.
   * 5B (R1-92): FUNDER rows are never pruned and do not count against `maxRows`. A wallet's funder fact is written only the first time the
   * window learns it, so a later launch that wallet buys relies on the old row; dropping it with the old launch made the survivors' buyers
   * look independent (optimistic). Their number is reported apart in getLaunchRecordingStatus so their growth is visible.
   */
  public pruneLaunchRecording(retentionDays: number, maxRows: number, now: number = Date.now()): number {
    try {
      const c = this.launchCounts();
      // 5B: RETURNING kind keeps the in-memory counts exact without a COUNT(*) over the table
      const drop = (rows: Array<{ kind: string }>) => { for (const r of rows) c.byKind[r.kind] = (c.byKind[r.kind] ?? 0) - 1; return rows.length; };
      let n = drop(this.db.prepare(`DELETE FROM launch_recording WHERE ts < ? AND kind <> 'FUNDER' RETURNING kind`).all(now - retentionDays * 86_400_000) as any[]);
      const total = Object.entries(c.byKind).reduce((a, [k, v]) => (k === 'FUNDER' ? a : a + v), 0);
      if (total > maxRows) n += drop(this.db.prepare(`DELETE FROM launch_recording WHERE id IN (SELECT id FROM launch_recording WHERE kind <> 'FUNDER' ORDER BY id ASC LIMIT ?) RETURNING kind`).all(total - maxRows) as any[]);
      if (n > 0) Object.assign(c, this.launchRecordingSpan());
      return n;
    } catch {
      // the counts may be off after a failed delete: read them again from the table on the next status read
      this.recCounts = null;
      return 0;
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
      lastValidBlockHeight: r.last_valid_block_height ?? undefined,
      exitReason: r.exit_reason ?? undefined,
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

  /**
   * S11 / Q14: persist ONLY the mark fields. A mark refresh works from a copy loaded before several awaits; saving the whole row from
   * that copy can undo a close or a sell that committed meanwhile (status, quantity, realized). This touches no other column and never
   * a CLOSED row, so a stale refresh cannot resurrect a position or write a bogus realized event.
   */
  public saveMark(pos: NormalizedPosition): boolean {
    const now = Date.now();
    const markTimestamp = pos.lastMarkTimestamp && pos.lastMarkTimestamp > 0 ? pos.lastMarkTimestamp : 0;
    const r = this.db.prepare(`
      UPDATE positions SET
        current_price_sol = ?,
        last_mark_timestamp = CASE WHEN ? > 0 THEN ? ELSE last_mark_timestamp END,
        last_mark_source = CASE WHEN ? != 'UNKNOWN' THEN ? ELSE last_mark_source END,
        venue = COALESCE(?, venue),
        pool_address = COALESCE(?, pool_address),
        migration_timestamp = COALESCE(?, migration_timestamp),
        high_water_mark_sol = MAX(COALESCE(high_water_mark_sol, 0), ?),
        record_updated_at = ?,
        updated_at = ?
      WHERE id = ? AND status != 'CLOSED'
    `).run(
      pos.currentPriceSol ?? 0,
      markTimestamp, markTimestamp,
      pos.markSource || 'UNKNOWN', pos.markSource || 'UNKNOWN',
      pos.venue ?? null,
      pos.poolAddress ?? null,
      pos.migrationTimestamp ?? null,
      pos.highWaterMarkSol ?? 0,
      now, now,
      pos.id
    );
    return Number((r as any).changes) > 0;
  }

  /** Q56 / S11: the exit engine's own fields (high-water mark, trailing stop, stage) for an open row, nothing else. */
  public saveExitState(pos: NormalizedPosition): boolean {
    const now = Date.now();
    const r = this.db.prepare(`
      UPDATE positions SET
        high_water_mark_sol = CASE WHEN ? > 0 THEN ? ELSE high_water_mark_sol END,
        trailing_stop_sol = CASE WHEN ? > 0 THEN ? ELSE trailing_stop_sol END,
        exit_stage = ?,
        record_updated_at = ?, updated_at = ?
      WHERE id = ? AND status != 'CLOSED'
    `).run(pos.highWaterMarkSol ?? 0, pos.highWaterMarkSol ?? 0, pos.trailingStopSol ?? 0, pos.trailingStopSol ?? 0, pos.exitStage ?? 0, now, now, pos.id);
    return Number((r as any).changes) > 0;
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

  private static utcMidnightMs(): number {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    return startOfDay.getTime();
  }

  /**
   * Realized PnL since `sinceMs`. The default is UTC midnight (the figure the UI shows as "today"); the risk gate passes a rolling
   * 24 h start instead (N-61, 3C), so a new calendar day does not hand out a fresh loss budget.
   */
  public getDailyRealizedPnLSol(mode: ExecutionMode = 'LIVE', sinceMs: number = WorkstationDatabase.utcMidnightMs()): number {
    const startMs = sinceMs;

    const stmt = this.db.prepare(`
      SELECT COALESCE(SUM(delta_lamports), 0) as total_pnl_lamports
      FROM realized_events
      WHERE execution_mode = ? AND ts >= ?
    `);
    const res = stmt.get(mode, startMs) as any;
    return (res?.total_pnl_lamports || 0) / 1e9;
  }

  /** Unrealized PnL of the mode's OPEN and PARTIALLY_CLOSED positions at their last marks (3C: the risk gate's worst case uses it). */
  public getOpenUnrealizedPnLSol(mode: ExecutionMode): number {
    return this.loadPositions()
      .filter((p) => p.executionMode === mode && (p.status === 'OPEN' || p.status === 'PARTIALLY_CLOSED'))
      .reduce((sum, pos) => sum + (pos.unrealizedPnLSol ?? 0), 0);
  }

  /** 3C: time of the oldest losing realized event at or after `sinceMs`, or null. Tells the operator when the 24 h window can move. */
  public getOldestRealizedLossTs(mode: ExecutionMode, sinceMs: number): number | null {
    const res = this.db.prepare(`
      SELECT MIN(ts) as oldest FROM realized_events WHERE execution_mode = ? AND ts >= ? AND delta_lamports < 0
    `).get(mode, sinceMs) as any;
    return typeof res?.oldest === 'number' ? res.oldest : null;
  }

  /**
   * B20: Daily Total PnL (Realized Closed PnL + Open Unrealized PnL - Transaction Fees)
   * Prevents unrealized drawdown blindness by accounting for mark-to-market open position losses.
   */
  public getDailyTotalPnLSol(mode: ExecutionMode = 'LIVE', sinceMs: number = WorkstationDatabase.utcMidnightMs()): number {
    const closedPnL = this.getDailyRealizedPnLSol(mode, sinceMs);
    const openUnrealizedPnL = this.getOpenUnrealizedPnLSol(mode);
    // Q3: realized and unrealized PnL already contain every fee, tip and rent of the trades that produced a position (cost basis is the
    // whole wallet delta, proceeds are post-fee). Only the fee of a transaction that landed and failed has no position to sit in.
    const unbookedFeesSol = this.getDailyUnbookedFeesLamports(mode, sinceMs) / 1e9;
    return Number((closedPnL + openUnrealizedPnL - unbookedFeesSol).toFixed(6));
  }

  /**
   * Q3: network fees (not Jito tips: a failed bundle does not pay its tip) of transactions that landed on chain and failed today.
   * Their cost is in no position's basis. Pre-written PENDING rows, rows that never reached the chain and rows that became positions
   * are not counted. A revert path has to record the landing slot for its fee to show up here.
   */
  public getDailyUnbookedFeesLamports(mode: ExecutionMode, sinceMs: number = WorkstationDatabase.utcMidnightMs()): number {
    try {
      const res = this.db.prepare(`
        SELECT COALESCE(SUM(network_fee_lamports), 0) as total_fees
        FROM transactions
        WHERE execution_mode = ? AND submission_time >= ? AND reconciliation_state = 'REVERTED' AND landing_slot IS NOT NULL AND landing_slot > 0
      `).get(mode, sinceMs) as any;
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

  /** DBW: below this much free space on the database's filesystem the database counts as not writable (Mike chose 32 MiB over 16 MiB). */
  public static readonly MIN_FREE_BYTES = 32 * 1024 * 1024;
  /** Below this much free space the System checks database row is WARN and a DISK_SPACE_LOW alert is raised; buys go on until MIN_FREE_BYTES. */
  public static readonly LOW_FREE_WARN_BYTES = 128 * 1024 * 1024;
  /** DBW: a passed probe is reused this long, so a per-buy check does not commit (and fsync) on every call. A failure is never reused. */
  public static readonly WRITABLE_CACHE_MS = 1000;
  private lastWritableOkAt: number | null = null; // on performance.now()

  /**
   * DBW: true only when a real write commits and the filesystem has MIN_FREE_BYTES free. `BEGIN IMMEDIATE; ROLLBACK;` writes nothing, so it
   * passed on a full disk and on read-only storage. The upsert alone is not enough either: on a full disk SQLite can still commit small
   * writes into WAL frames and free pages it already holds, while the next larger write fails. Any error, including a failed free-space
   * read, means not writable.
   */
  public isWritable(): boolean {
    const now = performance.now();
    if (this.lastWritableOkAt !== null && now - this.lastWritableOkAt < WorkstationDatabase.WRITABLE_CACHE_MS) return true;
    this.lastWritableOkAt = null;
    try {
      this.db
        .prepare(
          `INSERT INTO db_health (id, probe_seq, probed_at) VALUES (1, 1, ?)
           ON CONFLICT(id) DO UPDATE SET probe_seq = probe_seq + 1, probed_at = excluded.probed_at`
        )
        .run(Date.now());
      if (this.dbPath !== ':memory:' && this.freeBytes() < WorkstationDatabase.MIN_FREE_BYTES) return false;
      this.lastWritableOkAt = performance.now();
      return true;
    } catch {
      return false;
    }
  }

  /** Free bytes on the database's filesystem for the low-disk warning; null for a `:memory:` database or when the read fails. */
  public getFreeBytes(): number | null {
    if (this.dbPath === ':memory:') return null;
    try {
      return this.freeBytes();
    } catch {
      return null;
    }
  }

  /** Free bytes on the filesystem holding the database file, as an unprivileged writer sees them. */
  private freeBytes(): number {
    const s = statfsSync(path.dirname(path.resolve(this.dbPath)));
    return Number(s.bavail) * Number(s.bsize);
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
