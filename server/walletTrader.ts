import { EventEmitter } from 'events';
import { Logger, endpointOrigin } from './middleware/enterprise';
import { executionCoordinator } from './execution/coordinator';
import { localSigner } from './solana/signer';
import { workstationDb } from './db/database';
import { riskEngine } from './risk/riskEngine';
import { ExecutionMode, NormalizedPosition } from './core/types';
import { executionConfig } from './solana/executionConfig';
import { allowedCluster, resolveJitoUrl, resolveRpcUrl } from './solana/clusterGuard';
import { solPriceService } from './market/solPriceService';
import { emergencyStop, type EmergencyStopReport } from './execution/emergencyStop';
import { memecoinAggregator } from './memecoinAggregator';

export interface WalletTraderConfig {
  walletAddress: string;
  rpcEndpoint: string;
  jitoBlockEngineUrl: string;
  jitoTipAccount: string;
  jitoTipSol: number;
  slippageToleranceBps: number;
  capitalTier: 'MICRO_10' | 'INSTITUTIONAL' | 'CUSTOM';
  isLiveTradingActive: boolean;
  riskLimits: {
    maxDailyLossUsd: number;
    maxPositionSizeSol: number;
  };
}

export interface LiveWalletState {
  walletAddress: string;
  signerStatus: 'READY' | 'LOCKED' | 'NOT_CONFIGURED';
  /** The wallet's real SOL balance from the last RPC read; null until one has succeeded. */
  solBalance: number | null;
  solPriceUsd: number | null;
  /**
   * The real balance plus the marked value of the open positions, in dollars; null until both the balance and a SOL price have been
   * read. (Audit 2026-10-22: it used to be built from `allocatedSol`, a constant per capital tier that looked like a wallet figure.)
   * Also null while any open position has no finite mark (none yet, or NaN): such a position used to count as 0, and a NaN mark made
   * the whole total NaN (review 2026-10-24, finding 13).
   */
  totalPortfolioValueUsd: number | null;
  /**
   * The open positions of the current mode, followed (R6-2) by the open LIVE positions when the mode is not LIVE. Each row carries its
   * own `executionMode`, so a LIVE row is labelled as such.
   */
  activePositions: NormalizedPosition[];
  /** Q35: the header pill reads these; it used to read two fields that were never sent. Current mode only (LIVE ones are in `liveOpen`). */
  activePositionsCount: number;
  closedPositionsCount: number;
  /** Realized today (UTC day, as the database keys it), net of fees, from the realized-events ledger. */
  totalRealizedPnLSol: number;
  totalRealizedPnLUsd: number | null;
  /** Marked profit or loss of the open positions (recovered dust is 0 by Q2). */
  totalUnrealizedPnLSol: number;
  totalUnrealizedPnLUsd: number | null;
  totalJitoTipsPaidSol: number;
  executionMode: ExecutionMode;
  isLiveTradingActive: boolean;
  killSwitchActive: boolean;
  rpcLatencyMs: number;
  lastSyncTimestamp: number;
  /**
   * R6-2: real LIVE positions still open while the mode is not LIVE (a kill switch, panic, DISARM or an auto trigger sets PAPER, and their
   * exits keep running). The totals above are the current mode's; these are the LIVE ones, kept apart so paper and real PnL never mix.
   * null when the mode is LIVE (the totals above are LIVE then) or no LIVE position is open.
   */
  liveOpen: LiveOpenSummary | null;
}

export interface LiveOpenSummary {
  count: number;
  unrealizedPnLSol: number;
  unrealizedPnLUsd: number | null;
  /** null when any open LIVE position has no finite mark */
  openValueSol: number | null;
  /** realized LIVE PnL today (UTC day), net of fees */
  realizedTodaySol: number;
  realizedTodayUsd: number | null;
}

export type PanicLiquidationReport = EmergencyStopReport;

class PlugAndPlayWalletTrader extends EventEmitter {
  private config: WalletTraderConfig;

