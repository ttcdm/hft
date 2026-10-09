import { MemecoinPool, SniperPosition, SniperBotConfig } from '../src/types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { PumpCurveService } from './solana/pumpCurve';
import { executionCoordinator } from './execution/coordinator';
import { workstationDb } from './db/database';
import { evaluateTokenSafety } from './risk/tokenSafety';
import { pumpFeedListener, PumpCreateEvent } from './solana/pumpFeedListener';
import { SignalProvenance, ConfluenceBreakdown } from './core/types';
import { CapitalSizer } from './capital/capitalSizer';
import { ConfluenceEngine, isConfluencePassed, MIN_CONFLUENCE_SCORE } from './signals/confluenceEngine';
import { curveVelocityEvaluator } from './signals/curveVelocityEvaluator';

const INITIAL_POOLS: MemecoinPool[] = [
  {
    id: 'pool-pump-01',
    platform: 'PUMP_FUN',
    chain: 'SOLANA',
    symbol: 'GOAT',
    name: 'Goatseus Maximus',
    contractAddress: 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS',
    priceUsd: 0.000342,
    priceNative: 0.00000235,
    marketCapUsd: 342000,
    liquidityUsd: 64200,
    bondingCurveProgress: 88.5,
    isMigrated: false,
    volume5mUsd: 28400,
    volume1hUsd: 142000,
    volume24hUsd: 890000,
    priceChange5mPct: 4.8,
    priceChange1hPct: 12.5,
    buys5m: 148,
    sells5m: 82,
    top10HoldersPct: 14.2,
    devHoldingPct: 0.0,
    isMintRevoked: true,
    isFreezeRevoked: true,
    isLpBurned: false,
    rugcheckScore: 'SAFE',
    createdAgo: '18m ago',
    trendingRank: 1,
  },
  {
    id: 'pool-ray-02',
    platform: 'RAYDIUM',
    chain: 'SOLANA',
    symbol: 'MOODENG',
    name: 'Moo Deng',
    contractAddress: 'ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY',
    priceUsd: 0.00184,
    priceNative: 0.0000126,
    marketCapUsd: 1840000,
    liquidityUsd: 215000,
    bondingCurveProgress: 100,
    isMigrated: true,
    volume5mUsd: 48200,
    volume1hUsd: 310000,
    volume24hUsd: 3400000,
    priceChange5mPct: -1.2,
    priceChange1hPct: 8.4,
    buys5m: 120,
    sells5m: 115,
    top10HoldersPct: 11.5,
    devHoldingPct: 0.5,
    isMintRevoked: true,
    isFreezeRevoked: true,
    isLpBurned: true,
    rugcheckScore: 'SAFE',
    createdAgo: '2h 14m ago',
    trendingRank: 2,
  },
  {
    id: 'pool-dex-03',
    platform: 'DEXSCREENER',
    chain: 'SOLANA',
    symbol: 'PNUT',
    name: 'Peanut the Squirrel',
    contractAddress: '2qEH8vxXMwYePYNpdkmcz69g78mXfW7kG2bV3e7X6h8L',
    priceUsd: 0.00642,
    priceNative: 0.0000441,
    marketCapUsd: 6420000,
    liquidityUsd: 580000,
    bondingCurveProgress: 100,
    isMigrated: true,
    volume5mUsd: 68100,
    volume1hUsd: 540000,
    volume24hUsd: 8200000,
    priceChange5mPct: -2.8,
    priceChange1hPct: 4.1,
    buys5m: 115,
    sells5m: 140,
    top10HoldersPct: 9.8,
    devHoldingPct: 0.0,
    isMintRevoked: true,
    isFreezeRevoked: true,
    isLpBurned: true,
    rugcheckScore: 'SAFE',
    createdAgo: '4h 30m ago',
    trendingRank: 3,
  },
];

const DEMO_POOL_IDS: ReadonlySet<string> = new Set(INITIAL_POOLS.map((p) => p.id));

