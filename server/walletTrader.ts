import { EventEmitter } from 'events';
import { Logger } from './middleware/enterprise';
import { executionCoordinator } from './execution/coordinator';
import { localSigner } from './solana/signer';
import { workstationDb } from './db/database';
import { riskEngine } from './risk/riskEngine';
import { ExecutionMode, NormalizedPosition } from './core/types';
import { executionConfig } from './solana/executionConfig';
import { resolveRpcUrl } from './solana/clusterGuard';

export interface WalletTraderConfig {
  walletAddress: string;
  rpcEndpoint: string;
  wsRpcEndpoint?: string;
  jitoBlockEngineUrl: string;
  jitoTipAccount: string;
  jitoTipSol: number;
  slippageToleranceBps: number;
  capitalTier: 'MICRO_10' | 'INSTITUTIONAL' | 'CUSTOM';
  allocatedSol: number;
  isLiveTradingActive: boolean;
  enabledStrategies: {
    pumpFunSniper: boolean;
    marketMaking: boolean;
    crossArb: boolean;
    momentumScalp: boolean;
  };
  riskLimits: {
    maxDailyLossUsd: number;
    maxPositionSizeSol: number;
    stopLossPct: number;
    takeProfitMultiple: number;
    requireConfluenceScore: number;
  };
}

export interface LiveWalletState {
  walletAddress: string;
  signerStatus: 'READY' | 'LOCKED' | 'NOT_CONFIGURED';
  solBalance: number | null;
  allocatedSol: number;
  availableSol: number;
  solPriceUsd: number;
  totalPortfolioValueUsd: number;
  activePositions: NormalizedPosition[];
  closedPositionsCount: number;
  totalRealizedPnLSol: number;
  totalRealizedPnLUsd: number;
  totalJitoTipsPaidSol: number;
  executionMode: ExecutionMode;
  isLiveTradingActive: boolean;
  killSwitchActive: boolean;
  rpcLatencyMs: number;
  lastSyncTimestamp: number;
}

export interface PanicLiquidationReport {
  attemptedCount: number;
  succeeded: Array<{ id: string; symbol: string; pnlSol: number; status?: string }>;
  failed: Array<{ id: string; symbol: string; error: string }>;
  totalRealizedPnLSol: number;
  killSwitchActivated: boolean;
}

class PlugAndPlayWalletTrader extends EventEmitter {
  private config: WalletTraderConfig;

