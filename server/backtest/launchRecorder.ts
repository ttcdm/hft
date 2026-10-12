import { EventEmitter } from 'events';
import type { PumpCreateEvent, PumpTradeEvent } from '../solana/pumpFeedListener';
import type { WatchWindow } from '../signals/watchWindow';
import type { WorkstationDatabase } from '../db/database';
import { Logger } from '../middleware/enterprise';
import { recorderConfig, setRecorderRuntime, RECORD_DEFAULT_MINT_MINUTES, RECORD_TRADES_PER_30_MIN, RECORD_DEFAULT_RETENTION_DAYS, RECORD_DEFAULT_MAX_ROWS, type RecorderConfig, type RecorderRuntime } from './recorderConfig';

/**
 * How long, and how much, of one launch is recorded: see recorderConfig.ts (env-configurable; 30 minutes on a normal server, 180 read-only).
 * The old constants stay as the normal defaults.
 */
export const RECORD_MINT_MS = RECORD_DEFAULT_MINT_MINUTES * 60_000;
export const RECORD_MAX_TRADES_PER_MINT = RECORD_TRADES_PER_30_MIN;
export const RECORD_RETENTION_DAYS = RECORD_DEFAULT_RETENTION_DAYS;
export const RECORD_MAX_ROWS = RECORD_DEFAULT_MAX_ROWS;
const PENDING_CREATES_MAX = 500;
/** Launches whose trade count is tracked. Entries older than the window are dropped first; only then the oldest, so a long window never loses a live launch. */
const RECORDED_TRACK_SOFT = 5_000;
const RECORDED_TRACK_HARD = 50_000;

type Db = Pick<WorkstationDatabase, 'recordLaunchEvent' | 'pruneLaunchRecording'>;

/** BigInt-safe JSON form of a decoded pump event (all u64 fields as decimal strings). */
export function eventToJson(e: object): Record<string, unknown> {
  return JSON.parse(JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

/**
 * Saves what the watch window sees, so the same rules can be replayed later over real launches. It records only launches the window
 * is scoring (so the volume is the window's: at most WATCH_MAX_CANDIDATES live at a time), their trades for RECORD_MINT_MS, and the
 * funder facts the window learns. A write failure is swallowed: recording must never affect trading.
 */
export class LaunchRecorder {
  private pending = new Map<string, { ts: number; event: PumpCreateEvent; solUsd: number | null }>();
  private recorded = new Map<string, { createdAt: number; trades: number }>();
  private attachedTo: Array<{ off: () => void }> = [];
  private lastPrune = 0;
  private runtime: RecorderRuntime;

  constructor(private db: Db, private window: Pick<WatchWindow, 'isWatching'> & EventEmitter, private solUsd: () => number | null = () => null, private now: () => number = Date.now, private config: RecorderConfig = recorderConfig()) {
    this.runtime = { config: this.config, prunedRows: 0, prunings: 0, firstPruneAt: null, lastPruneAt: null, lastPruneRows: 0 };
    setRecorderRuntime(this.runtime);
  }

  public getRuntime(): RecorderRuntime { return this.runtime; }

  public attach(feed: EventEmitter): void {
    const onCreate = (e: PumpCreateEvent) => this.onCreate(e);
    const onTrade = (t: PumpTradeEvent) => this.onTrade(t);
    const onFunder = (f: { wallet: string; funder: string | null }) => this.onFunder(f);
    feed.on('create_event', onCreate);
    feed.on('trade_event', onTrade);
    this.window.on('funder', onFunder);
    this.attachedTo.push({ off: () => { feed.off('create_event', onCreate); feed.off('trade_event', onTrade); this.window.off('funder', onFunder); } });
  }

  public detach(): void {
    for (const a of this.attachedTo) a.off();
    this.attachedTo = [];
  }

  public onCreate(e: PumpCreateEvent): void {
    this.pending.set(e.mint, { ts: this.now(), event: e, solUsd: this.solUsd() });
    if (this.pending.size > PENDING_CREATES_MAX) this.pending.delete(this.pending.keys().next().value as string);
  }

  public onTrade(t: PumpTradeEvent): void {
    const at = this.now();
    let rec = this.recorded.get(t.mint);
    if (!rec) {
      const p = this.pending.get(t.mint);
      // Only a launch the window actually watches is kept; the first trade after its create is the moment that is known.
      if (!p || !this.window.isWatching(t.mint)) return;
      if (!this.db.recordLaunchEvent(p.ts, t.mint, 'CREATE', { ...eventToJson(p.event), solUsd: p.solUsd })) return;
      this.pending.delete(t.mint);
      rec = { createdAt: p.ts, trades: 0 };
      this.recorded.set(t.mint, rec);
      this.trimTracked(at);
    }
    if (at - rec.createdAt > this.config.mintMs || rec.trades >= this.config.maxTradesPerMint) return;
    rec.trades++;
    this.db.recordLaunchEvent(at, t.mint, 'TRADE', eventToJson(t));
    this.maybePrune(at);
  }

  public onFunder(f: { wallet: string; funder: string | null }): void {
    this.db.recordLaunchEvent(this.now(), '', 'FUNDER', { wallet: f.wallet, funder: f.funder });
  }

  private trimTracked(now: number): void {
    if (this.recorded.size <= RECORDED_TRACK_SOFT) return;
    for (const [mint, r] of this.recorded) if (now - r.createdAt > this.config.mintMs) this.recorded.delete(mint);
    while (this.recorded.size > RECORDED_TRACK_HARD) this.recorded.delete(this.recorded.keys().next().value as string);
  }

  private maybePrune(now: number): void {
    if (now - this.lastPrune < 3_600_000) return;
    this.lastPrune = now;
    const deleted = this.db.pruneLaunchRecording(this.config.retentionDays, this.config.maxRows, now);
    if (deleted > 0) {
      const rt = this.runtime;
      const first = rt.firstPruneAt === null;
      rt.prunedRows += deleted; rt.prunings++; rt.lastPruneRows = deleted; rt.lastPruneAt = now; rt.firstPruneAt ??= now;
      // Pruning removes the OLDEST recorded launches, so say so loudly the first time and quietly after
      const msg = `[RECORDER] pruned ${deleted} recorded row(s) (limits: ${this.config.maxRows} rows, ${this.config.retentionDays} days). The oldest launches are being dropped${first ? '; raise APEX_RECORD_MAX_ROWS / APEX_RECORD_RETENTION_DAYS if you want to keep them (about 330 bytes a row on disk)' : ''}.`;
      if (first) Logger.warn(msg); else Logger.info(msg);
    }
  }
}
