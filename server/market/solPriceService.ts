/**
 * Single source of the SOL/USD price (C3). Read-only public market data; no chain access.
 *
 * - Sources are tried in order: Coinbase SOL-USD spot, CoinGecko, Binance SOLUSDT (last: api.binance.com refuses US connections). (Jupiter price API v6 was removed: deprecated.)
 * - The first price, the first after a 10-minute gap, and any price that would break the 2x band need two sources within 5% (N-64).
 * - No numeric fallback price exists. Until a price has been read, getPrice() reports null.
 * - Fail closed: LIVE code calls requireFreshPrice(), which throws if the price is missing or older than maxAgeMs.
 *   PAPER code may use the last known price with `stale: true`.
 */
import { allowedCluster } from '../solana/clusterGuard';

export interface SolPriceReading {
  usd: number | null;
  /** Age of the reading in ms, or null if there has never been one. */
  ageMs: number | null;
  stale: boolean;
  source: string | null;
  /** N-64 (3C): set while the last refresh's sources did not agree, e.g. "COINBASE 15 vs COINGECKO 150 BINANCE 150". */
  disagreement?: string;
}

export class SolPriceUnavailableError extends Error {
  constructor(reason: string) {
    super(`SOL_PRICE_UNAVAILABLE: ${reason}`);
    this.name = 'SolPriceUnavailableError';
  }
}

export const SOL_PRICE_MAX_AGE_MS = 120_000;
export const SOL_PRICE_MIN_USD = 1;
export const SOL_PRICE_MAX_USD = 100_000;
/** N-64 (3C): two sources agree when they are within this fraction of each other. */
export const SOL_PRICE_AGREEMENT_FRACTION = 0.05;
/** A reading under this age anchors the next one (the 2x band); older, or none, and a new price needs two agreeing sources. */
export const SOL_PRICE_ANCHOR_MAX_AGE_MS = 10 * 60_000;

const agree = (a: number, b: number) => Math.abs(a - b) <= SOL_PRICE_AGREEMENT_FRACTION * Math.min(a, b);

