/**
 * The two ways a signed transaction leaves the process: plain Solana RPC (`SolanaRpcTransport`) and a Jito block engine (`JitoTransport`).
 * Each can submit, retry and confirm, and reports a lifecycle state and timing. `JitoTransport` also reports health and a tip floor.
 *
 * Jito is off unless a block engine URL is configured, and on devnet and localnet none should be: `resolveJitoUrl` returns an empty string for
 * a mainnet URL unless mainnet is allowed, and for any URL on localnet, but it keeps any other URL on devnet (tests use a mock), and that
 * URL is then used. With no URL every send goes through `SolanaRpcTransport`. The RPC transport sends with `skipPreflight: true`: nothing is simulated
 * first, so a transaction that would fail is found out on chain, not before it.
 *
 * What it must never do: send in read-only mode (both `submit` methods call `assertNotReadOnly` first, then `assertSendClusterAllowed`, which refuses whenever `ALLOWED_CLUSTER=mainnet-beta`), call the public Jito tip-floor
 * service unless mainnet was allowed (`jitoTipFloorAllowed`), or be used as a way around the cluster guard. These classes refuse a mainnet
 * setting themselves but do not check the RPC's genesis hash; `ExecutionCoordinator.submitAndConfirmInner` runs `assertClusterAllowed` before it
 * calls them, so they must only be reached through it.
 *
 * Called by: `server/execution/coordinator.ts` only.
 */
