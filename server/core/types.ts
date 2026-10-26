/**
 * Shared types and the provenance rule for the trading core. Types only, plus `LIVE_APPROVED_PROVENANCES` and `isLiveApprovedProvenance`,
 * which are code: they decide which signal sources may reach a LIVE trade.
 *
 * What it must never do: widen `LIVE_APPROVED_PROVENANCES` to a simulated or test source (`SYNTHETIC_*`, `DEMO_PAPER`, `PAPER_REPLAY`).
 * `ExecutionCoordinator.executeTrade` refuses a LIVE trade whose provenance is not on the list, and that is what keeps invented data from
 * ever moving SOL.
 *
 * Used by about 18 of the 61 files under `server/` (the execution, signal, auto and database modules among them).
 */
/** Where a trade runs. Only `LIVE` signs and sends (devnet or localnet here); `PAPER` simulates; no trade runs in `BACKTEST` or `REPLAY` (they are in the type only; the replay backtest does not use the coordinator). */
export type ExecutionMode = 'LIVE' | 'PAPER' | 'BACKTEST' | 'REPLAY';
/** The two modes a trade can actually be in. */
export type ProtocolExecutionMode = 'LIVE' | 'PAPER';

/** Where the signal behind a trade came from. LIVE accepts only the sources in `LIVE_APPROVED_PROVENANCES`. */
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

/** The only provenances a LIVE trade may carry. Simulated, replayed and demo sources are deliberately absent. */
export const LIVE_APPROVED_PROVENANCES: readonly SignalProvenance[] = [
  'LIVE_PUMP_STREAM',
  'REAL_ONCHAIN',
  'PUMP_HTTP_API',
  'REAL_SOCIAL',
  'COPY_TRADE',
  'MANUAL_OPERATOR',
] as const;

/** True when a LIVE trade may carry this provenance. */
export function isLiveApprovedProvenance(provenance: SignalProvenance): boolean {
  return LIVE_APPROVED_PROVENANCES.includes(provenance);
}

/** Which market trades a mint: the Pump.fun bonding curve, the canonical PumpSwap pool after migration, or unknown (do not trade). */
export type TradingVenue = 'PUMP_BONDING_CURVE' | 'PUMPSWAP' | 'UNKNOWN';

/** A check result that can say "not verified". UNKNOWN is never a pass in LIVE. */
export type TriState = 'PASS' | 'FAIL' | 'UNKNOWN';

/** Where a price or fact was read from, for labels and audit rows. */
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

/** `NOT_CONFIGURED` (no key), `LOCKED` (key present but not usable), `READY`. Read-only mode is always `NOT_CONFIGURED`. */
export type SignerStatus = 'NOT_CONFIGURED' | 'LOCKED' | 'READY';

/** The risk engine's breaker. Anything other than `CLOSED` blocks arming and new buys. */
export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Outcome or stage of one trade request. The coordinator returns one of these on every response. Not every member is ever assigned: a search of
 * `server/`, `src/`, `scripts/` and `tests/` at commit 1a80181 found no use of DISCOVERED, ENRICHING, ELIGIBILITY_PASSED, SIGNAL_GENERATED,
 * RISK_APPROVED, BUILDING_TRANSACTION, SIGNED, LANDED or BUILD_FAILED. They look like a state machine and are not one; flagged, not removed.
 */
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

/** Why the risk engine approved or refused an order. SELLABILITY_UNKNOWN, SIGNER_UNAVAILABLE and TOKEN_RULE_FAILED are never returned by any code at commit 1a80181. */
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
  | 'CIRCUIT_BREAKER_OPEN'
  | 'RISK_LIMIT_INVALID';

/** The limits `HardenedRiskEngine.evaluateOrder` enforces. Amounts are in SOL or lamports as the names say; ages and cooldowns are in milliseconds. */
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

/** The parts of one confluence score and `compositeScore`, the sum compared with the buy threshold. `socialSignalScore` is always 0 in practice (KNOWN_RISKS section 8). */
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

/** One rule's outcome in an eligibility report: what was observed, the threshold, and whether it passed. `status` UNKNOWN means not verified. */
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

/** Every rule result for one mint. `isEligible` is true only when no check failed. */
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

/** One position row as stored in SQLite and served to the UI. Quantities in raw token units are strings (they can exceed a JS number); costs are lamports; prices are SOL per token. */
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

/** The result of `getLiveReadiness`: `ready` only when `reasons` is empty, plus per-subsystem health. */
export interface LiveReadiness {
  ready: boolean;
  reasons: string[];
  components: {
    rpc: { healthy: boolean; latencyMs: number; status: 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED' };
    pumpFeed: { healthy: boolean; lastEventAgeMs: number; status: 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED' | 'WARMING_UP'; required?: boolean; mainnetApiLastEventAgeMs?: number };
    markFeed: { healthy: boolean; lastMarkAgeMs: number; status: 'HEALTHY' | 'DEGRADED' | 'STALE' };
    jito: { healthy: boolean; status: 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED' | 'OFFLINE' | 'NOT_CONFIGURED' };
    db: { healthy: boolean; status: 'HEALTHY' | 'DEGRADED' | 'ERROR' };
    signer: { healthy: boolean; status: SignerStatus };
  };
  checkedAt: number;
}

/** An alert kept in memory for the operator (for example a halt). A restart forgets them; the journal keeps the events behind them. */
export interface OperatorAlert {
  code: string;
  message: string;
  positionId?: string;
  raisedAt: number;
  lastSeenAt: number;
  cleared: boolean;
}

/** The snapshot behind the status header: mode, kill switch, signer, RPC, feeds, Jito, wallet and day totals. */
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
