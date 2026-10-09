import { solPriceService } from '../market/solPriceService';
import dotenv from 'dotenv';
dotenv.config();
import { Connection, PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createCloseAccountInstruction } from '@solana/spl-token';
import {
  ExecutionMode,
  NormalizedPosition,
  SystemDiagnostics,
  OperatorAlert,
  ExecutionLifecycleState,
  DataSource,
  SignalProvenance,
  TokenEligibilityReport,
  LiveReadiness,
  isLiveApprovedProvenance,
} from '../core/types';
/** C4: a mark older than this is not trusted for exits; the position is re-read directly first. */
export const MARK_STALE_MS = 15_000;
/** C4: if a direct read still fails after this long, raise an operator alert. */
export const MARK_ALERT_AFTER_MS = 60_000;
import { EligibilityFilter } from '../signals/eligibilityFilter';
import { localSigner } from '../solana/signer';
import { txBuilder, SolanaTransactionBuilder, PumpBuyParams, PumpSellParams } from '../solana/transactionBuilder';
import { SolanaRpcTransport, JitoTransport } from '../solana/transports';
import { riskEngine, estimateRoundTripCostLamports, MAX_ROUND_TRIP_COST_FRACTION } from '../risk/riskEngine';
import { paperEngine, PaperExecutionEngine } from './paperEngine';
import { workstationDb } from '../db/database';
import { getRandomJitoTipAccount, TOKEN_2022_PROGRAM_ID } from '../solana/programs';
import { executionConfig } from '../solana/executionConfig';
import { Logger } from '../middleware/enterprise';
import { assertClusterAllowed, resolveRpcUrl } from '../solana/clusterGuard';
import { PumpCurveService, TradeQuote, fetchTokenHolderDistribution } from '../solana/pumpCurve';
import { TradeReconciler, RealMarkPriceService, PreTradeSnapshot } from './reconciliation';
export type { PreTradeSnapshot };
import { CapitalSizer } from '../capital/capitalSizer';
import { ExitEngine } from '../exits/exitEngine';

export interface ExecuteTradeRequest {
  mint: string;
  symbol: string;
  name: string;
  amountSol: number;
  currentPriceSol?: number;
  slippageBps?: number;
  jitoTipSol?: number;
  source: 'MANUAL' | 'AUTO_SNIPER' | 'TELEGRAM_BOT' | 'HOT_CALLOUT' | 'COPY_TRADE' | 'SOCIAL_SCANNER';
  provenance: SignalProvenance;
  eligibilityReport?: TokenEligibilityReport;
  liquidityUsd?: number;
  signalTimestamp?: number;
  marketDataTimestamp?: number;
  executionMode?: ExecutionMode;
}

export interface ExecutionResponse {
  success: boolean;
  lifecycleState: ExecutionLifecycleState;
  positionId?: string;
  signature?: string;
  txSignature?: string;
  bundleId?: string;
  fillPriceSol?: number;
  tokensReceived?: number;
  executionMode: ExecutionMode;
  feesPaidLamports?: number;
  error?: string;
  /** Which gates a PAPER fill passed (C5). */
  gates?: Record<string, unknown>;
  correlationId: string;
}

export class ExecutionCoordinator {
  private executionMode: ExecutionMode = 'PAPER';
  private isLiveTradingArmed: boolean = false;
  private inFlightReservedSol: number = 0;
  private inFlightPositionExits: Set<string> = new Set<string>();
  private inFlightBuyMints: Set<string> = new Set<string>();
  private connection: Connection;
  private rpcEndpoint: string;
  private rpcLatencyMs: number = 0;
  private rpcHealth: 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED' = 'DISCONNECTED';
  private pumpFeedHealth: 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED' = 'DISCONNECTED';
  private lastPumpFeedTimestamp: number = 0;
  private readonly startedAt: number = Date.now();
  private readonly startupGracePeriodMs: number = parseInt(process.env.STARTUP_GRACE_PERIOD_MS || '300000', 10); // 5-minute initialization grace period (B02)
  private positionMarkHealth: 'HEALTHY' | 'DEGRADED' | 'STALE' = 'HEALTHY';
  private lastPositionMarkTimestamp: number = 0;
  private realWalletBalanceSol: number | null = null;
  private lastRpcSyncTimestamp: number = 0;
  private jitoTransport: JitoTransport;
  private rpcTransport: SolanaRpcTransport;
  private lastMarketEventTimestamp: number = 0;
  private lastRealMarketEventTimestamp: number = 0;
  private lastSyntheticMarketEventTimestamp: number = 0;
  private autoTpSlInterval: NodeJS.Timeout | null = null;
  private feedHeartbeatInterval: NodeJS.Timeout | null = null;
  private jitoProbeInterval: NodeJS.Timeout | null = null;
  private lastStartupReconciliation: {
    status: 'EXECUTION_READY' | 'RECONCILIATION_MISMATCH' | 'SIGNER_LOCKED' | 'OFFLINE';
    checkedAt: number;
    details: string;
  } | null = null;

  private readonly isDefaultSingleton: boolean;