import { Connection, SendTransactionError, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { Logger } from '../middleware/enterprise';
import { assertSendClusterAllowed, jitoTipFloorAllowed, resolveJitoUrl } from './clusterGuard';
import { executionConfig } from './executionConfig';
import { assertNotReadOnly } from './readOnly';

/**
 * Where a submission stands. `SUBMITTED_TO_JITO` and `BUNDLE_PENDING` only occur on the Jito path. `EXPIRED_BLOCKHASH` is what
 * `SolanaRpcTransport.confirm` returns when the blockhash expired with no status (P2.1). `BUNDLE_LANDED` and `TX_RECONCILED` are declared
 * but nothing assigns them (checked by searching `server/`).
 */
export type BundleLifecycleState =
  | 'SUBMITTED_TO_JITO'
  | 'BUNDLE_PENDING'
  | 'BUNDLE_LANDED'
  | 'TX_CONFIRMED'
  | 'TX_RECONCILED'
  | 'SUBMIT_FAILED'
  | 'REVERTED'
  | 'TIMED_OUT'
  | 'EXPIRED_BLOCKHASH';

/**
 * P1.5 (R1-2, R1-70, R1-82, R1-113): the send errors that prove the RPC did not accept the transaction. Only a JSON-RPC error object
 * the node returned can prove that (web3.js SendTransactionError: a preflight failure, a sanitize or deserialize failure, a failed signature
 * check, an unknown blockhash), or a message that names one of those. Everything else
 * (fetch failed, a socket reset, a timeout, an HTTP 5xx page, an "already processed" answer that means it landed earlier) leaves the
 * outcome unknown: the transaction may have been forwarded and may land.
 *
 * S262: a rate-limit refusal (`isRateLimitedSendError`) is NOT definite. S245 made it definite to stop a refused sell from holding the
 * position for the pending window. A review showed that a balancer may already have forwarded the request. Since P2.1 (S251, S252) an
 * unknown send is watched, with resends, until its blockhash expires, and then released, so S245's problem no longer needs the
 * definite reading.
 *
 * R4-10: an HTTP 401, 402 or 403 (`rpcAuthRejectionStatus`) is definite: the provider refused the caller (an expired plan, a refused key)
 * before forwarding anything. Its result carries `authRejected` and an error starting with RPC_AUTH_REJECTED.
 */
export const DEFINITE_SEND_REJECTION = /sanitiz|failed to deserialize|signature verification fail|Transaction signature verification failure|Blockhash not found|invalid transaction/i;

/** "Already processed": the node has seen this transaction, so it may well be on chain. Never a definite rejection. */
const ALREADY_PROCESSED = /already (?:been )?processed/i;

/**
 * S245: the shapes a rate-limit refusal of sendTransaction takes through web3.js 1.x (lib/index.cjs.js):
 *  - HTTP 429. With `disableRetryOnRateLimit` (the trading Connection, rpcConnection.ts) web3.js does not retry and throws a plain
 *    `Error(\`${status} ${statusText}: ${body}\`)`, so the message starts with "429" (statusText may be empty over HTTP/2, "429 : {...}"),
 *    followed by the JSON-RPC body (public devnet: code -32007 or 429, "15/second request limit reached", "Too many requests ...").
 *  - HTTP 200 with a JSON-RPC error body: `sendEncodedTransaction` throws `SendTransactionError` whose message carries only the
 *    error's message text (the code is dropped), e.g. "Transaction  resulted in an error. \n15/second request limit reached ...".
 *  - a `SolanaJSONRPCError`-like object with `code` -32007 or 429 (providers' "limit reached"). Not -32005: that is Solana's "node unhealthy".
 */
export const RATE_LIMITED_SEND = /request limit reached|too many requests|rate[ -]?limit(?:ed| exceeded| reached)|"code"\s*:\s*-3200[57]\b/i;
export const RATE_LIMIT_RPC_CODES: ReadonlySet<number> = new Set([-32007, 429]); // S262: not -32005, which is Solana's "node unhealthy"

/**
 * R4-10: the HTTP statuses an RPC provider answers with when it refuses the caller, not the transaction: 401 (key missing or wrong),
 * 402 (plan expired or out of credit) and 403 (key refused, IP or method not allowed). The gateway answers these before anything reaches
 * a validator, so a send refused this way was not forwarded: it is a definite rejection, never an unknown outcome.
 */
export const RPC_AUTH_HTTP_STATUSES: ReadonlySet<number> = new Set([401, 402, 403]);
export const RPC_AUTH_REJECTED = 'RPC_AUTH_REJECTED';
export const RPC_AUTH_REJECTED_TEXT = 'RPC plan expired or key refused';

/**
 * R4-10: the auth status (401, 402 or 403) behind an RPC error, or null. web3.js 1.x turns a non-OK HTTP answer into a plain
 * `Error(\`${status} ${statusText}: ${body}\`)` (statusText may be empty over HTTP/2, "401 : ..."), so the message starts with the status.
 * An error object carrying a numeric `status`/`statusCode` is read too.
 */
export function rpcAuthRejectionStatus(err: unknown): number | null {
  for (const k of ['status', 'statusCode']) {
    const n = Number((err as any)?.[k]);
    if (RPC_AUTH_HTTP_STATUSES.has(n)) return n;
  }
  const msg = String((err as any)?.message ?? err ?? '');
  const m = /^(40[123])\b/.exec(msg);
  return m ? Number(m[1]) : null;
}

/** R4-10: listeners told whenever an RPC request (a send or a read) is refused with 401, 402 or 403. The coordinator raises RPC_AUTH_REJECTED from it. */
export type RpcAuthRejection = { status: number; method: string };
const rpcAuthListeners = new Set<(r: RpcAuthRejection) => void>();
/** Registers a listener; returns the function that removes it. */
export function onRpcAuthRejected(fn: (r: RpcAuthRejection) => void): () => void {
  rpcAuthListeners.add(fn);
  return () => { rpcAuthListeners.delete(fn); };
}
/** Tells every listener. A listener that throws is logged and does not stop the others or the caller. */
export function noteRpcAuthRejected(status: number, method: string): void {
  for (const fn of rpcAuthListeners) {
    try { fn({ status, method }); } catch (e: any) { Logger.error(`RPC_AUTH_REJECTED listener failed: ${e?.message ?? e}`); }
  }
}

export function isRateLimitedSendError(err: unknown): boolean {
  if (rpcAuthRejectionStatus(err) !== null) return false; // R4-10: an auth refusal is not a rate limit, even if its body says "limit"
  const code = Number((err as any)?.code);
  if (Number.isFinite(code) && RATE_LIMIT_RPC_CODES.has(code)) return true;
  const msg = String((err as any)?.message ?? err ?? '');
  if (ALREADY_PROCESSED.test(msg)) return false;
  return /^429\b/.test(msg) || RATE_LIMITED_SEND.test(msg);
}

export function isDefiniteSendRejection(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? '');
  if (ALREADY_PROCESSED.test(msg)) return false;
  // R4-10: a 401/402/403 is the provider refusing the caller (an expired plan, a refused key) before anything is forwarded.
  if (rpcAuthRejectionStatus(err) !== null) return true;
  // S262 (review 2026-10-24, HIGH on S245): a rate limit proves only that this answer was a refusal. Behind a load balancer an earlier
  // attempt of the same request may have been forwarded, so it is an unknown outcome, never proof that nothing was sent. The resend loop
  // (`submitThroughRateLimit`) is still safe: it resends the same signed bytes.
  if (isRateLimitedSendError(err)) return false;
  // web3.js throws SendTransactionError only when the RPC answered sendTransaction with a JSON-RPC error object (a preflight failure such as
  // -32002, a failed signature check, a node that is behind). The node returns those before it forwards anything. An HTTP error page, a
  // timeout or a reset socket is a plain Error and stays ambiguous.
  if (err instanceof SendTransactionError) return true;
  return DEFINITE_SEND_REJECTION.test(msg);
}

