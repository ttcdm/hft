import { EventEmitter } from 'events';
import type { PumpCreateEvent, PumpTradeEvent } from '../solana/pumpFeedListener';
import type { WatchWindow } from '../signals/watchWindow';
import type { WorkstationDatabase } from '../db/database';
import { CREATOR_LOOKUP_FAILED_FLAG, type CreatorRiskReport } from '../signals/creatorRiskScorer';
import { Logger } from '../middleware/enterprise';
import { recorderConfig, setRecorderRuntime, RECORD_DEFAULT_MIN_FREE_MB, RECORD_DEFAULT_MINT_MINUTES, RECORD_TRADES_PER_30_MIN, RECORD_DEFAULT_RETENTION_DAYS, RECORD_DEFAULT_MAX_ROWS, type RecorderConfig, type RecorderRuntime } from './recorderConfig';

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
/** 5B: how often the recorder looks for launches whose window has passed with no further trade, to write their END/WINDOW row. */
const END_SWEEP_EVERY_MS = 60_000;

/**
 * 5B (R1-106): why a launch's recording stopped. One END row per launch, written when the recorder stops keeping its trades:
 *  - TRADE_CAP: the launch reached maxTradesPerMint; later trades were dropped (`ts` is the first dropped trade).
 *  - WINDOW: the recording window (mintMs after the create) passed (`ts` is the window's end).
 *  - CURVE_COMPLETE: a trade emptied the bonding curve (realTokenReserves 0), so the coin graduates and its later trades are not on the
 *    curve the feed decodes (`ts` is that trade).
 * A launch with no END row is unresolved: it was still being recorded, or the process stopped (or the tracking limit dropped it) first.
 */
export type RecordingEndReason = 'TRADE_CAP' | 'WINDOW' | 'CURVE_COMPLETE';

type Db = Pick<WorkstationDatabase, 'recordLaunchEvent' | 'pruneLaunchRecording'> & Partial<Pick<WorkstationDatabase, 'getFreeBytes'>>;
/** R4-5: how often the recorder reads the free space (a statfs) while it records. */
export const RECORD_SPACE_CHECK_MS = 5_000;

