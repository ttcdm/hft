import { Connection, type ConnectionConfig } from '@solana/web3.js';

/**
 * P1.7 (R1-71): the trading Connection. Every call it makes is bounded:
 *  - each HTTP request is aborted after `rpcRequestTimeoutMs()` (RPC_REQUEST_TIMEOUT_MS, default 1500 ms), so a stuck socket cannot
 *    hold a sell (and with it every other exit) open; the slow scans no sell waits on (SLOW_READ_METHODS) get 10 s;
 *  - web3.js's own 429 retry (up to 5 tries with 0.5-4 s sleeps) is off (`disableRetryOnRateLimit`);
 *  - an idempotent read (IDEMPOTENT_READ_METHODS) that times out, fails at the network or gets a 429 is tried once more at once,
 *    with no sleep (2 tries in all). A send is never retried here: whether it reached the node is unknown, and P1.5's watch decides
 *    (S245: a send refused with a rate limit was not accepted; the coordinator resends a SELL itself, SELL_RATE_LIMIT_BACKOFF_MS);
 *  - with RPC_MAX_REQUESTS_PER_SEC set, request starts are spaced to that rate, sends ahead of reads (off by default).
 */
export const DEFAULT_RPC_REQUEST_TIMEOUT_MS = 1500;
export const RPC_READ_TRIES = 2;

export function rpcRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.RPC_REQUEST_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_RPC_REQUEST_TIMEOUT_MS;
}

/** JSON-RPC methods that only read, so asking twice can change nothing. sendTransaction and requestAirdrop are not here. */
export const IDEMPOTENT_READ_METHODS: ReadonlySet<string> = new Set([
  'getAccountInfo', 'getBalance', 'getBlockHeight', 'getEpochInfo', 'getFeeForMessage', 'getGenesisHash', 'getHealth', 'getLatestBlockhash',
  'getMinimumBalanceForRentExemption', 'getMultipleAccounts', 'getParsedAccountInfo', 'getProgramAccounts', 'getRecentPrioritizationFees',
  'getSignatureStatuses', 'getSignaturesForAddress', 'getSlot', 'getTokenAccountBalance', 'getTokenAccountsByOwner', 'getTokenLargestAccounts',
  'getTokenSupply', 'getTransaction', 'getVersion', 'isBlockhashValid', 'simulateTransaction',
]);

/**
 * Reads that scan many accounts or signatures and that no sell waits on (the feed listener, the aggregator, startup reconciliation,
 * post-confirm fill reads). On a public RPC they can take several seconds, so the hot-path limit would make them fail; they get
 * SLOW_READ_TIMEOUT_MS instead (still bounded), or the configured limit when that is longer.
 */
export const SLOW_READ_METHODS: ReadonlySet<string> = new Set([
  'getProgramAccounts', 'getSignaturesForAddress', 'getTransaction', 'getTokenLargestAccounts', 'getTokenAccountsByOwner',
]);
export const SLOW_READ_TIMEOUT_MS = 10_000;

/** The JSON-RPC method names in a request body (a batch has several); empty when the body cannot be read. */
function rpcMethods(body: unknown): string[] {
  if (typeof body !== 'string') return [];
  try {
    const j = JSON.parse(body);
    return (Array.isArray(j) ? j : [j]).map((r: any) => String(r?.method ?? ''));
  } catch {
    return [];
  }
}

/**
 * S245: an optional client-side cap on the trading Connection's request rate, RPC_MAX_REQUESTS_PER_SEC (default unset: off, no queue,
 * no added wait). The public devnet RPC refuses more than a few requests a second per client (HTTP 429, "15/second request limit
 * reached"); the devnet harness sets 10 when it runs against it. Off by default because on the hot path a queue delays a stop-loss.
 */
export function rpcMaxRequestsPerSec(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.RPC_MAX_REQUESTS_PER_SEC);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * S245: spaces request starts at least 1000/perSec ms apart. Waiting sends (any request that is not all IDEMPOTENT_READ_METHODS) go before waiting reads (a send waits for at most the
 * sends queued ahead of it, one interval each); among each kind the order is first come, first served. `acquire` resolves at once
 * while the next slot is free. One limiter per rate is shared by every trading Connection in the process (an RPC switch builds a new
 * Connection, and the provider counts per client, not per Connection).
 */