/**
 * S245: the wait before each resend of a send the RPC refused with a rate limit. Tests replace `sleep` with a spy (it is the only clock
 * the resend loop reads), so they need not wait for real.
 */
export const sendBackoff = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** P2.1: the clock `SolanaRpcTransport.confirm` reads. Tests replace both with a virtual clock (sleep advances now), so no test waits for real. */
export const confirmPacing = {
  // S271 review: the monotonic clock. On Date.now a wall clock set back mid-watch stretched the watch (and the sell it holds) by the jump.
  now: (): number => performance.now(),
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** What one submit attempt returned: the signature, which transport, timing and, on failure, the reason. */
export interface SubmitResult {
  /** P1.5: the transaction's own signature whenever it was signed, also when the send failed (it is known before anything is sent). */
  signature: string;
  /** P1.5: the send failed without proof that the transaction was not accepted. It may still land; the caller must watch it, not call it REVERTED. */
  ambiguous?: boolean;
  /** S245: the RPC refused the send with a rate limit (HTTP 429, -32007, "request limit reached"). Definite: nothing was accepted, so resending the same signed transaction is safe. */
  rateLimited?: boolean;
  /** R4-10: the RPC refused the caller with this HTTP status (401, 402 or 403): the plan expired or the key was refused. Definite: nothing was forwarded. `error` starts with RPC_AUTH_REJECTED. */
  authRejected?: number;
  bundleId?: string;
  transport: 'SOLANA_RPC' | 'JITO';
  success: boolean;
  submitDurationMs: number;
  lifecycleState: BundleLifecycleState;
  error?: string;
}

/** What waiting for a signature found: confirmed, failed on chain, or timed out. */
export interface ConfirmationResult {
  signature: string;
  confirmed: boolean;
  slot?: number;
  feeLamports?: number;
  confirmDurationMs: number;
  lifecycleState: BundleLifecycleState;
  error?: string;
}

/** What the coordinator needs from a transport. */
export interface ExecutionTransport {
  submit(tx: VersionedTransaction): Promise<SubmitResult>;
  confirm(signature: string, maxWaitMs?: number, bundleId?: string): Promise<ConfirmationResult>;
}

/** Jito health as shown in readiness. `NOT_CONFIGURED` is the normal state on devnet and localnet and does not block arming. */
export interface JitoHealthTelemetry {
  health: 'HEALTHY' | 'DEGRADED' | 'OFFLINE' | 'NOT_CONFIGURED';
  lastResponseMsAgo: number | null;
  lastLatencyMs: number | null;
  tipFloorLamports: number | null;
  activeTipAccount: string | null;
  lastError: string | null;
}

/** The first signature of a signed transaction, base58; '' when it is unsigned (all zero). */
function localSignature(tx: VersionedTransaction): string {
  const sig = tx?.signatures?.[0];
  if (!sig || sig.every((b) => b === 0)) return '';
  return bs58.encode(sig);
}

/** Sends over plain RPC (`sendRawTransaction`, no preflight, 2 node-side retries) and confirms by polling signature statuses. The only transport used on devnet and localnet. */
export class SolanaRpcTransport implements ExecutionTransport {
  private lastRequestTimestamp: number | null = null;
  private lastLatencyMs: number | null = null;

  constructor(private connection: Connection) {}

  /** Sends one signed transaction with `sendRawTransaction`, `skipPreflight: true`. Throws `READ_ONLY` before touching the network in read-only mode. */
  public async submit(tx: VersionedTransaction, opts: { maxRetries?: number } = {}): Promise<SubmitResult> {
    assertNotReadOnly('sending a transaction over RPC'); // S185: before anything is serialized or sent
    assertSendClusterAllowed(); // S206: the lowest choke point; a mainnet setting never reaches the network from here
    const t0 = performance.now();
    try {
      const raw = tx.serialize();
      const signature = await this.connection.sendRawTransaction(raw, {
        skipPreflight: true,
        maxRetries: opts.maxRetries ?? 2,
        preflightCommitment: 'processed',
      });
      const duration = Math.round(performance.now() - t0);
      this.lastRequestTimestamp = Date.now();
      this.lastLatencyMs = duration;

      return {
        signature,
        transport: 'SOLANA_RPC',
        success: true,
        submitDurationMs: duration,
        lifecycleState: 'BUNDLE_PENDING',
      };
    } catch (err: any) {
      const duration = Math.round(performance.now() - t0);
      this.lastRequestTimestamp = Date.now();
      this.lastLatencyMs = duration;
      const ambiguous = !isDefiniteSendRejection(err);
      const rateLimited = isRateLimitedSendError(err);
      const authStatus = rpcAuthRejectionStatus(err);
      const message = String(err?.message ?? err);
      if (authStatus !== null) {
        noteRpcAuthRejected(authStatus, 'sendTransaction');
        Logger.error(`RPC submit refused (${RPC_AUTH_REJECTED}, HTTP ${authStatus}: ${RPC_AUTH_REJECTED_TEXT}; not forwarded): ${message}`);
      } else {
        Logger.error(`RPC submit failed${rateLimited ? ' (rate limited; outcome unknown, it is watched)' : ambiguous ? ' (outcome unknown: it may have been forwarded)' : ''}: ${message}`);
      }
      return {
        signature: localSignature(tx),
        transport: 'SOLANA_RPC',
        success: false,
        ambiguous,
        rateLimited,
        ...(authStatus !== null ? { authRejected: authStatus } : {}),
        submitDurationMs: duration,
        lifecycleState: 'SUBMIT_FAILED',
        error: authStatus !== null ? `${RPC_AUTH_REJECTED}: ${RPC_AUTH_REJECTED_TEXT} (HTTP ${authStatus}); nothing was forwarded. ${message}` : message,
      };
    }
  }

  /**
   * S245: `submit`, and while the RPC refuses it with a rate limit, wait `backoffMs[i]` and send the same signed transaction again (one
   * resend per entry). Safe: a rate-limited send was not accepted, and a resend carries the same signature, so it can land at most once.
   * Any other outcome (sent, ambiguous, another definite rejection) is returned at once. `rateLimitedResends` counts the resends.
   */
  public async submitThroughRateLimit(tx: VersionedTransaction, backoffMs: readonly number[]): Promise<SubmitResult & { rateLimitedResends: number }> {
    let res = await this.submit(tx);
    let resends = 0;
    while (res.rateLimited && resends < backoffMs.length) {
      Logger.warn(`[S245] RPC rate-limited the send of ${res.signature.slice(0, 8) || 'an unsigned transaction'}; resending in ${backoffMs[resends]} ms (${resends + 1}/${backoffMs.length})`);
      await sendBackoff.sleep(backoffMs[resends]);
      resends++;
      res = await this.submit(tx);
    }
    return { ...res, rateLimitedResends: resends };
  }

  /** Retries `submit` (default 2 retries, 200 ms apart). Returns the last result and the number of attempts. */
  public async submitWithRetry(
    tx: VersionedTransaction,
    customMaxRetries = 2,
    customRetryIntervalMs = 200
  ): Promise<SubmitResult & { attempts: number }> {
    let attempts = 0;
    let lastResult: SubmitResult = {
      signature: '',
      transport: 'SOLANA_RPC',
      success: false,
      submitDurationMs: 0,
      lifecycleState: 'SUBMIT_FAILED',
      error: 'No attempts made',
    };

    for (let attempt = 0; attempt <= customMaxRetries; attempt++) {
      attempts++;
      lastResult = await this.submit(tx);
      if (lastResult.success && lastResult.signature) {
        return { ...lastResult, attempts };
      }
      if (attempt < customMaxRetries && customRetryIntervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, customRetryIntervalMs));
      }
    }

    return { ...lastResult, attempts };
  }

  /**
   * Polls the signature's status until it is confirmed, fails on chain, or the wait ends.
   * P2.1 (R1-20, R1-69, R1-77): with `opts.rebroadcast` (the signed transaction) the same transaction is resent through `submit` every `resendEveryMs` (default 1.5 s)
   * with `maxRetries: 0`. It has the same signature, so it can land at most once. With `opts.lastValidBlockHeight` the wait does not stop at
   * `maxWaitMs` while the blockhash is still valid. It goes on until the confirmed block height passes that height, capped at
   * `maxWaitMs + maxExtendMs` (default 60 s more). Past the height, with no status even in history, the result is `EXPIRED_BLOCKHASH`:
   * the transaction never landed and never can. A failed status read or resend only skips that round. No `getTransaction` is made.
   */
  public async confirm(
    signature: string,
    maxWaitMs = 25000,
    _bundleId?: string,
    opts: { rebroadcast?: VersionedTransaction; lastValidBlockHeight?: number; resendEveryMs?: number; maxExtendMs?: number } = {}
  ): Promise<ConfirmationResult> {
    const t0 = performance.now();
    const now = confirmPacing.now;
    const startTime = now();
    const lvbh = typeof opts.lastValidBlockHeight === 'number' && opts.lastValidBlockHeight > 0 ? opts.lastValidBlockHeight : undefined;
    const hardStop = startTime + maxWaitMs + (lvbh !== undefined ? (opts.maxExtendMs ?? 60_000) : 0);
    const resendEveryMs = opts.resendEveryMs ?? 1_500;
    let lastResend = startTime;
    let resendStopped = false;
    let lastPollError: string | null = null;
    let expired = false;
    const statusOf = async (history: boolean) => {
      try {
        return (await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: history }))?.value?.[0] ?? null;
      } catch (pollErr: any) {
        lastPollError = pollErr?.message ?? String(pollErr); // P1.5: one failed poll says nothing about the transaction; keep polling
        return undefined;
      }
    };
    const settled = (status: any): ConfirmationResult | null => {
      if (!status) return null;
      if (status.err) {
        return { signature, confirmed: false, confirmDurationMs: Math.round(performance.now() - t0), lifecycleState: 'REVERTED', error: JSON.stringify(status.err) };
      }
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return { signature, confirmed: true, slot: status.slot, feeLamports: 5000, confirmDurationMs: Math.round(performance.now() - t0), lifecycleState: 'TX_CONFIRMED' };
      }
      return null;
    };

    for (;;) {
      const done = settled(await statusOf(false));
      if (done) return done;
      const t = now();
      if (t >= hardStop) break;
      if (t - startTime >= maxWaitMs) {
        if (lvbh === undefined) break;
        try {
          if ((await this.connection.getBlockHeight('confirmed')) > lvbh) { expired = true; break; }
        } catch (hErr: any) {
          lastPollError = hErr?.message ?? String(hErr); // an unreadable height is not expiry: keep watching until the hard stop
        }
      }
      if (opts.rebroadcast && !resendStopped && t - lastResend >= resendEveryMs) {
        lastResend = t;
        // through submit, so the read-only and cluster guards run on every resend; a failed resend is logged there and only skips this round
        try {
          await this.submit(opts.rebroadcast, { maxRetries: 0 });
        } catch (guardErr: any) {
          // Review L1: a guard that throws before sending (read-only turned on, or the cluster refused, mid-watch) stops the resends only.
          // The transaction may already have landed, so the watch goes on and settles the row as it would without resends.
          resendStopped = true;
          Logger.warn(`Resends of ${signature.slice(0, 8)} stopped, the watch goes on: ${guardErr?.message ?? String(guardErr)}`);
        }
      }
      await confirmPacing.sleep(400);
    }

    // One last look with history before saying it did not land.
    const last = await statusOf(true);
    const done = settled(last);
    if (done) return done;
    if (expired && last === null) {
      return {
        signature,
        confirmed: false,
        confirmDurationMs: Math.round(performance.now() - t0),
        lifecycleState: 'EXPIRED_BLOCKHASH',
        error: 'BLOCKHASH_EXPIRED: the transaction did not land and its blockhash is no longer valid; safe to retry with a new transaction',
      };
    }
    return {
      signature,
      confirmed: false,
      confirmDurationMs: Math.round(performance.now() - t0),
      lifecycleState: 'TIMED_OUT',
      error: `Transaction did not confirm within ${Math.round(now() - startTime)}ms${lastPollError ? ` (last status read failed: ${lastPollError})` : ''}`,
    };
  }
}