export class MemecoinAggregatorService extends EventEmitter {
  private pools: MemecoinPool[] = [];
  private solPriceUsd = 145.0;
  private simulationTimer: NodeJS.Timeout | null = null;
  private config: SniperBotConfig = {
    isAutoSnipeEnabled: false,
    minConfidenceScore: 80,
    defaultSnipeAmountUsd: 5.0,
    maxSlippagePct: 6.0,
    jitoTipSol: 0.002,
    takeProfitPct: 45.0,
    stopLossPct: 20.0,
    trailingStopEnabled: true,
    requireMintRevoked: true,
    requireFreezeRevoked: true,
    maxDevHoldingPct: 5.0,
    telegramBotToken: '',
    telegramChatId: '',
    telegramWebhookActive: false,
  };
  private isConfluenceGatingEnabled: boolean = false;

  constructor() {
    super();
    if (process.env.DEMO_MODE === 'true') {
      this.pools = [...INITIAL_POOLS];
      this.startPriceSimulation();
    } else {
      this.pools = [];
    }

    // Wire real Solana WebSocket listener into aggregator (B08)
    pumpFeedListener.on('create_event', (event: PumpCreateEvent) => {
      this.ingestOnChainCreateEvent(event);
    });

    this.startAutonomousSniperLoop();
  }

  private autoSniperTimer: NodeJS.Timeout | null = null;

  private startAutonomousSniperLoop() {
    if (this.autoSniperTimer) return;
    this.autoSniperTimer = setInterval(async () => {
      if (!this.config.isAutoSnipeEnabled || process.env.AUTO_SNIPE_ENABLED !== 'true') return;
      
      const mode = executionCoordinator.getExecutionMode();
      const activePositions = executionCoordinator.getPositions(mode, 'ACTIVE');
      if (activePositions.length >= 3) return;

      try {
        const { pumpFunService, calloutProvenance } = await import('./pumpfunService');
        const callouts = pumpFunService.getHotCallouts();

        for (const c of callouts) {
          if (c.token.bondingCurveProgress >= 95) continue;
          const mint = c.token.mint;
          const alreadyOpen = activePositions.some((p) => p.mint.toLowerCase() === mint.toLowerCase());
          if (alreadyOpen) continue;

          await this.executeSnipe({
            contractAddress: mint,
            amountUsd: this.config.defaultSnipeAmountUsd || 5.0,
            platform: 'PUMP_FUN',
            jitoTipSol: this.config.jitoTipSol || 0.002,
            slippagePct: this.config.maxSlippagePct || 6.0,
            signalId: c.id,
            provenance: calloutProvenance(c),
          });
          break;
        }
      } catch {}
    }, 5000);
  }

  /**
   * Ingest real on-chain Pump.fun V2 CreateEvent parsed from Solana WebSocket logs
   */
  public ingestOnChainCreateEvent(event: PumpCreateEvent): MemecoinPool {
    const cleanCa = event.mint.trim();
    const existing = this.pools.find((p) => p.contractAddress.toLowerCase() === cleanCa.toLowerCase());
    // Record initial transition in curve velocity evaluator (B14)
    curveVelocityEvaluator.recordTransition(
      cleanCa,
      event.slot,
      Number(event.realSolReserves) / 1e9,
      event.receivedAt
    );

    if (existing) {
      existing.priceNative = event.initialPriceSol;
      existing.priceUsd = event.initialPriceSol * this.solPriceUsd;
      existing.marketCapUsd = event.initialMarketCapSol * this.solPriceUsd;
      this.emit('price_update', { pool: existing });
      return existing;
    }

    const priceUsd = event.initialPriceSol * this.solPriceUsd;
    const marketCapUsd = event.initialMarketCapSol * this.solPriceUsd;
    const pool: MemecoinPool = {
      id: `pool-onchain-${cleanCa.slice(0, 8)}`,
      platform: 'PUMP_FUN',
      chain: 'SOLANA',
      symbol: event.symbol || cleanCa.slice(0, 5).toUpperCase(),
      name: event.name || `Token ${cleanCa.slice(0, 4)}...${cleanCa.slice(-4)}`,
      contractAddress: cleanCa,
      priceUsd,
      priceNative: event.initialPriceSol,
      marketCapUsd,
      liquidityUsd: 0,
      bondingCurveProgress: 0.0,
      isMigrated: false,
      volume5mUsd: 0,
      volume1hUsd: 0,
      volume24hUsd: 0,
      priceChange5mPct: 0.0,
      priceChange1hPct: 0.0,
      buys5m: 0,
      sells5m: 0,
      top10HoldersPct: -1, // -1 denotes UNKNOWN until on-chain holder query
      devHoldingPct: -1,   // -1 denotes UNKNOWN until on-chain holder query
      isMintRevoked: true,
      isFreezeRevoked: true,
      isLpBurned: false,
      rugcheckScore: 'SAFE',
      createdAgo: 'Just now (WS)',
      trendingRank: 0,
    };

    this.pools.unshift(pool);
    if (this.pools.length > 200) {
      this.pools = this.pools.slice(0, 200);
    }

    this.emit('pool_added', pool);
    return pool;
  }

