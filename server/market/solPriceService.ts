/**
 * Single source of the SOL/USD price (C3). Read-only public market data; no chain access.
 *
 * - Sources are tried in order: Binance SOLUSDT, Coinbase SOL-USD spot, CoinGecko. (Jupiter price API v6 was removed: deprecated.)
 * - No numeric fallback price exists. Until a price has been read, getPrice() reports null.
 * - Fail closed: LIVE code calls requireFreshPrice(), which throws if the price is missing or older than maxAgeMs.
 *   PAPER code may use the last known price with `stale: true`.
 */
export interface SolPriceReading {
  usd: number | null;
  /** Age of the reading in ms, or null if there has never been one. */
  ageMs: number | null;
  stale: boolean;
  source: string | null;
}

export class SolPriceUnavailableError extends Error {
  constructor(reason: string) {
    super(`SOL_PRICE_UNAVAILABLE: ${reason}`);
    this.name = 'SolPriceUnavailableError';
  }
}

export const SOL_PRICE_MAX_AGE_MS = 120_000;

const parse = (v: unknown): number | null => {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

export class SolPriceService {
  private usd: number | null = null;
  private asOf = 0;
  private source: string | null = null;
  private inFlight: Promise<SolPriceReading> | null = null;

  constructor(private readonly maxAgeMs = SOL_PRICE_MAX_AGE_MS) {}

  public getPrice(): SolPriceReading {
    if (this.usd === null) return { usd: null, ageMs: null, stale: true, source: null };
    const ageMs = Date.now() - this.asOf;
    return { usd: this.usd, ageMs, stale: ageMs > this.maxAgeMs, source: this.source };
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
  public setPrice(usd: number, source: string, asOf = Date.now()) {
    if (parse(usd) === null) return;
    this.usd = usd;
    this.source = source;
    this.asOf = asOf;
  }

  public reset() {
    this.usd = null;
    this.asOf = 0;
    this.source = null;
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
    const sources: Array<[string, () => Promise<number | null>]> = [
      ['BINANCE', async () => parse((await this.getJson('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT'))?.price)],
      ['COINBASE', async () => parse((await this.getJson('https://api.coinbase.com/v2/prices/SOL-USD/spot'))?.data?.amount)],
      ['COINGECKO', async () => parse((await this.getJson('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'))?.solana?.usd)],
    ];
    for (const [name, read] of sources) {
      try {
        const px = await read();
        if (px !== null) {
          this.setPrice(px, name);
          break;
        }
      } catch {
        // try the next source
      }
    }
    return this.getPrice();
  }

  private async getJson(url: string): Promise<any | null> {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.json() : null;
  }
}

export const solPriceService = new SolPriceService();
