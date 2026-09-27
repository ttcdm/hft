export type StrategyArchetype =
  | 'MARKET_MAKING'
  | 'STATISTICAL_ARBITRAGE'
  | 'ORDER_BOOK_IMBALANCE'
  | 'LATENCY_ARBITRAGE'
  | 'MOMENTUM_SCALPING';

export type AssetClass = 'CRYPTO' | 'EQUITIES' | 'FX' | 'COMMODITIES';

export type OrderSide = 'BUY' | 'SELL';
export type OrderStatus = 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED' | 'REJECTED';

export interface TradingBot {
  id: string;
  name: string;
  archetype: StrategyArchetype;
  assetClass: AssetClass;
  symbol: string;
  isRunning: boolean;
  winRate: number;
  pnl: number;
  tradesCount: number;
  opsPerSec: number;
  maxDailyLoss: number;
  slippageLimitBps: number;
  leverage: number;
  gamma?: number; // Risk aversion
  kappa?: number; // Order intensity
}

export interface OrderBookEntry {
  price: number;
  size: number;
  total: number;
  depthPct: number;
}

export interface OrderBook {
  symbol: string;
  midPrice: number;
  spread: number;
  microPrice: number;
  asks: OrderBookEntry[];
  bids: OrderBookEntry[];
  imbalanceRatio: number; // -1.0 to +1.0
  lastTradedPrice: number;
  lastTradedSide?: OrderSide;
}

export interface ExecutedTrade {
  id: string;
  timestamp: number;
  microsecondTime: string;
  botId: string;
  botName: string;
  symbol: string;
  side: OrderSide;
  status: OrderStatus;
  price: number;
  size: number;
  pnlDelta: number;
  slippageBps: number;
  executionLatencyMs: number;
  rejectionReason?: string;
}

export type JitterProfileType = 'GAUSSIAN' | 'PARETO_BURST' | 'MICROWAVE_FADE' | 'CIRCUIT_BREAKER';

export interface NetworkStressConfig {
  isStressActive: boolean;
  profile: JitterProfileType;
  baseLatencyMs: number;
  jitterMs: number;
  packetLossPct: number;
  exchangeDisconnect: boolean;
}

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
}

export interface LatencyTestSample {
  timestamp: number;
  latencyMs: number;
  dropped: boolean;
  status: 'SUCCESS' | 'DROPPED' | 'SPIKE';
}

export interface PublicMarketTrade {
  id: string | number;
  timestamp: number;
  timeStr: string;
  microsecondTime: string;
  symbol: string;
  price: number;
  size: number;
  notionalUsd: number;
  isBuyerMaker: boolean; // true = Sell order hit bid (seller aggressive), false = Buy order hit ask (buyer aggressive)
  side: OrderSide;
}

export interface ActiveOrder {
  orderId: string;
  symbol: string;
  side: OrderSide;
  type: 'LIMIT' | 'MARKET';
  price: number;
  quantity: number;
  executedQty: number;
  status: OrderStatus;
  createdAt: number;
  botId?: string;
  botName?: string;
}

export interface AccountBalance {
  asset: string;
  free: number;
  locked: number;
  totalUsd: number;
}

export interface ExchangeGatewayConfig {
  mode: 'REAL_TAPE_PAPER_MATCHING' | 'BINANCE_TESTNET' | 'BINANCE_LIVE';
  apiKey: string;
  apiSecret: string;
  maxOrderNotional: number;
  maxDailyLoss: number;
  fatFingerBandPct: number;
  isConnected: boolean;
  accountBalances: AccountBalance[];
  exchangePingMs: number;
  atomicClockDriftMs: number;
}

export interface MarketTickerStats {
  symbol: string;
  lastPrice: number;
  priceChange24h: number;
  priceChangePercent24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  quoteVolume24h: number;
}

export interface EngineWALEntry {
  seqId: number;
  timestampNs: string;
  timestampIso: string;
  eventType: string;
  payload: Record<string, any>;
  checksum: string;
}