  private solPriceUsd = 145.0;
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
      allocatedSol: execCfg.capitalTier === 'MICRO_10' ? 0.07 : 5.0,
      isLiveTradingActive: false,
      enabledStrategies: {
        pumpFunSniper: true,
        marketMaking: false,
        crossArb: false,
        momentumScalp: false,
      },
      riskLimits: {
        maxDailyLossUsd: execCfg.maxDailyLossUsd,
        maxPositionSizeSol: execCfg.maxPositionSizeSol,
        stopLossPct: 20,
        takeProfitMultiple: 1.5,
        requireConfluenceScore: 70,
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

    let fetchedPrice: number | null = null;

    // 1. Primary: Binance SOLUSDT (if available / non-geoblocked)
    try {
      const priceRes = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', {
        signal: AbortSignal.timeout(3000),
      });
      if (priceRes.ok) {
        const pData = (await priceRes.json()) as any;
        if (pData?.price) {
          const parsed = parseFloat(pData.price);
          if (parsed > 0) fetchedPrice = parsed;
        }
      }
    } catch {}

    // 2. Secondary: Jupiter DEX Price API v6 (Solana-native, non-geoblocked) (B23)
    if (!fetchedPrice) {
      try {
        const jupRes = await fetch('https://price.jup.ag/v6/price?ids=SOL', {
          signal: AbortSignal.timeout(3000),
        });
        if (jupRes.ok) {
          const jData = (await jupRes.json()) as any;
          if (jData?.data?.SOL?.price) {
            const parsed = parseFloat(jData.data.SOL.price);
            if (parsed > 0) fetchedPrice = parsed;
          }
        }
      } catch {}
    }

    // 3. Tertiary: CoinGecko SOL/USD Price API
    if (!fetchedPrice) {
      try {
        const cgRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {
          signal: AbortSignal.timeout(3000),
        });
        if (cgRes.ok) {
          const cgData = (await cgRes.json()) as any;
          if (cgData?.solana?.usd) {
            const parsed = parseFloat(cgData.solana.usd);
            if (parsed > 0) fetchedPrice = parsed;
          }
        }
      } catch {}
    }

    if (fetchedPrice && fetchedPrice > 0) {
      this.solPriceUsd = fetchedPrice;
    }

    this.emit('wallet_state_updated', this.getState());
    return bal;
  }

  // Authoritative snipe dispatch strictly through ExecutionCoordinator
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
    const res = await executionCoordinator.executeTrade({
      mint: order.mint,
      symbol: order.symbol || order.mint.slice(0, 6).toUpperCase(),
      name: order.name || `Solana Token (${order.mint.slice(0, 4)}...${order.mint.slice(-4)})`,
      amountSol: order.amountSol,
      currentPriceSol: order.currentPriceSol, // No invented fallback price! Coordinator queries on-chain bonding curve
      slippageBps: Math.round((order.slippagePct || 8.0) * 100),
      jitoTipSol: order.jitoTipSol || this.config.jitoTipSol,
      source: 'AUTO_SNIPER',
      provenance: 'REAL_ONCHAIN',
      liquidityUsd: order.liquidityUsd,
      signalTimestamp: order.signalTimestamp,
    });

    if (res.success) {
      this.emit('wallet_state_updated', this.getState());
      return {
        success: true,
        positionId: res.positionId,
        txSignature: res.txSignature,
      };
    } else {
      return {
        success: false,
        error: res.error,
      };
    }
  }

  // Authoritative close position dispatch through ExecutionCoordinator
  public async closePosition(
    positionId: string,
    sellPct = 100,
    reason = 'Manual Close'
  ): Promise<{ success: boolean; realizedPnLSol: number; status?: string; error?: string }> {
    const res = await executionCoordinator.closePosition(positionId, sellPct, reason);
    this.emit('wallet_state_updated', this.getState());
    return {
      success: res.success,
      realizedPnLSol: res.pnlSol,
      status: res.status,
      error: res.error,
    };
  }

  // Safe panic liquidator with detailed per-position reporting
  public async panicLiquidateAll(): Promise<PanicLiquidationReport> {
    // 1. Engage Emergency Kill Switch & Disarm Live Entry FIRST to immediately block new incoming orders
    riskEngine.setKillSwitch(true);
    executionCoordinator.armLiveTrading(false);
    this.config.isLiveTradingActive = false;

    // 2. Enumerate all active holdings (both OPEN and PARTIALLY_CLOSED) across all modes
    const activePositions = workstationDb.loadPositions(undefined, 'ACTIVE');
    const succeeded: Array<{ id: string; symbol: string; pnlSol: number; status?: string }> = [];
    const failed: Array<{ id: string; symbol: string; error: string }> = [];
    let totalRealized = 0;

    // 3. Liquidate each holding
    for (const pos of activePositions) {
      try {
        const res = await executionCoordinator.closePosition(pos.id, 100, 'EMERGENCY_PANIC_LIQUIDATION');
        if (res.success) {
          succeeded.push({ id: pos.id, symbol: pos.symbol, pnlSol: res.pnlSol, status: res.status });
          totalRealized += res.pnlSol;
        } else {
          failed.push({ id: pos.id, symbol: pos.symbol, error: res.error || 'Execution failed' });
        }
      } catch (err: any) {
        failed.push({ id: pos.id, symbol: pos.symbol, error: err.message });
      }
    }

    Logger.warn(
      `PANIC LIQUIDATE REPORT: Attempted ${activePositions.length}, Succeeded ${succeeded.length}, Failed ${failed.length}. Emergency kill switch active.`
    );
    this.emit('wallet_state_updated', this.getState());

    return {
      attemptedCount: activePositions.length,
      succeeded,
      failed,
      totalRealizedPnLSol: totalRealized,
      killSwitchActivated: true,
    };
  }

  public updateConfig(newConfig: Partial<WalletTraderConfig>): WalletTraderConfig {
    if (newConfig.rpcEndpoint) {
      this.config.rpcEndpoint = newConfig.rpcEndpoint;
      executionCoordinator.setRpcEndpoint(newConfig.rpcEndpoint);
    }
    if (newConfig.jitoBlockEngineUrl) {
      this.config.jitoBlockEngineUrl = newConfig.jitoBlockEngineUrl;
      executionCoordinator.setJitoBlockEngineUrl(newConfig.jitoBlockEngineUrl);
    }
    if (newConfig.jitoTipSol !== undefined) this.config.jitoTipSol = newConfig.jitoTipSol;
    if (newConfig.slippageToleranceBps !== undefined) this.config.slippageToleranceBps = newConfig.slippageToleranceBps;
    if (newConfig.capitalTier) this.config.capitalTier = newConfig.capitalTier;
    if (newConfig.allocatedSol !== undefined) this.config.allocatedSol = newConfig.allocatedSol;

    if (newConfig.enabledStrategies) {
      this.config.enabledStrategies = { ...this.config.enabledStrategies, ...newConfig.enabledStrategies };
    }
    if (newConfig.riskLimits) {
      this.config.riskLimits = { ...this.config.riskLimits, ...newConfig.riskLimits };
      riskEngine.updateLimits({
        maxDailyLossSol: newConfig.riskLimits.maxDailyLossUsd / this.solPriceUsd,
        maxPositionSol: newConfig.riskLimits.maxPositionSizeSol,
      });
    }

    Logger.info('Wallet Trader configuration updated', {
      wallet: this.config.walletAddress,
      allocatedSol: this.config.allocatedSol,
      tier: this.config.capitalTier,
    });

    this.syncRpcBalance();
    return this.config;
  }

  public getConfig(): WalletTraderConfig {
    return { ...this.config };
  }

  public getState(): LiveWalletState {
    const mode = executionCoordinator.getExecutionMode();
    const activePositions = executionCoordinator.getPositions(mode, 'ACTIVE');
    const closedPositions = executionCoordinator.getPositions(mode, 'CLOSED');
    const totalOpenCost = activePositions.reduce((s, p) => s + p.costBasisLamports / 1e9, 0);
    const totalOpenValue = activePositions.reduce((s, p) => s + p.currentValueSol, 0);
    const availableSol = Math.max(0, this.config.allocatedSol - totalOpenCost);

    const totalPortfolioValueUsd = (availableSol + totalOpenValue) * this.solPriceUsd;
    const totalRealizedPnLSol = workstationDb.getDailyRealizedPnLSol(mode);
    const totalRealizedPnLUsd = totalRealizedPnLSol * this.solPriceUsd;

    const totalJitoTipsPaidSol = activePositions.reduce((s, p) => s + p.jitoTipLamports / 1e9, 0);

    const signerStatus = localSigner.getStatus();
    const walletAddress =
      signerStatus === 'READY'
        ? localSigner.getPublicKey().toBase58()
        : 'NO_SIGNER_CONFIGURED';

    const diag = executionCoordinator.getDiagnostics();

    return {
      walletAddress,
      signerStatus,
      solBalance: diag.walletSolBalance,
      allocatedSol: this.config.allocatedSol,
      availableSol: Number(availableSol.toFixed(4)),
      solPriceUsd: Number(this.solPriceUsd.toFixed(2)),
      totalPortfolioValueUsd: Number(totalPortfolioValueUsd.toFixed(2)),
      activePositions,
      closedPositionsCount: closedPositions.length,
      totalRealizedPnLSol: Number(totalRealizedPnLSol.toFixed(4)),
      totalRealizedPnLUsd: Number(totalRealizedPnLUsd.toFixed(2)),
      totalJitoTipsPaidSol: Number(totalJitoTipsPaidSol.toFixed(4)),
      executionMode: mode,
      isLiveTradingActive: executionCoordinator.isLiveArmed(),
      killSwitchActive: riskEngine.isKillSwitchActive(),
      rpcLatencyMs: diag.rpcLatencyMs,
      lastSyncTimestamp: Date.now(),
    };
  }
}

export const walletTrader = new PlugAndPlayWalletTrader();