/** Sends bundles to a block engine. Disabled (`isEnabled()` false) unless a non-mainnet URL is configured, and `submit` then fails with `JITO_DISABLED` rather than falling through. */
export class JitoTransport implements ExecutionTransport {
  private blockEngineUrl: string;
  private lastSubmitTimestamp: number | null = null;
  private lastLatencyMs: number | null = null;
  private lastHealthStatus: 'HEALTHY' | 'DEGRADED' | 'OFFLINE' | 'NOT_CONFIGURED' = 'NOT_CONFIGURED';
  private lastErrorMessage: string | null = null;
  private lastProbeTimestamp: number | null = null;
  private cachedTipFloor: { lamports: number; timestamp: number } | null = null;

  constructor(
    private connection: Connection,
    blockEngineUrl?: string
  ) {
    const configUrl = executionConfig.getConfig().jitoBlockEngineUrl;
    // '' means Jito is disabled. There is no default block engine.
    this.blockEngineUrl = resolveJitoUrl(blockEngineUrl || configUrl || '');
  }

  /** True only when a non-mainnet-guarded block engine URL is configured. */
  public isEnabled(): boolean {
    return this.blockEngineUrl !== '';
  }

  public setBlockEngineUrl(url: string) {
    const resolved = resolveJitoUrl(url);
    if (url.trim() !== '' && resolved === '') {
      throw new Error('CLUSTER_GUARD: refusing to configure a mainnet Jito block engine URL');
    }
    this.blockEngineUrl = resolved;
    executionConfig.updateConfig({ jitoBlockEngineUrl: this.blockEngineUrl });
    this.lastHealthStatus = 'NOT_CONFIGURED';
  }

