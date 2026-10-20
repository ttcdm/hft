import { Connection, type ConnectionConfig } from '@solana/web3.js';

/**
 * P1.7 (R1-71): the trading Connection. Every call it makes is bounded:
 *  - each HTTP request is aborted after `rpcRequestTimeoutMs()` (RPC_REQUEST_TIMEOUT_MS, default 1500 ms), so a stuck socket cannot
 *    hold a sell (and with it every other exit) open; the slow scans no sell waits on (SLOW_READ_METHODS) get 10 s;
 *  - web3.js's own 429 retry (up to 5 tries with 0.5-4 s sleeps) is off (`disableRetryOnRateLimit`);
 *  - an idempotent read (IDEMPOTENT_READ_METHODS) that times out, fails at the network or gets a 429 is tried once more at once,
 *    with no sleep (2 tries in all). A send is never retried here: whether it reached the node is unknown, and P1.5's watch decides.
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

/** The fetch the trading Connection uses. It calls globalThis.fetch at request time (web3.js's own default on Node 18+). */
export function boundedRpcFetch(timeoutMs: number = rpcRequestTimeoutMs()) {
  return async (input: any, init?: any): Promise<Response> => {
    const methods = rpcMethods(init?.body);
    const label = methods.join(',') || 'request';
    const tries = methods.length > 0 && methods.every((m) => IDEMPOTENT_READ_METHODS.has(m)) ? RPC_READ_TRIES : 1;
    const limitMs = methods.length > 0 && methods.every((m) => SLOW_READ_METHODS.has(m)) ? Math.max(timeoutMs, SLOW_READ_TIMEOUT_MS) : timeoutMs;
    // web3.js passes an http.Agent for node-fetch; the built-in fetch does not take one
    const { agent: _agent, ...rest } = init ?? {};
    let lastErr: unknown;
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
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