const parse = (v: unknown): number | null => {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

export class SolPriceService {
  private usd: number | null = null;
  private asOf = 0;
  private source: string | null = null;
  private inFlight: Promise<SolPriceReading> | null = null;
  private disagreement: string | null = null;

  constructor(private readonly maxAgeMs = SOL_PRICE_MAX_AGE_MS) {}

  public getPrice(): SolPriceReading {
    const disagreement = this.disagreement ? { disagreement: this.disagreement } : {};
    if (this.usd === null) return { usd: null, ageMs: null, stale: true, source: null, ...disagreement };
    const ageMs = Date.now() - this.asOf;
    return { usd: this.usd, ageMs, stale: ageMs > this.maxAgeMs, source: this.source, ...disagreement };
  }

  /** LIVE: the price, or a thrown SolPriceUnavailableError when missing or stale. */
  public requireFreshPrice(): number {
    const r = this.getPrice();
    if (r.usd === null) throw new SolPriceUnavailableError('no price has been read yet');
    if (r.stale) throw new SolPriceUnavailableError(`last price is ${Math.round((r.ageMs ?? 0) / 1000)}s old (source ${r.source})`);
    return r.usd;
  }

  /** PAPER: the last known price (possibly stale), or null if none. */
  public lastKnownPrice(): number | null {
    return this.usd;
  }

  /** Records a reading. Used by refresh() and by tests that need a deterministic price. */
  public setPrice(usd: number, source: string, asOf = Date.now()): boolean {
    if (parse(usd) === null) return false;
    // Q56: a sanity band. SOL outside $1 to $100,000, or a jump of more than 2x either way against a reading under 10 minutes old, is a bad
    // feed (a wrong unit, a different asset, a fat-finger fixed price), not a market. It would size every order and the SOL loss cap.
    if (usd < SOL_PRICE_MIN_USD || usd > SOL_PRICE_MAX_USD) return false;
    if (this.hasAnchor(asOf) && (usd > this.usd! * 2 || usd < this.usd! / 2)) return false;
    this.usd = usd;
    this.source = source;
    this.asOf = asOf;
    return true;
  }

  public reset() {
    this.usd = null;
    this.asOf = 0;
    this.source = null;
    this.disagreement = null;
  }

  /** True when the last reading is recent enough to anchor the next one. */
  private hasAnchor(at = Date.now()): boolean {
    return this.usd !== null && at - this.asOf < SOL_PRICE_ANCHOR_MAX_AGE_MS;
  }

  /**
   * N-64 (3C): a price set from two sources within SOL_PRICE_AGREEMENT_FRACTION of each other. It replaces any anchor, so a wrong
   * anchor does not block the true price for 10 minutes. Still inside the $1 to $100,000 band.
   */
  private setAgreedPrice(a: [string, number], b: [string, number]): boolean {
    const usd = (a[1] + b[1]) / 2;
    if (usd < SOL_PRICE_MIN_USD || usd > SOL_PRICE_MAX_USD) return false;
    this.usd = usd;
    this.source = `${a[0]}+${b[0]}`;
    this.asOf = Date.now();
    return true;
  }

  private timer: NodeJS.Timeout | null = null;

  /**
   * Keeps the price fresh in the background. Before this existed only the wallet snipe route refreshed it, so a cold-start
   * LIVE trade through any other route failed SOL_PRICE_UNAVAILABLE (found by the localnet end-to-end run).
   */
  public startAutoRefresh(intervalMs = 30_000) {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref?.();
  }

  public stopAutoRefresh() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Boot wiring. External feeds on: keep the price fresh in the background. External feeds off (tests, loopback-only servers): no
   * background polling and no public host, but on a local validator one refresh still runs, because doRefresh() is the only reader of
   * LOCALNET_SOL_PRICE_USD and without it the first LIVE buy answers SOL_PRICE_UNAVAILABLE. On devnet/mainnet nothing runs, and on
   * localnet nothing runs unless that fixed price is set: doRefresh() would otherwise fall through to Coinbase/CoinGecko/Binance.
   */
  public startForBoot(externalFeedsDisabled: boolean) {
    if (!externalFeedsDisabled) return this.startAutoRefresh();
    if (allowedCluster() === 'localnet' && parse(process.env.LOCALNET_SOL_PRICE_USD) !== null) void this.refresh();
  }

  /** Reads from the public sources in order. Concurrent calls share one request. Never throws. */
  public refresh(): Promise<SolPriceReading> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doRefresh(): Promise<SolPriceReading> {
    // A local validator has no market: when (and only when) ALLOWED_CLUSTER=localnet, an operator-chosen price labelled
    // LOCALNET_FIXED stands in so LIVE sizing can run offline. It is never read on devnet or mainnet.
    if (allowedCluster() === 'localnet') {
      const fixed = parse(process.env.LOCALNET_SOL_PRICE_USD);
      if (fixed !== null) {
        this.setPrice(fixed, 'LOCALNET_FIXED');
        return this.getPrice();
      }
    }
    const sources: Array<[string, () => Promise<number | null>]> = [
      ['COINBASE', async () => parse((await this.getJson('https://api.coinbase.com/v2/prices/SOL-USD/spot'))?.data?.amount)],
      ['COINGECKO', async () => parse((await this.getJson('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'))?.solana?.usd)],
      ['BINANCE', async () => parse((await this.getJson('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT'))?.price)],
    ];
    // With a fresh anchor, the first source inside the 2x band is enough. With no anchor (first reading, or after a 10-minute gap),
    // or when a source falls outside the band, the sources are read until two agree within 5% (N-64, 3C). One source alone, or
    // sources that disagree, change nothing and are reported in `disagreement`.
    const seen: Array<[string, number]> = [];
    for (const [name, read] of sources) {
      let px: number | null = null;
      try {
        px = await read();
      } catch {
        // try the next source
      }
      if (px === null) continue;
      if (seen.length === 0 && this.hasAnchor() && this.setPrice(px, name)) {
        this.disagreement = null;
        return this.getPrice();
      }
      const match = seen.find(([, other]) => agree(other, px!));
      seen.push([name, px]);
      if (match && this.setAgreedPrice(match, [name, px])) {
        this.disagreement = seen.length > 2 ? seen.map(([n, p]) => `${n} ${p}`).join(' vs ') : null;
        return this.getPrice();
      }
    }
    this.disagreement = seen.length > 0 ? `no two sources agree within 5%: ${seen.map(([n, p]) => `${n} ${p}`).join(', ')}` : this.disagreement;
    return this.getPrice();
  }

  private async getJson(url: string): Promise<any | null> {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.json() : null;
  }
}

export const solPriceService = new SolPriceService();
