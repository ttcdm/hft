import { Connection, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { Logger } from '../middleware/enterprise';
import { jitoTipFloorAllowed, resolveJitoUrl } from './clusterGuard';
import { executionConfig } from './executionConfig';

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

export interface SubmitResult {
  signature: string;
  bundleId?: string;
  transport: 'SOLANA_RPC' | 'JITO';
  success: boolean;
  submitDurationMs: number;
  lifecycleState: BundleLifecycleState;
  error?: string;
}

export interface ConfirmationResult {
  signature: string;
  confirmed: boolean;
  slot?: number;
  feeLamports?: number;
  confirmDurationMs: number;
  lifecycleState: BundleLifecycleState;
  error?: string;
}

export interface ExecutionTransport {
  submit(tx: VersionedTransaction): Promise<SubmitResult>;
  confirm(signature: string, maxWaitMs?: number, bundleId?: string): Promise<ConfirmationResult>;
}

export interface JitoHealthTelemetry {
  health: 'HEALTHY' | 'DEGRADED' | 'OFFLINE' | 'NOT_CONFIGURED';
  lastResponseMsAgo: number | null;
  lastLatencyMs: number | null;
  tipFloorLamports: number | null;
  activeTipAccount: string | null;
  lastError: string | null;
}

export class SolanaRpcTransport implements ExecutionTransport {
  private lastRequestTimestamp: number | null = null;
  private lastLatencyMs: number | null = null;

  constructor(private connection: Connection) {}

  public async submit(tx: VersionedTransaction): Promise<SubmitResult> {
    const t0 = performance.now();
    try {
      const raw = tx.serialize();
      const signature = await this.connection.sendRawTransaction(raw, {
        skipPreflight: true,
        maxRetries: 2,
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
      Logger.error(`RPC submit failed: ${err.message}`);
      return {
        signature: '',
        transport: 'SOLANA_RPC',
        success: false,
        submitDurationMs: duration,
        lifecycleState: 'SUBMIT_FAILED',
        error: err.message,
      };
    }
  }

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

  public async confirm(signature: string, maxWaitMs = 25000): Promise<ConfirmationResult> {
    const t0 = performance.now();
    const startTime = Date.now();

    try {
      // Loop with bounded timeout rather than ignoring maxWaitMs
      while (Date.now() - startTime < maxWaitMs) {
        const statuses = await this.connection.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        });
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
            const txDetails = await this.connection.getTransaction(signature, {
              maxSupportedTransactionVersion: 0,
              commitment: 'confirmed',
            });

            return {
              signature,
              confirmed: true,
              slot: status.slot || txDetails?.slot,
              feeLamports: txDetails?.meta?.fee || 5000,
              confirmDurationMs: Math.round(performance.now() - t0),
              lifecycleState: 'TX_CONFIRMED',
            };
          }
        }

        // Sleep 400ms before next polling attempt
        await new Promise((r) => setTimeout(r, 400));
      }

      return {
        signature,
        confirmed: false,
        confirmDurationMs: Math.round(performance.now() - t0),
        lifecycleState: 'TIMED_OUT',
        error: `Transaction did not confirm within ${maxWaitMs}ms limit`,
      };
    } catch (err: any) {
      return {
        signature,
        confirmed: false,
        confirmDurationMs: Math.round(performance.now() - t0),
        lifecycleState: 'REVERTED',
        error: err.message,
      };
    }
  }
}

export class JitoTransport implements ExecutionTransport {
  private blockEngineUrl: string;
  private lastSubmitTimestamp: number | null = null;
  private lastLatencyMs: number | null = null;
  private lastHealthStatus: 'HEALTHY' | 'DEGRADED' | 'OFFLINE' | 'NOT_CONFIGURED' = 'NOT_CONFIGURED';
  private lastErrorMessage: string | null = null;
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

  public async probe(): Promise<{ healthy: boolean; tipFloorLamports: number | null; latencyMs: number }> {
    const t0 = performance.now();
    if (!this.isEnabled()) {
      this.lastHealthStatus = 'NOT_CONFIGURED';
      this.lastErrorMessage = null;
      return { healthy: false, tipFloorLamports: null, latencyMs: 0 };
    }
    try {
      const tipFloor = await this.getTipFloorLamports();
      const latencyMs = Math.round(performance.now() - t0);
      this.lastHealthStatus = 'HEALTHY';
      this.lastLatencyMs = latencyMs;
      this.lastErrorMessage = null;
      return { healthy: true, tipFloorLamports: tipFloor, latencyMs };
    } catch (err: any) {
      const latencyMs = Math.round(performance.now() - t0);
      this.lastHealthStatus = 'OFFLINE';
      this.lastLatencyMs = latencyMs;
      this.lastErrorMessage = err.message;
      return { healthy: false, tipFloorLamports: null, latencyMs };
    }
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

  public async submit(tx: VersionedTransaction): Promise<SubmitResult> {
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

  public async confirm(
    signature: string,
    maxWaitMs = 25000,
    bundleId?: string
  ): Promise<ConfirmationResult> {
    const t0 = performance.now();
    const startTime = Date.now();

    // If bundleId is present, check bundle statuses periodically
    let bundleLandedSlot: number | undefined;

    while (Date.now() - startTime < maxWaitMs) {
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

      // Check on-chain signature confirmation
      const statuses = await this.connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });
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
          const txDetails = await this.connection.getTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          });

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
      error: `Bundle transaction did not confirm within ${maxWaitMs}ms limit`,
    };
  }
}