  public getPools(platform?: string, chain?: string): MemecoinPool[] {
    let result = this.pools;
    if (platform) {
      result = result.filter((p) => p.platform.toLowerCase() === platform.toLowerCase());
    }
    if (chain) {
      result = result.filter((p) => p.chain.toLowerCase() === chain.toLowerCase());
    }
    return result;
  }

  // Canonical positions mapped from single authoritative SQLite store via ExecutionCoordinator
  public getPositions(): SniperPosition[] {
    const mode = executionCoordinator.getExecutionMode();
    const rawPositions = executionCoordinator.getPositions(mode);

    return rawPositions.map((p) => {
      const tokenQty = Number(p.tokenQuantityRaw) / Math.pow(10, p.tokenDecimals);
      const entryPriceUsd = p.entryPriceSol * this.solPriceUsd;
      const currentPriceUsd = p.currentPriceSol * this.solPriceUsd;
      const costBasisUsd = (p.costBasisLamports / 1e9) * this.solPriceUsd;
      const currentValueUsd = p.currentValueSol * this.solPriceUsd;
      const unrealizedPnlUsd = p.unrealizedPnLSol * this.solPriceUsd;

      return {
        id: p.id,
        tokenTicker: `$${p.symbol}`,
        tokenName: p.name,
        contractAddress: p.mint,
        platform: 'PUMP_FUN',
        chain: 'SOLANA',
        entryPriceUsd,
        currentPriceUsd,
        quantityTokens: tokenQty,
        costBasisUsd,
        currentValueUsd,
        unrealizedPnlUsd,
        unrealizedPnlPct: p.unrealizedPnLPct,
        targetTpPct: this.config.takeProfitPct,
        targetSlPct: -this.config.stopLossPct,
        priorityFeeSol: p.jitoTipLamports / 1e9,
        openedAt: p.entryTimestamp,
        status: p.status === 'OPEN' || p.status === 'PARTIALLY_CLOSED' ? 'OPEN' : 'CLOSED',
        txHash: p.entryTxSignature,
      };
    });
  }

  public getConfig(): SniperBotConfig {
    return this.config;
  }

  public updateConfig(newConfig: Partial<SniperBotConfig>): SniperBotConfig {
    this.config = { ...this.config, ...newConfig };
    this.emit('config_updated', this.config);
    return this.config;
  }

  public setConfluenceGating(enabled: boolean): void {
    this.isConfluenceGatingEnabled = enabled;
  }

  public getConfluenceGating(): boolean {
    return this.isConfluenceGatingEnabled;
  }

