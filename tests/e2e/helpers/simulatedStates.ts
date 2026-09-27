import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../../../server/solana/programs';
import { PumpMarketState } from '../../../server/solana/pumpCurve';
import { PumpSwapExecutionState } from '../../../server/solana/pumpSwapService';
import { TokenEligibilityReport, SignalProvenance } from '../../../server/core/types';

// Canonical Mints
export const VALID_PUMP_MINT_1 = new PublicKey('CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS');
export const VALID_PUMP_MINT_2 = new PublicKey('2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv');
export const GRADUATED_PUMP_MINT = new PublicKey('ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY');
export const TOKEN_2022_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
export const INVALID_FORMAT_MINT = 'NotAValidSolanaBase58AddressString!!!';
export const UNKNOWN_MINT = new PublicKey('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');

export const DUMMY_FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');
export const DUMMY_RESERVED_FEE_RECIPIENT = new PublicKey('AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY');
export const DUMMY_BUYBACK_FEE_RECIPIENT = new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD');
export const SOL_NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const NON_SOL_QUOTE_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // USDC

export function createSimulatedBondingCurveState(overrides: Partial<PumpMarketState> = {}): PumpMarketState {
  const mint = overrides.mint || VALID_PUMP_MINT_1;
  const bondingCurve = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');

  return {
    mint,
    bondingCurve,
    associatedBondingCurve: bondingCurve,
    creator: mint,
    feeRecipient: DUMMY_FEE_RECIPIENT,
    buybackFeeRecipient: DUMMY_BUYBACK_FEE_RECIPIENT,
    quoteMint: SOL_NATIVE_MINT,
    baseTokenProgram: TOKEN_PROGRAM_ID,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
    tokenProgram: TOKEN_PROGRAM_ID,
    tokenDecimals: 6,
    virtualTokenReserves: 1_073_000_000_000_000n, // 1.073B tokens
    virtualSolReserves: 30_000_000_000n,          // 30 SOL initial
    realTokenReserves: 793_000_000_000_000n,
    realSolReserves: 12_500_000_000n,             // 12.5 SOL in curve
    tokenTotalSupply: 1_000_000_000_000_000n,
    complete: false,
    isMayhemMode: false,
    protocolFeeBps: 100,
    creatorFeeBps: 0,
    isMintAuthorityRevoked: true,
    isFreezeAuthorityRevoked: true,
    feeComputationStatus: 'VERIFIED',
    marketDataTimestamp: Date.now(),
    marketDataSource: 'SIMULATED_PUMP_RPC',
    ...overrides,
  };
}

export function createSimulatedPumpSwapState(overrides: Partial<PumpSwapExecutionState> = {}): PumpSwapExecutionState {
  const baseMint = overrides.baseMint || GRADUATED_PUMP_MINT;
  const poolAddress = new PublicKey('8Hq6t12DqYc82tPnQkF3pQ5P17ZpXvK5uXf8hJ7u2L4m');

  const baseReserve = overrides.baseReserve ?? 200_000_000_000_000n; // 200M tokens
  const quoteReserve = overrides.quoteReserve ?? 85_000_000_000n;     // 85 SOL
  const virtualQuoteReserves = overrides.virtualQuoteReserves ?? 30_000_000_000n;
  const effectiveQuoteReserve = quoteReserve + virtualQuoteReserves;

  const baseHuman = Number(baseReserve) / 1e6;
  const quoteSol = Number(effectiveQuoteReserve) / 1e9;
  const spotPriceSol = baseHuman > 0 ? quoteSol / baseHuman : 0.000575;

  return {
    poolAddress,
    baseMint,
    quoteMint: SOL_NATIVE_MINT,
    baseReserve,
    quoteReserve,
    virtualQuoteReserves,
    effectiveQuoteReserve,
    isCashbackCoin: false,
    baseTokenProgram: TOKEN_PROGRAM_ID,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
    spotPriceSol,
    isMayhemMode: false,
    creatorFeeBps: 0n,
    marketDataTimestamp: Date.now(),
    ...overrides,
  };
}