  private syncIntervalTimer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    const execCfg = executionConfig.getConfig();
    this.config = {
      walletAddress: '',
      rpcEndpoint: resolveRpcUrl(),
      jitoBlockEngineUrl: execCfg.jitoBlockEngineUrl,
      jitoTipAccount: execCfg.jitoTipAccount,
      jitoTipSol: execCfg.defaultJitoTipSol,
      slippageToleranceBps: execCfg.maxSlippageBps,
      capitalTier: execCfg.capitalTier,
      isLiveTradingActive: false,
      riskLimits: {
        maxDailyLossUsd: execCfg.maxDailyLossUsd,
        maxPositionSizeSol: execCfg.maxPositionSizeSol,
      },
    };
    this.initWalletAddress();
    this.startBackgroundLoops();
  }

  private initWalletAddress() {
    if (localSigner.getStatus() === 'READY') {
      this.config.walletAddress = localSigner.getPublicKey().toBase58();
    } else {
      this.config.walletAddress = 'NO_SIGNER_CONFIGURED';
    }
  }

  private startBackgroundLoops() {
    this.syncIntervalTimer = setInterval(() => {
      this.syncRpcBalance();
    }, 10000);

    setTimeout(() => this.syncRpcBalance(), 1000);
  }

  public async syncRpcBalance(): Promise<number | null> {
    const bal = await executionCoordinator.syncRealWalletBalance();

    // C3: the single SolPriceService owns fetching, caching and staleness.
    // S26: with APEX_DISABLE_EXTERNAL_FEEDS=true (unit tests, loopback-only child servers) no price host is contacted from this loop.
    if (process.env.APEX_DISABLE_EXTERNAL_FEEDS !== 'true') await solPriceService.refresh();

    this.emit('wallet_state_updated', this.getState());
    return bal;
  }

  // Authoritative snipe dispatch strictly through ExecutionCoordinator
  /**
   * The Plug & Play buy (POST /api/wallet/snipe). R5-40: it runs the same gates as every other manual buy, through
   * memecoinAggregator.executeSnipe: the confluence gate, the freeze-authority and dev-holding pool checks, the capital sizing and
   * recent-expectancy refusals, and the synthetic-pool refusal (an invented pool is never traded, PAPER included). The mode is taken here,
   * before any await, and sent with the order, so a LIVE arm during the reads is refused MODE_CHANGED. A client-sent confluenceScore is
   * refused: the score is the server's to compute.
   */
  public async executeLiveSnipe(order: {
    mint: string;
    symbol?: string;
    name?: string;
    amountSol: number;
    currentPriceSol?: number;
    slippagePct?: number;
    jitoTipSol?: number;
    callerHandle?: string;
    confluenceScore?: number;
    liquidityUsd?: number;
    signalTimestamp?: number;
  }): Promise<{ success: boolean; positionId?: string; txSignature?: string; error?: string }> {
    if (order.confluenceScore !== undefined) {
      return { success: false, error: 'REJECTED: confluenceScore is computed by the server and cannot be supplied by a client' };
    }
    const expectedMode = executionCoordinator.getExecutionMode();
    const res = await memecoinAggregator.executeSnipe({
      contractAddress: order.mint,
      amountUsd: 0,
      operatorAmountSol: order.amountSol, // checked (refused, never clamped) by executeSnipe, as on the other operator routes
      slippagePct: order.slippagePct || 8.0,
      jitoTipSol: order.jitoTipSol || this.config.jitoTipSol,
      // Only the operator route calls this; it does not carry an on-chain signal of its own.
      provenance: 'MANUAL_OPERATOR',
      source: 'MANUAL',
      signalTimestamp: order.signalTimestamp,
      expectedMode,
      noSyntheticPool: true,
    });

    if (res.success) {
      this.emit('wallet_state_updated', this.getState());
      return {
        success: true,
        positionId: res.positionId,
        txSignature: res.execResult?.txSignature ?? (res.txHash || undefined),
      };
    }
    return {
      success: false,
      error: res.message,
    };
  }

  // Authoritative close position dispatch through ExecutionCoordinator
  public async closePosition(
    positionId: string,
    sellPct = 100,
    reason = 'Manual Close'
  ): Promise<{ success: boolean; realizedPnLSol: number; status?: string; error?: string; adoptedPendingSell?: boolean; adoptedPartial?: boolean; remainingTokensRaw?: string }> {
    const res = await executionCoordinator.closePosition(positionId, sellPct, reason);
    this.emit('wallet_state_updated', this.getState());
    return {
      success: res.success,
      realizedPnLSol: res.pnlSol,
      status: res.status,
      error: res.error,
      // R6-9: the close only booked an earlier sell that had landed unseen; with adoptedPartial the position is still open
      ...(res.adoptedPendingSell ? { adoptedPendingSell: true } : {}),
      ...(res.adoptedPartial ? { adoptedPartial: true, remainingTokensRaw: res.remainingTokensRaw } : {}),
    };
  }

  /**
   * Panic: P1.4 makes this the shared emergency stop (kill switch, auto killed after its buy in flight, LIVE disarmed, every ACTIVE
   * position of every mode sold with EMERGENCY_PANIC_LIQUIDATION, the list read again once after the loop). See emergencyStop.ts.
   */
  public async panicLiquidateAll(reason = 'panic liquidate'): Promise<PanicLiquidationReport> {
    this.config.isLiveTradingActive = false;
    try {
      return await emergencyStop({ exitAll: true, reason });
    } finally {
      this.emit('wallet_state_updated', this.getState());
    }
  }

  /**
   * Throws (before changing anything) when a value is refused: a position size above the environment ceiling, a Jito URL this cluster
   * does not allow, or an RPC endpoint the cluster guard refuses or cannot reach. Only the fields that are present are changed (3G).
   */
  public async updateConfig(newConfig: Partial<WalletTraderConfig>): Promise<WalletTraderConfig> {
    // R8s: the HTTP API may lower the per-trade size but not raise it past what the environment and capital tier allow
    // (MAX_POSITION_SIZE_SOL). Checked first, so a refused request changes nothing.
    const ceiling = executionConfig.getConfig().maxPositionSizeSol;
    const requested = newConfig.riskLimits?.maxPositionSizeSol;
    if (requested !== undefined && requested > ceiling) {
      throw new Error(`maxPositionSizeSol ${requested} exceeds the configured ceiling ${ceiling} SOL; raise MAX_POSITION_SIZE_SOL in the environment and restart to allow more`);
    }
    // 3G (N-19): the Jito URL is checked before anything changes. It used to be stored, and the RPC switched, before the transport
    // refused it, so a 400 left the request half applied. `undefined` leaves Jito alone and '' turns it off (N-8).
    const jitoUrl = newConfig.jitoBlockEngineUrl;
    if (jitoUrl !== undefined && jitoUrl.trim() !== '' && resolveJitoUrl(jitoUrl) === '') {
      throw new Error(
        allowedCluster() === 'localnet'
          ? 'CLUSTER_GUARD: Jito is not used on localnet; send an empty jitoBlockEngineUrl or leave it out'
          : 'CLUSTER_GUARD: refusing to configure a mainnet Jito block engine URL'
      );
    }
    if (newConfig.rpcEndpoint && newConfig.rpcEndpoint !== this.config.rpcEndpoint) {
      const switched = await executionCoordinator.setRpcEndpoint(newConfig.rpcEndpoint);
      if (!switched.success) throw new Error(`RPC endpoint rejected: ${switched.error ?? 'unknown error'}`);
      this.config.rpcEndpoint = newConfig.rpcEndpoint;
    }
    if (jitoUrl !== undefined) {
      executionCoordinator.setJitoBlockEngineUrl(jitoUrl);
      this.config.jitoBlockEngineUrl = resolveJitoUrl(jitoUrl); // as the transport resolves it: '' when off
    }
    if (newConfig.jitoTipSol !== undefined) this.config.jitoTipSol = newConfig.jitoTipSol;
    if (newConfig.slippageToleranceBps !== undefined) this.config.slippageToleranceBps = newConfig.slippageToleranceBps;
    if (newConfig.capitalTier) this.config.capitalTier = newConfig.capitalTier;
    const limits = newConfig.riskLimits;
    if (limits) {
      // 3G (N-67): only the limits that were sent. maxDailyLossUsd is never taken from a request (the route refuses it): the risk
      // engine reads MAX_DAILY_LOSS_USD, so the stored value stays the environment's.
      if (limits.maxPositionSizeSol !== undefined) {
        this.config.riskLimits.maxPositionSizeSol = limits.maxPositionSizeSol;
        // C3: the daily-loss limit stays derived from the live SOL price inside the risk engine; only the size is pushed.
        riskEngine.updateLimits({ maxPositionSol: limits.maxPositionSizeSol });
      }
    }

    Logger.info('Wallet Trader configuration updated', {
      wallet: this.config.walletAddress,
      tier: this.config.capitalTier,
    });

    this.syncRpcBalance();
    return this.config;
  }

  public getConfig(): WalletTraderConfig {
    return { ...this.config, riskLimits: { ...this.config.riskLimits } };
  }

  /** The config as the API shows it (Q54, 3G): the RPC and Jito URLs as their origin only, so no key in a path or query is returned. */
  public getPublicConfig(): WalletTraderConfig {
    return { ...this.getConfig(), rpcEndpoint: endpointOrigin(this.config.rpcEndpoint), jitoBlockEngineUrl: endpointOrigin(this.config.jitoBlockEngineUrl) };
  }

  public getState(): LiveWalletState {
    const mode = executionCoordinator.getExecutionMode();
    const modePositions = executionCoordinator.getPositions(mode, 'ACTIVE');
    // R6-2: after a disarm the mode is PAPER while real LIVE positions stay open; they are always listed, labelled by executionMode
    const liveOpenPositions = mode === 'LIVE' ? [] : executionCoordinator.getPositions('LIVE', 'ACTIVE');
    const activePositions = modePositions;
    const closedPositions = executionCoordinator.getPositions(mode, 'CLOSED');
    // null when any open position is unpriced: a total that silently leaves one out would read as a real figure
    const totalOpenValue = activePositions.every((p) => Number.isFinite(p.currentValueSol))
      ? activePositions.reduce((s, p) => s + (p.currentValueSol as number), 0)
      : null;
    const diag = executionCoordinator.getDiagnostics();

    const solPriceUsd = solPriceService.lastKnownPrice(); // null when no price has ever been read
    const totalPortfolioValueUsd = solPriceUsd === null || diag.walletSolBalance === null || totalOpenValue === null ? null : (diag.walletSolBalance + totalOpenValue) * solPriceUsd;
    const totalUnrealizedPnLSol = activePositions.reduce((s, p) => s + (Number.isFinite(p.unrealizedPnLSol) ? (p.unrealizedPnLSol as number) : 0), 0);
    const totalRealizedPnLSol = workstationDb.getDailyRealizedPnLSol(mode);
    const totalRealizedPnLUsd = solPriceUsd === null ? null : totalRealizedPnLSol * solPriceUsd;

    const liveUnrealizedSol = liveOpenPositions.reduce((s, p) => s + (Number.isFinite(p.unrealizedPnLSol) ? (p.unrealizedPnLSol as number) : 0), 0);
    const liveRealizedSol = liveOpenPositions.length ? workstationDb.getDailyRealizedPnLSol('LIVE') : 0;
    const liveOpen: LiveOpenSummary | null = liveOpenPositions.length === 0 ? null : {
      count: liveOpenPositions.length,
      unrealizedPnLSol: Number(liveUnrealizedSol.toFixed(6)),
      unrealizedPnLUsd: solPriceUsd === null ? null : Number((liveUnrealizedSol * solPriceUsd).toFixed(2)),
      openValueSol: liveOpenPositions.every((p) => Number.isFinite(p.currentValueSol)) ? liveOpenPositions.reduce((s, p) => s + (p.currentValueSol as number), 0) : null,
      realizedTodaySol: Number(liveRealizedSol.toFixed(4)),
      realizedTodayUsd: solPriceUsd === null ? null : Number((liveRealizedSol * solPriceUsd).toFixed(2)),
    };

    const totalJitoTipsPaidSol = activePositions.reduce((s, p) => s + (p.jitoTipLamports ?? 0) / 1e9, 0);

    const signerStatus = localSigner.getStatus();
    const walletAddress =
      signerStatus === 'READY'
        ? localSigner.getPublicKey().toBase58()
        : 'NO_SIGNER_CONFIGURED';

    return {
      walletAddress,
      signerStatus,
      solBalance: diag.walletSolBalance,
      solPriceUsd: solPriceUsd === null ? null : Number(solPriceUsd.toFixed(2)),
      totalPortfolioValueUsd: totalPortfolioValueUsd === null ? null : Number(totalPortfolioValueUsd.toFixed(2)),
      activePositions: [...modePositions, ...liveOpenPositions],
      activePositionsCount: modePositions.length,
      closedPositionsCount: closedPositions.length,
      totalRealizedPnLSol: Number(totalRealizedPnLSol.toFixed(4)),
      totalRealizedPnLUsd: totalRealizedPnLUsd === null ? null : Number(totalRealizedPnLUsd.toFixed(2)),
      totalUnrealizedPnLSol: Number(totalUnrealizedPnLSol.toFixed(6)),
      totalUnrealizedPnLUsd: solPriceUsd === null ? null : Number((totalUnrealizedPnLSol * solPriceUsd).toFixed(2)),
      totalJitoTipsPaidSol: Number(totalJitoTipsPaidSol.toFixed(4)),
      executionMode: mode,
      isLiveTradingActive: executionCoordinator.isLiveArmed(),
      killSwitchActive: riskEngine.isKillSwitchActive(),
      rpcLatencyMs: diag.rpcLatencyMs,
      lastSyncTimestamp: Date.now(),
      liveOpen,
    };
  }
}

export const walletTrader = new PlugAndPlayWalletTrader();