  public evaluateTokenConfluence(poolOrMint: MemecoinPool | string): {
    score: number;
    passed: boolean;
    breakdown: ConfluenceBreakdown;
  } {
    let pool: MemecoinPool | undefined;
    if (typeof poolOrMint === 'string') {
      pool = this.pools.find((p) => p.contractAddress.toLowerCase() === poolOrMint.trim().toLowerCase());
    } else {
      pool = poolOrMint;
    }

    const mint = pool ? pool.contractAddress : typeof poolOrMint === 'string' ? poolOrMint : '';
    const priceChange5mPct = pool?.priceChange5mPct ?? 0;
    const liquidityUsd = pool?.liquidityUsd ?? 0;
    const top10HoldersPct = pool?.top10HoldersPct !== undefined && pool.top10HoldersPct >= 0 ? pool.top10HoldersPct : 20;
    const bondingCurveProgress = pool?.bondingCurveProgress ?? 0;
    const buys5m = pool?.buys5m ?? 0;
    const sells5m = pool?.sells5m ?? 0;
    const devHoldingPct = pool?.devHoldingPct !== undefined && pool.devHoldingPct >= 0 ? pool.devHoldingPct : 0;
    const hasVerifiedSocialCall =
      (pool?.trendingRank !== undefined && pool.trendingRank > 0) ||
      (pool?.volume5mUsd !== undefined && pool.volume5mUsd > 10000);
    const socialCallCount = pool?.trendingRank ? Math.max(1, 4 - pool.trendingRank) : 0;

    const breakdown = ConfluenceEngine.calculate({
      mint,
      priceChange5mPct,
      liquidityUsd,
      top10HoldersPct,
      bondingCurveProgress,
      buys5m,
      sells5m,
      devHoldingPct,
      hasVerifiedSocialCall,
      socialCallCount,
    });

    return {
      score: breakdown.compositeScore,
      passed: isConfluencePassed(breakdown.compositeScore),
      breakdown,
    };
  }

