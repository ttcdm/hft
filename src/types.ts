// 3H (B3): the exchange-era types (OrderBook, ExecutedTrade, ActiveOrder, AccountBalance, ExchangeGatewayConfig, MarketTickerStats and
// the rest of the BTC market-maker shapes) were removed; nothing imported them.

export interface PerformanceKPIs {
  dailyPnL: number;
  unrealizedPnL: number;
  totalEquity: number;
  winRate: number;
  totalTrades: number;
  sharpeRatio: number;
  sortinoRatio: number;
  profitFactor: number;
  maxDrawdownPct: number;
  var99Pct: number;
  averageLatencyMs: number;
  p99LatencyMs: number;
  systemThroughputOps: number;
  dailyVolumeUsd: number;
  peakEquity: number;
}

export interface AlertEvent {
  id: string;
  timestamp: number;
  timeStr: string;
  level: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  message: string;
  acknowledged: boolean;
  /** R6-1: 'server' for an operator alert the server holds (it leaves when the server clears it). */
  source?: 'local' | 'server';
  /** No dismiss button: it stays until the server clears it. */
  sticky?: boolean;
}

// ---------------- SOCIAL SCANNER & ALPHA INTELLIGENCE ----------------
export type SocialSource = 'TELEGRAM' | 'X_TWITTER' | 'PUMP_FEED'; // Q33: PUMP_FEED = discovered on the pump.fun / DexScreener lists, no social post behind it

export type AuthorTier =
  | 'CABAL_TRACKER'
  | 'MARKET_MAKER_BOT'
  | 'TOP_KOL'
  | 'DEV_DEPLOYER'
  | 'SMART_WALLET'
  | 'UNVERIFIED'; // discovered on the feed; nothing is known about who is behind it

export type SignalPattern =
  | 'STEALTH_ACCUMULATION'
  | 'CABAL_LAUNCH'
  | 'MM_VOLUME_BOT'
  | 'MIGRATION_SNIPE'
  | 'KOL_COORDINATED'
  | 'UNCLASSIFIED';

export type SignalProvenance =
  | 'LIVE_PUMP_STREAM'
  | 'REAL_ONCHAIN'
  | 'PUMP_HTTP_API' // Q33: the pump.fun / DexScreener HTTP lists; market data, not an on-chain event and not a social post
  | 'REAL_SOCIAL'
  | 'COPY_TRADE'
  | 'MANUAL_OPERATOR'
  | 'PAPER_REPLAY'
  | 'SYNTHETIC_SIMULATION'
  | 'SYNTHETIC_TEST'
  | 'DEMO_PAPER';

export interface SocialSignal {
  id: string;
  provenance: SignalProvenance;
  source: SocialSource;
  authorHandle: string;
  authorDisplayName: string;
  authorTier: AuthorTier;
  verified: boolean;
  timestamp: number;
  timeStr: string;
  rawText: string;
  tokenTicker: string;
  tokenName: string;
  contractAddress: string;
  chain: 'SOLANA' | 'BASE' | 'ETHEREUM' | 'TRON';
  signalPattern: SignalPattern;
  confidenceScore: number | null; // 0 - 100; null = not scored
  sentimentScore: number | null; // -1.0 to +1.0; null = not scored
  liquidityUsd?: number;
  marketCapUsd?: number;
  metrics: {
    views?: number;
    reposts?: number;
    subscribers?: number;
    whaleCount?: number;
  };
  actionSuggested: 'SNIPE_IMMEDIATE' | 'MONITOR_VOLUME' | 'AVOID_HONEYPOT' | 'REVIEW';
  status: 'NEW' | 'SNIPED' | 'DISMISSED';
  externalUrl?: string;
  socials?: {
    twitter?: string;
    telegram?: string;
    website?: string;
    pumpFun?: string;
    dexScreener?: string;
  };
  isLiveFeed?: boolean;
}

// ---------------- MEMECOIN PLATFORM AGGREGATOR ----------------
export type MemecoinPlatform =
  | 'PUMP_FUN'
  | 'RAYDIUM'
  | 'DEXSCREENER'
  | 'UNISWAP_BASE'
  | 'MOONSHOT'
  | 'SUNPUMP';

export interface MemecoinPool {
  id: string;
  platform: MemecoinPlatform;
  chain: 'SOLANA' | 'BASE' | 'ETHEREUM' | 'TRON';
  symbol: string;
  name: string;
  contractAddress: string;
  priceUsd: number;
  priceNative: number;
  marketCapUsd: number;
  liquidityUsd: number;
  bondingCurveProgress?: number; // 0 - 100%
  isMigrated: boolean;
  volume5mUsd: number;
  volume1hUsd: number;
  volume24hUsd: number;
  priceChange5mPct: number;
  priceChange1hPct: number;
  buys5m: number;
  sells5m: number;
  top10HoldersPct: number;
  devHoldingPct: number;
  isMintRevoked: boolean;
  isFreezeRevoked: boolean;
  /**
   * Q10d: false when isMintRevoked / isFreezeRevoked are placeholders (a pool made from a create event, a demo pool) and have not been read
   * from the chain. The execution path reads the chain itself; this flag only stops a screen from showing a placeholder as a fact.
   */
  authoritiesVerified?: boolean;
  isLpBurned: boolean;
  /** R6-13: UNKNOWN when nothing has rated the token (a pool made from a create event or a callout); never SAFE by default. */
  rugcheckScore: 'SAFE' | 'CAUTION' | 'DANGEROUS' | 'UNKNOWN';
  createdAgo: string;
  trendingRank: number;
  /** Q32: true when some numbers above are placeholders (a pool built from a callout, not read from the chain). It is never real evidence. */
  unverified?: boolean;
}