  /** Median landed tip in lamports from the public tip-floor service, cached 15 s. Mainnet-only: with mainnet not allowed it never makes the call and returns the cached value or null. */
  public async getTipFloorLamports(): Promise<number | null> {
    const now = Date.now();
    if (this.cachedTipFloor && now - this.cachedTipFloor.timestamp < 15000) {
      return this.cachedTipFloor.lamports;
    }
    // The public tip-floor service is mainnet-only: never call it unless mainnet was explicitly allowed.
    if (!this.isEnabled() || !jitoTipFloorAllowed()) {
      return this.cachedTipFloor?.lamports ?? null;
    }

    try {
      const res = await fetch('https://bundles.jito.wtf/api/v1/bundles/tip_floor', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(3000),
      });

      if (res.ok) {
        const data = await res.json();
        // Typically returns array of percentiles [{ landed_tips_50th_percentile: 0.0001, ... }]
        if (Array.isArray(data) && data.length > 0) {
          const item = data[0];
          const tipSol = item.landed_tips_50th_percentile || item.ema_landed_tips_50th_percentile || 0.00005;
          const lamports = Math.round(tipSol * 1e9);
          this.cachedTipFloor = { lamports, timestamp: now };
          return lamports;
        }
      }
    } catch {
      // Return cached if available, otherwise null (truthful fallback)
    }