  // Execution routed STRICTLY through authoritative ExecutionCoordinator
  public async executeSnipe(params: {
    contractAddress: string;
    amountUsd: number;
    platform?: string;
    jitoTipSol?: number;
    slippagePct?: number;
    signalId?: string;
    provenance?: SignalProvenance;
    enforceConfluence?: boolean;
    minConfluenceScore?: number;
  }): Promise<{ success: boolean; message: string; txHash: string; position?: SniperPosition; confluenceScore?: number }> {
    const cleanCa = params.contractAddress.trim();

    // Sizing via CapitalSizer (B12): determine spendable bankroll and 10% ceiling
    const executionMode = executionCoordinator.getExecutionMode();
    const walletBalanceSol = executionCoordinator.getRealWalletBalanceSol() ?? 0.07;
    const historicalStats = CapitalSizer.getHistoricalTradeStats(executionMode);
    const sizingResult = CapitalSizer.calculateOrderSize({
      walletBalanceSol,
      historicalTradeCount: historicalStats.tradeCount,
      winProbability: historicalStats.winRate,
      winLossRatio: historicalStats.winLossRatio,
    });

    // Cold start: with no closed-trade history Kelly is 0 (p=0.5, b=1), which would reject every first LIVE trade and
    // so never create any history. Until CapitalSizer.SHRINKAGE_PRIOR_WEIGHT (25) closed trades exist, a zero-expectancy
    // rejection falls through to the fixed-size path below: the requested or default amount, capped at 10% of spendable
    // bankroll, and still subject to every RiskEngine limit. Real negative expectancy (25+ trades) still rejects.
    const isColdStart =
      historicalStats.tradeCount < CapitalSizer.SHRINKAGE_PRIOR_WEIGHT &&
      sizingResult.rejectionReason === 'NEGATIVE_OR_ZERO_EXPECTANCY';
    if (executionMode === 'LIVE' && !sizingResult.approved && !isColdStart) {
      return {
        success: false,
        message: `REJECTED: Capital sizing failed (${sizingResult.rejectionReason})`,
        txHash: '',
      };
    }

    let amountSol: number;
    let amountUsd: number;

    if (params.amountUsd && params.amountUsd > 0) {
      amountUsd = params.amountUsd;
      amountSol = amountUsd / this.solPriceUsd;

      // Cap at 10% of spendable bankroll
      const spendable = sizingResult.spendableBankrollSol;
      const maxAllowedSol = Number((spendable * 0.10).toFixed(6));
      if (spendable > 0 && amountSol > maxAllowedSol) {
        amountSol = maxAllowedSol;
        amountUsd = amountSol * this.solPriceUsd;
      }
    } else if (sizingResult.approved && sizingResult.orderSizeSol > 0) {
      amountSol = sizingResult.orderSizeSol;
      amountUsd = amountSol * this.solPriceUsd;
    } else {
      amountUsd = Math.max(1.0, this.config.defaultSnipeAmountUsd);
      amountSol = amountUsd / this.solPriceUsd;
      const spendable = sizingResult.spendableBankrollSol;
      const maxAllowedSol = Number((spendable * 0.10).toFixed(6));
      if (spendable > 0 && amountSol > maxAllowedSol) {
        amountSol = maxAllowedSol;
        amountUsd = amountSol * this.solPriceUsd;
      }
    }

    const slippageBps = Math.round((params.slippagePct || this.config.maxSlippagePct) * 100);
    const jitoTipSol = params.jitoTipSol || this.config.jitoTipSol;

    let pool = this.pools.find((p) => p.contractAddress.toLowerCase() === cleanCa.toLowerCase());

    if (!pool) {
      try {
        const mintPubkey = new PublicKey(cleanCa);
        const currentMode = executionCoordinator.getExecutionMode() === 'LIVE' ? 'LIVE' : 'PAPER';
        const state = await PumpCurveService.fetchPumpMarketState({
          connection: executionCoordinator.getConnection(),
          mint: mintPubkey,
          executionMode: currentMode,
        });
        if (state && !state.complete) {
          executionCoordinator.recordPumpFeedEvent('ON_CHAIN_CURVE', cleanCa);
          const priceNative =
            Number(state.virtualSolReserves) /
            Number(state.virtualTokenReserves) /
            (1e9 / Math.pow(10, state.tokenDecimals));
          const priceUsd = priceNative * this.solPriceUsd;
          const marketCapUsd = (Number(state.virtualSolReserves) / 1e9) * this.solPriceUsd;
          const liquidityUsd = (Number(state.realSolReserves) / 1e9) * this.solPriceUsd * 2;
          pool = {
            id: `pool-onchain-${cleanCa.slice(0, 8)}`,
            platform: 'PUMP_FUN',
            chain: 'SOLANA',
            symbol: cleanCa.slice(0, 5).toUpperCase(),
            name: `Token ${cleanCa.slice(0, 4)}...${cleanCa.slice(-4)}`,
            contractAddress: cleanCa,
            priceUsd,
            priceNative,
            marketCapUsd,
            liquidityUsd,
            bondingCurveProgress: Number(Math.min(100, (Number(state.realSolReserves) / (85 * 1e9)) * 100).toFixed(1)),
            isMigrated: false,
            volume5mUsd: 0,
            volume1hUsd: 0,
            volume24hUsd: 0,
            priceChange5mPct: 0.0,
            priceChange1hPct: 0.0,
            buys5m: 0,
            sells5m: 0,
            top10HoldersPct: -1, // -1 denotes UNKNOWN / unindexed
            devHoldingPct: -1,   // -1 denotes UNKNOWN / unindexed
            isMintRevoked: state.isMintAuthorityRevoked,
            isFreezeRevoked: state.isFreezeAuthorityRevoked,
            isLpBurned: false,
            rugcheckScore: evaluateTokenSafety(
              {
                mint: cleanCa,
                curveProgress: Number(Math.min(100, (Number(state.realSolReserves) / (85 * 1e9)) * 100).toFixed(1)),
                complete: state.complete,
                isMintRevoked: state.isMintAuthorityRevoked,
                isFreezeRevoked: state.isFreezeAuthorityRevoked,
                devHoldingPct: null, // Unknown until on-chain holder snapshot is taken
                top10HoldersPct: null, // Unknown until on-chain holder snapshot is taken
              },
              executionCoordinator.getExecutionMode() === 'LIVE'
            ).score,
            createdAgo: 'On-Chain Verified',
            trendingRank: 0,
          };
          this.pools.unshift(pool);
        }
      } catch {}
    }

    // S1: the callout-derived pool fills unknown holder/authority fields with "safe" defaults, which is only
    // acceptable for paper trading. In LIVE a token whose real curve state could not be read is not tradable here.
    if (!pool && executionCoordinator.getExecutionMode() !== 'LIVE') {
      // 1. Check if token exists in hot callouts feed
      try {
        const { pumpFunService } = await import('./pumpfunService');
        const callout = pumpFunService.getHotCallouts().find(
          (c) => c.token.mint.toLowerCase() === cleanCa.toLowerCase()
        );
        if (callout) {
          const t = callout.token;
          const priceUsd = t.currentPriceUsd || 0.000045;
          const priceNative = priceUsd / this.solPriceUsd;
          pool = {
            id: `pool-callout-${cleanCa.slice(0, 8)}`,
            platform: 'PUMP_FUN',
            chain: 'SOLANA',
            symbol: t.symbol,
            name: t.name,
            contractAddress: cleanCa,
            priceUsd,
            priceNative,
            marketCapUsd: t.marketCapAtCalloutUsd || 45000,
            liquidityUsd: 15000,
            bondingCurveProgress: t.bondingCurveProgress || 50,
            isMigrated: t.complete,
            volume5mUsd: t.volume5mUsd || 15000,
            volume1hUsd: 45000,
            volume24hUsd: 120000,
            priceChange5mPct: 5.5,
            priceChange1hPct: 18.2,
            buys5m: t.buys5m || 40,
            sells5m: t.sells5m || 8,
            top10HoldersPct: t.top10HoldersPct ?? 15,
            devHoldingPct: t.devHoldingPct ?? 0.8,
            isMintRevoked: t.isMintRevoked ?? true,
            isFreezeRevoked: t.isFreezeRevoked ?? true,
            isLpBurned: false,
            rugcheckScore: (t.rugcheckScore as any) || 'SAFE',
            createdAgo: t.timeAgoStr || 'Just now',
            trendingRank: 1,
          };
          this.pools.unshift(pool);
        }
      } catch {}
    }

    if (!pool && executionCoordinator.getExecutionMode() === 'PAPER') {
      const priceUsd = 0.000045;
      const priceNative = priceUsd / this.solPriceUsd;
      pool = {
        id: `pool-simulated-${cleanCa.slice(0, 8)}`,
        platform: 'PUMP_FUN',
        chain: 'SOLANA',
        symbol: cleanCa.slice(0, 5).toUpperCase(),
        name: `Token ${cleanCa.slice(0, 4)}...${cleanCa.slice(-4)}`,
        contractAddress: cleanCa,
        priceUsd,
        priceNative,
        marketCapUsd: 45000,
        liquidityUsd: 15000,
        bondingCurveProgress: 45,
        isMigrated: false,
        volume5mUsd: 12000,
        volume1hUsd: 35000,
        volume24hUsd: 95000,
        priceChange5mPct: 4.2,
        priceChange1hPct: 12.0,
        buys5m: 35,
        sells5m: 6,
        top10HoldersPct: 12,
        devHoldingPct: 0.5,
        isMintRevoked: true,
        isFreezeRevoked: true,
        isLpBurned: false,
        rugcheckScore: 'SAFE',
        createdAgo: 'Simulated Paper',
        trendingRank: 1,
      };
      this.pools.unshift(pool);
    }

    if (!pool) {
      return {
        success: false,
        message: `MARKET_DATA_UNAVAILABLE: Token pool ${cleanCa} not found and real on-chain bonding curve could not be resolved. Sniping without real market state is rejected.`,
        txHash: '',
      };
    }

    if (this.config.requireFreezeRevoked && !pool.isFreezeRevoked) {
      return {
        success: false,
        message: 'REJECTED: Freeze authority active. Honeypot risk.',
        txHash: '',
      };
    }
    if (this.config.maxDevHoldingPct > 0 && pool.devHoldingPct > this.config.maxDevHoldingPct) {
      return {
        success: false,
        message: `REJECTED: Creator holds ${pool.devHoldingPct}% (Limit: ${this.config.maxDevHoldingPct}%).`,
        txHash: '',
      };
    }

    // Alpha Pipeline Integration (B14): Enforce confluence composite score >= 70 when gating is enabled
    const shouldEnforceConfluence = params.enforceConfluence === true || this.isConfluenceGatingEnabled;
    const minConfluence = params.minConfluenceScore ?? MIN_CONFLUENCE_SCORE;
    const confluenceEval = this.evaluateTokenConfluence(pool);

    if (shouldEnforceConfluence && confluenceEval.score < minConfluence) {
      return {
        success: false,
        message: `REJECTED: Confluence score ${confluenceEval.score}/100 failed minimum threshold of ${minConfluence} (${confluenceEval.breakdown.explanation})`,
        txHash: '',
        confluenceScore: confluenceEval.score,
      };
    }

    // Assign REAL_ONCHAIN provenance to all on-chain events discovered via WebSocket or RPC (B09)
    const isSyntheticPool =
      DEMO_POOL_IDS.has(pool.id) || pool.id.startsWith('pool-simulated-');
    // The synthetic-pool check always wins over an explicit provenance param (A5).
    const provenance: SignalProvenance = isSyntheticPool
      ? 'SYNTHETIC_TEST'
      : params.provenance || 'REAL_ONCHAIN';

    // Dispatch execution strictly through central ExecutionCoordinator
    const execRes = await executionCoordinator.executeTrade({
      mint: pool.contractAddress,
      symbol: pool.symbol,
      name: pool.name,
      amountSol,
      currentPriceSol: pool.priceNative,
      slippageBps,
      jitoTipSol,
      source: 'AUTO_SNIPER',
      provenance,
      liquidityUsd: pool.liquidityUsd,
    });

    if (!execRes.success) {
      return {
        success: false,
        message: execRes.error || 'Execution rejected by pipeline',
        txHash: '',
        confluenceScore: confluenceEval.score,
      };
    }

    pool.buys5m += 1;
    pool.volume5mUsd += amountUsd;

    const allPositions = this.getPositions();
    const pos = allPositions.find((p) => p.id === execRes.positionId);

    const message = `${execRes.executionMode} Snipe: $${pool.symbol} (${pool.chain}) with $${amountUsd.toFixed(2)} [ID: ${execRes.positionId?.slice(0, 8)}...]`;
    this.emit('sniper_trade', { position: pos, txHash: execRes.txSignature, message });

    return {
      success: true,
      position: pos,
      message,
      txHash: execRes.txSignature || execRes.positionId || '',
      confluenceScore: confluenceEval.score,
    };
  }