// ---------------- SNIPER POSITIONS & EXECUTION ----------------
export interface SniperPosition {
  id: string;
  tokenTicker: string;
  tokenName: string;
  contractAddress: string;
  platform: MemecoinPlatform;
  chain: 'SOLANA' | 'BASE' | 'ETHEREUM' | 'TRON';
  entryPriceUsd: number;
  currentPriceUsd: number;
  quantityTokens: number;
  costBasisUsd: number;
  currentValueUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
  targetTpPct: number;
  targetSlPct: number;
  priorityFeeSol: number;
  openedAt: number;
  status: 'OPEN' | 'CLOSED';
  signalId?: string;
  /** R6-2: the mode the position was opened in; a LIVE row is real SOL even while the server is in PAPER. */
  executionMode?: 'LIVE' | 'PAPER' | 'BACKTEST' | 'REPLAY';
}

export interface SniperBotConfig {
  isAutoSnipeEnabled: boolean;
  defaultSnipeAmountUsd: number;
  maxSlippagePct: number;
  jitoTipSol?: number; // optional operator override; absent = dynamic policy (C6)
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopEnabled: boolean;
  requireFreezeRevoked: boolean;
  maxDevHoldingPct: number;
  telegramBotToken: string;
  telegramChatId: string;
  telegramWebhookActive: boolean;
}

// ---------------- PUMP.FUN HOT CALLOUTS & CALLER LEADERBOARD ----------------
export type CallerReputationTier =
  | 'LEGENDARY_WHALE'
  | 'VERIFIED_ALPHA'
  | 'HIGH_MOMENTUM'
  | 'EMERGING_CALLER';

export interface TopCalloutRecord {
  calloutId: string;
  coinMint: string;
  symbol: string;
  name?: string;
  calloutPrice: number;
  marketCapAtCall: number;
  multiple: number;
  createdAt: number;
  maxPriceSol: number;
  peakTimestamp: number;
}

export interface PumpFunCaller {
  userId: string;
  userUuid: string;
  primaryWallet: string;
  avatarUrl?: string;
  totalCallouts: number;
  avgMultiple: number;
  medianMultiple: number;
  winRate1_2x: number;
  winRate1_5x: number;
  winRate2x: number;
  avgTimeToPeakMs: number;
  followersCount: number;
  totalVolumeDrivenUsd: number;
  reputationTier: CallerReputationTier;
  topCallouts: TopCalloutRecord[];
}

export type CalloutHftAction =
  | 'INSTANT_SNIPE'
  | 'MOMENTUM_ENTRY'
  | 'PRE_GRADUATION_WATCH'
  | 'LATE_STAGE_HOLD'
  | 'DUMP_RISK';

export interface PumpFunHotCallout {
  id: string;
  calloutId: string;
  caller: PumpFunCaller;
  token: {
    mint: string;
    symbol: string;
    name: string;
    imageUri: string;
    description: string;
    bondingCurveProgress: number; // 0 - 100%
    bondingCurveAddress: string;
    associatedBondingCurve?: string;
    creator: string;
    calloutPriceUsd: number | null; // null = unknown (no price when first seen)
    currentPriceUsd: number;
    marketCapAtCalloutUsd: number | null; // market cap when this server first saw the callout; null = unknown
    currentMarketCapUsd: number;
    athPriceSol: number;
    peakMultiple: number | null;
    currentMultiple: number | null; // null = unknown, never a made-up 1.00x
    complete: boolean; // Raydium / PumpSwap migration status
    raydiumPool?: string;
    // null = not provided by the feed (never an invented value)
    volume5mUsd: number | null;
    buys5m: number | null;
    sells5m: number | null;
    priceChange5mPct?: number | null;
    top10HoldersPct: number;
    devHoldingPct: number;
    isMintRevoked: boolean;
    isFreezeRevoked: boolean;
    rugcheckScore: 'SAFE' | 'CAUTION' | 'DANGEROUS';
    createdTimestamp: number;
    timeAgoStr: string;
    twitter?: string;
    telegram?: string;
    website?: string;
  };
  calloutTimestamp: number;
  calloutNote: string;
  confluenceCount: number; // >=2 indicates multiple KOLs called this coin
  otherCallers?: string[];
  hftAction: CalloutHftAction;
  decayWindowSecondsRemaining: number;
  status: 'ACTIVE' | 'SNIPED' | 'EXPIRED';
}

export interface PumpFunHotCalloutsResponse {
  status: string;
  /** 3H: NO_DATA / ONLINE / STALE, from real feed activity on the server */
  feedStatus?: 'NO_DATA' | 'ONLINE' | 'STALE';
  liveSource: string;
  syncLatencyMs: number;
  lastUpdated: number;
  tokensTrackedCount: number;
  callouts: PumpFunHotCallout[];
  leaderboard: PumpFunCaller[];
  autoSnipeRules: {
    minCallerWinRate2x: number;
    minAvgMultiple: number;
    autoSnipeOnConfluence: boolean;
    maxEntryMultiple: number;
    maxElapsedSeconds: number;
    snipeAmountUsd: number;
    jitoPriorityTipSol: number;
  };
}


