export type ExecutionMode = 'LIVE' | 'PAPER' | 'BACKTEST' | 'REPLAY';
export type ProtocolExecutionMode = 'LIVE' | 'PAPER';

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

export const LIVE_APPROVED_PROVENANCES: readonly SignalProvenance[] = [
  'LIVE_PUMP_STREAM',
  'REAL_ONCHAIN',
  'REAL_SOCIAL',
  'COPY_TRADE',
  'MANUAL_OPERATOR',
] as const;

export function isLiveApprovedProvenance(provenance: SignalProvenance): boolean {
  return LIVE_APPROVED_PROVENANCES.includes(provenance);
}

export type TradingVenue = 'PUMP_BONDING_CURVE' | 'PUMPSWAP' | 'UNKNOWN';

export type TriState = 'PASS' | 'FAIL' | 'UNKNOWN';

export type DataSource =
  | 'SOLANA_RPC'
  | 'JITO'
  | 'PUMPFUN'
  | 'DEXSCREENER'
  | 'BINANCE'
  | 'PAPER_ENGINE'
  | 'BACKTEST'
  | 'SYNTHETIC_TEST'
  | 'RECONCILED_ON_CHAIN'
  | 'BONDING_CURVE_RPC';

export type SignerStatus = 'NOT_CONFIGURED' | 'LOCKED' | 'READY';

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type ExecutionLifecycleState =
  | 'DISCOVERED'
  | 'ENRICHING'
  | 'ELIGIBILITY_PASSED'
  | 'SIGNAL_GENERATED'
  | 'RISK_APPROVED'
  | 'BUILDING_TRANSACTION'
  | 'SIGNED'
  | 'SUBMITTED'
  | 'LANDED'
  | 'CONFIRMED'
  | 'RECONCILIATION_REQUIRED'
  | 'FILTER_REJECTED'
  | 'RISK_REJECTED'
  | 'STALE'
  | 'BUILD_FAILED'
  | 'SIGN_FAILED'
  | 'SUBMIT_FAILED'
  | 'DROPPED'
  | 'REVERTED'
  | 'EXPIRED'
  | 'CHAIN_ERROR';

export type RiskReasonCode =
  | 'RISK_OK'
  | 'INSUFFICIENT_BALANCE'
  | 'DAILY_LOSS_LIMIT'
  | 'MAX_EXPOSURE'
  | 'MAX_POSITION_SIZE'
  | 'STALE_MARKET_DATA'
  | 'STALE_SIGNAL'
  | 'SLIPPAGE_TOO_HIGH'
  | 'PRICE_IMPACT_TOO_HIGH'
  | 'FEE_TOO_HIGH'
  | 'EXPECTED_EDGE_BELOW_EXECUTION_COST'
  | 'DUPLICATE_MINT'
  | 'SELLABILITY_UNKNOWN'
  | 'TOKEN_RULE_FAILED'
  | 'KILL_SWITCH_ACTIVE'
  | 'EXECUTION_DISABLED'
  | 'SIGNER_UNAVAILABLE'
  | 'CIRCUIT_BREAKER_OPEN';

export interface PreTradeRiskLimits {
  maxPositionSol: number;
  maxAggregateExposureSol: number;
  maxDailyLossSol: number;
  maxSimultaneousPositions: number;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  maxExecutionCostLamports: number;
  maxJitoTipLamports: number;
  maxFeePctOfPosition: number;
  minWalletReserveSol: number;
  maxDataAgeMs: number;
  maxSignalAgeMs: number;
  cooldownAfterFailedTradeMs: number;
  cooldownPerMintMs: number;
}

export interface ConfluenceBreakdown {
  momentumScore: number;
  liquidityScore: number;
  holderDistributionScore: number;
  bondingCurveVelocityScore: number;
  buySellImbalanceScore: number;
  creatorRiskScore: number;
  socialSignalScore: number;
  compositeScore: number;
  explanation: string;
}