  // Close position routed strictly through ExecutionCoordinator
  public async closePosition(
    positionId: string,
    sellPct: number = 100
  ): Promise<{ success: boolean; realizedPnl: number; message: string }> {
    const res = await executionCoordinator.closePosition(positionId, sellPct, 'Aggregator Close');

    const pnlUsd = res.pnlSol * this.solPriceUsd;
    const message = res.success
      ? `Closed ${sellPct}% of position ${positionId.slice(0, 8)}... Realized PnL: ${res.pnlSol >= 0 ? '+' : ''}${res.pnlSol.toFixed(5)} SOL ($${pnlUsd.toFixed(2)})`
      : `Failed to close position: ${res.error}`;

    this.emit('position_closed', { positionId, pnl: pnlUsd, message });

    return {
      success: res.success,
      realizedPnl: pnlUsd,
      message,
    };
  }

  private startPriceSimulation() {
    if (process.env.DEMO_MODE !== 'true') {
      return;
    }
    if (this.simulationTimer) {
      clearInterval(this.simulationTimer);
    }
    this.simulationTimer = setInterval(() => {
      // Isolate synthetic visualizer ticks from real live on-chain market feed freshness
      executionCoordinator.recordSyntheticMarketEvent('UI_PRICE_SIMULATOR');

      // Demo pool variation for UI visualizer
      this.pools.forEach((pool) => {
        const deltaPct = (Math.random() - 0.5) * 1.2;
        pool.priceUsd = Math.max(0.000001, pool.priceUsd * (1 + deltaPct / 100));
        pool.priceNative = pool.priceUsd / this.solPriceUsd;
        pool.marketCapUsd = Math.round(pool.priceUsd * 1000000000);
      });

      this.emit('price_update', {
        pools: this.pools,
        positions: this.getPositions(),
      });
    }, 2000);
  }
}

export const memecoinAggregator = new MemecoinAggregatorService();