export function createPassingEligibilityReport(mint: string = VALID_PUMP_MINT_1.toBase58()): TokenEligibilityReport {
  const now = Date.now();
  return {
    mint,
    isEligible: true,
    failedCount: 0,
    evaluatedAt: now,
    checks: [
      {
        ruleId: 'FREEZE_AUTHORITY_REVOKED',
        ruleName: 'Freeze Authority Revoked',
        passed: true,
        status: 'PASS',
        observedValue: 'Revoked',
        threshold: 'Revoked',
        reason: 'Freeze authority is disabled.',
        source: 'SOLANA_RPC',
        timestamp: now,
      },
      {
        ruleId: 'MINT_AUTHORITY_REVOKED',
        ruleName: 'Mint Authority Revoked',
        passed: true,
        status: 'PASS',
        observedValue: 'Revoked',
        threshold: 'Revoked',
        reason: 'Supply is fixed.',
        source: 'SOLANA_RPC',
        timestamp: now,
      },
      {
        ruleId: 'MAX_CREATOR_EXPOSURE',
        ruleName: 'Creator Holding Concentration',
        passed: true,
        status: 'PASS',
        observedValue: '2.5%',
        threshold: '< 10%',
        reason: 'Creator holds 2.5%, within safe tolerance.',
        source: 'SOLANA_RPC',
        timestamp: now,
      },
      {
        ruleId: 'TOP_10_CONCENTRATION',
        ruleName: 'Top 10 Holders Concentration',
        passed: true,
        status: 'PASS',
        observedValue: '28.0%',
        threshold: '< 40%',
        reason: 'Top 10 hold 28.0%, decentralized.',
        source: 'SOLANA_RPC',
        timestamp: now,
      },
      {
        ruleId: 'MIN_LIQUIDITY_DEPTH',
        ruleName: 'Minimum Liquidity Depth',
        passed: true,
        status: 'PASS',
        observedValue: '$25,000',
        threshold: '> $2,000',
        reason: 'Sufficient liquidity.',
        source: 'PUMPFUN',
        timestamp: now,
      },
    ],
  };
}

export function createUnknownEligibilityReport(mint: string = VALID_PUMP_MINT_1.toBase58()): TokenEligibilityReport {
  const now = Date.now();
  return {
    mint,
    isEligible: false,
    failedCount: 1,
    evaluatedAt: now,
    checks: [
      {
        ruleId: 'FREEZE_AUTHORITY_REVOKED',
        ruleName: 'Freeze Authority Revoked',
        passed: true,
        status: 'PASS',
        observedValue: 'Revoked',
        threshold: 'Revoked',
        reason: 'Freeze authority is disabled.',
        source: 'SOLANA_RPC',
        timestamp: now,
      },
      {
        ruleId: 'MINT_AUTHORITY_REVOKED',
        ruleName: 'Mint Authority Revoked',
        passed: false,
        status: 'UNKNOWN',
        observedValue: 'Unknown',
        threshold: 'Revoked',
        reason: 'Mint authority status is UNKNOWN. Critical safety unverified; rejected in LIVE mode.',
        source: 'SOLANA_RPC',
        timestamp: now,
      },
    ],
  };
}

export function createFailingEligibilityReport(mint: string = VALID_PUMP_MINT_1.toBase58(), reason: string = 'Honeypot Freeze Active'): TokenEligibilityReport {
  const now = Date.now();
  return {
    mint,
    isEligible: false,
    failedCount: 1,
    evaluatedAt: now,
    checks: [
      {
        ruleId: 'FREEZE_AUTHORITY_REVOKED',
        ruleName: 'Freeze Authority Revoked',
        passed: false,
        status: 'FAIL',
        observedValue: 'Active',
        threshold: 'Revoked',
        reason: `Freeze authority is active: ${reason}`,
        source: 'SOLANA_RPC',
        timestamp: now,
      },
    ],
  };
}

export const SIMULATED_PASSING_ELIGIBILITY: TokenEligibilityReport = createPassingEligibilityReport();