export interface EligibilityCheckResult {
  ruleId: string;
  ruleName?: string;
  passed: boolean;
  status?: TriState;
  observedValue: string | number | boolean;
  threshold: string | number | boolean;
  reason: string;
  source?: DataSource;
  timestamp?: number;
  scoreImpact?: number;
  weight?: number;
}

export interface TokenEligibilityReport {
  mint: string;
  isEligible: boolean;
  score?: string;
  riskScoreNumber?: number;
  checks: EligibilityCheckResult[];
  failedCount: number;
  warningCount?: number;
  passedCount?: number;
  evaluatedAt: number;
}

export interface NormalizedPosition {
  id: string;
  mint: string;
  symbol: string;
  name: string;
  tokenDecimals: number;
  baseTokenProgram?: string;
  tokenQuantityRaw: string; // BigInt serialized to string
  costBasisLamports: number;
  entryPriceSol: number;
  currentPriceSol: number;
  currentValueSol?: number;
  unrealizedPnLSol?: number;
  unrealizedPnLPct?: number;
  realizedPnLSol: number;
  entryTxSignature: string;
  entrySlot?: number;
  entryTimestamp: number;
  entryFeeLamports?: number;
  priorityFeeLamports?: number;
  jitoTipLamports?: number;
  markSource?: DataSource;
  markAgeMs?: number;
  venue?: TradingVenue;
  poolAddress?: string;
  migrationTimestamp?: number;
  lastMarkTimestamp?: number;
  lastMarkSource?: string;
  executionMode: ExecutionMode;
  status: 'OPEN' | 'PARTIALLY_CLOSED' | 'CLOSED';
  lastUpdatedTimestamp?: number;
  updatedAt?: number;
  recordUpdatedAt?: number;
  tokenQuantityUi?: number;
  exitReason?: string;
  exitTxSignature?: string;
  exitTimestamp?: number;
  exitSlot?: number;
  highWaterMarkSol?: number;
  trailingStopSol?: number;
  exitStage?: number;
}

export interface LiveReadiness {
  ready: boolean;
  reasons: string[];
  components: {
    rpc: { healthy: boolean; latencyMs: number; status: 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED' };
    pumpFeed: { healthy: boolean; lastEventAgeMs: number; status: 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED' | 'WARMING_UP' };
    markFeed: { healthy: boolean; lastMarkAgeMs: number; status: 'HEALTHY' | 'DEGRADED' | 'STALE' };
    jito: { healthy: boolean; status: 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED' | 'OFFLINE' | 'NOT_CONFIGURED' };
    db: { healthy: boolean; status: 'HEALTHY' | 'DEGRADED' | 'ERROR' };
    signer: { healthy: boolean; status: SignerStatus };
  };
  checkedAt: number;
}

export interface OperatorAlert {
  code: string;
  message: string;
  positionId?: string;
  raisedAt: number;
  lastSeenAt: number;
  cleared: boolean;
}

export interface SystemDiagnostics {
  executionMode: ExecutionMode;
  liveTradingActive: boolean;
  killSwitchActive: boolean;
  circuitBreakerState: CircuitBreakerState;
  activeWalletAddress: string;
  signerStatus: SignerStatus;
  rpcEndpoint: string;
  rpcLatencyMs: number;
  rpcHealth: 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED';
  pumpFeedHealth: 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED' | 'WARMING_UP';
  positionMarkHealth: 'HEALTHY' | 'DEGRADED' | 'STALE';
  operatorAlerts?: OperatorAlert[];
  marketFeedHealth: 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED' | 'WARMING_UP';
  marketFeedLastEventMsAgo: number;
  jitoHealth: 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED' | 'NOT_CONFIGURED';
  jitoTipFloorLamports: number;
  walletSolBalance: number | null; // null when RPC unknown
  walletSpendableSol: number | null;
  openPositionsCount: number;
  dailyRealizedPnLSol: number;
  dailyFeesPaidLamports: number;
  totalTradesToday: number;
  lastConfirmedTradeTime: number | null;
  dbPath: string;
  sqliteJournalOk: boolean;
}