export interface EngineTelemetryData {
  status: 'STOPPED' | 'INITIALIZING' | 'RUNNING' | 'HALTED_RISK' | 'HALTED_KILL_SWITCH';
  symbol: string;
  seqId: number;
  uptimeSeconds: number;
  inventoryQty: number;
  inventoryUsd: number;
  reservationPrice: number;
  midPrice: number;
  microPrice: number;
  spreadBps: number;
  ofi: number;
  activeBuyQuote: { price: number; size: number } | null;
  activeSellQuote: { price: number; size: number } | null;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalPnlUsd: number;
  totalFillsCount: number;
  totalOrdersCount: number;
  rejectionsCount: number;
  ordersPerSec: number;
  tickToTradeStats: {
    minMicros: number;
    medianMicros: number;
    p99Micros: number;
    maxMicros: number;
    samplesCount: number;
  };
  walTotalEntries: number;
  memoryUsageMb: number;
  gcPauseEstimateMs: number;
  environment?: 'SIMULATED_ORDERBOOK' | 'LIVE_SOLANA';
  isSimulatedEngine?: boolean;
}

// ---------------- SOCIAL SCANNER & ALPHA INTELLIGENCE ----------------
export type SocialSource = 'TELEGRAM' | 'X_TWITTER';

export type AuthorTier =
  | 'CABAL_TRACKER'
  | 'MARKET_MAKER_BOT'
  | 'TOP_KOL'
  | 'DEV_DEPLOYER'
  | 'SMART_WALLET';

export type SignalPattern =
  | 'STEALTH_ACCUMULATION'
  | 'CABAL_LAUNCH'
  | 'MM_VOLUME_BOT'
  | 'MIGRATION_SNIPE'
  | 'KOL_COORDINATED';

export type SignalProvenance =
  | 'LIVE_PUMP_STREAM'
  | 'REAL_ONCHAIN'
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
  confidenceScore: number; // 0 - 100
  sentimentScore: number; // -1.0 to +1.0
  liquidityUsd?: number;
  marketCapUsd?: number;
  metrics: {
    views?: number;
    reposts?: number;
    subscribers?: number;
    whaleCount?: number;
  };
  actionSuggested: 'SNIPE_IMMEDIATE' | 'MONITOR_VOLUME' | 'AVOID_HONEYPOT';
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
  isLpBurned: boolean;
  rugcheckScore: 'SAFE' | 'CAUTION' | 'DANGEROUS';
  createdAgo: string;
  trendingRank: number;
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
}

export interface SniperBotConfig {
  isAutoSnipeEnabled: boolean;
  minConfidenceScore: number;
  defaultSnipeAmountUsd: number;
  maxSlippagePct: number;
  jitoTipSol: number;
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopEnabled: boolean;
  requireMintRevoked: boolean;
  requireFreezeRevoked: boolean;
  maxDevHoldingPct: number;
  telegramBotToken: string;
  telegramChatId: string;
  telegramWebhookActive: boolean;
}

// ---------------- REALISM & MICROSTRUCTURE CONFIG ----------------
export type CoLocationRegion =
  | 'AWS_TOKYO_AP_NORTHEAST_1'
  | 'TOKYO_RETAIL_FIBER'
  | 'AWS_OREGON_US_WEST_2'
  | 'AWS_FRANKFURT_EU_CENTRAL_1';

export type ExchangeFeeTier = 'VIP_0' | 'VIP_1' | 'VIP_4' | 'VIP_9_NEGATIVE_MAKER';

export interface MicrostructureRealismConfig {
  region: CoLocationRegion;
  networkLatencyMs: number;
  queuePositionModeling: boolean;
  toxicFlowAdverseSelection: boolean;
  feeTier: ExchangeFeeTier;
  makerFeeBps: number;
  takerFeeBps: number;
  slippageModelEnabled: boolean;
  jitoMevProtection: boolean;
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
  isAutoSnipeSubscribed: boolean;
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
    calloutPriceUsd: number;
    currentPriceUsd: number;
    marketCapAtCalloutUsd: number;
    currentMarketCapUsd: number;
    athPriceSol: number;
    peakMultiple: number;
    currentMultiple: number;
    complete: boolean; // Raydium / PumpSwap migration status
    raydiumPool?: string;
    volume5mUsd: number;
    buys5m: number;
    sells5m: number;
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


