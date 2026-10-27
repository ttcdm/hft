import { MemecoinPool, SniperPosition, SniperBotConfig } from '../src/types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { traced } from './observability/tracing';
import { PumpCurveService } from './solana/pumpCurve';
import { executionCoordinator } from './execution/coordinator';
import { solPriceService } from './market/solPriceService';
import { workstationDb } from './db/database';
import { evaluateTokenSafety } from './risk/tokenSafety';
import { pumpFeedListener, PumpCreateEvent, PumpTradeEvent } from './solana/pumpFeedListener';
import { onChainPoolStats } from './market/poolStats';
import { SignalProvenance, ConfluenceBreakdown, ExecutionMode } from './core/types';
import { CapitalSizer } from './capital/capitalSizer';
import { ConfluenceEngine, isConfluencePassed } from './signals/confluenceEngine';
import { getConfluenceThreshold } from './signals/confluenceThreshold';
import { curveVelocityEvaluator } from './signals/curveVelocityEvaluator';
import { checkSnipeAmountSol } from './execution/snipeAmount';

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
  /** S185: pools dropped from the board to keep it at 200 (never one the watch window still scores). */
  private poolsTrimmed = 0;
  // C3: the SOL/USD price comes from the single SolPriceService. 0 here means "no price known"; every code path that
  // converts USD to SOL is guarded in executeSnipe (LIVE needs a fresh price, PAPER needs a last known one).
  private get solPriceUsd(): number {
    return solPriceService.lastKnownPrice() ?? 0;
  }
  private simulationTimer: NodeJS.Timeout | null = null;
  private config: SniperBotConfig = {
    isAutoSnipeEnabled: false,
    defaultSnipeAmountUsd: 5.0,
    maxSlippagePct: 6.0,
    takeProfitPct: 45.0,
    stopLossPct: 20.0,
    trailingStopEnabled: true,
    requireFreezeRevoked: true,
    maxDevHoldingPct: 5.0,
    telegramBotToken: '',
    telegramChatId: '',
    telegramWebhookActive: false,
  };
  // C2: on by default. 3H (A14): no route, screen or production code calls setConfluenceGating, so in the running app it is always on (the
  // safe direction) and a caller's enforceConfluence makes no difference. Tests use the setter to switch it off; that is its only use.
  private isConfluenceGatingEnabled: boolean = true;

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
    // Q6: a pool made from a create event holds zeros for everything a trade reveals. Trades fill them in.
    pumpFeedListener.on('trade_event', (t: PumpTradeEvent) => this.applyTradeToPool(t));

    this.startAutonomousSniperLoop();
    this.startAuthorityLoop();
  }

  private autoSniperTimer: NodeJS.Timeout | null = null;
  private authorityTimer: NodeJS.Timeout | null = null;
  private authorityRetryAt = new Map<string, number>();
  private authorityBackoffUntil = 0;
  private authorityInflight = false;

  /**
   * A pool made from a create event has no mint / freeze authority yet (it shows "unknown"). Read both from the chain this server is on,
   * for up to 100 mints in ONE getMultipleAccounts call: the SPL mint layout has the mint authority option at byte 0 and the freeze
   * authority option at byte 46 (0 = no authority, i.e. revoked). A mint the cluster does not have (a mainnet mint shown on devnet)
   * stays unknown and is asked again at most once a minute. Returns how many pools were verified.
   */
  public async verifyPoolAuthorities(now = Date.now()): Promise<number> {
    if (this.authorityInflight || now < this.authorityBackoffUntil) return 0;
    const due = this.pools
      .filter((p) => p.authoritiesVerified === false && (this.authorityRetryAt.get(p.contractAddress) ?? 0) <= now)
      .slice(0, 100);
    if (due.length === 0) return 0;
    this.authorityInflight = true;
    let verified = 0;
    try {
      const keys: PublicKey[] = [];
      const pools: MemecoinPool[] = [];
      for (const p of due) {
        try { keys.push(new PublicKey(p.contractAddress)); pools.push(p); } catch { this.authorityRetryAt.set(p.contractAddress, now + 3_600_000); }
      }
      if (keys.length === 0) return 0;
      const infos = await executionCoordinator.getConnection().getMultipleAccountsInfo(keys, 'confirmed');
      pools.forEach((p, i) => {
        const data = infos[i]?.data;
        if (!data || data.length < 82) {
          this.authorityRetryAt.set(p.contractAddress, now + 60_000);
          return;
        }
        p.isMintRevoked = data.readUInt32LE(0) === 0;
        p.isFreezeRevoked = data.readUInt32LE(46) === 0;
        p.authoritiesVerified = true;
        this.authorityRetryAt.delete(p.contractAddress);
        verified++;
      });
      if (this.authorityRetryAt.size > 2_000) this.authorityRetryAt.clear();
    } catch {
      this.authorityBackoffUntil = now + 30_000; // an RPC failure (a 429) must not become a retry storm
    } finally {
      this.authorityInflight = false;
    }
    return verified;
  }

  private startAuthorityLoop() {
    if (this.authorityTimer) return;
    this.authorityTimer = setInterval(() => void this.verifyPoolAuthorities(), 5000);
    this.authorityTimer.unref?.();
  }

  private startAutonomousSniperLoop() {
    if (this.autoSniperTimer) return;
    this.autoSniperTimer = setInterval(async () => {
      // G1: this loop is a candidate source. The controller owns the mode, budgets and execution.
      if (!this.config.isAutoSnipeEnabled) return;

      const mode = executionCoordinator.getExecutionMode();
      const activePositions = executionCoordinator.getPositions(mode, 'ACTIVE');
      if (activePositions.length >= 3) return;

      try {
        const { pumpFunService, calloutProvenance } = await import('./pumpfunService');
        const { autoSnipeController } = await import('./auto/controller');
        if (autoSnipeController.getMode() === 'OFF') return;
        const callouts = pumpFunService.getHotCallouts();

        for (const c of callouts) {
          if (c.token.bondingCurveProgress >= 95) continue;
          const mint = c.token.mint;
          const alreadyOpen = activePositions.some((p) => p.mint.toLowerCase() === mint.toLowerCase());
          if (alreadyOpen) continue;

          await autoSnipeController.submitCandidate({
            mint,
            symbol: c.token.symbol,
            source: 'AGGREGATOR_LOOP',
            amountUsd: this.config.defaultSnipeAmountUsd || 5.0,
            jitoTipSol: this.config.jitoTipSol,
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
      event.receivedAt,
      { create: true } // P4.3: the create's state is a baseline, never one end of an acceleration pair
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
      authoritiesVerified: false, // placeholders until the curve is read at execution
      isMintRevoked: true,
      isFreezeRevoked: true,
      isLpBurned: false,
      rugcheckScore: 'SAFE',
      createdAgo: 'Just now (WS)',
      trendingRank: 0,
    };

    this.pools.unshift(pool);
    if (this.pools.length > 200) {
      // S4: newest 200, plus any pool the watch window is still scoring. Dropping that one made scoreOf return null (no HOT, a READY
      // without a score) and stopped applyTradeToPool for it, at any feed rate that creates 200 mints inside the 120 s window.
      const before = this.pools.length;
      this.pools = this.pools.filter((p, i) => i < 200 || this.isPoolPinned(p.contractAddress));
      this.poolsTrimmed += before - this.pools.length; // S185: counted, shown in System checks
    }

    onChainPoolStats.track(cleanCa, {
      insiders: [event.creator, event.user],
      supplyRaw: event.tokenTotalSupply,
      createPriceSol: event.initialPriceSol,
      realTokenReserves: event.realTokenReserves,
    });
    this.emit('pool_added', pool);
    return pool;
  }

  private isPoolPinned: (mint: string) => boolean = () => false;
  public setPoolPinned(fn: (mint: string) => boolean): void {
    this.isPoolPinned = fn;
  }

  private lastPoolPush = new Map<string, number>();

  /** Q6: fold one decoded trade into its pool (price, liquidity, curve progress, order flow, holder shares). */
  public applyTradeToPool(t: PumpTradeEvent, now = Date.now()): void {
    if (!onChainPoolStats.record(t, now)) return;
    const pool = this.pools.find((p) => p.contractAddress === t.mint);
    const m = onChainPoolStats.get(t.mint, now);
    if (!pool || !m) return;
    const solUsd = this.solPriceUsd;
    pool.priceNative = m.priceSol;
    pool.priceUsd = m.priceSol * solUsd;
    pool.marketCapUsd = m.priceSol * 1_000_000_000 * solUsd;
    pool.liquidityUsd = m.realSolReserves * solUsd * 2;
    if (m.curveProgressPct !== null) pool.bondingCurveProgress = Number(m.curveProgressPct.toFixed(1)); // review M2: unknown leaves the last figure
    pool.priceChange5mPct = Number(m.priceChange5mPct.toFixed(2)); // a float residue like 9.99e-8 is not a price move
    pool.buys5m = m.buys5m;
    pool.sells5m = m.sells5m;
    pool.volume5mUsd = m.volume5mSol * solUsd;
    pool.top10HoldersPct = m.top10HoldersPct ?? -1;
    pool.devHoldingPct = m.devHoldingPct ?? -1;
    if (now - (this.lastPoolPush.get(t.mint) ?? 0) >= 1_000) {
      this.lastPoolPush.set(t.mint, now);
      // S14: one entry per mint ever traded, never removed. Keep the most recent 1,000 (an entry only throttles a mint's price push to once a second).
      if (this.lastPoolPush.size > 1_000) this.lastPoolPush.delete(this.lastPoolPush.keys().next().value as string);
      this.emit('price_update', { pool });
    }
  }

  /** One pool per mint. Two entries for the same mint can only come from a race between the feed and a snipe that built a pool; keep the first. */
  private dedupePools(): void {
    const seen = new Set<string>();
    const unique = this.pools.filter((p) => {
      const k = p.contractAddress.trim().toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (unique.length !== this.pools.length) this.pools = unique;
  }

  public getPoolsTrimmedCount(): number {
    return this.poolsTrimmed;
  }

  public getPools(platform?: string, chain?: string): MemecoinPool[] {
    this.dedupePools();
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
      const currentValueUsd = (p.currentValueSol ?? 0) * this.solPriceUsd;
      const unrealizedPnlUsd = (p.unrealizedPnLSol ?? 0) * this.solPriceUsd;

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
        unrealizedPnlPct: p.unrealizedPnLPct ?? 0,
        targetTpPct: this.config.takeProfitPct,
        targetSlPct: -this.config.stopLossPct,
        priorityFeeSol: (p.jitoTipLamports ?? 0) / 1e9,
        openedAt: p.entryTimestamp,
        status: p.status === 'OPEN' || p.status === 'PARTIALLY_CLOSED' ? 'OPEN' : 'CLOSED',
        txHash: p.entryTxSignature,
      };
    });
  }

  /** The config as it may leave this process (HTTP, WebSocket, events): the Telegram bot token is never included, only whether one is set. */
  public getConfig(): SniperBotConfig & { telegramBotTokenSet: boolean } {
    return { ...this.config, telegramBotToken: '', telegramBotTokenSet: Boolean(this.config.telegramBotToken) };
  }

  public updateConfig(newConfig: Partial<SniperBotConfig>): SniperBotConfig & { telegramBotTokenSet: boolean } {
    this.config = { ...this.config, ...newConfig };
    const out = this.getConfig();
    this.emit('config_updated', out);
    return out;
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
    // C2: unknown stays null (scores 0 and is listed as missing), never a defaulted 0
    const fin = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null);
    const priceChange5mPct = fin(pool?.priceChange5mPct);
    const liquidityUsd = fin(pool?.liquidityUsd);
    // B3: -1 / undefined mean UNKNOWN. Unknown is passed as null and scores 0; it used to default to 20% (10 free points).
    const top10HoldersPct = pool?.top10HoldersPct !== undefined && pool.top10HoldersPct >= 0 ? pool.top10HoldersPct : null;
    const bondingCurveProgress = pool?.bondingCurveProgress ?? 0;
    const buys5m = fin(pool?.buys5m);
    const sells5m = fin(pool?.sells5m);
    // Unknown dev holding used to default to 0% (the full 5 dev-risk points).
    const devHoldingPct = pool?.devHoldingPct !== undefined && pool.devHoldingPct >= 0 ? pool.devHoldingPct : null;
    // C2: a DexScreener trending rank or a volume figure is not a verified social call, so the social factor is
    // not awarded here (it used to be inferred from trendingRank / volume > $10k).
    const hasVerifiedSocialCall = false;
    const socialCallCount = 0;

    const breakdown = ConfluenceEngine.calculate({
      mint,
      creatorAddress: pumpFeedListener.getCreatorForMint(mint),
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
    /** S181: the operator's chosen size in SOL. Checked (refused with a reason, never clamped) and used as is. */
    operatorAmountSol?: number;
    platform?: string;
    jitoTipSol?: number;
    slippagePct?: number;
    signalId?: string;
    provenance?: SignalProvenance;
    enforceConfluence?: boolean;
    minConfluenceScore?: number;
    /** G1: run every gate and report what would be bought, without sending or filling anything. */
    dryRun?: boolean;
    /** S16: the auto trader never trades against an invented pool (a PAPER fill on made-up price and liquidity is not evidence). */
    noSyntheticPool?: boolean;
    /** G1: fixed order size in SOL (auto-snipe Devnet mode). Overrides sizing; the 10% ceiling still applies downstream. */
    amountSolOverride?: number;
    /** When the signal behind this trade happened (ms). Required for LIVE: the coordinator never defaults it to now. */
    signalTimestamp?: number;
    /** R5: the coordinator mode the caller checked before its awaits; the coordinator refuses the trade if the mode has changed since. */
    expectedMode?: ExecutionMode;
  }): Promise<{
    success: boolean;
    message: string;
    txHash: string;
    position?: SniperPosition;
    confluenceScore?: number;
    dryRun?: boolean;
    amountSol?: number;
    positionId?: string;
    feesPaidLamports?: number;
    /** G3: quoted and filled price (SOL/token) and the slippage cap, so the auto controller can count slippage breaches. */
    quotePriceSol?: number;
    fillPriceSol?: number;
    slippageBps?: number;
    gates?: Record<string, unknown>;
  }> {
    const cleanCa = params.contractAddress.trim();

    // S181: an operator-chosen size is judged first, so a refused amount never costs an RPC read or touches any state.
    const operatorCheck = params.operatorAmountSol !== undefined ? checkSnipeAmountSol(params.operatorAmountSol) : null;
    if (operatorCheck && !operatorCheck.ok) return { success: false, message: operatorCheck.reason, txHash: '' };

    // Sizing via CapitalSizer (B12): determine spendable bankroll and 10% ceiling
    const executionMode = executionCoordinator.getExecutionMode();
    // C3: LIVE needs a fresh SOL/USD price (fail closed). PAPER may use the last known one, but not none.
    if (executionMode === 'LIVE') {
      try {
        solPriceService.requireFreshPrice();
      } catch (e: any) {
        return { success: false, message: `REJECTED: ${e.message}`, txHash: '' };
      }
    } else if (solPriceService.lastKnownPrice() === null) {
      return { success: false, message: 'REJECTED: SOL_PRICE_UNAVAILABLE: no SOL/USD price has been read yet', txHash: '' };
    }
    // C3: LIVE never assumes a wallet balance. With no real balance read, reject; PAPER keeps the 0.07 SOL paper default
    // (C5 moves that default into the configured paper bankroll).
    const realWalletBalanceSol = executionCoordinator.getRealWalletBalanceSol();
    if (executionMode === 'LIVE' && (realWalletBalanceSol === null || realWalletBalanceSol === undefined)) {
      return { success: false, message: 'REJECTED: WALLET_BALANCE_UNKNOWN: no real wallet balance has been read', txHash: '' };
    }
    const walletBalanceSol = realWalletBalanceSol ?? 0.07;
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

    // A LIVE buy sized against a bankroll with nothing spendable would skip the 10% cap below (it only applies when spendable > 0)
    // and go out at the full requested size. Refuse instead.
    if (executionMode === 'LIVE' && !params.dryRun && !(sizingResult.spendableBankrollSol > 0)) {
      return { success: false, message: 'REJECTED: NO_SPENDABLE_BANKROLL: the wallet has nothing spendable after the reserve, rent and in-flight orders', txHash: '' };
    }

    let amountSol: number;
    let amountUsd: number;

    if (operatorCheck && operatorCheck.ok) {
      amountSol = operatorCheck.amountSol;
      amountUsd = amountSol * this.solPriceUsd;
      // No 10% clamp here: the coordinator refuses an order above its bankroll ceiling with its own reason.
    } else if (params.amountUsd && params.amountUsd > 0) {
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
    const jitoTipSol = params.jitoTipSol || this.config.jitoTipSol || undefined;

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
        // the feed may have created this mint's pool while the curve was being read; use it instead of adding a second entry
        pool = this.pools.find((p) => p.contractAddress.toLowerCase() === cleanCa.toLowerCase());
        if (!pool && state && !state.complete) {
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
            authoritiesVerified: true,
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
            marketCapUsd: t.currentMarketCapUsd || 0, // the feed's current figure, not a launch-time stand-in
            liquidityUsd: 15000,
            bondingCurveProgress: t.bondingCurveProgress || 50,
            isMigrated: t.complete,
            volume5mUsd: t.volume5mUsd ?? 0,
            volume1hUsd: 0, // Q32: not provided by the callout feed; 0 is "unknown", not a made-up figure
            volume24hUsd: 0,
            priceChange5mPct: t.priceChange5mPct ?? 0,
            priceChange1hPct: 0,
            buys5m: t.buys5m ?? 0,
            sells5m: t.sells5m ?? 0,
            top10HoldersPct: t.top10HoldersPct ?? 15,
            devHoldingPct: t.devHoldingPct ?? 0.8,
            isMintRevoked: t.isMintRevoked ?? true,
            isFreezeRevoked: t.isFreezeRevoked ?? true,
            authoritiesVerified: t.isMintRevoked != null && t.isFreezeRevoked != null,
            isLpBurned: false,
            rugcheckScore: (t.rugcheckScore as any) || 'SAFE',
            createdAgo: t.timeAgoStr || 'Just now',
            trendingRank: 1,
            unverified: true, // Q32
          };
          this.pools.unshift(pool);
        }
      } catch {}
    }

    if (!pool && !params.noSyntheticPool && executionCoordinator.getExecutionMode() === 'PAPER') {
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

    if (pool && params.noSyntheticPool && (DEMO_POOL_IDS.has(pool.id) || pool.id.startsWith('pool-simulated-'))) {
      return { success: false, message: `MARKET_DATA_UNAVAILABLE: ${cleanCa} has only a simulated pool; the auto trader does not trade against one.`, txHash: '' };
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

    // Alpha Pipeline Integration (B14): Enforce the confluence composite score (threshold in force, default 70) when gating is enabled
    const shouldEnforceConfluence = params.enforceConfluence === true || this.isConfluenceGatingEnabled;
    const minConfluence = params.minConfluenceScore ?? getConfluenceThreshold();
    const confluenceEval = traced('gate.confluence', () => this.evaluateTokenConfluence(pool));

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
      DEMO_POOL_IDS.has(pool.id) || pool.id.startsWith('pool-simulated-') || pool.id.startsWith('pool-callout-'); // Q32: placeholders are not REAL_*
    // The synthetic-pool check always wins over an explicit provenance param (A5).
    const provenance: SignalProvenance = isSyntheticPool
      ? 'SYNTHETIC_TEST'
      : params.provenance || 'REAL_ONCHAIN';

    if (params.amountSolOverride && params.amountSolOverride > 0) {
      amountSol = params.amountSolOverride;
      amountUsd = amountSol * this.solPriceUsd;
    }

    if (params.dryRun) {
      const preview = await executionCoordinator.previewBuy({
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
        signalTimestamp: params.signalTimestamp, // P4.3 (R1-59): SHADOW runs the same signal-age check as PAPER and LIVE
      });
      if (preview.status === 'REJECTED') {
        return { success: false, message: preview.error, txHash: '', confluenceScore: confluenceEval.score, dryRun: true };
      }
      return {
        success: true,
        message: `DRY_RUN would buy $${pool.symbol}: ${amountSol} SOL at ${preview.quotePriceSol} SOL/token, tip ${preview.tipLamports} lamports`,
        txHash: '',
        confluenceScore: confluenceEval.score,
        dryRun: true,
        amountSol,
      };
    }

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
      signalTimestamp: params.signalTimestamp,
      // R1-10: a caller that names no mode (the operator routes, callout and Telegram snipes) gets the mode this call started in, checked
      // before any await, where the route's live confirmation was checked too. A LIVE arm during the reads above must not turn a PAPER
      // click into a LIVE send; the coordinator refuses it as MODE_CHANGED.
      executionMode: params.expectedMode ?? executionMode,
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
      amountSol,
      positionId: execRes.positionId,
      feesPaidLamports: execRes.feesPaidLamports,
      quotePriceSol: execRes.quotePriceSol ?? pool.priceNative,
      fillPriceSol: execRes.fillPriceSol,
      slippageBps,
      gates: execRes.gates,
    };
  }

  // Close position routed strictly through ExecutionCoordinator
  public async closePosition(
    positionId: string,
    sellPct: number = 100
  ): Promise<{ success: boolean; realizedPnl: number; message: string; adoptedPartial?: boolean; remainingTokensRaw?: string }> {
    const res = await executionCoordinator.closePosition(positionId, sellPct, 'Aggregator Close');

    const pnlUsd = res.pnlSol * this.solPriceUsd;
    // R6-9: a close that only adopted an earlier partial sold nothing now, and the position is still open
    const message = res.success && res.adoptedPartial
      ? `Nothing sold now: an earlier partial sell of position ${positionId.slice(0, 8)}... had landed and was booked (PnL ${res.pnlSol >= 0 ? '+' : ''}${res.pnlSol.toFixed(5)} SOL); ${res.remainingTokensRaw} raw tokens are still open. Close again to sell the rest.`
      : res.success
      ? `Closed ${sellPct}% of position ${positionId.slice(0, 8)}... Realized PnL: ${res.pnlSol >= 0 ? '+' : ''}${res.pnlSol.toFixed(5)} SOL ($${pnlUsd.toFixed(2)})`
      : `Failed to close position: ${res.error}`;

    this.emit('position_closed', { positionId, pnl: pnlUsd, message });

    return {
      success: res.success,
      realizedPnl: pnlUsd,
      message,
      ...(res.adoptedPartial ? { adoptedPartial: true, remainingTokensRaw: res.remainingTokensRaw } : {}),
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

      // Demo pool variation for UI visualizer. P3.1 (N-20): only the built-in demo pools move; a pool ingested from the chain keeps its real price.
      this.pools.forEach((pool) => {
        if (!DEMO_POOL_IDS.has(pool.id)) return;
        const deltaPct = (Math.random() - 0.5) * 1.2;
        pool.priceUsd = Math.max(0.000001, pool.priceUsd * (1 + deltaPct / 100));
        if (this.solPriceUsd > 0) pool.priceNative = pool.priceUsd / this.solPriceUsd;
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