/** BigInt-safe JSON form of a decoded pump event (all u64 fields as decimal strings). */
export function eventToJson(e: object): Record<string, unknown> {
  return JSON.parse(JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

/**
 * 5B-2 (A119): a creator report as the recorder saved it (a CREATOR row): from `ts` on, live scored the launch's creator `confluenceScore`
 * points (0 to 5); `failed` is a failed history lookup (0 points, and the creator counts as missing data). Oldest first.
 */
export interface RecordedCreatorReport { ts: number; confluenceScore: number; failed: boolean; riskScore: number | null; isBurner: boolean | null; riskFlags: string[] }
export function recordedCreatorReport(ts: number, p: any): RecordedCreatorReport {
  const score = Number(p?.confluenceScore);
  return {
    ts,
    // an unreadable score is worth nothing, as no report is
    confluenceScore: Number.isFinite(score) ? Math.max(0, Math.min(5, score)) : 0,
    failed: p?.failed === true,
    riskScore: Number.isFinite(Number(p?.riskScore)) ? Number(p.riskScore) : null,
    isBurner: typeof p?.isBurner === 'boolean' ? p.isBurner : null,
    riskFlags: Array.isArray(p?.riskFlags) ? p.riskFlags.map(String) : [],
  };
}

/** 5B-2: where the recorder hears of creator reports: the live CreatorRiskScorer. */
export interface CreatorReportSource {
  onReport(fn: (creator: string, report: CreatorRiskReport, failed: boolean) => void): () => void;
  getCachedReport(creator: string): CreatorRiskReport | undefined;
}

/** A CREATOR row's payload: what the confluence engine reads from the report (its 0-5 score, the failed-lookup flag) plus the inputs, for study. */
function creatorPayload(creator: string, report: CreatorRiskReport): Record<string, unknown> {
  return {
    creator, confluenceScore: report.confluenceScore, riskScore: report.riskScore, isBurner: report.isBurner,
    failed: report.riskFlags.includes(CREATOR_LOOKUP_FAILED_FLAG), riskFlags: report.riskFlags, signatureCount: report.signatureCount,
    walletAgeSeconds: report.walletAgeSeconds, evaluatedAt: report.evaluatedAt,
  };
}

/**
 * Saves what the watch window sees, so the same rules can be replayed later over real launches. It records only launches the window
 * is scoring (so the volume is the window's: at most WATCH_MAX_CANDIDATES live at a time), their trades for RECORD_MINT_MS, and the
 * funder facts the window learns. A write failure is swallowed: recording must never affect trading.
 */
export class LaunchRecorder {
  private pending = new Map<string, { ts: number; event: PumpCreateEvent; solUsd: number | null; creatorReports: Array<{ ts: number; payload: Record<string, unknown> }> }>();
  private recorded = new Map<string, { createdAt: number; trades: number; ended: boolean; creator?: string }>();
  private attachedTo: Array<{ off: () => void }> = [];
  private lastPrune = 0;
  private lastEndSweep = 0;
  private creatorReports: CreatorReportSource | null = null;
  private runtime: RecorderRuntime;
  private lastSpaceCheck = -Infinity;
  private pausedForSpace = false;

  constructor(private db: Db, private window: Pick<WatchWindow, 'isWatching'> & EventEmitter, private solUsd: () => number | null = () => null, private now: () => number = Date.now, private config: RecorderConfig = recorderConfig()) {
    this.runtime = { config: this.config, prunedRows: 0, prunings: 0, firstPruneAt: null, lastPruneAt: null, lastPruneRows: 0, pausedForSpaceSince: null, skippedForSpace: 0 };
    setRecorderRuntime(this.runtime);
  }

  public getRuntime(): RecorderRuntime { return this.runtime; }

  /** `creatorReports` (5B-2): the creator scorer, so each launch's live creator report is saved with it (CREATOR rows). */
  public attach(feed: EventEmitter, creatorReports?: CreatorReportSource): void {
    this.creatorReports = creatorReports ?? null;
    const onCreate = (e: PumpCreateEvent) => this.onCreate(e);
    const onTrade = (t: PumpTradeEvent) => this.onTrade(t);
    const onFunder = (f: { wallet: string; funder: string | null }) => this.onFunder(f);
    feed.on('create_event', onCreate);
    feed.on('trade_event', onTrade);
    this.window.on('funder', onFunder);
    const offReports = creatorReports?.onReport((c, r) => this.onCreatorReport(c, r));
    this.attachedTo.push({ off: () => { feed.off('create_event', onCreate); feed.off('trade_event', onTrade); this.window.off('funder', onFunder); offReports?.(); } });
  }

  public detach(): void {
    for (const a of this.attachedTo) a.off();
    this.attachedTo = [];
  }

  public onCreate(e: PumpCreateEvent): void {
    if (this.pausedForSpace) return; // R4-5: stopped for disk space; its trades would not be kept
    const ts = this.now();
    this.pending.set(e.mint, { ts, event: e, solUsd: this.solUsd(), creatorReports: [] });
    // 5B-2: a report the scorer already holds for this creator (a cache hit stores nothing, so no report event follows) applies from the create
    const cached = e.creator ? this.creatorReports?.getCachedReport(e.creator) : undefined;
    if (cached) this.pending.get(e.mint)!.creatorReports.push({ ts, payload: creatorPayload(e.creator, cached) });
    if (this.pending.size > PENDING_CREATES_MAX) this.pending.delete(this.pending.keys().next().value as string);
  }

  /**
   * R4-5: false while free space on the database's filesystem is below the recorder's floor (read at most every RECORD_SPACE_CHECK_MS).
   * Stopping logs once; every launch being recorded is dropped from tracking with no END row (it reads as unresolved, since its trades
   * have a gap), and pending creates are forgotten. Recording resumes, with new launches only, once space is back, and that logs once too.
   * A database with no free-space reading (`:memory:`, or a read that failed) records.
   */
  private spaceOk(now: number): boolean {
    if (now - this.lastSpaceCheck < RECORD_SPACE_CHECK_MS) return this.skipIfPaused();
    this.lastSpaceCheck = now;
    const floor = this.config.minFreeBytes ?? RECORD_DEFAULT_MIN_FREE_MB * 1024 * 1024;
    const free = this.db.getFreeBytes?.() ?? null;
    const low = free !== null && free < floor;
    const mib = (b: number) => Math.round(b / (1024 * 1024));
    if (low && !this.pausedForSpace) {
      this.pausedForSpace = true;
      this.runtime.pausedForSpaceSince = now;
      for (const r of this.recorded.values()) r.ended = true; // no END row: their recording has a gap, so they stay unresolved
      this.pending.clear();
      Logger.warn(`[RECORDER] stopped recording: ${mib(free!)} MiB free on the database's disk, below the recorder's ${mib(floor)} MiB floor (APEX_RECORD_MIN_FREE_MB). The space is left for trading writes; recording resumes when space is back.`);
    } else if (!low && this.pausedForSpace) {
      this.pausedForSpace = false;
      this.runtime.pausedForSpaceSince = null;
      this.pending.clear(); // a launch created during the stop may have traded unrecorded: only launches created from now on are kept
      Logger.info(`[RECORDER] recording resumed: ${free === null ? 'free space unreadable' : `${mib(free)} MiB free`} (floor ${mib(floor)} MiB); ${this.runtime.skippedForSpace ?? 0} event(s) were not recorded meanwhile`);
    }
    return this.skipIfPaused();
  }

  private skipIfPaused(): boolean {
    if (!this.pausedForSpace) return true;
    this.runtime.skippedForSpace = (this.runtime.skippedForSpace ?? 0) + 1;
    return false;
  }

  public onTrade(t: PumpTradeEvent): void {
    const at = this.now();
    if (!this.spaceOk(at)) return; // R4-5
    this.sweepEnded(at);
    let rec = this.recorded.get(t.mint);
    if (!rec) {
      const p = this.pending.get(t.mint);
      // Only a launch the window actually watches is kept; the first trade after its create is the moment that is known.
      if (!p || !this.window.isWatching(t.mint)) return;
      if (!this.db.recordLaunchEvent(p.ts, t.mint, 'CREATE', { ...eventToJson(p.event), solUsd: p.solUsd })) return;
      this.pending.delete(t.mint);
      // reports that arrived before the first trade, at the time they arrived
      for (const r of p.creatorReports) this.db.recordLaunchEvent(r.ts, t.mint, 'CREATOR', r.payload);
      rec = { createdAt: p.ts, trades: 0, ended: false, creator: p.event.creator };
      this.recorded.set(t.mint, rec);
      this.trimTracked(at);
    }
    if (rec.ended) return;
    if (at - rec.createdAt > this.config.mintMs) { this.end(t.mint, rec, 'WINDOW', rec.createdAt + this.config.mintMs); return; }
    if (rec.trades >= this.config.maxTradesPerMint) { this.end(t.mint, rec, 'TRADE_CAP', at, { droppedSignature: t.signature }); return; }
    rec.trades++;
    this.db.recordLaunchEvent(at, t.mint, 'TRADE', eventToJson(t));
    // the pump program marks the curve complete when a buy takes its last real token; nothing after it trades on this curve
    if (t.realTokenReserves === 0n) this.end(t.mint, rec, 'CURVE_COMPLETE', at, { signature: t.signature });
    this.maybePrune(at);
  }

  /** 5B: write the launch's one END row. A failed write leaves it unresolved (no END), never mislabelled. */
  private end(mint: string, rec: { createdAt: number; trades: number; ended: boolean }, reason: RecordingEndReason, ts: number, extra: Record<string, unknown> = {}): void {
    rec.ended = true;
    this.db.recordLaunchEvent(ts, mint, 'END', { reason, trades: rec.trades, windowMs: this.config.mintMs, maxTradesPerMint: this.config.maxTradesPerMint, ...extra });
  }

  /** 5B: a launch that went quiet gets its END/WINDOW row once its window has passed, at most once a minute (on the recorder's clock). */
  private sweepEnded(now: number): void {
    if (now - this.lastEndSweep < END_SWEEP_EVERY_MS) return;
    this.lastEndSweep = now;
    for (const [mint, r] of this.recorded) if (!r.ended && now - r.createdAt > this.config.mintMs) this.end(mint, r, 'WINDOW', r.createdAt + this.config.mintMs);
  }

  /**
   * 5B-2 (A119): the live creator report, as the confluence engine would read it from this moment on, for every launch of that creator the
   * recorder has pending or is recording. `failed` marks a failed history lookup (0 points, missing data). A launch whose creator never got a
   * report has no CREATOR row, and the replay scores it 0 as live does without a report.
   */
  public onCreatorReport(creator: string, report: CreatorRiskReport): void {
    const at = this.now();
    if (!this.spaceOk(at)) return; // R4-5
    const payload = creatorPayload(creator, report);
    for (const p of this.pending.values()) if (p.event.creator === creator) p.creatorReports.push({ ts: at, payload });
    for (const [mint, r] of this.recorded) if (r.creator === creator && !r.ended) this.db.recordLaunchEvent(at, mint, 'CREATOR', payload);
  }

  public onFunder(f: { wallet: string; funder: string | null }): void {
    const at = this.now();
    if (!this.spaceOk(at)) return; // R4-5
    this.db.recordLaunchEvent(at, '', 'FUNDER', { wallet: f.wallet, funder: f.funder });
  }

  private trimTracked(now: number): void {
    if (this.recorded.size <= RECORDED_TRACK_SOFT) return;
    for (const [mint, r] of this.recorded) {
      if (now - r.createdAt <= this.config.mintMs) continue;
      if (!r.ended) this.end(mint, r, 'WINDOW', r.createdAt + this.config.mintMs);
      this.recorded.delete(mint);
    }
    // a launch still inside its window dropped here gets no END row, so it reads as unresolved (5B), which is what it is
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
