import { Connection, PublicKey } from '@solana/web3.js';
import { Logger } from '../middleware/enterprise';

export const FUNDER_LOOKUP_CONCURRENCY = 4;
export const FUNDER_LOOKUP_MAX_PER_MINT = 150;
export const FUNDER_SIGNATURE_PAGE = 1000;
/** S4c: an RPC error is retried after these delays (then the wallet stays unknown). Public RPCs rate-limit; one error used to pin the wallet unknown for the candidate's life. */
export const FUNDER_RETRY_DELAYS_MS = [1_500, 4_000, 10_000];
/**
 * P4.1 (R1-60): the most lookups that may wait at once, across all mints: jobs in the queue plus jobs waiting in a retry timer (B14).
 * When it is full, waiting jobs for mints that are no longer watched are dropped first; if it is still full the new request is refused
 * (the wallet stays unknown, so coverage stays below 1).
 */
export const FUNDER_LOOKUP_MAX_QUEUE = 1_000;

export type FunderResult =
  | { funder: string; reason?: undefined }
  | { funder: null; reason: 'NO_TRANSFER' | 'ESTABLISHED_WALLET' }
  | { funder: null; reason: 'ERROR'; error: string };

interface Job { wallet: string; mints: Set<string>; attempt: number }

/** The lamports-in instructions a funder is read from: [funder, recipient] when `ix` (parsed) moves SOL into a new or existing account. */
function fundingOf(ix: any): [string, string] | null {
  if (ix?.program !== 'system' || !ix.parsed?.info) return null;
  const info = ix.parsed.info;
  switch (ix.parsed.type) {
    case 'transfer': return [String(info.source), String(info.destination)];
    // the seeded source account is derived from (and controlled by) sourceBase, so the base is the one funder behind every seed
    case 'transferWithSeed': return [String(info.sourceBase ?? info.source), String(info.destination)];
    case 'createAccount': return [String(info.source), String(info.newAccount)];
    default: return null;
  }
}

/**
 * Q6b: who first funded a wallet. The watch window's "unique buyers" signal only counts buyers whose funder is known (wallets sharing a
 * funder are one cluster), and no lookup existed, so the signal never passed.
 *
 * The funder is the sender of the first system transfer into the wallet, read from its oldest transaction. A wallet with a full page of
 * history is an established wallet: its first funding is out of reach here and it is reported as its own cluster, not guessed.
 * An RPC error is reported as an error (the wallet stays unknown); nothing is invented.
 *
 * P4.1 (R1-54): no signatures at all is index lag (the buyer was seen at processed, the history is read at confirmed), so it is an
 * ERROR that is retried, never NO_TRANSFER. The transfer is looked for in the inner (CPI) instructions too, in execution order.
 */
export class FunderLookup {
  private cache = new Map<string, FunderResult>();
  private queue: Job[] = [];
  /** B14 (review 2026-10-24, finding 14): jobs waiting for a retry, with their timers. They count toward FUNDER_LOOKUP_MAX_QUEUE. */
  private retrying = new Map<Job, ReturnType<typeof setTimeout>>();
  private inFlight = 0;
  private perMint = new Map<string, number>();
  /** Every wallet with a job waiting, running or waiting for a retry. */
  private queued = new Map<string, Job>();
  private listeners: Array<(wallet: string, result: FunderResult) => void> = [];
  /** P4.1 (R1-60): which mints still want answers (the watch window's isWatching). Unset: every mint does. */
  private wanted: ((mint: string) => boolean) | null = null;
  private dropped = 0;
  private refusedFull = 0;

  constructor(private getConnection: () => Connection | null, private opts: { concurrency?: number; maxPerMint?: number; cacheSize?: number; retryDelaysMs?: number[]; maxQueue?: number } = {}) {}

  /** Jobs whose every mint is unwanted are dropped before they reach the RPC (and their retries are not rescheduled). */
  public setWanted(fn: ((mint: string) => boolean) | null): void {
    this.wanted = fn;
  }

  public getStats(): { queued: number; retrying: number; inFlight: number; dropped: number; refusedFull: number } {
    return { queued: this.queue.length, retrying: this.retrying.size, inFlight: this.inFlight, dropped: this.dropped, refusedFull: this.refusedFull };
  }

  /** Jobs that wait: in the queue or in a retry timer. */
  private waitingCount(): number {
    return this.queue.length + this.retrying.size;
  }

  private isWanted(job: Job): boolean {
    if (!this.wanted) return true;
    for (const m of job.mints) if (this.wanted(m)) return true;
    return false;
  }

  private drop(job: Job): void {
    this.dropped++;
    this.queued.delete(job.wallet);
  }

  public onResult(fn: (wallet: string, result: FunderResult) => void): void {
    this.listeners.push(fn);
  }

