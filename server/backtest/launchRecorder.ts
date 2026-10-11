import { EventEmitter } from 'events';
import type { PumpCreateEvent, PumpTradeEvent } from '../solana/pumpFeedListener';
import type { WatchWindow } from '../signals/watchWindow';
import type { WorkstationDatabase } from '../db/database';

/** How long, and how much, of one launch is recorded. The auto trader's exits run for up to 30 minutes, so that is how long trades are kept. */
export const RECORD_MINT_MS = 30 * 60_000;
export const RECORD_MAX_TRADES_PER_MINT = 2_000;
export const RECORD_RETENTION_DAYS = 14;
export const RECORD_MAX_ROWS = 300_000;
const PENDING_CREATES_MAX = 500;

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

  constructor(private db: Db, private window: Pick<WatchWindow, 'isWatching'> & EventEmitter, private solUsd: () => number | null = () => null, private now: () => number = Date.now) {}

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
      if (this.recorded.size > 2_000) this.recorded.delete(this.recorded.keys().next().value as string);
    }
    if (at - rec.createdAt > RECORD_MINT_MS || rec.trades >= RECORD_MAX_TRADES_PER_MINT) return;
    rec.trades++;
    this.db.recordLaunchEvent(at, t.mint, 'TRADE', eventToJson(t));
    this.maybePrune(at);
  }

  public onFunder(f: { wallet: string; funder: string | null }): void {
    this.db.recordLaunchEvent(this.now(), '', 'FUNDER', { wallet: f.wallet, funder: f.funder });
  }

  private maybePrune(now: number): void {
    if (now - this.lastPrune < 3_600_000) return;
    this.lastPrune = now;
    this.db.pruneLaunchRecording(RECORD_RETENTION_DAYS, RECORD_MAX_ROWS, now);
  }
}