export class RpcRateLimiter {
  private readonly intervalMs: number;
  private nextSlotAt = 0;
  private readonly waiting: { send: boolean; resolve: () => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly perSec: number) {
    this.intervalMs = 1000 / perSec;
  }

  acquire(send: boolean): Promise<void> {
    return new Promise((resolve) => {
      const w = { send, resolve };
      if (send) {
        const firstRead = this.waiting.findIndex((x) => !x.send);
        if (firstRead === -1) this.waiting.push(w);
        else this.waiting.splice(firstRead, 0, w);
      } else {
        this.waiting.push(w);
      }
      this.pump();
    });
  }

  /** Requests waiting for a slot (for tests and diagnostics). */
  get queued(): number {
    return this.waiting.length;
  }

  private pump(): void {
    if (this.timer) return;
    while (this.waiting.length > 0) {
      const now = Date.now();
      if (now >= this.nextSlotAt) {
        this.nextSlotAt = now + this.intervalMs;
        this.waiting.shift()!.resolve();
        continue;
      }
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, this.nextSlotAt - now);
      return;
    }
  }
}

const sharedLimiters = new Map<number, RpcRateLimiter>();
/** The process-wide limiter for this rate (see RpcRateLimiter). */
export function sharedRpcRateLimiter(perSec: number): RpcRateLimiter {
  let l = sharedLimiters.get(perSec);
  if (!l) sharedLimiters.set(perSec, (l = new RpcRateLimiter(perSec)));
  return l;
}

/**
 * The fetch the trading Connection uses. It calls globalThis.fetch at request time (web3.js's own default on Node 18+). With
 * `maxRequestsPerSec` > 0 every HTTP attempt (a read's second try included) first waits for a slot of the shared limiter, sends first.
 */
export function boundedRpcFetch(timeoutMs: number = rpcRequestTimeoutMs(), maxRequestsPerSec: number = rpcMaxRequestsPerSec()) {
  const limiter = maxRequestsPerSec > 0 ? sharedRpcRateLimiter(maxRequestsPerSec) : null;
  return async (input: any, init?: any): Promise<Response> => {
    const methods = rpcMethods(init?.body);
    const label = methods.join(',') || 'request';
    // a request that is not entirely idempotent reads (a send, an airdrop) is served before waiting reads
    const isSend = methods.length === 0 || methods.some((m) => !IDEMPOTENT_READ_METHODS.has(m));
    const tries = methods.length > 0 && methods.every((m) => IDEMPOTENT_READ_METHODS.has(m)) ? RPC_READ_TRIES : 1;
    const limitMs = methods.length > 0 && methods.every((m) => SLOW_READ_METHODS.has(m)) ? Math.max(timeoutMs, SLOW_READ_TIMEOUT_MS) : timeoutMs;
    // web3.js passes an http.Agent for node-fetch; the built-in fetch does not take one
    const { agent: _agent, ...rest } = init ?? {};
    let lastErr: unknown;
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        if (limiter) await limiter.acquire(isSend); // the wait for a slot is not part of the request's timeout
        const res = await globalThis.fetch(input, { ...rest, signal: AbortSignal.timeout(limitMs) });
        if (res.status === 429 && attempt < tries) continue; // rate limited: one more try at once, no sleep
        return res;
      } catch (err: any) {
        lastErr = err?.name === 'TimeoutError' || err?.name === 'AbortError'
          ? new Error(`RPC_TIMEOUT: ${label} got no answer within ${limitMs} ms`)
          : err;
      }
    }
    throw lastErr;
  };
}

/** A Connection for the trading hot path (see above). The coordinator builds exactly one per endpoint. */
export function createTradingConnection(endpoint: string, config: Omit<ConnectionConfig, 'fetch' | 'disableRetryOnRateLimit'> = {}): Connection {
  return new Connection(endpoint, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 30000,
    ...config,
    disableRetryOnRateLimit: true,
    fetch: boundedRpcFetch() as any,
  });
}