  /**
   * Ask for a wallet's funder. Cached wallets answer at once; the rest are queued, bounded per mint. B3: a `priority` request (a seller,
   * whose sell may be the creator cluster's) is not held to the per-mint bound and goes to the front of the queue; the queue bound still
   * applies. Returns false when the request was refused (no answer will come), true when it was answered or is waiting.
   */
  public request(wallet: string, mint: string, priority = false): boolean {
    const hit = this.cache.get(wallet);
    if (hit) {
      for (const fn of this.listeners) fn(wallet, hit);
      return true;
    }
    const waiting = this.queued.get(wallet);
    if (waiting) {
      waiting.mints.add(mint); // one lookup answers every mint the wallet bought; a released first mint must not drop it for the others
      const at = priority ? this.queue.indexOf(waiting) : -1;
      if (at > 0) this.queue.unshift(...this.queue.splice(at, 1));
      return true;
    }
    const used = this.perMint.get(mint) ?? 0;
    if (!priority && used >= (this.opts.maxPerMint ?? FUNDER_LOOKUP_MAX_PER_MINT)) return false;
    const maxQueue = this.opts.maxQueue ?? FUNDER_LOOKUP_MAX_QUEUE;
    if (this.waitingCount() >= maxQueue) {
      const keep: Job[] = [];
      for (const j of this.queue) if (this.isWanted(j)) keep.push(j); else this.drop(j);
      this.queue = keep;
      for (const [j, timer] of [...this.retrying]) {
        if (this.isWanted(j)) continue;
        clearTimeout(timer);
        this.retrying.delete(j);
        this.drop(j);
      }
      if (this.waitingCount() >= maxQueue) {
        this.refusedFull++;
        return false;
      }
    }
    this.perMint.set(mint, used + 1);
    if (this.perMint.size > 500) this.perMint.delete(this.perMint.keys().next().value as string);
    const job: Job = { wallet, mints: new Set([mint]), attempt: 0 };
    this.queued.set(wallet, job);
    if (priority) this.queue.unshift(job); else this.queue.push(job);
    this.pump();
    return true;
  }

  private pump(): void {
    const max = this.opts.concurrency ?? FUNDER_LOOKUP_CONCURRENCY;
    while (this.inFlight < max && this.queue.length > 0) {
      const job = this.queue.shift()!;
      if (!this.isWanted(job)) {
        this.drop(job); // P4.1 (R1-60): its mint was released while it waited
        continue;
      }
      this.inFlight++;
      let retrying = false;
      this.lookup(job.wallet)
        .then((result) => {
          const delays = this.opts.retryDelaysMs ?? FUNDER_RETRY_DELAYS_MS;
          if (result.reason === 'ERROR' && job.attempt < delays.length) {
            // S4c: keep the wallet in `queued` while it waits, so a second request for it does not start a parallel lookup.
            retrying = true;
            const timer = setTimeout(() => {
              this.retrying.delete(job);
              job.attempt++;
              this.queue.push(job);
              this.pump();
            }, delays[job.attempt]);
            timer.unref?.();
            this.retrying.set(job, timer);
            return;
          }
          if (result.reason !== 'ERROR') this.remember(job.wallet, result);
          for (const fn of this.listeners) fn(job.wallet, result);
        })
        .catch(() => undefined)
        .finally(() => {
          this.inFlight--;
          if (!retrying) this.queued.delete(job.wallet);
          this.pump();
        });
    }
  }

  private remember(wallet: string, result: FunderResult): void {
    this.cache.set(wallet, result);
    if (this.cache.size > (this.opts.cacheSize ?? 5000)) this.cache.delete(this.cache.keys().next().value as string);
  }

  public async lookup(wallet: string): Promise<FunderResult> {
    const conn = this.getConnection();
    if (!conn) return { funder: null, reason: 'ERROR', error: 'no RPC connection' };
    try {
      const key = new PublicKey(wallet);
      const sigs = await conn.getSignaturesForAddress(key, { limit: FUNDER_SIGNATURE_PAGE }, 'confirmed');
      // P4.1 (R1-54): a buyer always has its own buy in its history, so none at all means the index has not caught up
      if (sigs.length === 0) return { funder: null, reason: 'ERROR', error: 'no signatures yet (history not indexed at confirmed)' };
      if (sigs.length >= FUNDER_SIGNATURE_PAGE) return { funder: null, reason: 'ESTABLISHED_WALLET' };
      const oldest = sigs[sigs.length - 1];
      const tx = await conn.getParsedTransaction(oldest.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
      if (!tx) return { funder: null, reason: 'ERROR', error: 'oldest transaction not returned' };
      // Top-level instruction i, then the instructions it invoked (meta.innerInstructions[index === i]): execution order.
      const inner = new Map<number, any[]>();
      for (const set of (tx.meta?.innerInstructions ?? []) as any[]) inner.set(set.index, set.instructions ?? []);
      const top = tx.transaction.message.instructions as any[];
      for (let i = 0; i < top.length; i++) {
        for (const ix of [top[i], ...(inner.get(i) ?? [])]) {
          const f = fundingOf(ix);
          if (f && f[1] === wallet && f[0] !== wallet) return { funder: f[0] };
        }
      }
      return { funder: null, reason: 'NO_TRANSFER' };
    } catch (e: any) {
      Logger.warn(`funder lookup for ${wallet.slice(0, 6)} failed: ${e?.message || e}`);
      return { funder: null, reason: 'ERROR', error: String(e?.message || e) };
    }
  }
}

/**
 * Connect a lookup to a watch window: new buyers are looked up, answers are fed back. B3: sellers are asked for with priority, and a
 * lookup that still fails after its retries is reported (setFunderUnreadable), so the window stops waiting for it.
 */
export function wireFunderLookup(
  ww: {
    setFunder(w: string, f: string): void; setNoFunder(w: string): void; setFunderUnreadable(w: string): void; isWatching(mint: string): boolean;
    setFunderRequester(fn: ((wallet: string, mint: string, priority?: boolean) => boolean | void) | null): void;
  },
  lookup: FunderLookup
): void {
  lookup.setWanted((mint) => ww.isWatching(mint)); // P4.1 (R1-60): a released mint's waiting lookups are dropped
  lookup.onResult((wallet, r) => {
    if (r.funder) ww.setFunder(wallet, r.funder);
    else if (r.reason !== 'ERROR') ww.setNoFunder(wallet);
    else ww.setFunderUnreadable(wallet);
  });
  ww.setFunderRequester((wallet, mint, priority) => lookup.request(wallet, mint, priority));
}