  constructor(connectionOrIsSingleton: Connection | boolean = false, isDefaultSingleton: boolean = false) {
    const isConn = Boolean(
      connectionOrIsSingleton &&
      typeof connectionOrIsSingleton === 'object' &&
      ('getSlot' in connectionOrIsSingleton || (connectionOrIsSingleton as any) instanceof Connection)
    );
    if (isConn) {
      this.isDefaultSingleton = Boolean(isDefaultSingleton);
      this.connection = connectionOrIsSingleton as Connection;
      this.rpcEndpoint = (connectionOrIsSingleton as any)._rpcEndpoint || resolveRpcUrl();
    } else {
      this.isDefaultSingleton = Boolean(connectionOrIsSingleton);
      this.rpcEndpoint = resolveRpcUrl();
      this.connection = new Connection(this.rpcEndpoint, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 30000,
      });
    }
    this.jitoTransport = new JitoTransport(this.connection);
    this.rpcTransport = new SolanaRpcTransport(this.connection);
    this.initializeConnection();
    this.startAutoPositionMonitor();
    this.startMarketFeedHeartbeat();
  }

  private startMarketFeedHeartbeat() {
    const checkFeed = async () => {
      try {
        const t0 = performance.now();
        const slot = await this.connection.getSlot('processed');
        const latency = Math.round(performance.now() - t0);
        if (slot > 0) {
          this.recordRpcHeartbeat(slot, latency);
        }
      } catch {
        this.rpcHealth = 'DISCONNECTED';
      }

      // Check pump feed freshness (strategy-critical Pump.fun stream)
      const now = Date.now();
      const pumpAge = this.lastPumpFeedTimestamp > 0 ? now - this.lastPumpFeedTimestamp : Infinity;
      if (pumpAge > 120000) {
        this.pumpFeedHealth = 'DISCONNECTED';
      } else if (pumpAge > 45000) {
        this.pumpFeedHealth = 'DEGRADED';
      } else {
        this.pumpFeedHealth = 'HEALTHY';
      }

      // Check position mark freshness
      const markAge = this.lastPositionMarkTimestamp > 0 ? now - this.lastPositionMarkTimestamp : 0;
      if (markAge > 90000) {
        this.positionMarkHealth = 'STALE';
      } else if (markAge > 45000) {
        this.positionMarkHealth = 'DEGRADED';
      } else {
        this.positionMarkHealth = 'HEALTHY';
      }
    };
    checkFeed();
    this.feedHeartbeatInterval = setInterval(checkFeed, 10000);
  }

  /** Re-probe the block engine on an interval so readiness reflects current health, not boot-time health. */
  private startJitoProbeLoop() {
    if (this.jitoProbeInterval || !this.jitoTransport.isEnabled()) return;
    const intervalMs = Math.max(1000, executionConfig.getConfig().jitoProbeIntervalMs);
    this.jitoProbeInterval = setInterval(() => {
      if (this.jitoTransport.isEnabled()) void this.jitoTransport.probe();
    }, intervalMs);
  }

  private async initializeConnection() {
    try {
      const t0 = performance.now();
      const slot = await this.connection.getSlot('processed');
      this.rpcLatencyMs = Math.round(performance.now() - t0);
      this.rpcHealth = this.rpcLatencyMs > 800 ? 'DEGRADED' : 'HEALTHY';
      Logger.info(`Solana RPC connected: Slot ${slot}, Latency ${this.rpcLatencyMs}ms`);
      await this.jitoTransport.probe();
      this.startJitoProbeLoop();
      await this.syncRealWalletBalance();
      await this.startupReconciliation();
    } catch (err: any) {
      this.rpcHealth = 'DISCONNECTED';
      Logger.warn(`Solana RPC connection failed: ${err.message}. Operating in safe paper/offline mode.`);
    }
  }

  public getConnection(): Connection {
    return this.connection;
  }

  // Explicit LiveReadiness object with independent health tracking across all critical subsystems (R0.12)
  public getLiveReadiness(): LiveReadiness {
    const reasons: string[] = [];
    const now = Date.now();

    if (process.env.ALLOW_LIVE_REAL_MONEY_TRADING !== 'true') {
      reasons.push('Live real-money trading is disabled by environment policy (ALLOW_LIVE_REAL_MONEY_TRADING !== "true")');
    }

    const signerStatus = localSigner.getStatus();
    const signerHealthy = signerStatus === 'READY';
    if (!signerHealthy) {
      reasons.push(`Signer status is ${signerStatus} (Ed25519 keypair must be configured and ready)`);
    }

    if (this.realWalletBalanceSol === null || this.realWalletBalanceSol <= 0.015) {
      reasons.push(
        `Insufficient spendable wallet balance (${this.realWalletBalanceSol ?? 0} SOL, minimum 0.015 SOL reserve required)`
      );
    }

    const dbHealthy = workstationDb.isWritable();
    if (!dbHealthy) {
      reasons.push('Workstation SQLite database is not writable');
    }

    if (!this.lastStartupReconciliation || this.lastStartupReconciliation.status !== 'EXECUTION_READY') {
      reasons.push(
        this.lastStartupReconciliation
          ? `Startup reconciliation has unresolved issues: ${this.lastStartupReconciliation.details}`
          : 'Startup reconciliation is in progress or has not completed'
      );
    }

    const rpcHealthy = this.rpcHealth === 'HEALTHY';
    if (!rpcHealthy) {
      reasons.push(`Solana RPC health is ${this.rpcHealth} (Must be HEALTHY)`);
    }

    const inGracePeriod = now - this.startedAt < this.startupGracePeriodMs;
    const pumpFeedAgeMs = this.lastPumpFeedTimestamp > 0 ? now - this.lastPumpFeedTimestamp : Infinity;
    const isPumpFeedWarmingUp = this.isDefaultSingleton && this.lastPumpFeedTimestamp === 0 && inGracePeriod;
    const pumpFeedStatus: 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED' | 'WARMING_UP' = isPumpFeedWarmingUp
      ? 'WARMING_UP'
      : this.pumpFeedHealth;
    const pumpFeedHealthy = (this.pumpFeedHealth === 'HEALTHY' && pumpFeedAgeMs <= 120000) || isPumpFeedWarmingUp;

    if (!pumpFeedHealthy) {
      const feedAgeSec = this.lastPumpFeedTimestamp > 0 ? Math.round(pumpFeedAgeMs / 1000) : null;
      reasons.push(
        `Pump.fun real event stream is ${this.pumpFeedHealth} (${feedAgeSec !== null ? `${feedAgeSec}s ago` : 'never received'})`
      );
    }

    const markAgeMs = this.lastPositionMarkTimestamp > 0 ? now - this.lastPositionMarkTimestamp : Infinity;
    const markFeedHealthy = this.positionMarkHealth === 'HEALTHY' && (this.lastPositionMarkTimestamp === 0 || markAgeMs <= 120000);
    if (!markFeedHealthy || this.positionMarkHealth === 'STALE') {
      reasons.push(
        `Position mark feed is ${this.positionMarkHealth} (${markAgeMs === Infinity ? 'never marked' : `${Math.round(markAgeMs / 1000)}s ago`})`
      );
    }

    if (riskEngine.isKillSwitchActive()) {
      reasons.push('Emergency risk kill switch is active');
    }

    if (riskEngine.getCircuitBreakerState() !== 'CLOSED') {
      reasons.push(`Risk circuit breaker is tripped (${riskEngine.getCircuitBreakerState()})`);
    }

    const jitoTelemetry = this.jitoTransport.getTelemetry();
    const jitoReadiness = this.getJitoReadiness();
    const jitoHealthy = jitoReadiness.ready;
    if (!jitoHealthy && jitoReadiness.reason) {
      reasons.push(jitoReadiness.reason);
    }

    const realFeedAgeMs = this.lastRealMarketEventTimestamp > 0
      ? now - this.lastRealMarketEventTimestamp
      : Infinity;
    const isRealMarketWarmingUp = this.lastRealMarketEventTimestamp === 0 && inGracePeriod;
    if (realFeedAgeMs > 120000 && !isRealMarketWarmingUp) {
      reasons.push(
        `Real on-chain market feed has no recent events (${
          realFeedAgeMs === Infinity ? 'never received' : Math.round(realFeedAgeMs / 1000) + 's ago'
        })`
      );
    }

    return {
      ready: reasons.length === 0,
      reasons,
      components: {
        rpc: {
          healthy: rpcHealthy,
          latencyMs: this.rpcLatencyMs,
          status: this.rpcHealth,
        },
        pumpFeed: {
          healthy: pumpFeedHealthy,
          lastEventAgeMs: pumpFeedAgeMs === Infinity ? -1 : pumpFeedAgeMs,
          status: pumpFeedStatus,
        },
        markFeed: {
          healthy: markFeedHealthy,
          lastMarkAgeMs: markAgeMs === Infinity ? -1 : markAgeMs,
          status: this.positionMarkHealth,
        },
        jito: {
          healthy: jitoHealthy,
          status: jitoTelemetry.health,
        },
        db: {
          healthy: dbHealthy,
          status: dbHealthy ? 'HEALTHY' : 'ERROR',
        },
        signer: {
          healthy: signerHealthy,
          status: signerStatus,
        },
      },
      checkedAt: now,
    };
  }

  // Authoritative fail-closed evaluation of all live trading prerequisites
  public canExecuteLive(): { allowed: boolean; reasons: string[]; readiness: LiveReadiness } {
    const readiness = this.getLiveReadiness();
    return {
      allowed: readiness.ready,
      reasons: readiness.reasons,
      readiness,
    };
  }

  // Update RPC endpoint with safe re-instantiation
  public async setRpcEndpoint(newEndpoint: string): Promise<{ success: boolean; latencyMs: number; error?: string }> {
    try {
      const newConn = new Connection(newEndpoint, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 30000,
      });
      const t0 = performance.now();
      await newConn.getSlot('processed');
      const latency = Math.round(performance.now() - t0);

      this.rpcEndpoint = newEndpoint;
      this.connection = newConn;
      this.rpcLatencyMs = latency;
      this.rpcHealth = latency > 800 ? 'DEGRADED' : 'HEALTHY';
      this.jitoTransport = new JitoTransport(this.connection);
      this.rpcTransport = new SolanaRpcTransport(this.connection);

      Logger.info(`Switched Solana RPC endpoint to ${newEndpoint} (${latency}ms)`);
      await this.syncRealWalletBalance();
      return { success: true, latencyMs: latency };
    } catch (err: any) {
      Logger.error(`Failed to switch RPC endpoint: ${err.message}`);
      return { success: false, latencyMs: 0, error: err.message };
    }
  }

  // Update Jito Block Engine URL
  public setJitoBlockEngineUrl(url: string) {
    this.jitoTransport.setBlockEngineUrl(url);
    Logger.info(`Updated Jito Block Engine URL to ${url}`);
  }

  /**
   * Jito readiness for live execution. With no block engine configured (devnet), RPC is the only transport
   * and there is nothing to be healthy, so it is not a blocker. With a block engine configured it must be
   * HEALTHY from a recent real probe, otherwise live execution fails closed.
   */
  public getJitoReadiness(): { ready: boolean; enabled: boolean; status: string; reason?: string } {
    const telemetry = this.jitoTransport.getTelemetry();
    if (!this.jitoTransport.isEnabled()) {
      return { ready: true, enabled: false, status: 'NOT_CONFIGURED' };
    }
    const maxProbeAgeMs = Math.max(45_000, executionConfig.getConfig().jitoProbeIntervalMs * 3);
    const probeAgeMs = this.jitoTransport.getProbeAgeMs();
    if (telemetry.health !== 'HEALTHY') {
      return { ready: false, enabled: true, status: telemetry.health, reason: `Jito Block Engine is ${telemetry.health} (Must be HEALTHY for live execution)` };
    }
    if (probeAgeMs === null || probeAgeMs > maxProbeAgeMs) {
      return { ready: false, enabled: true, status: 'STALE', reason: 'Jito Block Engine health probe is stale (Must be HEALTHY for live execution)' };
    }
    return { ready: true, enabled: true, status: 'HEALTHY' };
  }

  /** Dynamic tip, forced to zero when Jito is not in use so no lamports are sent to a tip account. */
  private resolveLiveTip(params: Parameters<typeof executionConfig.resolveDynamicJitoTip>[0]) {
    const tip = executionConfig.resolveDynamicJitoTip(params);
    if (this.jitoTransport.isEnabled()) return tip;
    return { ...tip, tipLamports: 0, tipSol: 0, policyReason: `${tip.policyReason} -> Jito disabled, tip forced to 0 (RPC transport)` };
  }

  public getJitoTransport(): JitoTransport {
    return this.jitoTransport;
  }

  public setJitoTransport(transport: JitoTransport) {
    this.jitoTransport = transport;
  }

  public getRpcTransport(): SolanaRpcTransport {
    return this.rpcTransport;
  }

  public setRpcTransport(transport: SolanaRpcTransport) {
    this.rpcTransport = transport;
  }

  public setConnection(conn: Connection) {
    this.connection = conn;
    this.jitoTransport = new JitoTransport(this.connection);
    this.rpcTransport = new SolanaRpcTransport(this.connection);
  }

  // Provenance separation: Record verified on-chain RPC / market events
  public recordRealMarketEvent(source = 'SOLANA_RPC') {
    const now = Date.now();
    this.lastRealMarketEventTimestamp = now;
    this.lastMarketEventTimestamp = now;
  }

  public recordPumpFeedEvent(source = 'PUMPFUN_STREAM', mint?: string) {
    const now = Date.now();
    this.lastPumpFeedTimestamp = now;
    this.pumpFeedHealth = 'HEALTHY';
    this.lastRealMarketEventTimestamp = now;
    this.lastMarketEventTimestamp = now;
  }

  public recordRpcHeartbeat(slot: number, latencyMs: number) {
    this.rpcLatencyMs = latencyMs;
    this.rpcHealth = latencyMs > 800 ? 'DEGRADED' : 'HEALTHY';
  }

  public recordPositionMarkEvent() {
    this.lastPositionMarkTimestamp = Date.now();
    this.positionMarkHealth = 'HEALTHY';
  }

  public getStartedAt(): number {
    return this.startedAt;
  }

  public getStartupGracePeriodMs(): number {
    return this.startupGracePeriodMs;
  }

  public getLastPumpFeedTimestamp(): number {
    return this.lastPumpFeedTimestamp;
  }

  // Record synthetic simulator events for UI visualizers without polluting real market freshness
  public recordSyntheticMarketEvent(source = 'SIMULATOR') {
    this.lastSyntheticMarketEventTimestamp = Date.now();
  }

  // Legacy fallback: route to synthetic to prevent spoofing live prerequisites
  public recordMarketEvent() {
    this.recordSyntheticMarketEvent('LEGACY_DISPATCH');
  }

  // Startup Reconciliation checking database, on-chain balances, and transport health
  public async startupReconciliation(): Promise<{
    status: 'EXECUTION_READY' | 'RECONCILIATION_MISMATCH' | 'SIGNER_LOCKED' | 'OFFLINE';
    mismatchesCount: number;
    details: string;
  }> {
    const now = Date.now();
    let mismatchesCount = 0;
    const issues: string[] = [];

    // 1. Check signer status
    const signerStatus = localSigner.getStatus();
    if (signerStatus !== 'READY') {
      issues.push(`Signer status is ${signerStatus}`);
    }

    // 2. Query real wallet SOL
    await this.syncRealWalletBalance();

    // 3. Verify ALL active LIVE positions (OPEN and PARTIALLY_CLOSED) against on-chain token accounts
    if (signerStatus === 'READY') {
      const walletPubkey = localSigner.getPublicKey();
      const activeLivePositions = workstationDb.loadPositions('LIVE', 'ACTIVE');

      for (const pos of activeLivePositions) {
        try {
          const mintPubkey = new PublicKey(pos.mint);
          // Query ATA balance using position's actual token program (supports Token-2022 & standard SPL)
          const tokenProgramId = pos.baseTokenProgram ? new PublicKey(pos.baseTokenProgram) : undefined;
          const ata = PumpCurveService.getAssociatedTokenAddress(mintPubkey, walletPubkey, tokenProgramId);
          const balRes = await this.connection.getTokenAccountBalance(ata, 'confirmed').catch(() => null);
          const onChainAmount = balRes?.value?.amount ? BigInt(balRes.value.amount) : 0n;

          if (onChainAmount <= 0n) {
            mismatchesCount++;
            issues.push(
              `Position ${pos.symbol} (${pos.mint.slice(0, 6)}...) recorded active in DB, but on-chain balance is 0`
            );
            // Flag position with reconciliation warning
            pos.exitReason = 'RECONCILIATION_MISMATCH: Zero on-chain token balance';
            workstationDb.savePosition(pos);
          }
        } catch (e: any) {
          issues.push(`Failed to verify on-chain balance for ${pos.symbol}: ${e.message}`);
        }
      }
    }

    // 4. Resolve pending transactions from previous runs with actual on-chain transaction verification
    const pendingTxs = workstationDb.getPendingTransactions();
    if (pendingTxs.length > 0) {
      Logger.info(`Found ${pendingTxs.length} pending transactions from previous session to reconcile.`);
      const walletPubkey = signerStatus === 'READY' ? localSigner.getPublicKey() : null;

      for (const pTx of pendingTxs) {
        try {
          const txStatus = await this.connection.getSignatureStatuses([pTx.signature], {
            searchTransactionHistory: true,
          });
          const status = txStatus?.value?.[0];

          if (status?.err) {
            pTx.reconciliationState = 'REVERTED';
            pTx.error = JSON.stringify(status.err);
            workstationDb.saveTransaction(pTx);
          } else if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
            // Actually inspect transaction details, fees, and landing slot
            const txDetails = await this.connection.getTransaction(pTx.signature, {
              maxSupportedTransactionVersion: 0,
              commitment: 'confirmed',
            });

            if (txDetails?.meta?.err) {
              pTx.reconciliationState = 'REVERTED';
              pTx.error = JSON.stringify(txDetails.meta.err);
            } else if (txDetails) {
              pTx.landingSlot = txDetails.slot;
              pTx.networkFeeLamports = txDetails.meta?.fee || 5000;
              pTx.confirmationTime = txDetails.blockTime ? txDetails.blockTime * 1000 : Date.now();

              const existingPos = workstationDb
                .loadPositions()
                .find((p) => (pTx.direction === 'SELL' ? p.exitTxSignature === pTx.signature : p.entryTxSignature === pTx.signature));

              if (existingPos) {
                pTx.reconciliationState = 'RECONCILED';
              } else if (walletPubkey) {
                // Recover interrupted transaction directly from confirmed on-chain data
                const recovery = await TradeReconciler.recoverInterruptedTransaction(
                  this.connection,
                  pTx.signature,
                  walletPubkey
                );

                if (recovery.recovered && recovery.mint) {
                  if (recovery.type === 'BUY' && recovery.tokenQuantityRaw) {
                    const tokenQty = Number(recovery.tokenQuantityRaw) / Math.pow(10, recovery.tokenDecimals ?? 6);
                    const effectivePrice =
                      (recovery.solSpentLamports ?? 0) > 0 && tokenQty > 0
                        ? ((recovery.solSpentLamports ?? 0) / 1e9) / tokenQty
                        : 0;

                    const recoveredPos: NormalizedPosition = {
                      id: pTx.signature,
                      mint: recovery.mint,
                      symbol: pTx.mint ? pTx.mint.slice(0, 5).toUpperCase() : recovery.mint.slice(0, 5).toUpperCase(),
                      name: `Recovered ${recovery.mint.slice(0, 4)}...${recovery.mint.slice(-4)}`,
                      tokenDecimals: recovery.tokenDecimals ?? 6,
                      baseTokenProgram: recovery.baseTokenProgram,
                      tokenQuantityRaw: recovery.tokenQuantityRaw,
                      costBasisLamports: recovery.solSpentLamports ?? 0,
                      entryPriceSol: effectivePrice,
                      currentPriceSol: effectivePrice,
                      currentValueSol: (recovery.solSpentLamports ?? 0) / 1e9,
                      unrealizedPnLSol: 0,
                      unrealizedPnLPct: 0,
                      realizedPnLSol: 0,
                      entryTxSignature: pTx.signature,
                      entrySlot: recovery.slot ?? txDetails.slot,
                      entryTimestamp: recovery.blockTime ?? Date.now(),
                      entryFeeLamports: recovery.networkFeeLamports ?? 5000,
                      priorityFeeLamports: 0,
                      jitoTipLamports: pTx.jitoTipLamports,
                      markSource: 'RECONCILED_ON_CHAIN',
                      markAgeMs: 0,
                      executionMode: pTx.executionMode,
                      status: 'OPEN',
                      lastUpdatedTimestamp: Date.now(),
                    };
                    workstationDb.savePosition(recoveredPos);
                    pTx.reconciliationState = 'RECONCILED';
                    Logger.info(`Successfully recovered interrupted BUY position for ${recovery.mint} (${pTx.signature})`);
                  } else if (recovery.type === 'SELL') {
                    const targetPos = workstationDb
                      .loadPositions()
                      .find((p) => p.mint === recovery.mint && (p.status === 'OPEN' || p.status === 'PARTIALLY_CLOSED'));
                    if (targetPos) {
                      const remainingTokens = BigInt(recovery.remainingTokensRaw ?? '0');
                      const tokensSold = BigInt(recovery.tokensSoldRaw ?? '0');
                      const totalTokensBefore = BigInt(recovery.tokenBeforeRaw ?? targetPos.tokenQuantityRaw);
                      const sellFraction = totalTokensBefore > 0n ? Number(tokensSold) / Number(totalTokensBefore) : 1;
                      const costPortionLamports = Math.round(targetPos.costBasisLamports * sellFraction);
                      const netProceedsLamports = recovery.solReceivedLamports ?? 0;
                      const realizedPnLSol = (netProceedsLamports - costPortionLamports) / 1e9;

                      if (remainingTokens > 0n) {
                        targetPos.status = 'PARTIALLY_CLOSED';
                        targetPos.tokenQuantityRaw = remainingTokens.toString();
                        targetPos.costBasisLamports = Math.max(0, targetPos.costBasisLamports - costPortionLamports);
                        targetPos.realizedPnLSol = (targetPos.realizedPnLSol ?? 0) + realizedPnLSol;
                      } else {
                        targetPos.status = 'CLOSED';
                        targetPos.tokenQuantityRaw = '0';
                        targetPos.costBasisLamports = 0;
                        targetPos.realizedPnLSol = (targetPos.realizedPnLSol ?? 0) + realizedPnLSol;
                      }

                      targetPos.exitTxSignature = pTx.signature;
                      targetPos.exitTimestamp = recovery.blockTime ?? Date.now();
                      targetPos.exitSlot = recovery.slot ?? txDetails.slot;
                      targetPos.lastUpdatedTimestamp = Date.now();
                      workstationDb.savePosition(targetPos);
                      pTx.reconciliationState = 'RECONCILED';
                      Logger.info(`Successfully recovered interrupted SELL trade for ${recovery.mint} (${pTx.signature})`);
                    } else {
                      pTx.reconciliationState = 'RECONCILIATION_REQUIRED';
                      mismatchesCount++;
                      issues.push(`SELL transaction ${pTx.signature.slice(0, 8)}... confirmed but could not match open position in database`);
                    }
                  }
                }
 else {
                  pTx.reconciliationState = 'RECONCILIATION_REQUIRED';
                  mismatchesCount++;
                  issues.push(`Transaction ${pTx.signature.slice(0, 8)}... confirmed but could not reconstruct position`);
                }
              } else {
                pTx.reconciliationState = 'RECONCILIATION_REQUIRED';
                mismatchesCount++;
                issues.push(`Transaction ${pTx.signature.slice(0, 8)}... confirmed but missing position record`);
              }
            }
            workstationDb.saveTransaction(pTx);
          } else if (Date.now() - pTx.submissionTime > 120000) {
            pTx.reconciliationState = 'TIMED_OUT';
            workstationDb.saveTransaction(pTx);
          }
        } catch (err: any) {
          Logger.warn(`Failed to reconcile pending transaction ${pTx.signature}: ${err.message}`);
        }
      }
    }

    let status: 'EXECUTION_READY' | 'RECONCILIATION_MISMATCH' | 'SIGNER_LOCKED' | 'OFFLINE';
    if (this.rpcHealth === 'DISCONNECTED') {
      status = 'OFFLINE';
    } else if (signerStatus !== 'READY') {
      status = 'SIGNER_LOCKED';
    } else if (mismatchesCount > 0) {
      status = 'RECONCILIATION_MISMATCH';
    } else {
      status = 'EXECUTION_READY';
    }

    const details = issues.length > 0 ? issues.join('; ') : 'All on-chain state reconciled. Systems verified.';
    this.lastStartupReconciliation = { status, checkedAt: now, details };

    Logger.info(`Startup Reconciliation result: ${status} (${details})`);
    return { status, mismatchesCount, details };
  }

  public async syncRealWalletBalance(): Promise<number | null> {
    try {
      if (localSigner.getStatus() !== 'READY') {
        this.realWalletBalanceSol = null;
        return null;
      }
      const pubkey = localSigner.getPublicKey();
      const lamports = await this.connection.getBalance(pubkey, 'confirmed');
      this.realWalletBalanceSol = Number((lamports / 1e9).toFixed(5));
      this.lastRpcSyncTimestamp = Date.now();
      riskEngine.recordRpcSuccess();
      return this.realWalletBalanceSol;
    } catch (err: any) {
      Logger.warn(`Wallet balance sync failed: ${err.message}`);
      this.realWalletBalanceSol = null;
      const tripped = riskEngine.recordRpcFailure();
      if (tripped && this.isLiveTradingArmed) {
        this.armLiveTrading(false);
      }
      return null;
    }
  }

  public getExecutionMode(): ExecutionMode {
    return this.executionMode;
  }

  public getRealWalletBalanceSol(): number | null {
    return this.realWalletBalanceSol;
  }

  public getSpendableBankrollSol(): number {
    const raw = this.realWalletBalanceSol ?? 0;
    return CapitalSizer.calculateSpendableBankroll(raw, 0.015, this.inFlightReservedSol);
  }

  public isLiveArmed(): boolean {
    return this.isLiveTradingArmed;
  }

  public armLiveTrading(arm: boolean, confirmationCode?: string): { success: boolean; message: string; reasons?: string[] } {
    if (arm) {
      if (confirmationCode !== 'CONFIRM_LIVE_TRADING_RISK') {
        return { success: false, message: 'Invalid confirmation code. Live trading arming rejected.' };
      }
      if (process.env.ALLOW_LIVE_REAL_MONEY_TRADING !== 'true') {
        return {
          success: false,
          message: 'REAL_MONEY_PROHIBITED: Live real-money trading is disabled by environment policy (ALLOW_LIVE_REAL_MONEY_TRADING !== "true").',
          reasons: ['ALLOW_LIVE_REAL_MONEY_TRADING !== "true"'],
        };
      }
      const check = this.canExecuteLive();
      if (!check.allowed) {
        return {
          success: false,
          message: `Cannot arm live trading. Prerequisites failed: ${check.reasons.join('; ')}`,
          reasons: check.reasons,
        };
      }
      this.isLiveTradingArmed = true;
      this.executionMode = 'LIVE';
      const isWarmingUp = check.readiness.components.pumpFeed.status === 'WARMING_UP';
      if (isWarmingUp) {
        Logger.warn('*** LIVE TRADING HAS BEEN ARMED (FEEDS WARMING UP) *** Real Solana transactions will be broadcast once events arrive.');
        return {
          success: true,
          message: 'Live trading armed successfully during startup grace period (feeds warming up). Transactions will be broadcast on Solana.',
        };
      }
      Logger.warn('*** LIVE TRADING HAS BEEN ARMED *** Real Solana transactions will be broadcast.');
      return { success: true, message: 'Live trading armed successfully. Transactions will be broadcast on Solana.' };
    } else {
      this.isLiveTradingArmed = false;
      this.executionMode = 'PAPER';
      Logger.info('Live trading disarmed. Switched to PAPER mode.');
      return { success: true, message: 'Trading disarmed. System is operating in PAPER mode.' };
    }
  }

  public getPositions(mode?: ExecutionMode, status?: 'OPEN' | 'PARTIALLY_CLOSED' | 'CLOSED' | 'ACTIVE'): NormalizedPosition[] {
    return workstationDb.loadPositions(mode, status);
  }

  // Update real mark prices for active positions without random walk
  public async updatePositionMarkPrices(priceMap?: Record<string, { priceSol: number; source: string }>) {
    const positions = workstationDb.loadPositions(undefined, 'ACTIVE');
    if (positions.length === 0) return;

    const now = Date.now();

    // 1. If explicit price map provided, use it ONLY for non-LIVE positions
    if (priceMap && Object.keys(priceMap).length > 0) {
      for (const pos of positions) {
        if (pos.executionMode === 'LIVE') continue; // LIVE NEVER accepts synthetic marks
        const entry = priceMap[pos.mint];
        if (entry && entry.priceSol > 0) {
          this.applyMarkPrice(pos, entry.priceSol, entry.source, now);
        }
      }
    }

    // 2. Query on-chain bonding curve marks for active positions
    const mints = positions.map((p) => p.mint);
    try {
      const hasLivePositions = positions.some((p) => p.executionMode === 'LIVE');
      const onChainMarks = await RealMarkPriceService.queryOnChainMarkPrices(
        this.connection,
        mints,
        hasLivePositions ? 'LIVE' : 'PAPER'
      );
      if (Object.keys(onChainMarks).length > 0) {
        this.recordRealMarketEvent('BONDING_CURVE_RPC');
      }

      for (const pos of positions) {
        const mark = onChainMarks[pos.mint];
        if (mark && mark.priceSol > 0) {
          this.applyMarkPrice(pos, mark.priceSol, mark.source, mark.timestamp, mark.poolAddress);
        } else if (!priceMap || !priceMap[pos.mint]) {
          // Mark age increases honestly
          const baseTimestamp = pos.lastMarkTimestamp || pos.lastUpdatedTimestamp;
          pos.markAgeMs = now - baseTimestamp;
          workstationDb.savePosition(pos);
        }
      }
    } catch (err: any) {
      Logger.debug(`Failed on-chain mark refresh: ${err.message}`);
    }
  }

  private applyMarkPrice(pos: NormalizedPosition, priceSol: number, source: string, timestamp: number, poolAddress?: string) {
    pos.currentPriceSol = priceSol;
    const tokenQty = Number(pos.tokenQuantityRaw) / Math.pow(10, pos.tokenDecimals);
    pos.currentValueSol = Number((tokenQty * priceSol).toFixed(6));
    pos.unrealizedPnLSol = Number((pos.currentValueSol - pos.costBasisLamports / 1e9).toFixed(6));
    pos.unrealizedPnLPct =
      pos.costBasisLamports > 0
        ? Number(((pos.unrealizedPnLSol / (pos.costBasisLamports / 1e9)) * 100).toFixed(2))
        : 0;
    pos.lastMarkTimestamp = timestamp;
    pos.markAgeMs = Math.max(0, Date.now() - timestamp);
    pos.markSource = source as DataSource;
    pos.highWaterMarkSol = Math.max(pos.highWaterMarkSol ?? 0, priceSol);

    // R0.4: If on-chain mark resolves to canonical PumpSwap pool, transition position to PUMPSWAP
    if (source === 'ON_CHAIN_PUMPSWAP_POOL' || pos.venue === 'PUMPSWAP') {
      if (pos.venue !== 'PUMPSWAP') {
        Logger.info(`[R0.4] Position ${pos.symbol || pos.mint} curve completed. Migrating to canonical PumpSwap pool.`);
        pos.venue = 'PUMPSWAP';
        pos.migrationTimestamp = pos.migrationTimestamp || Date.now();
      }
      if (poolAddress) {
        pos.poolAddress = poolAddress;
      }
    }

    pos.lastUpdatedTimestamp = Date.now();
    workstationDb.savePosition(pos);
  }

  // Pre-retry and pre-fallback on-chain and database verification (R0.6)
  public async checkIfTransactionLanded(
    signature: string,
    bundleId: string | undefined,
    owner: PublicKey,
    mintPubkey: PublicKey,
    tokenProgram: PublicKey,
    preSnapshot: PreTradeSnapshot,
    side: 'BUY' | 'SELL',
    orderId?: string
  ): Promise<{ landed: boolean; slot?: number }> {
    // 1. Check existing DB records for this clientOrderId
    if (orderId) {
      try {
        const txs = workstationDb.loadTransactions(orderId);
        const resolved = txs.find(
          (t) => t.reconciliationState === 'RECONCILED'
        );
        if (resolved) {
          return { landed: true, slot: resolved.landingSlot };
        }
      } catch {}
    }

    // 2. Check on-chain signature status
    if (signature) {
      try {
        const statuses = await this.connection.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        });
        const status = statuses?.value?.[0];
        if (
          status &&
          !status.err &&
          (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
        ) {
          return { landed: true, slot: status.slot };
        }
      } catch {}
    }

    // 3. Check Jito inflight and bundle status if bundleId is present
    if (bundleId) {
      try {
        const inflight = await this.jitoTransport.getInflightBundleStatus(bundleId);
        if (inflight && inflight.status === 'Landed') {
          return { landed: true, slot: inflight.landedSlot };
        }
        const bStatus = await this.jitoTransport.getBundleStatus(bundleId);
        if (bStatus && (bStatus.status === 'confirmed' || bStatus.status === 'finalized' || bStatus.landedSlot)) {
          return { landed: true, slot: bStatus.landedSlot };
        }
      } catch {}
    }

    // 4. Check wallet token balance delta and SOL balance delta (when verifying in-flight tx)
    if (signature || bundleId) {
      try {
        const ata = PumpCurveService.getAssociatedTokenAddress(mintPubkey, owner, tokenProgram);
        const balRes = await this.connection.getTokenAccountBalance(ata, 'confirmed');
        if (balRes && balRes.value) {
          const currentBal = BigInt(balRes.value.amount);
          const prevBal = BigInt(preSnapshot.tokenBalanceRaw || '0');
          if (side === 'BUY' && currentBal > prevBal) {
            return { landed: true };
          }
          if (side === 'SELL' && currentBal < prevBal) {
            return { landed: true };
          }
        }
      } catch {}

      // 5. Check wallet native SOL balance delta
      try {
        const currentSol = await this.connection.getBalance(owner, 'confirmed');
        const prevSol = preSnapshot.walletSolLamports;
        if (prevSol > 0) {
          if (side === 'BUY' && prevSol - currentSol > 100_000) {
            return { landed: true };
          }
          if (side === 'SELL' && currentSol - prevSol > 100_000) {
            return { landed: true };
          }
        }
      } catch {}
    }

    return { landed: false };
  }

  // Idempotent, bounded Jito retry loop with pre-checks and zero-double-fill RPC fallback (R0.6)
  public async submitAndConfirmWithRetry(params: {
    tx: VersionedTransaction;
    orderId: string;
    correlationId: string;
    side: 'BUY' | 'SELL';
    mint: string;
    mintPubkey: PublicKey;
    owner: PublicKey;
    tokenProgram: PublicKey;
    preSnapshot: PreTradeSnapshot;
    jitoTipLamports: number;
  }): Promise<{
    success: boolean;
    signature: string;
    bundleId?: string;
    transport: 'JITO' | 'SOLANA_RPC';
    slot?: number;
    error?: string;
    lifecycleState: 'CONFIRMED' | 'SUBMIT_FAILED' | 'REVERTED';
  }> {
    const { tx, orderId, correlationId, side, mint, mintPubkey, owner, tokenProgram, preSnapshot, jitoTipLamports } = params;
    const cfg = executionConfig.getConfig();

    // Cluster guard: every signed buy and sell passes through here. Refuse before anything is sent
    // unless the RPC reports the allowed cluster's genesis hash (devnet unless Mike set ALLOWED_CLUSTER).
    try {
      await assertClusterAllowed(this.connection);
    } catch (err: any) {
      Logger.error(`[R1] ${side} for order ${orderId} blocked: ${err.message}`);
      workstationDb.logJournal('CLUSTER_GUARD_BLOCK', correlationId, 'LIVE', { orderId, side, mint, error: err.message });
      return {
        success: false,
        signature: '',
        transport: 'SOLANA_RPC',
        error: err.message,
        lifecycleState: 'SUBMIT_FAILED',
      };
    }
    const jitoEnabled = this.jitoTransport.isEnabled();
    // Fail closed on Jito health: with a block engine configured, re-probe once if readiness is not current and
    // only use Jito if it answers HEALTHY. An unhealthy engine is not retried; the order goes to RPC only when
    // the operator enabled the RPC fallback, otherwise it is refused.
    let jitoUsable = jitoEnabled;
    let jitoUnhealthyReason: string | undefined;
    if (jitoEnabled && !this.getJitoReadiness().ready) {
      await this.jitoTransport.probe();
      const readiness = this.getJitoReadiness();
      jitoUsable = readiness.ready;
      if (!jitoUsable) {
        jitoUnhealthyReason = `Failed to submit: ${readiness.reason ?? 'Jito Block Engine is not healthy'} (fail closed)`;
        Logger.warn(`[A4] ${side} for order ${orderId}: ${jitoUnhealthyReason}`);
      }
    }
    // With no Jito block engine configured (always the case on devnet) there is nothing to retry: go straight to RPC.
    const maxRetries = jitoUsable ? Math.max(0, cfg.jitoMaxRetries) : -1;
    const retryIntervalMs = Math.max(0, cfg.jitoRetryIntervalMs);
    const confirmTimeoutMs = Math.max(1000, cfg.bundleConfirmTimeoutMs);

    // 0. Pre-execution check: Has this order already executed or landed?
    if (orderId) {
      const txs = workstationDb.loadTransactions(orderId);
      const resolved = txs.find((t) => t.reconciliationState === 'RECONCILED');
      if (resolved) {
        Logger.warn(`[R0.6] Order ${orderId} already landed or recorded in database; skipping resubmission`);
        return {
          success: true,
          signature: resolved.signature,
          transport: resolved.submissionTransport === 'SOLANA_RPC' ? 'SOLANA_RPC' : 'JITO',
          slot: resolved.landingSlot,
          lifecycleState: 'CONFIRMED',
        };
      }
    }

    let lastSignature = '';
    let lastBundleId: string | undefined;
    let lastError: string | undefined = jitoUnhealthyReason;
    let landedSlot: number | undefined;
    let jitoLanded = false;

    // Bounded Idempotent Jito Retry Loop
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        Logger.info(`[R0.6] Jito retry attempt ${attempt}/${maxRetries} for order ${orderId}`);
        // Before retrying after a timeout: check bundle status, check transaction status, check wallet/token balance, check existing execution record
        if (lastSignature || lastBundleId) {
          const check = await this.checkIfTransactionLanded(lastSignature, lastBundleId, owner, mintPubkey, tokenProgram, preSnapshot, side, orderId);
          if (check.landed) {
            Logger.info(`[R0.6] Pre-retry check verified tx ${lastSignature} already landed at slot ${check.slot}`);
            jitoLanded = true;
            landedSlot = check.slot;
            break;
          }
        }
        if (retryIntervalMs > 0) {
          await new Promise((r) => setTimeout(r, retryIntervalMs));
        }
      }

      // Submit bundle to Jito
      const submitRes = await this.jitoTransport.submit(tx);
      if (submitRes.signature) lastSignature = submitRes.signature;
      if (submitRes.bundleId) lastBundleId = submitRes.bundleId;

      if (!submitRes.success || !submitRes.signature) {
        lastError = submitRes.error || 'Failed to submit bundle to Block Engine';
        // If Jito explicitly rejected with a fatal instruction simulation error, do not keep retrying
        if (lastError.includes('InstructionError') || lastError.includes('Transaction simulation failed')) {
          break;
        }
        continue;
      }

      // Record transaction in SQLite as PENDING under clientOrderId
      workstationDb.saveTransaction({
        signature: submitRes.signature,
        bundleId: submitRes.bundleId,
        orderId,
        correlationId,
        mint,
        direction: side,
        submissionTransport: 'JITO',
        submissionTime: Date.now(),
        reconciliationState: 'PENDING',
        networkFeeLamports: 5000,
        jitoTipLamports,
        executionMode: 'LIVE',
      });

      // Confirm with bounded timeout
      const confirmRes = await this.jitoTransport.confirm(submitRes.signature, confirmTimeoutMs, submitRes.bundleId);
      if (confirmRes.confirmed) {
        jitoLanded = true;
        landedSlot = confirmRes.slot;
        break;
      } else {
        lastError = confirmRes.error || 'Transaction dropped or expired on Solana';
        // Check if it landed despite confirm timing out
        const postConfirmCheck = await this.checkIfTransactionLanded(submitRes.signature, submitRes.bundleId, owner, mintPubkey, tokenProgram, preSnapshot, side, orderId);
        if (postConfirmCheck.landed) {
          jitoLanded = true;
          landedSlot = postConfirmCheck.slot;
          break;
        }
      }
    }

    if (jitoLanded) {
      return {
        success: true,
        signature: lastSignature,
        bundleId: lastBundleId,
        transport: 'JITO',
        slot: landedSlot,
        lifecycleState: 'CONFIRMED',
      };
    }

    // Direct RPC Fallback branch (if enabled and Jito retries did not land; always taken when Jito is disabled)
    if (cfg.enableRpcFallback || !jitoEnabled) {
      // If Jito explicitly rejected with a fatal simulation error, do not fallback to RPC
      if (lastError && (lastError.includes('InstructionError') || lastError.includes('Transaction simulation failed'))) {
        return {
          success: false,
          signature: lastSignature,
          bundleId: lastBundleId,
          transport: 'JITO',
          error: lastError,
          lifecycleState: 'REVERTED',
        };
      }

      Logger.warn(`[R0.6] Jito attempts exhausted for order ${orderId}. Evaluating direct RPC fallback...`);
      // Crucial pre-check before fallback to prevent double fill:
      if (lastSignature || lastBundleId) {
        const preFallbackCheck = await this.checkIfTransactionLanded(lastSignature, lastBundleId, owner, mintPubkey, tokenProgram, preSnapshot, side, orderId);
        if (preFallbackCheck.landed) {
          Logger.info(`[R0.6] Pre-fallback check discovered Jito tx ${lastSignature} landed at slot ${preFallbackCheck.slot}. Aborting RPC fallback to prevent double fill.`);
          return {
            success: true,
            signature: lastSignature,
            bundleId: lastBundleId,
            transport: 'JITO',
            slot: preFallbackCheck.slot,
            lifecycleState: 'CONFIRMED',
          };
        }
      }

      workstationDb.logJournal('FALLBACK_RPC_ATTEMPT', correlationId, 'LIVE', {
        orderId,
        previousJitoSignature: lastSignature,
        previousJitoBundleId: lastBundleId,
      });

      const rpcSubmit = await this.rpcTransport.submit(tx);
      if (!rpcSubmit.success || !rpcSubmit.signature) {
        return {
          success: false,
          signature: rpcSubmit.signature || lastSignature,
          transport: 'SOLANA_RPC',
          error: rpcSubmit.error || 'RPC fallback submission failed',
          lifecycleState: 'SUBMIT_FAILED',
        };
      }

      // Record transaction under the SAME single logical orderId
      workstationDb.saveTransaction({
        signature: rpcSubmit.signature,
        orderId,
        correlationId,
        mint,
        direction: side,
        submissionTransport: 'SOLANA_RPC',
        submissionTime: Date.now(),
        reconciliationState: 'PENDING',
        networkFeeLamports: 5000,
        jitoTipLamports: 0,
        executionMode: 'LIVE',
      });

      const rpcConfirm = await this.rpcTransport.confirm(rpcSubmit.signature, cfg.rpcFallbackTimeoutMs || 15000);
      if (rpcConfirm.confirmed) {
        return {
          success: true,
          signature: rpcSubmit.signature,
          transport: 'SOLANA_RPC',
          slot: rpcConfirm.slot,
          lifecycleState: 'CONFIRMED',
        };
      } else {
        const postRpcCheck = await this.checkIfTransactionLanded(rpcSubmit.signature, undefined, owner, mintPubkey, tokenProgram, preSnapshot, side, orderId);
        if (postRpcCheck.landed) {
          return {
            success: true,
            signature: rpcSubmit.signature,
            transport: 'SOLANA_RPC',
            slot: postRpcCheck.slot,
            lifecycleState: 'CONFIRMED',
          };
        }
        return {
          success: false,
          signature: rpcSubmit.signature,
          transport: 'SOLANA_RPC',
          error: rpcConfirm.error || 'RPC fallback transaction dropped or unconfirmed',
          lifecycleState: 'REVERTED',
        };
      }
    }

    // If we reach here, Jito failed/timed out and RPC fallback was not enabled or failed
    return {
      success: false,
      signature: lastSignature,
      bundleId: lastBundleId,
      transport: 'JITO',
      error: lastError || 'Transaction unconfirmed or dropped across Jito attempts',
      lifecycleState: lastError?.includes('Failed to submit') ? 'SUBMIT_FAILED' : 'REVERTED',
    };
  }

  /** Shared by LIVE and PAPER (C5): the same on-chain facts become the same eligibility inputs. */
  private eligibilityInputFromMarket(
    req: ExecuteTradeRequest,
    marketState: any,
    holderDist: { devHoldingPct: number; top10HoldersPct: number } | null,
    liquidityUsd: number | undefined
  ) {
    return {
      mint: req.mint,
      symbol: req.symbol,
      name: req.name,
      creator: marketState.creator.toBase58(),
      priceSol:
        Number(marketState.virtualSolReserves) /
        Number(marketState.virtualTokenReserves) /
        (1e9 / Math.pow(10, marketState.tokenDecimals)),
      liquidityUsd,
      bondingCurveProgress: Number(
        Math.min(100, (Number(marketState.realSolReserves) / (85 * 1e9)) * 100).toFixed(1)
      ),
      isMigrated: marketState.complete,
      isMintAuthorityRevoked: marketState.isMintAuthorityRevoked,
      isFreezeAuthorityRevoked: marketState.isFreezeAuthorityRevoked,
      hasToken2022Extensions: marketState.baseTokenProgram?.equals(TOKEN_2022_PROGRAM_ID) ?? false,
      // Pass the extension inspection result through. LIVE already refuses unsafe mints in fetchPumpMarketState,
      // so a Token-2022 mint that reaches here with a report is explicitly safe; without this it was UNKNOWN and rejected.
      token2022Safe: marketState.token2022Report ? marketState.token2022Report.isSafe : undefined,
      unsupportedToken2022Extension:
        marketState.token2022Report && !marketState.token2022Report.isSafe
          ? marketState.token2022Report.unsupportedExtensionNames.join(',') || true
          : undefined,
      devHoldingPct: holderDist ? holderDist.devHoldingPct : null,
      top10HoldersPct: holderDist ? holderDist.top10HoldersPct : null,
    };
  }

  /**
   * The single eligibility verdict used by BOTH modes (C5), so the same report gives the same accept/reject.
   * Strict (LIVE, or PAPER with PAPER_STRICT_GATES=1) also rejects holder checks that are unverified;
   * non-strict PAPER lets UNKNOWN pass but the caller records it as unverified on the fill.
   */
  private eligibilityVerdict(
    eligibility: TokenEligibilityReport,
    now: number,
    mode: ExecutionMode,
    correlationId: string,
    strict: boolean = mode === 'LIVE'
  ): ExecutionResponse | null {
    const reject = (error: string): ExecutionResponse => ({
      success: false,
      lifecycleState: 'FILTER_REJECTED',
      executionMode: mode,
      error,
      correlationId,
    });
    if (now - eligibility.evaluatedAt > 60000) {
      return reject(`ELIGIBILITY_REPORT_STALE: Eligibility report evaluated ${Math.round((now - eligibility.evaluatedAt) / 1000)}s ago exceeds 60s max age for live trading.`);
    }

    const unsupportedExtensionCheck = eligibility.checks.find(
      (c) => c.ruleId === 'TOKEN_2022_POLICY' && !c.passed
    );
    if (unsupportedExtensionCheck) {
      return reject(`UNSUPPORTED_TOKEN_EXTENSION: ${unsupportedExtensionCheck.reason}`);
    }

    if (!eligibility.isEligible) {
      const failReasons = eligibility.checks.filter((c) => !c.passed).map((c) => c.reason).join('; ');
      return reject(`ELIGIBILITY_CHECK_FAILED: Token failed ${eligibility.failedCount} safety check(s): ${failReasons}`);
    }

    const hasUnverifiedHolders = eligibility.checks.some(
      (c) =>
        (c.ruleId === 'MAX_CREATOR_EXPOSURE' || c.ruleId === 'TOP_10_CONCENTRATION') &&
        (!c.passed || String(c.observedValue).toLowerCase().includes('unknown') || String(c.observedValue).toLowerCase().includes('unverified'))
    );
    if (strict && hasUnverifiedHolders) {
      return reject('SAFETY_CHECK_UNVERIFIED: Dev holding or top 10 holders distribution is unverified. Live trade rejected.');
    }

    return null;
  }

  /**
   * Everything a PAPER buy must pass before a fill: price, the shared eligibility gate, capital ceiling and risk.
   * Used by the paper fill itself and by previewBuy (auto-snipe Shadow mode), so a dry run runs the same gates.
   */
  private async evaluatePaperBuy(
    req: ExecuteTradeRequest,
    correlationId: string,
    now: number,
    openPositions: NormalizedPosition[],
    totalExposureSol: number
  ): Promise<
    | { rejection: ExecutionResponse }
    | { quotePriceSol: number; paperEligibility: { gates: Record<string, unknown> }; paperTip: ReturnType<typeof executionConfig.resolveDynamicJitoTip>; maxPaperOrderSol: number }
  > {
    let quotePriceSol = req.currentPriceSol;

    // If price not provided, attempt querying real on-chain bonding curve
    if (!quotePriceSol || quotePriceSol <= 0) {
      try {
        const mintPubkey = new PublicKey(req.mint);
        const state = await PumpCurveService.fetchPumpMarketState({
          connection: this.connection,
          mint: mintPubkey,
          executionMode: 'PAPER',
        });
        if (state && !state.complete) {
          quotePriceSol =
            Number(state.virtualSolReserves) /
            Number(state.virtualTokenReserves) /
            (1e9 / Math.pow(10, state.tokenDecimals));
        }
      } catch {}
    }

    if (!quotePriceSol || quotePriceSol <= 0) {
      return { rejection: {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'PAPER',
        error: 'MARKET_DATA_UNAVAILABLE: No valid market price available to execute paper order',
        correlationId,
      } };
    }

    const paperEligibility = await this.runPaperEligibility(req, quotePriceSol, now, correlationId);
    if (paperEligibility.verdict) {
      workstationDb.logJournal('TRADE_FILTER_REJECTED', correlationId, 'PAPER', {
        reason: paperEligibility.verdict.error,
        gates: paperEligibility.gates,
      });
      return { rejection: paperEligibility.verdict };
    }

    // Resolve dynamic tip for paper mode to respect economic sanity bounds
    const paperTip = executionConfig.resolveDynamicJitoTip({
      tradeAmountSol: req.amountSol,
      explicitTipSol: req.jitoTipSol,
    });

    // Pre-trade capital sizing check: ensure order does not exceed 10% of spendable bankroll (B12)
    // C5: the configured paper bankroll (default 0.07 SOL), never an invented 1.0
    const paperSpendable = CapitalSizer.calculateSpendableBankroll(
      this.realWalletBalanceSol !== null ? this.realWalletBalanceSol : executionConfig.getConfig().paperBankrollSol,
      0.015,
      this.inFlightReservedSol
    );
    const maxPaperOrderSol = Number((paperSpendable * 0.10).toFixed(6));
    if (paperSpendable > 0 && req.amountSol > maxPaperOrderSol + 0.000001) {
      return { rejection: {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'PAPER',
        error: `EXCEEDS_CAPITAL_CEILING: Trade size ${req.amountSol} SOL exceeds 10% spendable bankroll ceiling (${maxPaperOrderSol} SOL).`,
        correlationId,
      } };
    }

    // Evaluate Risk in Paper Mode
    const riskDecision = riskEngine.evaluateOrder({
      mint: req.mint,
      orderSizeSol: req.amountSol,
      expectedPriceSol: quotePriceSol,
      slippageBps: req.slippageBps || 800,
      estimatedPriceImpactBps: PaperExecutionEngine.estimateImpactBps(req.amountSol, req.liquidityUsd),
      estimatedFeeLamports: 15000,
      jitoTipLamports: paperTip.tipLamports,
      signalTimestamp: req.signalTimestamp || now,
      marketDataTimestamp: req.marketDataTimestamp || now,
      currentOpenPositionsCount: openPositions.length,
      currentTotalExposureSol: totalExposureSol,
      walletSpendableSol: paperSpendable,
      executionMode: 'PAPER',
    });

    if (!riskDecision.approved) {
      workstationDb.logJournal('TRADE_RISK_REJECTED', correlationId, 'PAPER', {
        reason: riskDecision.reasonCode,
        message: riskDecision.message,
      });
      return { rejection: {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'PAPER',
        error: `${riskDecision.reasonCode}: ${riskDecision.message}`,
        correlationId,
      } };
    }
    return { quotePriceSol, paperEligibility, paperTip, maxPaperOrderSol };
  }


  /**
   * G1: run every PAPER-side gate for a buy (price, eligibility, capital ceiling, risk) and stop before any fill.
   * Never touches the signer or the paper ledger, whatever the coordinator mode is. Used by auto-snipe Shadow mode.
   */
  public async previewBuy(req: ExecuteTradeRequest): Promise<
    | { status: 'OK'; quotePriceSol: number; tipLamports: number; amountSol: number; gates: Record<string, unknown> }
    | { status: 'REJECTED'; error: string; lifecycleState: ExecutionResponse['lifecycleState'] }
  > {
    const correlationId = `preview-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const openPositions = workstationDb.loadPositions('PAPER', 'ACTIVE');
    const totalExposureSol = openPositions.reduce((acc, p) => acc + p.costBasisLamports / 1e9, 0);
    const evaluated = await this.evaluatePaperBuy(req, correlationId, Date.now(), openPositions, totalExposureSol);
    if ('rejection' in evaluated) {
      return { status: 'REJECTED', error: evaluated.rejection.error || 'REJECTED', lifecycleState: evaluated.rejection.lifecycleState };
    }
    return {
      status: 'OK',
      quotePriceSol: evaluated.quotePriceSol,
      tipLamports: evaluated.paperTip.tipLamports,
      amountSol: req.amountSol,
      gates: evaluated.paperEligibility.gates,
    };
  }

  /**
   * C5: PAPER runs the same eligibility gate as LIVE. With a report supplied it is used as-is; otherwise the on-chain
   * facts are read (best effort, 4s cap) and evaluated. Facts that cannot be read stay UNKNOWN: strict mode
   * (PAPER_STRICT_GATES=1) rejects them like LIVE, default mode lets them through but records them as unverified.
   */
  private async runPaperEligibility(req: ExecuteTradeRequest, quotePriceSol: number, now: number, correlationId: string) {
    const strict = executionConfig.getConfig().paperStrictGates;
    let eligibility = req.eligibilityReport;
    const needsFacts = !eligibility || eligibility.checks.some(
      (c) => (c.ruleId === 'TOP_10_CONCENTRATION' || c.ruleId === 'MAX_CREATOR_EXPOSURE') && c.status === 'UNKNOWN'
    );
    if (needsFacts) {
      const within = <T>(p: Promise<T>) =>
        Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
      let marketState: any = null;
      let holderDist: { devHoldingPct: number; top10HoldersPct: number } | null = null;
      try {
        const mintPk = new PublicKey(req.mint);
        marketState = await within(
          PumpCurveService.fetchPumpMarketState({ connection: this.connection, mint: mintPk, executionMode: 'PAPER' })
        );
        if (marketState) {
          holderDist = await within(
            fetchTokenHolderDistribution(this.connection, mintPk, marketState.creator, marketState.bondingCurve)
          );
        }
      } catch (err: any) {
        Logger.debug(`[C5] Paper gate could not read on-chain facts for ${req.mint}: ${err.message}`);
      }
      const solUsd = solPriceService.lastKnownPrice();
      if (marketState) {
        const liquidityUsd = solUsd !== null ? (Number(marketState.realSolReserves) / 1e9) * solUsd * 2 : req.liquidityUsd;
        eligibility = EligibilityFilter.evaluate(this.eligibilityInputFromMarket(req, marketState, holderDist, liquidityUsd), strict);
      } else if (!eligibility) {
        eligibility = EligibilityFilter.evaluate(
          { mint: req.mint, symbol: req.symbol, name: req.name, priceSol: quotePriceSol, liquidityUsd: req.liquidityUsd },
          strict
        );
      }
    }
    const verdict = this.eligibilityVerdict(eligibility!, now, 'PAPER', correlationId, strict);
    const checks = eligibility!.checks;
    const gates = {
      strict,
      eligibility: {
        passed: checks.filter((c) => c.status === 'PASS' || (c.status === undefined && c.passed)).map((c) => c.ruleId),
        failed: checks.filter((c) => c.status === 'FAIL' || (c.status === undefined && !c.passed)).map((c) => c.ruleId),
        unverified: checks.filter((c) => c.status === 'UNKNOWN').map((c) => c.ruleId),
      },
    };
    return { verdict, gates };
  }

  // Authoritative Central Execution Entrypoint
  public async executeTrade(req: ExecuteTradeRequest): Promise<ExecutionResponse> {
    const correlationId = `exec-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const now = Date.now();
    this.recordMarketEvent();

    if (this.haltReason) {
      return { success: false, lifecycleState: 'RISK_REJECTED', executionMode: this.executionMode, error: `TRADING_HALTED: ${this.haltReason}`, correlationId };
    }

    workstationDb.logJournal('TRADE_REQUEST_RECEIVED', correlationId, this.executionMode, {
      ...req,
      executionMode: this.executionMode,
    });

    // Invariant: If an eligibility report is provided, its mint must match the trade mint exactly
    if (req.eligibilityReport && req.eligibilityReport.mint !== req.mint) {
      return {
        success: false,
        lifecycleState: 'FILTER_REJECTED',
        executionMode: this.executionMode,
        error: `ELIGIBILITY_MINT_MISMATCH: Provided eligibility report mint ${req.eligibilityReport.mint} does not match trade request mint ${req.mint}`,
        correlationId,
      };
    }

    if (this.executionMode === 'LIVE') {
      if (!isLiveApprovedProvenance(req.provenance)) {
        workstationDb.logJournal('TRADE_REJECTED_PROVENANCE_VIOLATION', correlationId, 'LIVE', {
          reason: 'PROVENANCE_VIOLATION',
          provenance: req.provenance,
          message: `Live execution rejected: signal provenance '${req.provenance}' is not permitted for live mainnet trades.`,
        });
        return {
          success: false,
          lifecycleState: 'RISK_REJECTED',
          executionMode: 'LIVE',
          error: `PROVENANCE_VIOLATION: Live trading requires LIVE_PUMP_STREAM, REAL_ONCHAIN, REAL_SOCIAL, COPY_TRADE, or MANUAL_OPERATOR provenance. Observed: '${req.provenance}'.`,
          correlationId,
        };
      }
    }

    const openPositions = workstationDb.loadPositions(this.executionMode, 'ACTIVE');
    const totalExposureSol = openPositions.reduce((acc, p) => acc + p.costBasisLamports / 1e9, 0);

    // =========================================================================
    // BRANCH A: PAPER EXECUTION
    // =========================================================================
    if (this.executionMode === 'PAPER') {
      const evaluated = await this.evaluatePaperBuy(req, correlationId, now, openPositions, totalExposureSol);
      if ('rejection' in evaluated) return evaluated.rejection;
      const { quotePriceSol, paperEligibility, paperTip, maxPaperOrderSol } = evaluated;

      const paperRes = paperEngine.executePaperBuy({
        mint: req.mint,
        symbol: req.symbol,
        name: req.name,
        amountSol: req.amountSol,
        currentPriceSol: quotePriceSol,
        slippageBps: req.slippageBps || 800,
        jitoTipSol: paperTip.tipSol,
        liquidityUsd: req.liquidityUsd,
      });

      if (!paperRes.success) {
        return {
          success: false,
          lifecycleState: 'SUBMIT_FAILED',
          executionMode: 'PAPER',
          error: paperRes.error,
          correlationId,
        };
      }

      riskEngine.recordTradeSuccess(req.mint);

      const gates = {
        ...paperEligibility.gates,
        capitalCeiling: { maxOrderSol: maxPaperOrderSol, orderSol: req.amountSol, passed: true },
        risk: { approved: true, tipLamports: paperTip.tipLamports, tipPolicy: paperTip.policyReason },
      };
      workstationDb.logJournal('PAPER_FILL_GATES', correlationId, 'PAPER', { mint: req.mint, orderId: paperRes.paperOrderId, gates });

      return {
        success: true,
        gates,
        lifecycleState: 'CONFIRMED',
        positionId: paperRes.paperOrderId,
        txSignature: paperRes.paperOrderId,
        fillPriceSol: paperRes.fillPriceSol,
        tokensReceived: paperRes.tokensReceived,
        executionMode: 'PAPER',
        feesPaidLamports: paperRes.networkFeeLamports + paperRes.jitoTipLamports,
        correlationId,
      };
    }

    // =========================================================================
    // BRANCH B: LIVE EXECUTION (Real Solana Mainnet On-Chain)
    // =========================================================================
    if (!this.isLiveTradingArmed || localSigner.getStatus() !== 'READY') {
      return {
        success: false,
        lifecycleState: 'SIGN_FAILED',
        executionMode: 'LIVE',
        error: 'Live trading is not armed or signer is unavailable',
        correlationId,
      };
    }

    let mintPubkey: PublicKey;
    try {
      mintPubkey = new PublicKey(req.mint);
    } catch {
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: `Invalid Solana mint public key: ${req.mint}`,
        correlationId,
      };
    }

    // 1. Fetch real on-chain Pump bonding curve market state (NEVER use fallback price)
    const marketState = await PumpCurveService.fetchPumpMarketState({
      connection: this.connection,
      mint: mintPubkey,
      executionMode: 'LIVE',
    });
    if (!marketState) {
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: 'MARKET_DATA_UNAVAILABLE: Could not fetch real Pump.fun bonding curve from Solana RPC. Live execution rejected.',
        correlationId,
      };
    }

    if (marketState.complete) {
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: 'BONDING_CURVE_MIGRATED: Token has graduated from bonding curve. Direct Pump.fun trade rejected.',
        correlationId,
      };
    }

    // 2. Authoritative Token Eligibility Verification (Fail-Closed in LIVE mode)
    if (req.eligibilityReport && req.eligibilityReport.mint !== req.mint) {
      return {
        success: false,
        lifecycleState: 'FILTER_REJECTED',
        executionMode: 'LIVE',
        error: `ELIGIBILITY_MINT_MISMATCH: Provided eligibility report mint ${req.eligibilityReport.mint} does not match trade request mint ${req.mint}`,
        correlationId,
      };
    }

    let eligibility = req.eligibilityReport;
    const needsHolderVerification = !eligibility || eligibility.checks.some(
      (c) => (c.ruleId === 'TOP_10_CONCENTRATION' || c.ruleId === 'MAX_CREATOR_EXPOSURE') && c.status === 'UNKNOWN'
    );

    if (needsHolderVerification) {
      let holderDist = null;
      try {
        holderDist = await fetchTokenHolderDistribution(
          this.connection,
          mintPubkey,
          marketState.creator,
          marketState.bondingCurve
        );
      } catch (err: any) {
        Logger.warn(`Could not fetch token holder distribution for ${req.mint}: ${err.message}`);
      }

      // C3: the liquidity gate needs the SOL/USD price. A missing or stale price fails closed in LIVE.
      let liveSolUsd: number;
      try {
        liveSolUsd = solPriceService.requireFreshPrice();
      } catch (e: any) {
        return {
          success: false,
          lifecycleState: 'RISK_REJECTED',
          executionMode: 'LIVE',
          error: e.message,
          correlationId,
        };
      }

      eligibility = EligibilityFilter.evaluate(
        this.eligibilityInputFromMarket(req, marketState, holderDist, (Number(marketState.realSolReserves) / 1e9) * liveSolUsd * 2),
        true
      );
    }

    const verdict = this.eligibilityVerdict(eligibility, now, 'LIVE', correlationId);
    if (verdict) return verdict;

    // 3. Pre-Trade Capital Sizing (B12): spendable bankroll and 10% ceiling check
    const rawWalletBalance = this.realWalletBalanceSol ?? 0;
    const spendable = CapitalSizer.calculateSpendableBankroll(rawWalletBalance, 0.015, this.inFlightReservedSol);

    if (spendable <= 0) {
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: `INSUFFICIENT_SPENDABLE_BANKROLL: Spendable bankroll is ${spendable.toFixed(4)} SOL after reserve (0.015 SOL) and in-flight orders (${this.inFlightReservedSol.toFixed(4)} SOL).`,
        correlationId,
      };
    }

    // Pre-trade sizing: trade size must not exceed 10% of spendable bankroll (B12)
    const maxAllowedOrderSol = Number((spendable * 0.10).toFixed(6));
    if (req.amountSol > maxAllowedOrderSol + 0.000001) {
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: `EXCEEDS_CAPITAL_CEILING: Trade size ${req.amountSol} SOL exceeds 10% spendable bankroll ceiling (${maxAllowedOrderSol} SOL).`,
        correlationId,
      };
    }

    // 4. Resolve dynamic Jito tip from live floor telemetry and execution policy
    const tipFloor = await this.jitoTransport.getTipFloorLamports();
    const resolvedTip = this.resolveLiveTip({
      tipFloorLamports: tipFloor,
      tradeAmountSol: req.amountSol,
      explicitTipSol: req.jitoTipSol,
    });

    // 5. Compute accurate mathematical trade quote with LIVE dynamic fee enforcement
    let quote: TradeQuote;
    try {
      quote = PumpCurveService.calculateBuyQuote({
        state: marketState,
        amountSol: req.amountSol,
        slippageBps: req.slippageBps || 800,
        jitoTipSol: resolvedTip.tipSol,
        priorityFeeLamports: Math.round(executionConfig.getConfig().priorityFeeMicrolamports * 0.25),
        executionMode: 'LIVE',
      });
    } catch (quoteErr: any) {
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: `QUOTE_FAILED: ${quoteErr.message}`,
        correlationId,
      };
    }

    const requiredSol = req.amountSol + (quote.expectedJitoTipLamports + quote.expectedPriorityFeeLamports + 5000) / 1e9;

    // Check balance concurrency reservation
    if (rawWalletBalance - this.inFlightReservedSol - requiredSol < 0.015) {
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: `INSUFFICIENT_FUNDS_CONCURRENCY: Wallet balance (${rawWalletBalance.toFixed(4)} SOL) minus in-flight reservations (${this.inFlightReservedSol.toFixed(4)} SOL) cannot cover required ${requiredSol.toFixed(4)} SOL plus 0.015 SOL reserve.`,
        correlationId,
      };
    }

    // C7b: an entry whose round-trip execution cost (both tips, both base+priority fees, pump fees both sides)
    // exceeds 20% of the order cannot realistically be profitable. The size is never rounded up to make it pass.
    const roundTripCostLamports = estimateRoundTripCostLamports({
      buyTipLamports: quote.expectedJitoTipLamports,
      sellTipLamports: resolvedTip.tipLamports,
      priorityFeeLamports: quote.expectedPriorityFeeLamports,
      buyProtocolFeeLamports: quote.protocolFeeLamports,
      buyCreatorFeeLamports: quote.creatorFeeLamports,
    });
    if (roundTripCostLamports > MAX_ROUND_TRIP_COST_FRACTION * req.amountSol * 1e9) {
      workstationDb.logJournal('TRADE_RISK_REJECTED', correlationId, 'LIVE', {
        reason: 'EXPECTED_EDGE_BELOW_EXECUTION_COST',
        roundTripCostLamports,
        orderLamports: Math.round(req.amountSol * 1e9),
      });
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: `EXPECTED_EDGE_BELOW_EXECUTION_COST: Round-trip cost ${roundTripCostLamports} lamports exceeds ${MAX_ROUND_TRIP_COST_FRACTION * 100}% of the ${req.amountSol} SOL order.`,
        correlationId,
      };
    }

    const riskDecision = riskEngine.evaluateOrder({
      mint: req.mint,
      orderSizeSol: req.amountSol,
      expectedPriceSol: quote.executionPriceSol,
      slippageBps: quote.slippageBps,
      estimatedPriceImpactBps: quote.estimatedPriceImpactBps,
      estimatedFeeLamports: quote.expectedPriorityFeeLamports + 5000,
      jitoTipLamports: quote.expectedJitoTipLamports,
      signalTimestamp: req.signalTimestamp || marketState.marketDataTimestamp,
      marketDataTimestamp: marketState.marketDataTimestamp,
      currentOpenPositionsCount: openPositions.length,
      currentTotalExposureSol: totalExposureSol,
      walletSpendableSol: Math.max(0, spendable - this.inFlightReservedSol),
      executionMode: 'LIVE',
    });

    if (!riskDecision.approved) {
      workstationDb.logJournal('TRADE_RISK_REJECTED', correlationId, 'LIVE', {
        reason: riskDecision.reasonCode,
        message: riskDecision.message,
        quote,
      });
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: `${riskDecision.reasonCode}: ${riskDecision.message}`,
        correlationId,
      };
    }

    // Cross-request dedupe: only one LIVE buy per mint may be in flight. The per-mint cooldown is only recorded
    // after a fill, so two concurrent requests (double click, WS plus HTTP, auto-snipe plus operator) could both pass it.
    // Check and add run in the same synchronous block as the reservation, so there is no await between them.
    if (this.inFlightBuyMints.has(req.mint)) {
      workstationDb.logJournal('TRADE_REJECTED_DUPLICATE_IN_FLIGHT', correlationId, 'LIVE', { mint: req.mint });
      return {
        success: false,
        lifecycleState: 'RISK_REJECTED',
        executionMode: 'LIVE',
        error: `DUPLICATE_MINT: A buy for ${req.mint} is already in flight.`,
        correlationId,
      };
    }
    this.inFlightBuyMints.add(req.mint);

    // Acquire in-flight balance reservation
    this.inFlightReservedSol += requiredSol;
    try {
      // 4. Capture Pre-Trade Balances for real reconciliation
      const buyer = localSigner.getPublicKey();
      const preSnapshot = await TradeReconciler.capturePreTradeSnapshot(
        this.connection,
        buyer,
        mintPubkey,
        marketState.tokenProgram,
        'LIVE'
      );

      const associatedUser = PumpCurveService.getAssociatedTokenAddress(
        mintPubkey,
        buyer,
        marketState.tokenProgram
      );

      const buyParams: PumpBuyParams = {
        buyer,
        mint: mintPubkey,
        bondingCurve: marketState.bondingCurve,
        associatedBondingCurve: marketState.associatedBondingCurve,
        associatedUser,
        creator: marketState.creator,
        feeRecipient: marketState.feeRecipient,
        buybackFeeRecipient: marketState.buybackFeeRecipient,
        quoteMint: marketState.quoteMint,
        tokenProgram: marketState.tokenProgram,
        quoteTokenProgram: marketState.quoteTokenProgram,
        amountTokens: BigInt(quote.tokenAmountRaw),
        maxSolCostLamports: BigInt(quote.maxInputLamports),
        computeUnits: 250000,
        priorityFeeMicroLamports: executionConfig.getConfig().priorityFeeMicrolamports,
        jitoTipLamports: BigInt(resolvedTip.tipLamports),
        jitoTipAccount: executionConfig.getJitoTipAccountPublicKey(),
      };

      // 5. Build, sign, and submit real Solana transaction
      const v0Tx = await txBuilder.buildBuyTransaction(this.connection, buyParams);
      await localSigner.signTransaction(v0Tx);

      // The tip transfer is an instruction inside the signed transaction, so it is paid on-chain whichever
      // transport lands it (Jito bundle or the RPC fallback). Accounting uses resolvedTip.tipLamports for both.
      // Record order in SQLite
      const clientOrderId = `ord-${correlationId}`;
      workstationDb.saveOrder({
        id: clientOrderId,
        clientOrderId,
        correlationId,
        mint: req.mint,
        symbol: req.symbol,
        side: 'BUY',
        amountLamports: quote.expectedSolAmountLamports,
        expectedTokensRaw: quote.tokenAmountRaw,
        slippageBps: quote.slippageBps,
        status: 'SUBMITTED',
        quoteJson: JSON.stringify(quote, (_key, value) =>
          typeof value === 'bigint' ? value.toString() : value
        ),
        executionMode: 'LIVE',
        createdAt: now,
        updatedAt: now,
      });

      // 5 & 6. Submit transaction with bounded idempotent retry & RPC fallback
      const subRes = await this.submitAndConfirmWithRetry({
        tx: v0Tx,
        orderId: clientOrderId,
        correlationId,
        side: 'BUY',
        mint: req.mint,
        mintPubkey,
        owner: buyer,
        tokenProgram: marketState.tokenProgram,
        preSnapshot,
        jitoTipLamports: resolvedTip.tipLamports,
      });

      if (!subRes.success || !subRes.signature) {
        riskEngine.recordTradeFailure();
        workstationDb.saveTransaction({
          signature: subRes.signature || `failed_${Date.now()}`,
          bundleId: subRes.bundleId,
          orderId: clientOrderId,
          correlationId,
          mint: req.mint,
          direction: 'BUY',
          submissionTransport: subRes.transport,
          submissionTime: Date.now(),
          reconciliationState: 'REVERTED',
          networkFeeLamports: 5000,
          jitoTipLamports: resolvedTip.tipLamports,
          executionMode: 'LIVE',
          error: subRes.error || 'Transaction unconfirmed or dropped across attempts',
        });

        return {
          success: false,
          lifecycleState: subRes.lifecycleState,
          executionMode: 'LIVE',
          txSignature: subRes.signature,
          bundleId: subRes.bundleId,
          error: subRes.error || 'Transaction dropped or expired on Solana',
          correlationId,
        };
      }

      // 7. REAL FILL RECONCILIATION
      // Do not construct position from estimates; verify confirmed on-chain fill
      const reconciliation = await TradeReconciler.reconcileBuyTransaction(
        this.connection,
        subRes.signature,
        buyer,
        mintPubkey,
        marketState.tokenProgram,
        preSnapshot,
        resolvedTip.tipLamports
      );

      if (!reconciliation.success || reconciliation.reconciliationState !== 'RECONCILED') {
        riskEngine.recordTradeFailure();
        workstationDb.saveTransaction({
          signature: subRes.signature,
          bundleId: subRes.bundleId,
          orderId: clientOrderId,
          correlationId,
          mint: req.mint,
          direction: 'BUY',
          submissionTransport: subRes.transport,
          submissionTime: Date.now(),
          landingSlot: subRes.slot,
          confirmationTime: Date.now(),
          reconciliationState: 'RECONCILIATION_REQUIRED',
          networkFeeLamports: reconciliation.actualNetworkFeeLamports || 5000,
          jitoTipLamports: resolvedTip.tipLamports,
          executionMode: 'LIVE',
          error: reconciliation.error || 'Token balance increase not verified',
        });

        return {
          success: false,
          lifecycleState: 'RECONCILIATION_REQUIRED',
          executionMode: 'LIVE',
          txSignature: subRes.signature,
          bundleId: subRes.bundleId,
          error: `RECONCILIATION FAILED: ${reconciliation.error}. Conflicting live executions blocked.`,
          correlationId,
        };
      }

      // 8. Reconciled Successfully: Persist verified OPEN position
      riskEngine.recordTradeSuccess(req.mint);
      await this.syncRealWalletBalance();

      const livePosition: NormalizedPosition = {
        id: subRes.signature,
        mint: req.mint,
        symbol: req.symbol,
        name: req.name,
        tokenDecimals: reconciliation.tokenDecimals,
        baseTokenProgram: marketState.baseTokenProgram.toBase58(),
        tokenQuantityRaw: reconciliation.actualTokensReceivedRaw,
        costBasisLamports: reconciliation.actualSolSpentLamports,
        entryPriceSol: reconciliation.effectiveFillPriceSol,
        currentPriceSol: reconciliation.effectiveFillPriceSol,
        currentValueSol: reconciliation.actualSolSpentLamports / 1e9,
        unrealizedPnLSol: 0,
        unrealizedPnLPct: 0,
        realizedPnLSol: 0,
        entryTxSignature: subRes.signature,
        entrySlot: reconciliation.slot,
        entryTimestamp: Date.now(),
        entryFeeLamports: reconciliation.actualNetworkFeeLamports,
        priorityFeeLamports: quote.expectedPriorityFeeLamports,
        jitoTipLamports: resolvedTip.tipLamports,
        markSource: 'RECONCILED_ON_CHAIN',
        markAgeMs: 0,
        venue: 'PUMP_BONDING_CURVE',
        poolAddress: marketState.bondingCurve.toBase58(),
        executionMode: 'LIVE',
        status: 'OPEN',
        lastUpdatedTimestamp: Date.now(),
      };

      workstationDb.savePosition(livePosition);

      workstationDb.saveTransaction({
        signature: subRes.signature,
        bundleId: subRes.bundleId,
        orderId: clientOrderId,
        correlationId,
        mint: req.mint,
        direction: 'BUY',
        submissionTransport: subRes.transport,
        submissionTime: Date.now(),
        landingSlot: reconciliation.slot,
        confirmationTime: Date.now(),
        reconciliationState: 'RECONCILED',
        networkFeeLamports: reconciliation.actualNetworkFeeLamports,
        jitoTipLamports: resolvedTip.tipLamports,
        executionMode: 'LIVE',
      });

      return {
        success: true,
        lifecycleState: 'CONFIRMED',
        positionId: subRes.signature,
        txSignature: subRes.signature,
        bundleId: subRes.bundleId,
        fillPriceSol: reconciliation.effectiveFillPriceSol,
        tokensReceived: reconciliation.tokensReceivedHuman,
        executionMode: 'LIVE',
        feesPaidLamports: reconciliation.actualNetworkFeeLamports + quote.expectedJitoTipLamports,
        correlationId,
      };
    } catch (err: any) {
      riskEngine.recordTradeFailure();
      Logger.error(`LIVE trade exception: ${err.message}`);
      return {
        success: false,
        lifecycleState: 'CHAIN_ERROR',
        executionMode: 'LIVE',
        error: err.message,
        correlationId,
      };
    } finally {
      // Always release in-flight balance reservation
      this.inFlightReservedSol = Math.max(0, this.inFlightReservedSol - requiredSol);
      this.inFlightBuyMints.delete(req.mint);
    }
  }

  // Canonical Close Position supporting partial sells (1-100%) and real proceeds reconciliation
  private haltReason: string | null = null;

  /** G3: hard stop of ALL trading, exits included (used when the wallet balance changes for a reason the journal cannot explain). */
  public haltAll(reason: string): void {
    if (this.haltReason) return;
    this.haltReason = reason;
    this.raiseOperatorAlert('TRADING_HALTED', `All trading including exits is halted: ${reason}`);
  }

  public clearHalt(): void {
    this.haltReason = null;
    this.clearOperatorAlert('TRADING_HALTED');
  }

  public getHaltReason(): string | null {
    return this.haltReason;
  }

  /** Close (part of) a position, and write the exit to the decision journal (G3). */
  public async closePosition(
    positionId: string,
    sellPct: number = 100,
    reason: string = 'Manual Close'
  ): Promise<{ success: boolean; pnlSol: number; status?: string; error?: string }> {
    if (this.haltReason) {
      return { success: false, pnlSol: 0, error: `TRADING_HALTED: ${this.haltReason}` };
    }
    const before = workstationDb.loadPositions().find((p) => p.id === positionId);
    const res = await this.closePositionImpl(positionId, sellPct, reason);
    if (res.success && before) {
      const fraction = Math.min(100, Math.max(1, sellPct)) / 100;
      workstationDb.logDecision({
        autoMode: 'n/a',
        mint: before.mint,
        symbol: before.symbol,
        source: 'EXIT_ENGINE',
        stage: 'exit',
        outcome: 'EXITED',
        reason,
        inputs: { sellPct, mode: before.executionMode, pnlSol: res.pnlSol },
        positionId,
        solDelta: (before.costBasisLamports / 1e9) * fraction + res.pnlSol,
      });
    }
    return res;
  }

  private async closePositionImpl(
    positionId: string,
    sellPct: number,
    reason: string
  ): Promise<{ success: boolean; pnlSol: number; status?: string; error?: string }> {
    if (this.inFlightPositionExits.has(positionId)) {
      return { success: false, pnlSol: 0, error: 'EXIT_IN_PROGRESS: An exit transaction for this position is already in progress.' };
    }
    this.inFlightPositionExits.add(positionId);

    try {
      const positions = workstationDb.loadPositions();
      const target = positions.find((p) => p.id === positionId && (p.status === 'OPEN' || p.status === 'PARTIALLY_CLOSED'));

      if (!target) {
        return { success: false, pnlSol: 0, error: 'Position not found or already closed' };
      }

      const safeSellPct = Math.min(100, Math.max(1, sellPct));
      const fraction = safeSellPct / 100;
      const percentageToSell = safeSellPct;
      const closeAta = (percentageToSell === 100);

      const tipFloor = await this.jitoTransport.getTipFloorLamports();
      const resolvedTip = this.resolveLiveTip({
        tipFloorLamports: tipFloor,
        tradeAmountSol: (target.currentValueSol || 0.05) * fraction,
      });

      // Check economic viability of exits in LIVE mode: calculate net proceeds residualValue + (closeAta ? 0.00203928 : 0) - fees (B19)
      if (target.executionMode === 'LIVE') {
        const tokenDecimals = target.tokenDecimals ?? 6;
        const tokenQty = Number(target.tokenQuantityRaw || 0) / Math.pow(10, tokenDecimals);
        const residualValue = ((target.currentValueSol !== undefined && target.currentValueSol !== null && target.currentValueSol > 0)
          ? target.currentValueSol
          : (tokenQty * (target.currentPriceSol || 0))) * fraction;

        const priorityFeeMicrolamports = executionConfig.getConfig().priorityFeeMicrolamports;
        const estimatedFeeLamports = resolvedTip.tipLamports + Math.round(priorityFeeMicrolamports * 0.25) + 5000;
        const fees = estimatedFeeLamports / 1e9;
        const netProceeds = residualValue + (closeAta ? 0.00203928 : 0) - fees;

        // Hard-stop and trailing-stop exits are never blocked by the dust check: a full exit closes the ATA and returns
        // about 0.002 SOL of rent, and holding a falling position to avoid a tip is worse. The check only gates
        // take-profit partials, the stale-position exit and manual closes.
        const isProtectiveExit = reason === 'STOP_LOSS' || reason === 'TRAILING_STOP';
        if (netProceeds <= 0 && !isProtectiveExit) {
          return {
            success: false,
            pnlSol: 0,
            error: 'DUST_POSITION_EXIT_UNECONOMICAL',
          };
        }
      }

      // PAPER Sell Branch
      if (target.executionMode === 'PAPER') {
        await new Promise((r) => setTimeout(r, 10));
        const res = paperEngine.executePaperSell(target.id, target.currentPriceSol, safeSellPct, reason);
        return {
          success: res.success,
          pnlSol: res.realizedPnLSol,
          status: res.position?.status,
          error: res.error,
        };
      }

    // LIVE Sell Branch (Risk-reducing exits always permitted when local signer is configured and ready)
    if (localSigner.getStatus() !== 'READY') {
      return { success: false, pnlSol: 0, error: 'Signer is not configured or locked' };
    }

    const seller = localSigner.getPublicKey();
    const mintPubkey = new PublicKey(target.mint);

      const totalTokensRaw = BigInt(target.tokenQuantityRaw);
      const amountTokensToSell = (totalTokensRaw * BigInt(safeSellPct)) / 100n;

      if (amountTokensToSell <= 0n) {
        return { success: false, pnlSol: 0, error: 'Calculated sell quantity is zero' };
      }

      const { PumpSwapVenueService } = await import('../solana/pumpSwapService');
      const posMode: ExecutionMode = target.executionMode === 'LIVE' ? 'LIVE' : 'PAPER';
      const venueInfo = await PumpSwapVenueService.resolveVenue(this.connection, mintPubkey, posMode);

      if (venueInfo.venue === 'UNKNOWN' && target.executionMode === 'LIVE') {
        return {
          success: false,
          pnlSol: 0,
          error: 'UNKNOWN_TRADING_VENUE: Could not authoritatively determine whether token is bonding curve or PumpSwap pool in LIVE mode.',
        };
      }

      let v0Tx: any;
      let expectedJitoTipLamports = resolvedTip.tipLamports;
      const jitoTipAccount = executionConfig.getJitoTipAccountPublicKey();
      let tokenProgramToUse = target.baseTokenProgram ? new PublicKey(target.baseTokenProgram) : TOKEN_PROGRAM_ID;

      if (venueInfo.venue === 'PUMPSWAP') {
        Logger.info(`Closing position ${target.symbol} via canonical PumpSwap AMM pool`);
        if (target.venue !== 'PUMPSWAP' || !target.poolAddress || !target.migrationTimestamp) {
          target.venue = 'PUMPSWAP';
          target.poolAddress = venueInfo.poolAddress?.toBase58() || target.poolAddress;
          target.migrationTimestamp = target.migrationTimestamp || Date.now();
          target.lastUpdatedTimestamp = Date.now();
          workstationDb.savePosition(target);
        }
        const pumpSwapSell = await PumpSwapVenueService.buildPumpSwapSellInstructions(
          this.connection,
          seller,
          mintPubkey,
          amountTokensToSell,
          800,
          posMode
        );

        const associatedUser = PumpCurveService.getAssociatedTokenAddress(mintPubkey, seller, tokenProgramToUse);
        const instructions = [
          ...SolanaTransactionBuilder.createComputeBudgetInstructions(250000, executionConfig.getConfig().priorityFeeMicrolamports),
          ...pumpSwapSell.instructions,
          ...(closeAta ? [createCloseAccountInstruction(associatedUser, seller, seller, [], tokenProgramToUse)] : []),
          SystemProgram.transfer({
            fromPubkey: seller,
            toPubkey: jitoTipAccount,
            lamports: expectedJitoTipLamports,
          }),
        ];

        v0Tx = await txBuilder.buildCustomVersionedTransaction(this.connection, seller, instructions);
      } else if (venueInfo.venue === 'PUMP_BONDING_CURVE') {
        const marketState = await PumpCurveService.fetchPumpMarketState({
          connection: this.connection,
          mint: mintPubkey,
          executionMode: posMode,
        });
        if (!marketState) {
          return { success: false, pnlSol: 0, error: 'Cannot fetch market state to quote and execute sell' };
        }
        tokenProgramToUse = marketState.tokenProgram;

        const sellQuote = PumpCurveService.calculateSellQuote({
          state: marketState,
          tokenAmountRaw: amountTokensToSell,
          slippageBps: 800,
          jitoTipSol: resolvedTip.tipSol,
          priorityFeeLamports: Math.round(executionConfig.getConfig().priorityFeeMicrolamports * 0.25),
          executionMode: posMode,
        });
        expectedJitoTipLamports = sellQuote.expectedJitoTipLamports;

        const associatedUser = PumpCurveService.getAssociatedTokenAddress(
          mintPubkey,
          seller,
          marketState.tokenProgram
        );

        const sellParams: PumpSellParams = {
          seller,
          mint: mintPubkey,
          bondingCurve: marketState.bondingCurve,
          associatedBondingCurve: marketState.associatedBondingCurve,
          associatedUser,
          creator: marketState.creator,
          feeRecipient: marketState.feeRecipient,
          buybackFeeRecipient: marketState.buybackFeeRecipient,
          quoteMint: marketState.quoteMint,
          tokenProgram: marketState.tokenProgram,
          quoteTokenProgram: marketState.quoteTokenProgram,
          amountTokens: amountTokensToSell,
          minSolOutputLamports: BigInt(sellQuote.minOutputLamports),
          computeUnits: 200000,
          priorityFeeMicroLamports: executionConfig.getConfig().priorityFeeMicrolamports,
          jitoTipLamports: BigInt(sellQuote.expectedJitoTipLamports),
          jitoTipAccount: jitoTipAccount,
          closeAta,
        };

        v0Tx = await txBuilder.buildSellTransaction(this.connection, sellParams, closeAta);
      } else {
        return { success: false, pnlSol: 0, error: `Trading venue for mint ${target.mint} cannot be resolved or migrated to unknown DEX` };
      }

      // Capture pre-sell balance snapshot
      const preSnapshot = await TradeReconciler.capturePreTradeSnapshot(
        this.connection,
        seller,
        mintPubkey,
        tokenProgramToUse
      );

      await localSigner.signTransaction(v0Tx);

      const exitOrderId = `ord-exit-${positionId.slice(0, 8)}-${Date.now()}`;
      const subRes = await this.submitAndConfirmWithRetry({
        tx: v0Tx,
        orderId: exitOrderId,
        correlationId: `exit-${positionId.slice(0, 8)}`,
        side: 'SELL',
        mint: target.mint,
        mintPubkey,
        owner: seller,
        tokenProgram: tokenProgramToUse,
        preSnapshot,
        jitoTipLamports: expectedJitoTipLamports,
      });

      if (!subRes.success || !subRes.signature) {
        return { success: false, pnlSol: 0, error: subRes.error || 'Failed to submit or confirm sell bundle' };
      }

      // Reconcile real proceeds from confirmed transaction
      const sellRecon = await TradeReconciler.reconcileSellTransaction(
        this.connection,
        subRes.signature,
        seller,
        mintPubkey,
        tokenProgramToUse,
        preSnapshot,
        target.costBasisLamports,
        fraction,
        expectedJitoTipLamports
      );

      if (!sellRecon.success) {
        return { success: false, pnlSol: 0, error: sellRecon.error };
      }

      target.realizedPnLSol += Number(sellRecon.actualRealizedPnLSol.toFixed(6));
      target.exitReason = reason;
      target.exitTxSignature = subRes.signature;
      target.lastUpdatedTimestamp = Date.now();

      if (sellRecon.isFullyClosed || safeSellPct >= 100) {
        target.status = 'CLOSED';
        target.tokenQuantityRaw = '0';
        target.costBasisLamports = 0;
      } else {
        target.status = 'PARTIALLY_CLOSED';
        target.tokenQuantityRaw = sellRecon.remainingTokensRaw;
        target.costBasisLamports = Math.round(target.costBasisLamports * (1 - fraction));
      }

      workstationDb.savePosition(target);
      await this.syncRealWalletBalance();

      return {
        success: true,
        pnlSol: sellRecon.actualRealizedPnLSol,
        status: target.status,
      };
    } catch (err: any) {
      return { success: false, pnlSol: 0, error: err.message };
    } finally {
      this.inFlightPositionExits.delete(positionId);
    }
  }

  /** C4: isolated per-position price read used when the shared mark feed has gone stale. */
  private async refreshStaleMark(pos: NormalizedPosition): Promise<boolean> {
    try {
      const marks = await RealMarkPriceService.queryOnChainMarkPrices(
        this.connection,
        [pos.mint],
        pos.executionMode === 'LIVE' ? 'LIVE' : 'PAPER'
      );
      const mark = marks[pos.mint];
      if (!mark || !(mark.priceSol > 0)) return false;
      this.applyMarkPrice(pos, mark.priceSol, mark.source, mark.timestamp, mark.poolAddress);
      return true;
    } catch (err: any) {
      Logger.debug(`Direct mark read failed for ${pos.mint}: ${err.message}`);
      return false;
    }
  }

  private operatorAlerts: OperatorAlert[] = [];

  /** Recent operator alerts (newest last). Surfaced in diagnostics. */
  public getOperatorAlerts(): OperatorAlert[] {
    return this.operatorAlerts.filter((a) => !a.cleared).map((a) => ({ ...a }));
  }

  private raiseOperatorAlert(code: string, message: string, positionId?: string) {
    const now = Date.now();
    const existing = this.operatorAlerts.find((a) => a.code === code && a.positionId === positionId && !a.cleared);
    if (existing) {
      existing.lastSeenAt = now;
      return;
    }
    this.operatorAlerts.push({ code, message, positionId, raisedAt: now, lastSeenAt: now, cleared: false });
    if (this.operatorAlerts.length > 50) this.operatorAlerts.shift();
    Logger.error(`[OPERATOR ALERT] ${code}: ${message}`);
  }

  private clearOperatorAlert(code: string, positionId?: string) {
    for (const a of this.operatorAlerts) {
      if (a.code === code && a.positionId === positionId) a.cleared = true;
    }
  }

  // Evaluate dynamic exit conditions for all active positions and execute exits via ExitEngine (B13)
  public async evaluateAndProcessExits(): Promise<void> {
    try {
      await this.updatePositionMarkPrices();
    } catch {}

    const positions = workstationDb.loadPositions(undefined, 'ACTIVE');
    const now = Date.now();

    for (const pos of positions) {
      // C4: staleness is measured from the last real mark only. lastUpdatedTimestamp is rewritten on every tick
      // and would hide a dead feed, so it is never a fallback; a never-marked position ages from its entry.
      const markAge = now - (pos.lastMarkTimestamp || pos.entryTimestamp || now);
      if (markAge > MARK_STALE_MS) {
        // Before skipping, read this position's curve/pool directly. A fresh read lets the stop-loss run.
        const refreshed = await this.refreshStaleMark(pos);
        if (!refreshed) {
          // Missing data is never "safe": exits cannot be priced, so say so loudly once the gap is long enough.
          if (markAge > MARK_ALERT_AFTER_MS) {
            this.raiseOperatorAlert(
              'POSITION_MARK_UNAVAILABLE',
              `No price for ${pos.symbol || pos.mint} for ${Math.round(markAge / 1000)}s and a direct curve/pool read failed. Stop-loss and take-profit cannot fire until a mark returns; consider closing manually.`,
              pos.id
            );
          }
          continue;
        }
        this.clearOperatorAlert('POSITION_MARK_UNAVAILABLE', pos.id);
      }

      const decision = ExitEngine.evaluate({
        positionId: pos.id,
        entryPriceSol: pos.entryPriceSol,
        currentPriceSol: pos.currentPriceSol,
        highWaterMarkSol: pos.highWaterMarkSol,
        trailingStopSol: pos.trailingStopSol,
        exitStage: pos.exitStage,
        entryTimestamp: pos.entryTimestamp,
        currentTimestamp: now,
      });

      // Persist high_water_mark_sol and trailing_stop_sol to SQLite (B13). The exit stage only advances after the
      // sell actually fills: advancing it first would skip a take-profit stage when the sell reverts or is refused.
      const priorExitStage = pos.exitStage;
      pos.highWaterMarkSol = decision.newHighWaterMarkSol;
      pos.trailingStopSol = decision.newTrailingStopSol;
      pos.exitStage = decision.shouldExit ? priorExitStage : decision.newExitStage;
      pos.lastUpdatedTimestamp = now;
      workstationDb.savePosition(pos);

      if (decision.shouldExit) {
        Logger.info(
          `[B13 ExitEngine] ${decision.reason} triggered for ${pos.symbol || pos.mint} (Sell ${decision.sellPercentage}%, PnL: ${decision.profitPct.toFixed(2)}%)`
        );
        const exitRes = await this.closePosition(pos.id, decision.sellPercentage, decision.reason);
        if (exitRes.success && decision.newExitStage !== priorExitStage) {
          const after = workstationDb.loadPositions(undefined, 'ACTIVE').find((p) => p.id === pos.id);
          if (after) {
            after.exitStage = decision.newExitStage;
            workstationDb.savePosition(after);
          }
        }
      }
    }
  }

  // Periodic Auto Position Monitor driven by ExitEngine (B13)
  private startAutoPositionMonitor() {
    this.autoTpSlInterval = setInterval(async () => {
      await this.evaluateAndProcessExits();
    }, 3000);
  }

  // Collect Comprehensive Truthful Diagnostics
  public getDiagnostics(): SystemDiagnostics {
    const activePositions = workstationDb.loadPositions(this.executionMode, 'ACTIVE');
    const signerStatus = localSigner.getStatus();
    const activeWallet =
      signerStatus === 'READY'
        ? localSigner.getPublicKey().toBase58()
        : 'NO_SIGNER_CONFIGURED';

    const now = Date.now();
    const jitoTelemetry = this.jitoTransport.getTelemetry();

    // Truthful market feed status derived from actual real on-chain events
    let marketFeedHealth: 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED' | 'WARMING_UP' = 'DISCONNECTED';
    let marketFeedLastEventMsAgo: number | null = null;
    if (this.lastRealMarketEventTimestamp > 0) {
      marketFeedLastEventMsAgo = now - this.lastRealMarketEventTimestamp;
      marketFeedHealth = marketFeedLastEventMsAgo < 30000 ? 'HEALTHY' : 'DEGRADED';
    } else if (now - this.startedAt < this.startupGracePeriodMs) {
      marketFeedHealth = 'WARMING_UP';
    } else if (this.lastMarketEventTimestamp > 0) {
      marketFeedLastEventMsAgo = now - this.lastMarketEventTimestamp;
      marketFeedHealth = 'DEGRADED';
    }

    const dailyFees = workstationDb.getDailyFeesPaidLamports(this.executionMode);

    return {
      executionMode: this.executionMode,
      liveTradingActive: this.isLiveTradingArmed,
      killSwitchActive: riskEngine.isKillSwitchActive(),
      circuitBreakerState: riskEngine.getCircuitBreakerState(),
      activeWalletAddress: activeWallet,
      signerStatus,
      rpcEndpoint: this.rpcEndpoint,
      rpcLatencyMs: this.rpcLatencyMs,
      rpcHealth: this.rpcHealth,
      pumpFeedHealth: (this.isDefaultSingleton && this.lastPumpFeedTimestamp === 0 && now - this.startedAt < this.startupGracePeriodMs)
        ? 'WARMING_UP'
        : this.pumpFeedHealth,
      positionMarkHealth: this.positionMarkHealth,
      operatorAlerts: this.getOperatorAlerts(),
      marketFeedHealth,
      marketFeedLastEventMsAgo: marketFeedLastEventMsAgo ?? 0,
      jitoHealth: jitoTelemetry.health === 'OFFLINE' ? 'DISCONNECTED' : jitoTelemetry.health,
      jitoTipFloorLamports: jitoTelemetry.tipFloorLamports ?? 0,
      walletSolBalance: this.realWalletBalanceSol,
      walletSpendableSol:
        this.realWalletBalanceSol !== null
          ? Math.max(0, this.realWalletBalanceSol - 0.015)
          : null,
      openPositionsCount: activePositions.length,
      dailyRealizedPnLSol: workstationDb.getDailyRealizedPnLSol(this.executionMode),
      dailyFeesPaidLamports: dailyFees,
      totalTradesToday: activePositions.length,
      lastConfirmedTradeTime: activePositions[0]?.entryTimestamp || null,
      dbPath: workstationDb.getDbPath(),
      sqliteJournalOk: true,
    };
  }

  public cleanup() {
    if (this.autoTpSlInterval) {
      clearInterval(this.autoTpSlInterval);
      this.autoTpSlInterval = null;
    }
    if (this.jitoProbeInterval) {
      clearInterval(this.jitoProbeInterval);
      this.jitoProbeInterval = null;
    }
    if (this.feedHeartbeatInterval) {
      clearInterval(this.feedHeartbeatInterval);
      this.feedHeartbeatInterval = null;
    }
  }
}

export const executionCoordinator = new ExecutionCoordinator(true);