    return this.cachedTipFloor?.lamports ?? null;
  }

  public getTelemetry(): JitoHealthTelemetry {
    const now = Date.now();
    return {
      health: this.lastHealthStatus,
      lastResponseMsAgo: this.lastSubmitTimestamp ? now - this.lastSubmitTimestamp : null,
      lastLatencyMs: this.lastLatencyMs,
      tipFloorLamports: this.cachedTipFloor?.lamports ?? null,
      activeTipAccount: null,
      lastError: this.lastErrorMessage,
    };
  }

  /**
   * Real health probe: asks the block engine for its tip accounts (a cheap authenticated-free JSON-RPC call)
   * and requires a non-empty array back. HEALTHY only on that answer; an HTTP error or unexpected body is
   * DEGRADED; a network error or timeout is OFFLINE. The tip-floor lookup no longer decides health.
   */
  /** Health probe against the block engine; sets the health status readiness reads. Returns unhealthy without a network call when Jito is not configured. */
  public async probe(): Promise<{ healthy: boolean; tipFloorLamports: number | null; latencyMs: number }> {
    const t0 = performance.now();
    if (!this.isEnabled()) {
      this.lastHealthStatus = 'NOT_CONFIGURED';
      this.lastErrorMessage = null;
      return { healthy: false, tipFloorLamports: null, latencyMs: 0 };
    }
    try {
      const res = await fetch(`${this.blockEngineUrl}/api/v1/bundles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }),
        signal: AbortSignal.timeout(3000),
      });
      const latencyMs = Math.round(performance.now() - t0);
      this.lastProbeTimestamp = Date.now();
      this.lastLatencyMs = latencyMs;
      if (!res.ok) {
        this.lastHealthStatus = 'DEGRADED';
        this.lastErrorMessage = `Probe HTTP ${res.status}`;
        return { healthy: false, tipFloorLamports: null, latencyMs };
      }
      const body: any = await res.json().catch(() => null);
      if (!Array.isArray(body?.result) || body.result.length === 0) {
        this.lastHealthStatus = 'DEGRADED';
        this.lastErrorMessage = 'Probe returned no tip accounts';
        return { healthy: false, tipFloorLamports: null, latencyMs };
      }
      this.lastHealthStatus = 'HEALTHY';
      this.lastErrorMessage = null;
      const tipFloor = await this.getTipFloorLamports();
      return { healthy: true, tipFloorLamports: tipFloor, latencyMs };
    } catch (err: any) {
      const latencyMs = Math.round(performance.now() - t0);
      this.lastProbeTimestamp = Date.now();
      this.lastHealthStatus = 'OFFLINE';
      this.lastLatencyMs = latencyMs;
      this.lastErrorMessage = err.message;
      return { healthy: false, tipFloorLamports: null, latencyMs };
    }
  }

  /** Milliseconds since the last completed probe, or null if none ran. */
  public getProbeAgeMs(): number | null {
    return this.lastProbeTimestamp === null ? null : Date.now() - this.lastProbeTimestamp;
  }

  // Check inflight status for bundles submitted within the last ~5 minutes
  public async getInflightBundleStatus(bundleId: string): Promise<{ status: string; landedSlot?: number; error?: string } | null> {
    if (!this.isEnabled()) return null;
    try {
      const res = await fetch(`${this.blockEngineUrl}/api/v1/getInflightBundleStatuses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getInflightBundleStatuses',
          params: [[bundleId]],
        }),
        signal: AbortSignal.timeout(3000),
      });

      if (res.ok) {
        const data = await res.json();
        const value = Array.isArray(data?.result?.value)
          ? data.result.value
          : Array.isArray(data?.result)
          ? data.result
          : null;

        if (value && value.length > 0) {
          const bInfo = value[0];
          if (bInfo) {
            const rawStatus = bInfo.status || 'Pending';
            if (rawStatus === 'Failed' || rawStatus === 'Invalid') {
              return {
                status: rawStatus,
                error: bInfo.err ? JSON.stringify(bInfo.err) : `Bundle ${rawStatus}`,
              };
            }
            return {
              status: rawStatus,
              landedSlot: bInfo.landed_slot || bInfo.slot,
            };
          }
        }
      }
    } catch {}
    return null;
  }

  // Check bundle confirmation status across processed / confirmed / finalized
  public async getBundleStatus(bundleId: string): Promise<{ status: string; landedSlot?: number; error?: string } | null> {
    if (!this.isEnabled()) return null;
    try {
      const res = await fetch(`${this.blockEngineUrl}/api/v1/getBundleStatuses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getBundleStatuses',
          params: [[bundleId]],
        }),
        signal: AbortSignal.timeout(3000),
      });

      if (res.ok) {
        const data = await res.json();
        const value = Array.isArray(data?.result?.value)
          ? data.result.value
          : Array.isArray(data?.result)
          ? data.result
          : null;

        if (value && value.length > 0) {
          const bInfo = value[0];
          if (bInfo) {
            if (bInfo.err) {
              return {
                status: 'Failed',
                error: JSON.stringify(bInfo.err),
              };
            }
            return {
              status: bInfo.confirmation_status || bInfo.status || 'Pending',
              landedSlot: bInfo.slot,
            };
          }
        }
      }
    } catch {}
    return null;
  }

  /** Sends the transaction as a one-transaction bundle. Fails at once with `JITO_DISABLED` when no block engine is configured. */
  public async submit(tx: VersionedTransaction): Promise<SubmitResult> {
    assertNotReadOnly('submitting a Jito bundle'); // S185: before anything is encoded or sent
    assertSendClusterAllowed(); // S206: same as the RPC transport
    const t0 = performance.now();
    if (!this.isEnabled()) {
      this.lastHealthStatus = 'NOT_CONFIGURED';
      return {
        signature: '',
        transport: 'JITO',
        success: false,
        submitDurationMs: 0,
        lifecycleState: 'SUBMIT_FAILED',
        error: 'JITO_DISABLED: no block engine URL configured',
      };
    }
    const raw = tx.serialize();
    // Modern official Jito format: Base64 encoding
    const b64Tx = Buffer.from(raw).toString('base64');
    const signature = bs58.encode(tx.signatures[0]);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(`${this.blockEngineUrl}/api/v1/bundles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendBundle',
          params: [
            [b64Tx],
            {
              encoding: 'base64',
            },
          ],
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const duration = Math.round(performance.now() - t0);
      this.lastSubmitTimestamp = Date.now();
      this.lastLatencyMs = duration;

      if (res.ok) {
        const data = await res.json();
        if (data.error) {
          this.lastHealthStatus = 'DEGRADED';
          this.lastErrorMessage = data.error.message || JSON.stringify(data.error);
          return {
            signature,
            transport: 'JITO',
            success: false,
            submitDurationMs: duration,
            lifecycleState: 'SUBMIT_FAILED',
            error: `Jito rejected bundle: ${this.lastErrorMessage}`,
          };
        }

        const bundleId = data?.result;
        this.lastHealthStatus = 'HEALTHY';
        this.lastErrorMessage = null;

        return {
          signature,
          bundleId,
          transport: 'JITO',
          success: true,
          submitDurationMs: duration,
          lifecycleState: 'SUBMITTED_TO_JITO',
        };
      } else {
        const text = await res.text();
        this.lastHealthStatus = 'DEGRADED';
        this.lastErrorMessage = `HTTP ${res.status}: ${text}`;
        return {
          signature,
          transport: 'JITO',
          success: false,
          submitDurationMs: duration,
          lifecycleState: 'SUBMIT_FAILED',
          error: `Jito Block Engine error (${res.status}): ${text}`,
        };
      }
    } catch (err: any) {
      const duration = Math.round(performance.now() - t0);
      this.lastSubmitTimestamp = Date.now();
      this.lastLatencyMs = duration;
      this.lastHealthStatus = 'OFFLINE';
      this.lastErrorMessage = err.message;

      return {
        signature,
        transport: 'JITO',
        success: false,
        submitDurationMs: duration,
        lifecycleState: 'SUBMIT_FAILED',
        error: `Jito submit exception: ${err.message}`,
      };
    }
  }

  // Bounded idempotent retry for bundle submission honoring jitoMaxRetries (R0.6)
  /** Retries `submit` up to `jitoMaxRetries` times (default 2) with `jitoRetryIntervalMs` between tries, both from `executionConfig`. Returns the last result and the attempt count. */
  public async submitWithRetry(
    tx: VersionedTransaction,
    customMaxRetries?: number,
    customRetryIntervalMs?: number
  ): Promise<SubmitResult & { attempts: number }> {
    const maxRetries = customMaxRetries !== undefined
      ? Math.max(0, customMaxRetries)
      : Math.max(0, executionConfig.getConfig().jitoMaxRetries);
    const retryIntervalMs = customRetryIntervalMs !== undefined
      ? Math.max(0, customRetryIntervalMs)
      : Math.max(0, executionConfig.getConfig().jitoRetryIntervalMs);

    let attempts = 0;
    let lastResult: SubmitResult = {
      signature: '',
      transport: 'JITO',
      success: false,
      submitDurationMs: 0,
      lifecycleState: 'SUBMIT_FAILED',
      error: 'No attempts made',
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      attempts++;
      lastResult = await this.submit(tx);
      if (lastResult.success && lastResult.signature) {
        return { ...lastResult, attempts };
      }

      // Fatal simulation errors or instruction errors should not be retried
      if (
        lastResult.error?.includes('InstructionError') ||
        lastResult.error?.includes('Transaction simulation failed')
      ) {
        break;
      }

      if (attempt < maxRetries && retryIntervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
      }
    }

    return { ...lastResult, attempts };
  }

  /** Polls bundle status (when a bundle id is given) and signature status until confirmed, failed or `maxWaitMs`. */
  public async confirm(
    signature: string,
    maxWaitMs = 25000,
    bundleId?: string
  ): Promise<ConfirmationResult> {
    const t0 = performance.now();
    const startTime = performance.now(); // monotonic: a wall clock set back cannot stretch this wait (S271 review)

    // If bundleId is present, check bundle statuses periodically
    let bundleLandedSlot: number | undefined;
    let lastPollError: string | null = null;

    while (performance.now() - startTime < maxWaitMs) {
      if (bundleId && !bundleLandedSlot) {
        // Tier 1: Check inflight status first
        const inflightInfo = await this.getInflightBundleStatus(bundleId);
        if (inflightInfo?.status === 'Failed' || inflightInfo?.status === 'Invalid') {
          return {
            signature,
            confirmed: false,
            confirmDurationMs: Math.round(performance.now() - t0),
            lifecycleState: 'REVERTED',
            error: inflightInfo.error || `Jito bundle failed inflight: ${inflightInfo.status}`,
          };
        }
        if (inflightInfo?.landedSlot) {
          bundleLandedSlot = inflightInfo.landedSlot;
        } else {
          // Tier 2: Check finalized/processed bundle status
          const bundleInfo = await this.getBundleStatus(bundleId);
          if (bundleInfo?.landedSlot) {
            bundleLandedSlot = bundleInfo.landedSlot;
          } else if (bundleInfo?.status === 'Failed' || bundleInfo?.status === 'Invalid') {
            return {
              signature,
              confirmed: false,
              confirmDurationMs: Math.round(performance.now() - t0),
              lifecycleState: 'REVERTED',
              error: bundleInfo.error || `Jito bundle failed with status: ${bundleInfo.status}`,
            };
          }
        }
      }

      // Check on-chain signature confirmation. P1.5 (R1-6, R1-80): an RPC error while polling says nothing about the transaction, so it is
      // caught here and polling goes on until the deadline (TIMED_OUT, which the caller treats as unconfirmed, never as a revert).
      let statuses: Awaited<ReturnType<Connection['getSignatureStatuses']>> | null = null;
      try {
        statuses = await this.connection.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        });
      } catch (pollErr: any) {
        lastPollError = pollErr?.message ?? String(pollErr);
      }
      const status = statuses?.value?.[0];

      if (status) {
        if (status.err) {
          return {
            signature,
            confirmed: false,
            confirmDurationMs: Math.round(performance.now() - t0),
            lifecycleState: 'REVERTED',
            error: JSON.stringify(status.err),
          };
        }

        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
          // The fee read is best effort: the transaction is confirmed whether or not its details can be read now.
          const txDetails = await this.connection.getTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          }).catch(() => null);

          return {
            signature,
            confirmed: true,
            slot: status.slot || txDetails?.slot || bundleLandedSlot,
            feeLamports: txDetails?.meta?.fee || 5000,
            confirmDurationMs: Math.round(performance.now() - t0),
            lifecycleState: 'TX_CONFIRMED',
          };
        }
      }

      await new Promise((r) => setTimeout(r, 400));
    }

    return {
      signature,
      confirmed: false,
      confirmDurationMs: Math.round(performance.now() - t0),
      lifecycleState: 'TIMED_OUT',
      error: `Bundle transaction did not confirm within ${maxWaitMs}ms limit${lastPollError ? ` (last status read failed: ${lastPollError})` : ''}`,
    };
  }
}
