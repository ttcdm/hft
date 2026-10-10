import { Connection, PublicKey } from '@solana/web3.js';
import { Logger } from '../middleware/enterprise';

export const FUNDER_LOOKUP_CONCURRENCY = 4;
export const FUNDER_LOOKUP_MAX_PER_MINT = 150;
export const FUNDER_SIGNATURE_PAGE = 1000;

export type FunderResult =
  | { funder: string; reason?: undefined }
  | { funder: null; reason: 'NO_TRANSFER' | 'ESTABLISHED_WALLET' }
  | { funder: null; reason: 'ERROR'; error: string };

/**
 * Q6b: who first funded a wallet. The watch window's "unique buyers" signal only counts buyers whose funder is known (wallets sharing a
 * funder are one cluster), and no lookup existed, so the signal never passed.
 *
 * The funder is the sender of the first system transfer into the wallet, read from its oldest transaction. A wallet with a full page of
 * history is an established wallet: its first funding is out of reach here and it is reported as its own cluster, not guessed.
 * An RPC error is reported as an error (the wallet stays unknown); nothing is invented.
 */
export class FunderLookup {
  private cache = new Map<string, FunderResult>();
  private queue: Array<{ wallet: string; mint: string }> = [];
  private inFlight = 0;
  private perMint = new Map<string, number>();
  private queued = new Set<string>();
  private listeners: Array<(wallet: string, result: FunderResult) => void> = [];

  constructor(private getConnection: () => Connection | null, private opts: { concurrency?: number; maxPerMint?: number; cacheSize?: number } = {}) {}

  public onResult(fn: (wallet: string, result: FunderResult) => void): void {
    this.listeners.push(fn);
  }

  /** Ask for a wallet's funder. Cached wallets answer at once; the rest are queued, bounded per mint. */
  public request(wallet: string, mint: string): void {
    const hit = this.cache.get(wallet);
    if (hit) {
      for (const fn of this.listeners) fn(wallet, hit);
      return;
    }
    if (this.queued.has(wallet)) return;
    const used = this.perMint.get(mint) ?? 0;
    if (used >= (this.opts.maxPerMint ?? FUNDER_LOOKUP_MAX_PER_MINT)) return;
    this.perMint.set(mint, used + 1);
    if (this.perMint.size > 500) this.perMint.delete(this.perMint.keys().next().value as string);
    this.queued.add(wallet);
    this.queue.push({ wallet, mint });
    this.pump();
  }

  private pump(): void {
    const max = this.opts.concurrency ?? FUNDER_LOOKUP_CONCURRENCY;
    while (this.inFlight < max && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.inFlight++;
      this.lookup(job.wallet)
        .then((result) => {
          if (result.reason !== 'ERROR') this.remember(job.wallet, result);
          for (const fn of this.listeners) fn(job.wallet, result);
        })
        .catch(() => undefined)
        .finally(() => {
          this.inFlight--;
          this.queued.delete(job.wallet);
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
      if (sigs.length === 0) return { funder: null, reason: 'NO_TRANSFER' };
      if (sigs.length >= FUNDER_SIGNATURE_PAGE) return { funder: null, reason: 'ESTABLISHED_WALLET' };
      const oldest = sigs[sigs.length - 1];
      const tx = await conn.getParsedTransaction(oldest.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
      if (!tx) return { funder: null, reason: 'ERROR', error: 'oldest transaction not returned' };
      for (const ix of tx.transaction.message.instructions as any[]) {
        if (ix?.program === 'system' && ix.parsed?.type === 'transfer' && ix.parsed.info?.destination === wallet) {
          return { funder: String(ix.parsed.info.source) };
        }
      }
      return { funder: null, reason: 'NO_TRANSFER' };
    } catch (e: any) {
      Logger.warn(`funder lookup for ${wallet.slice(0, 6)} failed: ${e?.message || e}`);
      return { funder: null, reason: 'ERROR', error: String(e?.message || e) };
    }
  }
}

/** Connect a lookup to a watch window: new buyers are looked up, answers are fed back. */
export function wireFunderLookup(
  ww: { setFunder(w: string, f: string): void; setNoFunder(w: string): void; setFunderRequester(fn: ((wallet: string, mint: string) => void) | null): void },
  lookup: FunderLookup
): void {
  lookup.onResult((wallet, r) => {
    if (r.funder) ww.setFunder(wallet, r.funder);
    else if (r.reason !== 'ERROR') ww.setNoFunder(wallet);
  });
  ww.setFunderRequester((wallet, mint) => lookup.request(wallet, mint));
}
