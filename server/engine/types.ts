export type EngineStatus = 'STOPPED' | 'INITIALIZING' | 'RUNNING' | 'HALTED_RISK' | 'HALTED_KILL_SWITCH';

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'LIMIT' | 'MARKET' | 'IOC' | 'FOK';
export type OrderState = 'PENDING_NEW' | 'ACTIVE' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED' | 'REJECTED';

export interface EngineOrder {
  orderId: string;
  clientOrderId: string;
  seqId: number;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  price: number;
  quantity: number;
  filledQty: number;
  avgFillPrice: number;
  state: OrderState;
  submitTimeNs: string;
  submitTimeIso: string;
  lastUpdateTimeNs: string;
  rejectionReason?: string;
  botId?: string;
  botName?: string;
}

export interface EngineTrade {
  tradeId: string;
  seqId: number;
  orderId: string;
  symbol: string;
  side: OrderSide;
  price: number;
  quantity: number;
  notionalUsd: number;
  feeUsd: number;
  realizedPnl: number;
  maker: boolean;
  matchTimestampNs: string;
  matchTimeIso: string;
  tickToTradeMicros: number;
}

export interface WALEntry {
  seqId: number;
  timestampNs: string;
  timestampIso: string;
  eventType:
    | 'ENGINE_START'
    | 'ENGINE_STOP'
    | 'ORDER_SUBMIT'
    | 'ORDER_ACCEPT'
    | 'ORDER_FILL'
    | 'ORDER_CANCEL'
    | 'ORDER_REJECT'
    | 'RISK_VIOLATION'
    | 'INVENTORY_REBALANCE'
    | 'KILL_SWITCH_TRIP';
  payload: Record<string, any>;
  checksum: string;
}

export interface PreTradeRiskLimits {
  minOrderNotionalUsd?: number;
  maxOrderNotionalUsd: number;
  maxSingleOrderQty: number;
  maxGrossInventoryQty: number;
  maxShortInventoryQty: number;
  maxOrdersPerSecond: number;
  fatFingerPriceBandPct: number;
  maxDailyLossUsd: number;
  selfTradePrevention: boolean;
}

export interface AvellanedaStoikovConfig {
  symbol: string;
  gamma: number; // Risk aversion parameter (e.g. 0.05 to 0.5)
  sigma: number; // Volatility estimate (annualized or per-minute)
  kappa: number; // Order book liquidity density intensity
  timeHorizon: number; // Target terminal horizon (e.g. 1.0 day or 60s window)
  targetSpreadBps: number;
  baseQuoteSize: number;
  inventoryLimitQty: number;
  minTickIncrement: number;
}

export interface EngineTelemetry {
  status: EngineStatus;
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
  environment: 'SIMULATED_ORDERBOOK';
  isSimulatedEngine: true;
}
