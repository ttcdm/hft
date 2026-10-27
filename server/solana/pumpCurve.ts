import { Connection, PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import {
  PUMP_SDK,
  GLOBAL_PDA,
  PUMP_FEE_CONFIG_PDA,
  computeFeesBps,
  isLegacyQuoteMint,
  bondingCurvePda,
  getBuyTokenAmountFromSolAmount,
  getBuySolAmountFromTokenAmount,
  getSellSolAmountFromTokenAmount,
} from '@pump-fun/pump-sdk';
import { PUMP_FUN_PROGRAM_ID, PUMP_FUN_FEE_RECIPIENT } from './programs';
import { expectedGenesisHash } from './clusterGuard';
import { Logger } from '../middleware/enterprise';
import { executionConfig } from './executionConfig';
import { ExecutionMode, TriState } from '../core/types';
import { classifyHolder, defaultHolderFunderSource, type HolderClass, type HolderFunderSource } from '../signals/holderCluster';

export type { ExecutionMode };

// Canonical fallback fee recipient sets (from official Pump SDK specification)
export const CURRENT_FEE_RECIPIENTS: string[] = [
  '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV',
  '7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ',
  '7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX',
  '9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz',
  'AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY',
  'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM',
  'FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz',
  'G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP',
];

export const CURRENT_RESERVED_FEE_RECIPIENTS: string[] = [
  'AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY',
  'FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz',
  '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV',
  '7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ',
];

export const CURRENT_FEE_RECIPIENTS_FOR_BUYBACK: string[] = [
  '5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD',
  '9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7',
  'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL',
  '3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR',
  '5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6',
  'EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL',
  '5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD',
  'A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW',
];

// Anchor BondingCurve account discriminator sha256("account:BondingCurve").slice(0, 8)
const BONDING_CURVE_DISCRIMINATOR = Buffer.from('17b7f83760d8ac60', 'hex');

export interface Token2022ExtensionReport {
  detectedExtensionTypes: number[];
  unsupportedExtensionTypes: number[];
  unsupportedExtensionNames: string[];
  hasTransferFee: boolean;
  hasTransferHook: boolean;
  hasPermanentDelegate: boolean;
  isNonTransferable: boolean;
  hasDefaultAccountState: boolean;
  hasConfidentialTransfers: boolean;
  isPausable: boolean;
  hasCorruptTlv: boolean;
  isSafe: boolean;
}

/**
 * Token-2022 ExtensionType numbers, as in the installed @solana/spl-token (ExtensionType enum).
 * Note 16/17 are the confidential transfer FEE extensions and MetadataPointer is 18; a test cross-checks these against the library.
 */
export const EXTENSION_TYPE_NAMES: Record<number, string> = {
  0: 'Uninitialized',
  1: 'TransferFeeConfig',
  2: 'TransferFeeAmount',
  3: 'MintCloseAuthority',
  4: 'ConfidentialTransferMint',
  5: 'ConfidentialTransferAccount',
  6: 'DefaultAccountState',
  7: 'ImmutableOwner',
  8: 'MemoTransfer',
  9: 'NonTransferable',
  10: 'InterestBearingMint',
  11: 'CpiGuard',
  12: 'PermanentDelegate',
  13: 'NonTransferableAccount',
  14: 'TransferHook',
  15: 'TransferHookAccount',
  16: 'ConfidentialTransferFeeConfig',
  17: 'ConfidentialTransferFeeAmount',
  18: 'MetadataPointer',
  19: 'TokenMetadata',
  20: 'GroupPointer',
  21: 'TokenGroup',
  22: 'GroupMemberPointer',
  23: 'TokenGroupMember',
  24: 'ConfidentialMintBurn',
  25: 'ScaledUiAmountMint',
  26: 'Pausable',
  27: 'PausableAccount',
  28: 'PermissionedBurn',
};

export const ALLOWED_SAFE_EXTENSIONS = new Set<number>([18, 19, 20, 21, 22, 23]);

/** A base SPL Mint is 82 bytes. Token-2022 pads mints with extensions to the 165-byte Account size, then 1 account-type byte (1 = Mint), then TLV. */
export const MINT_BASE_LEN = 82;
export const TOKEN_ACCOUNT_BASE_LEN = 165;
export const ACCOUNT_TYPE_MINT = 1;

export interface PumpMarketState {
  mint: PublicKey;
  creator: PublicKey;
  bondingCurve: PublicKey;
  associatedBondingCurve: PublicKey;
  quoteMint: PublicKey;
  baseTokenProgram: PublicKey;
  quoteTokenProgram: PublicKey;
  tokenProgram: PublicKey; // backwards-compatible alias to baseTokenProgram
  tokenDecimals: number;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  isMayhemMode: boolean;
  mintAuthorityStatus?: TriState;
  freezeAuthorityStatus?: TriState;
  isMintAuthorityRevoked: boolean;
  isFreezeAuthorityRevoked: boolean;
  feeComputationStatus: 'VERIFIED' | 'UNAVAILABLE' | 'FAILED';
  protocolFeeBps: number;
  creatorFeeBps: number;
  feeRecipient: PublicKey;
  buybackFeeRecipient: PublicKey;
  /**
   * R4-9: the wall time this read's data is from: when this process first saw the RPC's context slot of the read (not when the read
   * returned), so a node that stalls on one slot serves marks that age, and the staleness gates (exit marks, the buy's market-data age) see it.
   */
  marketDataTimestamp: number;
  /** R4-9: the context slot of the account read (getMultipleAccountsInfoAndContext); undefined when the RPC gave none. */
  marketDataSlot?: number;
  marketDataSource: string;
  token2022Report?: Token2022ExtensionReport;
  /**
   * P1.6 (N-42): set only on a LIVE state whose fee tier could not be verified while the fee recipients did resolve. Such a state is never
   * returned by `fetchPumpMarketState`; it travels only in `MarketStateFailure.sellableState`, and `calculateSellQuote` prices it with this
   * fee (the highest tier the fee config lists, or `PUMP_SELL_FEE_CEILING_BPS`), so an exit can still be built. Buys refuse it.
   */
  unverifiedFeeCeilingBps?: number;
}

/** P1.6 (N-42): why `fetchPumpMarketState` returned null. `MINT_NOT_FOUND` and `CURVE_NOT_FOUND` mean "no curve"; the rest mean the read failed. */
export type MarketStateFailureReason =
  | 'MINT_NOT_FOUND'
  | 'CURVE_NOT_FOUND'
  | 'NOT_A_TOKEN_MINT'
  | 'DANGEROUS_TOKEN_2022_EXTENSION'
  | 'BONDING_CURVE_DECODE_FAILED'
  | 'UNSUPPORTED_QUOTE_MINT'
  | 'FEE_RECIPIENT_UNRESOLVED'
  | 'DYNAMIC_FEE_CALCULATION_FAILED'
  | 'FEE_CONFIG_MISSING'
  | 'UNVERIFIED_DYNAMIC_FEE'
  | 'RPC_ERROR';

export interface MarketStateFailure {
  reason: MarketStateFailureReason;
  message: string;
  /**
   * Only for the three fee-tier reasons when the fee recipients resolved, and (P4.2) for FEE_RECIPIENT_UNRESOLVED when the Global read
   * null but this endpoint returned one before: the state with `unverifiedFeeCeilingBps` set, for a SELL only.
   */
  sellableState?: PumpMarketState;
}

export type MarketStateResult = { state: PumpMarketState; failure?: undefined } | { state: null; failure: MarketStateFailure };

/** The two failure reasons that mean the mint has no bonding curve, as opposed to a curve that could not be read. */
export const NO_CURVE_REASONS: ReadonlySet<MarketStateFailureReason> = new Set(['MINT_NOT_FOUND', 'CURVE_NOT_FOUND']);

/**
 * P1.6 (N-42): the fee a SELL assumes when the fee config could not be read at all. A floor on the proceeds only (minOut): the program
 * charges its real fee, so assuming more than it can only lower the minimum accepted, never what is received. 5% is above every tier
 * pump.fun has published (about 1.25% in total).
 */
export const PUMP_SELL_FEE_CEILING_BPS = 500;

/** The highest total fee (lp + protocol + creator) any tier of a decoded pump fee config lists, or PUMP_SELL_FEE_CEILING_BPS without one. */
export function highestFeeTierBps(feeConfig: any): number {
  const sets: any[] = [];
  for (const t of [...(Array.isArray(feeConfig?.feeTiers) ? feeConfig.feeTiers : []), ...(Array.isArray(feeConfig?.stableFeeTiers) ? feeConfig.stableFeeTiers : [])]) sets.push(t?.fees);
  sets.push(feeConfig?.flatFees, feeConfig?.exoticFlatFees);
  const num = (v: any) => { const n = Number(v?.toString?.() ?? v ?? 0); return Number.isFinite(n) ? n : 0; };
  let max = 0;
  for (const f of sets) if (f) max = Math.max(max, num(f.lpFeeBps) + num(f.protocolFeeBps) + num(f.creatorFeeBps));
  return max > 0 ? max : PUMP_SELL_FEE_CEILING_BPS;
}

export interface TradeQuote {
  mint: string;
  side: 'BUY' | 'SELL';
  tokenProgram: string;
  tokenDecimals: number;
  tokenAmountRaw: string;
  expectedSolAmountLamports: number;
  maxInputLamports: number;
  minOutputLamports: number;
  protocolFeeLamports: number;
  creatorFeeLamports: number;
  expectedPriorityFeeLamports: number;
  expectedJitoTipLamports: number;
  estimatedPriceImpactBps: number;
  slippageBps: number;
  spotPriceSol: number;
  executionPriceSol: number;
  marketDataSource: string;
  marketDataTimestamp: number;
  quoteTimestamp: number;
}

export interface FetchPumpMarketStateParams {
  connection: Connection;
  mint: PublicKey;
  executionMode: ExecutionMode;
  /** P1.6 (N-42): filled with the reason when the call returns null (see `fetchPumpMarketStateResult`). */
  failure?: Partial<MarketStateFailure>;
}

export interface CalculateBuyQuoteParams {
  state: PumpMarketState;
  amountSol: number;
  slippageBps?: number;
  jitoTipSol?: number;
  priorityFeeLamports?: number;
  executionMode: ExecutionMode;
}

export interface CalculateSellQuoteParams {
  state: PumpMarketState;
  tokenAmountRaw: bigint;
  slippageBps?: number;
  jitoTipSol?: number;
  priorityFeeLamports?: number;
  executionMode: ExecutionMode;
}

export function inspectToken2022Extensions(data: Buffer | Uint8Array): Token2022ExtensionReport {
  const detectedExtensionTypes: number[] = [];
  const unsupportedExtensionTypes: number[] = [];
  const unsupportedExtensionNames: string[] = [];
  let hasTransferFee = false;
  let hasTransferHook = false;
  let hasPermanentDelegate = false;
  let isNonTransferable = false;
  let hasDefaultAccountState = false;
  let hasConfidentialTransfers = false;
  let isPausable = false;
  let hasCorruptTlv = false;

  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length > MINT_BASE_LEN) {
    if (buf.length <= TOKEN_ACCOUNT_BASE_LEN || buf[TOKEN_ACCOUNT_BASE_LEN] !== ACCOUNT_TYPE_MINT) {
      // Longer than a base mint but without the padded account-type marker: not a layout we understand.
      hasCorruptTlv = true;
    } else {
      let offset = TOKEN_ACCOUNT_BASE_LEN + 1;
      while (offset + 4 <= buf.length) {
        const extensionType = buf.readUInt16LE(offset);
        const extensionLength = buf.readUInt16LE(offset + 2);
        if (extensionType === 0) break; // Uninitialized: zero padding, end of TLV (same rule as spl-token)

        if (offset + 4 + extensionLength > buf.length) {
          hasCorruptTlv = true;
          break;
        }

        detectedExtensionTypes.push(extensionType);
        if (!ALLOWED_SAFE_EXTENSIONS.has(extensionType)) {
          unsupportedExtensionTypes.push(extensionType);
          unsupportedExtensionNames.push(EXTENSION_TYPE_NAMES[extensionType] || `UnknownExtension(${extensionType})`);
        }

        if (extensionType === 1 || extensionType === 2) hasTransferFee = true;
        if (extensionType === 9 || extensionType === 13) isNonTransferable = true;
        if (extensionType === 12) hasPermanentDelegate = true;
        if (extensionType === 14 || extensionType === 15) hasTransferHook = true;
        if (extensionType === 6) hasDefaultAccountState = true;
        if (extensionType === 4 || extensionType === 5 || extensionType === 16 || extensionType === 17 || extensionType === 24) hasConfidentialTransfers = true;
        if (extensionType === 26 || extensionType === 27) isPausable = true;

        offset += 4 + extensionLength;
      }
    }
  }

  const isSafe = !hasCorruptTlv && unsupportedExtensionTypes.length === 0;
  return {
    detectedExtensionTypes,
    unsupportedExtensionTypes,
    unsupportedExtensionNames,
    hasTransferFee,
    hasTransferHook,
    hasPermanentDelegate,
    isNonTransferable,
    hasDefaultAccountState,
    hasConfidentialTransfers,
    isPausable,
    hasCorruptTlv,
    isSafe,
  };
}

// Authoritative resolution of fee recipient accounts according to official Pump V2 rules
export function resolvePumpFeeRecipients(
  global: any,
  isMayhemMode: boolean,
  executionMode: ExecutionMode
): { feeRecipient: PublicKey; buybackFeeRecipient: PublicKey } {
  if (executionMode !== 'LIVE' && executionMode !== 'PAPER' && (executionMode as any) !== 'BACKTEST') {
    throw new Error('CRITICAL_CONFIG_ERROR: executionMode ("LIVE" | "PAPER") is strictly required for resolvePumpFeeRecipients');
  }
  const isLiveMode = executionMode === 'LIVE';
  let normalRecipients: PublicKey[] = [];
  let reservedRecipients: PublicKey[] = [];
  let buybackRecipients: PublicKey[] = [];

  if (global) {
    // 1. Normal fee recipient pool (used when isMayhemMode = false)
    if (global.feeRecipient) {
      normalRecipients.push(new PublicKey(global.feeRecipient));
    }
    if (Array.isArray(global.feeRecipients)) {
      for (const r of global.feeRecipients) {
        if (r && !new PublicKey(r).equals(PublicKey.default)) {
          normalRecipients.push(new PublicKey(r));
        }
      }
    }

    // 2. Reserved fee recipient pool (used ONLY when isMayhemMode = true)
    if (global.reservedFeeRecipient) {
      reservedRecipients.push(new PublicKey(global.reservedFeeRecipient));
    }
    if (Array.isArray(global.reservedFeeRecipients)) {
      for (const r of global.reservedFeeRecipients) {
        if (r && !new PublicKey(r).equals(PublicKey.default)) {
          reservedRecipients.push(new PublicKey(r));
        }
      }
    }

    // 3. Buyback fee recipient pool (official SDK static pool used for ALL coins)
    if (Array.isArray(global.buybackFeeRecipients) && global.buybackFeeRecipients.length > 0) {
      const onchainBuyback: PublicKey[] = [];
      for (const r of global.buybackFeeRecipients) {
        if (r && !new PublicKey(r).equals(PublicKey.default)) {
          onchainBuyback.push(new PublicKey(r));
        }
      }
      if (onchainBuyback.length > 0) {
        buybackRecipients = onchainBuyback;
      }
    }
  }

  // Fail-closed verification for LIVE mode
  if (isLiveMode) {
    if (!isMayhemMode && normalRecipients.length === 0) {
      throw new Error('FEE_RECIPIENT_UNRESOLVED: Normal protocol fee recipients unresolvable from on-chain Global state in LIVE mode');
    }
    if (isMayhemMode && reservedRecipients.length === 0) {
      throw new Error('FEE_RECIPIENT_UNRESOLVED: Reserved fee recipients unresolvable for Mayhem coin in LIVE mode');
    }
    if (buybackRecipients.length === 0) {
      throw new Error('FEE_RECIPIENT_UNRESOLVED: Authoritative buyback fee recipients unresolvable from on-chain Global state in LIVE mode');
    }
  }

  // Fallback to official SDK constants if running in paper/test/mock mode
  if (normalRecipients.length === 0) {
    normalRecipients = CURRENT_FEE_RECIPIENTS.map((s) => new PublicKey(s));
  }
  if (reservedRecipients.length === 0) {
    reservedRecipients = CURRENT_RESERVED_FEE_RECIPIENTS.map((s) => new PublicKey(s));
  }
  if (buybackRecipients.length === 0) {
    buybackRecipients = CURRENT_FEE_RECIPIENTS_FOR_BUYBACK.map((s) => new PublicKey(s));
  }

  // Select feeRecipient: normal vs reserved based on isMayhemMode
  const feePool = isMayhemMode ? reservedRecipients : normalRecipients;
  const feeRecipient = feePool[Math.floor(Math.random() * feePool.length)];

  // Select buybackFeeRecipient: ALWAYS from the separate buyback pool (never reservedFeeRecipient or normal)
  const buybackFeeRecipient = buybackRecipients[Math.floor(Math.random() * buybackRecipients.length)];

  // Strict assertion: normal/reserved and buyback recipients must never collide
  if (feeRecipient.equals(buybackFeeRecipient)) {
    throw new Error(
      `FEE_RECIPIENT_COLLISION: feeRecipient (${feeRecipient.toBase58()}) and buybackFeeRecipient (${buybackFeeRecipient.toBase58()}) must not be identical`
    );
  }

  return {
    feeRecipient,
    buybackFeeRecipient,
  };
}

export interface TokenHolderDistribution {
  mint: string;
  totalCirculatingSupply: bigint;
  nonBondingCirculatingSupply: bigint;
  bondingCurveBalance: bigint;
  creatorBalance: bigint;
  /** R2-3: large holders whose owner the funder lookups tie to the creator (CREATOR_CLUSTER, or a non-ATA account of the creator). In devHoldingPct. */
  creatorClusterBalance: bigint;
  /** R2-3: large holders whose owner or funding is not known (UNKNOWN). Counted together as one holder in top10HoldersPct. */
  unknownHolderBalance: bigint;
  top10HoldersPct: number;
  /** The creator's own accounts plus its funder cluster (R2-3), as a share of total supply. */
  devHoldingPct: number;
  topHolders: Array<{ address: string; amount: bigint; pct: number; owner?: string | null; holderClass?: HolderClass | 'CREATOR_ATA' }>;
}

/**
 * The most keys one getMultipleAccounts call may carry. QuickNode's Discover plan refuses more than 5 with HTTP 413 ("getMultipleAccounts is
 * limited to a 5 range"; see the cloud devnet notes), which made the R2-3 owner read fail for every coin with more than 5 large holders
 * (devnet run 2026-10-27, step (a)). Other providers allow 100; 5 costs at most 4 calls for the 20 largest accounts.
 */
export const GET_MULTIPLE_ACCOUNTS_MAX_KEYS = 5;

/** R2-3: the owner of each token account (bytes 32..64 of the SPL / Token-2022 account), read GET_MULTIPLE_ACCOUNTS_MAX_KEYS at a time; null where unreadable. */
async function tokenAccountOwners(connection: Connection, accounts: PublicKey[]): Promise<Array<string | null>> {
  if (accounts.length === 0) return [];
  if (typeof (connection as any).getMultipleAccountsInfo !== 'function') return accounts.map(() => null);
  const owners: Array<string | null> = [];
  for (let i = 0; i < accounts.length; i += GET_MULTIPLE_ACCOUNTS_MAX_KEYS) {
    const batch = accounts.slice(i, i + GET_MULTIPLE_ACCOUNTS_MAX_KEYS);
    try {
      const infos = await connection.getMultipleAccountsInfo(batch, 'confirmed');
      for (let j = 0; j < batch.length; j++) {
        const d = infos?.[j]?.data;
        owners.push(d && d.length >= 64 ? new PublicKey(d.subarray(32, 64)).toBase58() : null);
      }
    } catch (err: any) {
      // fail closed: these holders count as unknown (never independent, never the creator's); the other batches are still read
      Logger.warn(`holder owners for the holder gate could not be read for ${batch.length} of ${accounts.length} account(s) (${err?.message || err}); those holders count as unknown`);
      for (let j = 0; j < batch.length; j++) owners.push(null);
    }
  }
  return owners;
}

/**
 * The holder gate's facts: creator holding and top-10 concentration, as shares of the total supply.
 * R2-3: each large non-curve account's owner is read (getMultipleAccountsInfo, GET_MULTIPLE_ACCOUNTS_MAX_KEYS per call) and classified by the funder
 * lookups' knowledge (`holderFunders`, default the watch window, see server/signals/holderCluster.ts). Holdings the creator's funder cluster
 * owns count in devHoldingPct with the creator's own. Fail closed for LIVE: a holder whose owner or funding is unknown is never taken as
 * independent; all unknown holders together count as ONE holder in the top-10 figure (so 40 unknown wallets at 1.8% read as 36% of the top
 * 20 accounts, not 18%).
 */
export async function fetchTokenHolderDistribution(
  connection: Connection,
  mint: PublicKey,
  creator?: PublicKey,
  bondingCurve?: PublicKey,
  holderFunders: HolderFunderSource = defaultHolderFunderSource
): Promise<TokenHolderDistribution> {
  const largestAccountsRes = await connection.getTokenLargestAccounts(mint);
  const largestAccounts = largestAccountsRes.value || [];

  // Determine bonding curve address and its associated token accounts
  const bondingCurveAddresses = new Set<string>();
  if (bondingCurve) {
    bondingCurveAddresses.add(bondingCurve.toBase58());
    const ataSpl = PumpCurveService.getAssociatedTokenAddress(mint, bondingCurve, TOKEN_PROGRAM_ID);
    bondingCurveAddresses.add(ataSpl.toBase58());
    const ata2022 = PumpCurveService.getAssociatedTokenAddress(mint, bondingCurve, TOKEN_2022_PROGRAM_ID);
    bondingCurveAddresses.add(ata2022.toBase58());
  }

  // Also derive the default Pump.fun bonding curve PDA and its ATAs
  try {
    const [derivedBc] = PumpCurveService.getBondingCurveAddress(mint);
    bondingCurveAddresses.add(derivedBc.toBase58());
    const derivedAtaSpl = PumpCurveService.getAssociatedTokenAddress(mint, derivedBc, TOKEN_PROGRAM_ID);
    bondingCurveAddresses.add(derivedAtaSpl.toBase58());
    const derivedAta2022 = PumpCurveService.getAssociatedTokenAddress(mint, derivedBc, TOKEN_2022_PROGRAM_ID);
    bondingCurveAddresses.add(derivedAta2022.toBase58());
  } catch {
    // ignore derivation errors if invalid mint buffer
  }

  // Find bonding curve account and its balance
  let bondingCurveBalance = 0n;
  for (const acc of largestAccounts) {
    if (bondingCurveAddresses.has(acc.address.toBase58())) {
      bondingCurveBalance += BigInt(acc.amount);
    }
  }

  // Filter out bonding curve account(s)
  const nonCurveAccounts = largestAccounts.filter(
    (acc) => !bondingCurveAddresses.has(acc.address.toBase58())
  );

  // Determine total supply and non-bonding circulating supply
  let totalSupply = 0n;
  try {
    if (typeof (connection as any).getTokenSupply === 'function') {
      const supplyRes = await (connection as any).getTokenSupply(mint);
      if (supplyRes?.value?.amount) {
        totalSupply = BigInt(supplyRes.value.amount);
      }
    }
  } catch {
    // If getTokenSupply RPC call fails or is unmocked
  }

  if (totalSupply === 0n) {
    // Fall back to sum of accounts if supply query was unavailable
    totalSupply = largestAccounts.reduce((sum, acc) => sum + BigInt(acc.amount), 0n);
  }

  let nonBondingCirculatingSupply = totalSupply - bondingCurveBalance;
  if (nonBondingCirculatingSupply <= 0n) {
    // Fall back to sum of non-curve accounts
    nonBondingCirculatingSupply = nonCurveAccounts.reduce((sum, acc) => sum + BigInt(acc.amount), 0n);
  }

  // Calculate creator holding
  let creatorBalance = 0n;
  const creatorAddrsForExclusion = new Set<string>();
  if (creator) {
    const creatorAddresses = creatorAddrsForExclusion;
    creatorAddresses.add(creator.toBase58());
    try {
      const creatorAtaSpl = PumpCurveService.getAssociatedTokenAddress(mint, creator, TOKEN_PROGRAM_ID);
      creatorAddresses.add(creatorAtaSpl.toBase58());
      const creatorAta2022 = PumpCurveService.getAssociatedTokenAddress(mint, creator, TOKEN_2022_PROGRAM_ID);
      creatorAddresses.add(creatorAta2022.toBase58());
    } catch {
      // ignore
    }

    for (const acc of nonCurveAccounts) {
      if (creatorAddresses.has(acc.address.toBase58())) {
        creatorBalance += BigInt(acc.amount);
      }
    }

    // If creator ATA was not in top largest accounts, try fetching directly if supported
    if (creatorBalance === 0n && typeof connection.getTokenAccountBalance === 'function') {
      try {
        const creatorAtaSpl = PumpCurveService.getAssociatedTokenAddress(mint, creator, TOKEN_PROGRAM_ID);
        const balRes = await connection.getTokenAccountBalance(creatorAtaSpl);
        if (balRes?.value?.amount) {
          creatorBalance = BigInt(balRes.value.amount);
        }
      } catch {
        // Creator has no balance or ATA not initialized -> 0
      }
    }
  }

  // R2-3: classify every other large holder by its owner's funding (one owner read for all of them)
  const insiders = new Set<string>(creator ? [creator.toBase58()] : []);
  const others = nonCurveAccounts.filter((acc) => !creatorAddrsForExclusion.has(acc.address.toBase58()));
  const owners = await tokenAccountOwners(connection, others.map((acc) => acc.address));
  const classOf = new Map<string, { owner: string | null; cls: HolderClass }>();
  others.forEach((acc, i) => classOf.set(acc.address.toBase58(), { owner: owners[i], cls: classifyHolder(owners[i], insiders, holderFunders) }));
  let creatorClusterBalance = 0n, unknownHolderBalance = 0n;
  const independent: bigint[] = [];
  for (const acc of others) {
    const amt = BigInt(acc.amount);
    const c = classOf.get(acc.address.toBase58())!.cls;
    if (c === 'CREATOR' || c === 'CREATOR_CLUSTER') creatorClusterBalance += amt;
    else if (c === 'UNKNOWN') unknownHolderBalance += amt;
    else independent.push(amt);
  }

  // C1: concentration is a share of TOTAL supply. The bonding curve and the creator's cluster are excluded from the top-10 list (they are
  // scored via devHoldingPct). R2-3: the unknown holders are one entry in it, summed.
  const entries = [...independent, ...(unknownHolderBalance > 0n ? [unknownHolderBalance] : [])].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const top10Amount = entries.slice(0, 10).reduce((sum, v) => sum + v, 0n);
  const pctOfTotal = (amt: bigint) =>
    totalSupply > 0n ? Number(((Number(amt) / Number(totalSupply)) * 100).toFixed(2)) : 0;
  const top10HoldersPct = pctOfTotal(top10Amount);

  const devHoldingPct = pctOfTotal(creatorBalance + creatorClusterBalance);

  const topHolders = nonCurveAccounts.map((acc) => {
    const amountBig = BigInt(acc.amount);
    const pct = pctOfTotal(amountBig);
    const address = acc.address.toBase58();
    const c = classOf.get(address);
    return { address, amount: amountBig, pct, owner: c ? c.owner : creator?.toBase58() ?? null, holderClass: c ? c.cls : ('CREATOR_ATA' as const) };
  });

  return {
    mint: mint.toBase58(),
    totalCirculatingSupply: totalSupply,
    nonBondingCirculatingSupply,
    bondingCurveBalance,
    creatorBalance,
    creatorClusterBalance,
    unknownHolderBalance,
    top10HoldersPct,
    devHoldingPct,
    topHolders,
  };
}

/**
 * R4-9: how many slots a read (or the RPC heartbeat) may be behind the highest slot already seen on the same endpoint and still be used.
 * The nodes behind one load-balanced RPC URL are usually a slot or two apart, and two concurrent reads can answer out of order; refusing
 * those made LIVE buys fail MARKET_DATA_UNAVAILABLE at random. A node further behind (seconds to minutes) is still refused. About 3 s.
 */
export const RPC_SLOT_SKEW_TOLERANCE = 8;
/** R4-9: the time one slot stands for when a read a few slots behind is stamped (Solana's target slot time). */
export const SLOT_TIME_ESTIMATE_MS = 400;

export class PumpCurveService {
  public static cachedGlobal: any = null;
  /** R19: mints whose account is not owned by a token program, with the reason, so the mark path can alert instead of falling through to PumpSwap. */
  private static mintRejections = new Map<string, string>();
  public static getMintRejection(mint: string): string | undefined { return PumpCurveService.mintRejections.get(mint); }
  public static clearMintRejections(): void { PumpCurveService.mintRejections.clear(); }
  public static cachedFeeConfig: any = null;
  public static fetchTokenHolderDistribution = fetchTokenHolderDistribution;
  private static cacheTimestamp = 0;
  private static readonly CACHE_TTL_MS = 60000; // 1 minute cache for global fee parameters
  /** P4.2 (N-43): which endpoint and cluster the cached Global and FeeConfig were read from (`globalCacheKey`). */
  private static cacheKey: string | null = null;
  /**
   * P4.2 (N-43 vs S237): the last Global that decoded, with its cache key. It never prices or routes a buy: it is used only to resolve
   * the fee recipients of the SELL-only state (`MarketStateFailure.sellableState`) when a refresh on the same endpoint and cluster read
   * the Global as null, so a transient null read does not leave a stop-loss without a transaction to send. Cleared by `resetGlobalCache`.
   */
  private static lastGoodGlobal: { key: string; global: any } | null = null;

  /**
   * R4-9: per Connection, the highest context slot a curve read has answered from and the wall time it was first seen. Reads ask for
   * at least that slot less RPC_SLOT_SKEW_TOLERANCE (`minContextSlot`), so a node further behind is refused by the RPC rather than read,
   * and a read whose slot is further behind anyway is treated as failed. A read from the same slot is stamped with the time that slot was
   * first seen, so a stalled node's marks age while wall time advances; one a few slots behind is stamped that much older again.
   * Keyed by the Connection object, so a new endpoint (setRpcEndpoint) starts fresh.
   */
  private static slotSeen = new WeakMap<object, { slot: number; firstSeenAt: number }>();

  /** R4-9: the slot floor for the next read on this connection (undefined before the first): the highest slot seen less the skew bound. */
  public static minContextSlotFor(connection: Connection): number | undefined {
    const seen = this.slotSeen.get(connection as object)?.slot;
    return seen === undefined ? undefined : Math.max(1, seen - RPC_SLOT_SKEW_TOLERANCE);
  }

  /**
   * R4-9: record a read's context slot; returns the wall time the data stands for, or null when the slot is more than
   * RPC_SLOT_SKEW_TOLERANCE behind one already seen (a lagging node, whose state must not be used). A read up to that many slots
   * behind (the nodes of a load-balanced RPC are a slot or two apart, and two concurrent reads can answer out of order) is used,
   * stamped SLOT_TIME_ESTIMATE_MS per slot older than the time the newest slot was first seen.
   */
  public static noteContextSlot(connection: Connection, slot: number | undefined, now: number = Date.now()): number | null {
    if (typeof slot !== 'number' || !Number.isFinite(slot) || slot <= 0) return now; // no context slot: the read time, as before
    const prev = this.slotSeen.get(connection as object);
    if (!prev || slot > prev.slot) {
      this.slotSeen.set(connection as object, { slot, firstSeenAt: now });
      return now;
    }
    const lag = prev.slot - slot;
    if (lag > RPC_SLOT_SKEW_TOLERANCE) return null;
    return Math.min(now, prev.firstSeenAt) - lag * SLOT_TIME_ESTIMATE_MS;
  }

  /**
   * P4.2 (N-43): the cache key: the Connection's endpoint plus the genesis hash the cluster guard requires for ALLOWED_CLUSTER (the
   * configured hash, not one read per call; the send path's genesis check is what proves the endpoint serves it). A read through
   * another endpoint, or after ALLOWED_CLUSTER / LOCALNET_GENESIS_HASH changed, refreshes the Global and FeeConfig first.
   */
  public static globalCacheKey(connection: Connection): string {
    let genesis = '';
    try { genesis = expectedGenesisHash(); } catch { /* localnet without LOCALNET_GENESIS_HASH: the endpoint alone */ }
    return `${(connection as any)?.rpcEndpoint ?? ''}|${genesis}`;
  }

  /** P4.2 (N-43): forget the cached Global and FeeConfig (called by `setRpcEndpoint`), so the next read fetches both again. */
  public static resetGlobalCache(): void {
    this.cachedGlobal = null;
    this.cachedFeeConfig = null;
    this.cacheTimestamp = 0;
    this.cacheKey = null;
    this.lastGoodGlobal = null;
  }

  // Derive bonding curve PDA for any token mint
  public static getBondingCurveAddress(mint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mint.toBuffer()],
      PUMP_FUN_PROGRAM_ID
    );
  }

  // Derive associated token account with dynamic token program (SPL vs Token-2022)
  public static getAssociatedTokenAddress(
    mint: PublicKey,
    owner: PublicKey,
    tokenProgramId: PublicKey = TOKEN_PROGRAM_ID
  ): PublicKey {
    const [ata] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    return ata;
  }

  // Fetch real on-chain bonding curve state, mint metadata, global config, and dynamic fees
  public static async fetchPumpMarketState(
    paramsOrConn: FetchPumpMarketStateParams | Connection,
    mintArg?: PublicKey,
    modeArg?: ExecutionMode
  ): Promise<PumpMarketState | null> {
    let connection: Connection;
    let mint: PublicKey;
    let executionMode: ExecutionMode;
    let out: Partial<MarketStateFailure> | undefined;

    if ('connection' in paramsOrConn) {
      connection = paramsOrConn.connection;
      mint = paramsOrConn.mint;
      executionMode = paramsOrConn.executionMode;
      out = paramsOrConn.failure;
    } else {
      connection = paramsOrConn;
      mint = mintArg!;
      if (modeArg !== 'LIVE' && modeArg !== 'PAPER') {
        throw new Error('CRITICAL_CONFIG_ERROR: executionMode ("LIVE" | "PAPER") is strictly required for fetchPumpMarketState');
      }
      executionMode = modeArg;
    }

    const isLiveMode = executionMode === 'LIVE';
    const [bondingCurve] = this.getBondingCurveAddress(mint);
    /** P1.6 (N-42): every null says why, so a caller can tell "no curve" from "the curve could not be read". */
    const fail = (reason: MarketStateFailureReason, message: string, sellableState?: PumpMarketState): null => {
      if (out) { out.reason = reason; out.message = message; out.sellableState = sellableState; }
      return null;
    };

    try {
      const now = Date.now();
      const key = this.globalCacheKey(connection);
      const needGlobalRefresh =
        !this.cachedGlobal ||
        !this.cachedFeeConfig ||
        key !== this.cacheKey ||
        now - this.cacheTimestamp > this.CACHE_TTL_MS;

      const accountsToFetch = [mint, bondingCurve];
      if (needGlobalRefresh) {
        accountsToFetch.push(GLOBAL_PDA, PUMP_FEE_CONFIG_PDA);
      }

      // R4-9: read with the context slot, never from a state older than one already seen on this connection
      const minContextSlot = this.minContextSlotFor(connection);
      const read = await connection.getMultipleAccountsInfoAndContext(accountsToFetch, minContextSlot ? { minContextSlot } : undefined);
      const accountInfos = read.value;
      const marketDataSlot: number | undefined = read.context?.slot;
      const highestSeen = this.slotSeen.get(connection as object)?.slot;
      const marketDataTimestamp = this.noteContextSlot(connection, marketDataSlot);
      if (marketDataTimestamp === null) {
        return fail('RPC_ERROR', `the RPC answered from slot ${marketDataSlot}, more than ${RPC_SLOT_SKEW_TOLERANCE} slots behind slot ${highestSeen} already seen (a lagging node); not used`);
      }
      const mintAccountInfo = accountInfos[0];
      const curveAccountInfo = accountInfos[1];

      if (needGlobalRefresh) {
        // P4.2 (N-43): a refresh replaces both values. An account that reads null (or does not decode) becomes null, never the
        // previous decode: LIVE then fails closed (FEE_RECIPIENT_UNRESOLVED without a Global, FEE_CONFIG_MISSING without a FeeConfig,
        // where a SELL still gets its S237 fee-ceiling state). The timestamp and key are set only when both were read, so a null is
        // asked for again on the next call instead of being kept for the TTL.
        let global: any = null;
        let feeConfig: any = null;
        if (accountInfos[2]) {
          try { global = PUMP_SDK.decodeGlobal(accountInfos[2]); } catch { global = null; }
        }
        if (accountInfos[3]) {
          try { feeConfig = PUMP_SDK.decodeFeeConfig(accountInfos[3]); } catch { feeConfig = null; }
        }
        this.cachedGlobal = global;
        this.cachedFeeConfig = feeConfig;
        if (global) this.lastGoodGlobal = { key, global };
        if (global && feeConfig) {
          this.cacheTimestamp = now;
          this.cacheKey = key;
        } else {
          this.cacheKey = null;
        }
      }

      const finalMintInfo = mintAccountInfo;
      const finalCurveInfo = curveAccountInfo;

      if (!finalMintInfo) {
        Logger.warn(`Mint account not found on Solana RPC: ${mint.toBase58()}`);
        return fail('MINT_NOT_FOUND', `mint account ${mint.toBase58()} not found`);
      }

      if (!finalCurveInfo) {
        Logger.warn(`Pump.fun bonding curve account not found: ${bondingCurve.toBase58()}`);
        return fail('CURVE_NOT_FOUND', `bonding curve ${bondingCurve.toBase58()} not found`);
      }

      // The token program is the mint account's owner, never inferred from its contents. Any other owner is not a mint.
      if (!finalMintInfo.owner.equals(TOKEN_PROGRAM_ID) && !finalMintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
        Logger.error(`Mint ${mint.toBase58()} is owned by ${finalMintInfo.owner.toBase58()}, not a token program`);
        PumpCurveService.mintRejections.set(mint.toBase58(), `its account is owned by ${finalMintInfo.owner.toBase58()}, not a token program`);
        return fail('NOT_A_TOKEN_MINT', `mint account owned by ${finalMintInfo.owner.toBase58()}, not a token program`);
      }
      PumpCurveService.mintRejections.delete(mint.toBase58());
      let baseTokenProgram = TOKEN_PROGRAM_ID;
      let token2022Report: Token2022ExtensionReport | undefined = undefined;
      if (finalMintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
        baseTokenProgram = TOKEN_2022_PROGRAM_ID;
        token2022Report = inspectToken2022Extensions(finalMintInfo.data);
        if (!token2022Report.isSafe) {
          if (isLiveMode) {
            Logger.error(
              `DANGEROUS_TOKEN_2022_EXTENSION in LIVE mode for ${mint.toBase58()}: unsupported=[${token2022Report.unsupportedExtensionNames.join(', ')}]`
            );
            return fail('DANGEROUS_TOKEN_2022_EXTENSION', `unsupported Token-2022 extensions: ${token2022Report.unsupportedExtensionNames.join(', ')}`);
          }
          Logger.warn(`Mint ${mint.toBase58()} has active Token-2022 extensions: ${token2022Report.unsupportedExtensionNames.join(', ')} (allowed in PAPER mode only)`);
        }
      }
      // WSOL / SOL quote is strictly standard SPL Token Program
      const quoteTokenProgram = TOKEN_PROGRAM_ID;

      // Parse token decimals and authority options from mint data (offset 44 in SPL / Token-2022 mint layout)
      let tokenDecimals = 6;
      let isMintAuthorityRevoked = false;
      let isFreezeAuthorityRevoked = false;
      let mintAuthorityStatus: TriState = 'UNKNOWN';
      let freezeAuthorityStatus: TriState = 'UNKNOWN';

      if (finalMintInfo.data.length >= 82) {
        // Offset 0..3: COption<Pubkey> for mint authority (0 = None/Revoked, 1 = Some/Active)
        const mintAuthOption = finalMintInfo.data.readUInt32LE(0);
        isMintAuthorityRevoked = mintAuthOption === 0;
        mintAuthorityStatus = isMintAuthorityRevoked ? 'PASS' : 'FAIL';

        tokenDecimals = finalMintInfo.data.readUInt8(44);

        // Offset 46..49: COption<Pubkey> for freeze authority (0 = None/Revoked, 1 = Some/Active)
        const freezeAuthOption = finalMintInfo.data.readUInt32LE(46);
        isFreezeAuthorityRevoked = freezeAuthOption === 0;
        freezeAuthorityStatus = isFreezeAuthorityRevoked ? 'PASS' : 'FAIL';
      } else if (finalMintInfo.data.length >= 45) {
        tokenDecimals = finalMintInfo.data.readUInt8(44);
      }

      let creator: PublicKey = PublicKey.default;
      let quoteMint: PublicKey = NATIVE_MINT;
      let isMayhemMode = false;
      let virtualTokenReserves = 0n;
      let virtualSolReserves = 0n;
      let realTokenReserves = 0n;
      let realSolReserves = 0n;
      let tokenTotalSupply = 0n;
      let complete = false;
      let creatorFeeBps = 0;
      let sdkDecodedSuccessfully = false;

      // Try official Anchor SDK decode first
      try {
        const decoded = PUMP_SDK.decodeBondingCurve(finalCurveInfo);
        virtualTokenReserves = BigInt(decoded.virtualTokenReserves.toString());
        virtualSolReserves = BigInt(decoded.virtualQuoteReserves.toString());
        realTokenReserves = BigInt(decoded.realTokenReserves.toString());
        realSolReserves = BigInt(decoded.realQuoteReserves.toString());
        tokenTotalSupply = BigInt(decoded.tokenTotalSupply.toString());
        complete = Boolean(decoded.complete);
        if (decoded.creator) {
          creator = new PublicKey(decoded.creator);
        }
        isMayhemMode = Boolean(decoded.isMayhemMode);
        if (decoded.quoteMint) {
          const rawQuote = new PublicKey(decoded.quoteMint);
          quoteMint = isLegacyQuoteMint(rawQuote) ? NATIVE_MINT : rawQuote;
        }
        if (decoded.creatorFeeBps) {
          creatorFeeBps = Number(decoded.creatorFeeBps.toString());
        }
        sdkDecodedSuccessfully = true;
      } catch (sdkErr: any) {
        if (isLiveMode) {
          // In LIVE mode: Fail closed! Never guess account layout using stale binary offsets
          Logger.error(`BONDING_CURVE_DECODE_FAILED: Official SDK decode failed in LIVE mode for ${mint.toBase58()}: ${sdkErr.message}`);
          return fail('BONDING_CURVE_DECODE_FAILED', `official SDK decode failed: ${sdkErr.message}`);
        }

        // Retain manual binary offset fallback strictly for PAPER/TEST/RESEARCH diagnostics
        const data = finalCurveInfo.data;
        if (data.length < 49) {
          Logger.warn(`Bonding curve account data truncated: ${data.length} bytes`);
          return fail('BONDING_CURVE_DECODE_FAILED', `bonding curve data truncated (${data.length} bytes)`);
        }

        const disc = data.subarray(0, 8);
        if (!disc.equals(BONDING_CURVE_DISCRIMINATOR)) {
          Logger.warn(`Invalid bonding curve account discriminator: ${disc.toString('hex')}`);
          return fail('BONDING_CURVE_DECODE_FAILED', `invalid bonding curve discriminator ${disc.toString('hex')}`);
        }

        virtualTokenReserves = data.readBigUInt64LE(8);
        virtualSolReserves = data.readBigUInt64LE(16);
        realTokenReserves = data.readBigUInt64LE(24);
        realSolReserves = data.readBigUInt64LE(32);
        tokenTotalSupply = data.readBigUInt64LE(40);
        complete = data.readUInt8(48) === 1;

        if (data.length >= 81) {
          creator = new PublicKey(data.subarray(49, 81));
        }
        if (data.length >= 82) {
          isMayhemMode = data.readUInt8(81) === 1;
        }
        if (data.length >= 115) {
          const rawQuote = new PublicKey(data.subarray(83, 115));
          quoteMint = isLegacyQuoteMint(rawQuote) ? NATIVE_MINT : rawQuote;
        }
        if (data.length >= 123) {
          creatorFeeBps = Number(data.readBigUInt64LE(115));
        }
      }

      // Explicitly enforce native SOL quote mint only. P4.2 (R1-64): PAPER too, so a non-SOL curve is never scored or paper-filled on SOL fields.
      if (!quoteMint.equals(NATIVE_MINT) && !quoteMint.equals(new PublicKey('So11111111111111111111111111111111111111112'))) {
        Logger.warn(`UNSUPPORTED_QUOTE_MINT: Mint ${mint.toBase58()} uses exotic quote mint ${quoteMint.toBase58()}. Only native SOL is supported.`);
        return fail('UNSUPPORTED_QUOTE_MINT', `quote mint ${quoteMint.toBase58()} is not native SOL`);
      }

      // Authoritative fee recipient resolution according to Pump V2 protocol
      let feeRecipient: PublicKey;
      let buybackFeeRecipient: PublicKey;
      let feeFailure: { reason: MarketStateFailureReason; message: string } | undefined;
      try {
        ({ feeRecipient, buybackFeeRecipient } = resolvePumpFeeRecipients(this.cachedGlobal, isMayhemMode, executionMode));
      } catch (recipErr: any) {
        Logger.error(`Fee recipients unresolved for ${mint.toBase58()}: ${recipErr.message}`);
        // P4.2: the Global read null on this endpoint. A buy fails closed; a SELL may still be built with the recipients of the last
        // Global this endpoint and cluster returned (through `sellableState` only, priced at the fee ceiling below).
        const stale = !this.cachedGlobal && isLiveMode && this.lastGoodGlobal?.key === key ? this.lastGoodGlobal.global : null;
        if (!stale) return fail('FEE_RECIPIENT_UNRESOLVED', recipErr.message);
        try {
          ({ feeRecipient, buybackFeeRecipient } = resolvePumpFeeRecipients(stale, isMayhemMode, executionMode));
        } catch {
          return fail('FEE_RECIPIENT_UNRESOLVED', recipErr.message);
        }
        feeFailure = { reason: 'FEE_RECIPIENT_UNRESOLVED', message: `${recipErr.message}; a SELL may use the last Global read from this endpoint` };
      }

      // Authoritative dynamic fee computation using official Pump V2 Fee Schedule
      let protocolFeeBps = 100;
      let feeComputationStatus: 'VERIFIED' | 'UNAVAILABLE' | 'FAILED' = 'UNAVAILABLE';

      if (this.cachedGlobal && this.cachedFeeConfig && typeof computeFeesBps === 'function') {
        try {
          const fees = computeFeesBps({
            global: this.cachedGlobal,
            feeConfig: this.cachedFeeConfig,
            mintSupply: new BN(tokenTotalSupply.toString()),
            virtualQuoteReserves: new BN(virtualSolReserves.toString()),
            virtualTokenReserves: new BN(virtualTokenReserves.toString()),
            quoteMint,
            creatorFeeBps: new BN(creatorFeeBps),
          });
          if (fees && fees.protocolFeeBps != null) {
            protocolFeeBps = Number(fees.protocolFeeBps.toString());
            feeComputationStatus = 'VERIFIED';
          }
          if (fees && fees.creatorFeeBps != null) {
            creatorFeeBps = Number(fees.creatorFeeBps.toString());
          }
        } catch (feeCalcErr: any) {
          feeComputationStatus = 'FAILED';
          if (isLiveMode) {
            Logger.error(`DYNAMIC_FEE_CALCULATION_FAILED in LIVE mode for ${mint.toBase58()}: ${feeCalcErr.message}`);
            feeFailure = { reason: 'DYNAMIC_FEE_CALCULATION_FAILED', message: feeCalcErr.message };
          } else {
            Logger.debug(`Dynamic fee calculation fallback: ${feeCalcErr.message}`);
          }
        }
      } else if (isLiveMode && !feeFailure) {
        Logger.error(`FEE_CONFIG_MISSING in LIVE mode: Cached global or feeConfig not present for ${mint.toBase58()}`);
        feeFailure = { reason: 'FEE_CONFIG_MISSING', message: 'the Global or FeeConfig account is missing or could not be decoded' };
      }

      if (isLiveMode && !feeFailure && feeComputationStatus !== 'VERIFIED') {
        Logger.error(`UNVERIFIED_DYNAMIC_FEE in LIVE mode for ${mint.toBase58()}: Status=${feeComputationStatus}`);
        feeFailure = { reason: 'UNVERIFIED_DYNAMIC_FEE', message: `fee computation status ${feeComputationStatus}` };
      }

      const associatedBondingCurve = this.getAssociatedTokenAddress(mint, bondingCurve, baseTokenProgram);

      const state: PumpMarketState = {
        mint,
        creator,
        bondingCurve,
        associatedBondingCurve,
        quoteMint,
        baseTokenProgram,
        quoteTokenProgram,
        tokenProgram: baseTokenProgram,
        tokenDecimals,
        virtualTokenReserves,
        virtualSolReserves,
        realTokenReserves,
        realSolReserves,
        tokenTotalSupply,
        complete,
        isMayhemMode,
        mintAuthorityStatus,
        freezeAuthorityStatus,
        isMintAuthorityRevoked,
        isFreezeAuthorityRevoked,
        feeComputationStatus,
        protocolFeeBps,
        creatorFeeBps,
        feeRecipient,
        buybackFeeRecipient,
        marketDataTimestamp,
        marketDataSlot,
        marketDataSource: 'SOLANA_RPC_BONDING_CURVE',
        token2022Report,
      };
      if (feeFailure) {
        // P1.6 (N-42): a LIVE buy must not guess the fee, so this call still returns null. The fee recipients did resolve, so a SELL can
        // be built with a minimum output at the highest fee tier; the state for that goes back only through the failure.
        return fail(feeFailure.reason, feeFailure.message, { ...state, unverifiedFeeCeilingBps: highestFeeTierBps(this.cachedFeeConfig) });
      }
      return state;
    } catch (err: any) {
      Logger.error(`Error querying Pump bonding curve for ${mint.toBase58()}: ${err.message}`);
      return fail('RPC_ERROR', err?.message ?? String(err));
    }
  }

  /**
   * P1.6 (N-42): `fetchPumpMarketState` with the reason when there is no state: "no curve" (`NO_CURVE_REASONS`) versus a read that failed,
   * plus, for a LIVE state whose fee tier is unverified, a state a SELL may use (`sellableState`). Goes through `fetchPumpMarketState`, so a
   * spy on that method steers this one too; a spy that returns null without a reason reads as `RPC_ERROR`.
   */
  public static async fetchPumpMarketStateResult(params: Omit<FetchPumpMarketStateParams, 'failure'>): Promise<MarketStateResult> {
    const failure: Partial<MarketStateFailure> = {};
    const state = await this.fetchPumpMarketState({ ...params, failure });
    if (state) return { state };
    return { state: null, failure: { reason: failure.reason ?? 'RPC_ERROR', message: failure.message ?? 'the curve read returned nothing', sellableState: failure.sellableState } };
  }

  // Calculate buy quote using official Pump SDK mathematics and authoritative dynamic fees
  public static calculateBuyQuote(
    paramsOrState: CalculateBuyQuoteParams | PumpMarketState,
    solAmountArg?: number,
    slippageBpsArg?: number,
    jitoTipSolArg?: number,
    priorityFeeLamportsArg?: number,
    modeArg?: ExecutionMode
  ): TradeQuote {
    let state: PumpMarketState;
    let solAmountSol: number;
    let slippageBps: number;
    let jitoTipSol: number;
    let priorityFeeLamports: number;
    let executionMode: ExecutionMode;

    if ('state' in paramsOrState) {
      state = paramsOrState.state;
      solAmountSol = paramsOrState.amountSol;
      slippageBps = paramsOrState.slippageBps ?? 800;
      jitoTipSol = paramsOrState.jitoTipSol ?? executionConfig.getConfig().defaultJitoTipSol;
      priorityFeeLamports = paramsOrState.priorityFeeLamports ?? 25000;
      executionMode = paramsOrState.executionMode;
    } else {
      state = paramsOrState;
      solAmountSol = solAmountArg!;
      slippageBps = slippageBpsArg ?? 800;
      jitoTipSol = jitoTipSolArg ?? executionConfig.getConfig().defaultJitoTipSol;
      priorityFeeLamports = priorityFeeLamportsArg ?? 25000;
      if (modeArg !== 'LIVE' && modeArg !== 'PAPER') {
        throw new Error('CRITICAL_CONFIG_ERROR: executionMode ("LIVE" | "PAPER") is strictly required for calculateBuyQuote');
      }
      executionMode = modeArg;
    }

    const isLiveMode = executionMode === 'LIVE';
    if (state.complete) {
      throw new Error(
        `BONDING_CURVE_MIGRATED: Token ${state.mint.toBase58()} bonding curve is 100% complete. Trading must route to PumpSwap.`
      );
    }

    if (!state.quoteMint.equals(NATIVE_MINT) && !state.quoteMint.equals(new PublicKey('So11111111111111111111111111111111111111112'))) {
      throw new Error(`UNSUPPORTED_QUOTE_MINT: Quote mint ${state.quoteMint.toBase58()} is not native SOL.`);
    }

    // S222: `undefined <= 0` is false, so a caller passing the wrong field name used to reach BigInt(NaN) with a confusing error
    if (!Number.isFinite(solAmountSol) || solAmountSol <= 0) {
      throw new Error(`Order size must be a number greater than zero SOL (got ${String(solAmountSol)}); the field is amountSol.`);
    }

    const solInputLamports = BigInt(Math.round(solAmountSol * 1e9));

    // Calculate dynamic fee and token output
    let tokensToReceiveRaw: bigint;

    const protocolFeeBps = state.protocolFeeBps;
    const creatorFeeBps = state.creatorFeeBps;

    // In LIVE mode: strictly verify fee calculation cannot silently assume 100 bps without fee config
    // P1.6: a state whose fee tier is unverified is for exits only (calculateSellQuote); a buy never pays a guessed fee.
    if (isLiveMode && (!this.cachedGlobal || !this.cachedFeeConfig || state.feeComputationStatus === 'UNAVAILABLE' || state.feeComputationStatus === 'FAILED' || state.unverifiedFeeCeilingBps !== undefined)) {
      throw new Error('DYNAMIC_FEE_CALCULATION_FAILED: Global fee configuration not available for LIVE trade quote.');
    }

    // Try official SDK quote calculation if available
    let sdkQuoteSucceeded = false;
    const effectiveFeeConfig = Array.isArray(this.cachedFeeConfig?.feeTiers)
      ? this.cachedFeeConfig
      : (this.cachedFeeConfig ? {
          feeTiers: [
            {
              marketCapLamportsThreshold: new BN(0),
              fees: {
                lpFeeBps: new BN(0),
                protocolFeeBps: new BN(protocolFeeBps || (this.cachedFeeConfig as any).feeBps || 100),
                creatorFeeBps: new BN(creatorFeeBps || 0),
              },
            },
          ],
          stableFeeTiers: [],
          flatFees: {
            lpFeeBps: new BN(0),
            protocolFeeBps: new BN(protocolFeeBps || (this.cachedFeeConfig as any).feeBps || 100),
            creatorFeeBps: new BN(creatorFeeBps || 0),
          },
          exoticFlatFees: {
            lpFeeBps: new BN(0),
            protocolFeeBps: new BN(protocolFeeBps || (this.cachedFeeConfig as any).feeBps || 100),
            creatorFeeBps: new BN(creatorFeeBps || 0),
          },
        } : null);

    const effectiveGlobal = {
      tokenTotalSupply: new BN(state.tokenTotalSupply.toString()),
      feeBasisPoints: new BN(protocolFeeBps || 100),
      creatorFeeBasisPoints: new BN(creatorFeeBps || 0),
      creatorFeeConfigurable: false,
      feeRecipient: new PublicKey(this.cachedGlobal?.feeRecipient || CURRENT_FEE_RECIPIENTS[0]),
      ...this.cachedGlobal,
    };
    if (!(effectiveGlobal.tokenTotalSupply instanceof BN)) {
      effectiveGlobal.tokenTotalSupply = new BN(state.tokenTotalSupply.toString());
    }
    if (!(effectiveGlobal.feeBasisPoints instanceof BN)) {
      effectiveGlobal.feeBasisPoints = new BN(protocolFeeBps || 100);
    }
    if (!(effectiveGlobal.creatorFeeBasisPoints instanceof BN)) {
      effectiveGlobal.creatorFeeBasisPoints = new BN(creatorFeeBps || 0);
    }

    if (this.cachedGlobal && effectiveFeeConfig && typeof getBuyTokenAmountFromSolAmount === 'function') {
      try {
        const tokensOut = getBuyTokenAmountFromSolAmount({
          global: effectiveGlobal as any,
          feeConfig: effectiveFeeConfig,
          mintSupply: new BN(state.tokenTotalSupply.toString()),
          bondingCurve: {
            virtualTokenReserves: new BN(state.virtualTokenReserves.toString()),
            virtualQuoteReserves: new BN(state.virtualSolReserves.toString()),
            realTokenReserves: new BN(state.realTokenReserves.toString()),
            realQuoteReserves: new BN(state.realSolReserves?.toString() || '0'),
            tokenTotalSupply: new BN(state.tokenTotalSupply.toString()),
            complete: state.complete,
            quoteMint: state.quoteMint,
            creatorFeeBps: new BN(state.creatorFeeBps),
            creator: state.creator,
            isMayhemMode: state.isMayhemMode,
            isCashbackCoin: false,
            canEditCreatorFee: false,
          },
          amount: new BN(solInputLamports.toString()),
          quoteMint: state.quoteMint,
          creatorFeeBps: new BN(state.creatorFeeBps),
        });

        tokensToReceiveRaw = BigInt(tokensOut.toString());
        sdkQuoteSucceeded = true;
      } catch (err: any) {
        if (isLiveMode) {
          throw new Error(`OFFICIAL_PUMP_QUOTE_FAILED: Official SDK buy quote failed in LIVE mode: ${err.message}`, { cause: err });
        }
      }
    }

    if (isLiveMode && !sdkQuoteSucceeded) {
      throw new Error('OFFICIAL_PUMP_QUOTE_FAILED: Official SDK buy quote calculation failed or unavailable in LIVE mode');
    }

    // Mathematical constant-product model (used for cross-check and fallback in paper mode)
    const totalFeeBps = BigInt(protocolFeeBps + creatorFeeBps);
    const netSolForCurve = (totalFeeBps > 0n && solInputLamports > 1n)
      ? ((solInputLamports - 1n) * 10000n) / (10000n + totalFeeBps)
      : solInputLamports;
    // 5A (N-41): the program charges ceil(curve input x bps / 1e4) per fee, on the curve input, not the gross. Both branches report the fee
    // as gross - netSolForCurve (what postBuySpot and the round-trip gate subtract), split by bps: the creator share ceil(net x bps / 1e4) as the
    // SDK's getFee, the protocol the rest (so a 0 bps creator gets nothing and the sum is always the total).
    const totalFeeLamports = solInputLamports - netSolForCurve;
    const creatorCeil = creatorFeeBps > 0 ? (netSolForCurve * BigInt(creatorFeeBps) + 9999n) / 10000n : 0n;
    const creatorFeeLamports = creatorCeil < totalFeeLamports ? creatorCeil : totalFeeLamports;
    const protocolFeeLamports = totalFeeLamports - creatorFeeLamports;

    const k = state.virtualSolReserves * state.virtualTokenReserves;
    const newVirtualSol = state.virtualSolReserves + netSolForCurve;
    const newVirtualTokens = k / newVirtualSol + 1n;

    let customTokensToReceiveRaw: bigint;
    if (newVirtualTokens >= state.virtualTokenReserves) {
      if (solInputLamports <= 1n) {
        customTokensToReceiveRaw = 0n;
      } else {
        throw new Error(`Insufficient bonding curve liquidity for requested buy size.`);
      }
    } else {
      customTokensToReceiveRaw = state.virtualTokenReserves - newVirtualTokens;
    }

    if (isLiveMode && customTokensToReceiveRaw > state.realTokenReserves) {
      // The program caps a buy at what is left on the curve (and completes it). That is not a math error, but this app
      // does not size final-fill buys: refuse with a plain reason instead of tripping the discrepancy alarm below.
      throw new Error(
        `CURVE_NEARLY_COMPLETE: a ${solAmountSol} SOL buy needs ${customTokensToReceiveRaw} tokens but only ${state.realTokenReserves} remain on the curve. Use a smaller size.`
      );
    }

    if (!sdkQuoteSucceeded) {
      tokensToReceiveRaw = customTokensToReceiveRaw;
    } else if (isLiveMode) {
      // R0.2: Cross-check custom quote math against official SDK and require exact integer-semantic agreement
      if (customTokensToReceiveRaw !== tokensToReceiveRaw!) {
        throw new Error(
          `QUOTE_MATH_DISCREPANCY: Custom integer math (${customTokensToReceiveRaw}) diverges from official SDK (${tokensToReceiveRaw!}) in LIVE mode. Failing closed.`
        );
      }
    }

    if (tokensToReceiveRaw! < 0n || (tokensToReceiveRaw! === 0n && solInputLamports > 1n)) {
      throw new Error(`Calculated token output is zero.`);
    }

    // Spot price in SOL per human token
    const spotPriceSol =
      Number(state.virtualSolReserves) /
      Number(state.virtualTokenReserves) /
      (1e9 / Math.pow(10, state.tokenDecimals));

    // Effective execution price in SOL per human token
    const tokenHumanQty = Number(tokensToReceiveRaw!) / Math.pow(10, state.tokenDecimals);
    const executionPriceSol = solAmountSol / tokenHumanQty;

    // Price impact in basis points
    const impactBps = Math.max(
      0,
      Math.round(((executionPriceSol - spotPriceSol) / spotPriceSol) * 10000)
    );

    // Max SOL input with slippage tolerance
    const maxInputLamports = Number(
      (solInputLamports * BigInt(10000 + slippageBps)) / 10000n
    );

    return {
      mint: state.mint.toBase58(),
      side: 'BUY',
      tokenProgram: state.tokenProgram.toBase58(),
      tokenDecimals: state.tokenDecimals,
      tokenAmountRaw: tokensToReceiveRaw!.toString(),
      expectedSolAmountLamports: Number(solInputLamports),
      maxInputLamports,
      minOutputLamports: 0,
      protocolFeeLamports: Number(protocolFeeLamports),
      creatorFeeLamports: Number(creatorFeeLamports),
      expectedPriorityFeeLamports: priorityFeeLamports,
      expectedJitoTipLamports: Math.round(jitoTipSol * 1e9),
      estimatedPriceImpactBps: impactBps,
      slippageBps,
      spotPriceSol,
      executionPriceSol,
      marketDataSource: state.marketDataSource,
      marketDataTimestamp: state.marketDataTimestamp,
      quoteTimestamp: Date.now(),
    };
  }

  // Calculate sell quote using official Pump SDK mathematics and authoritative dynamic fees
  public static calculateSellQuote(
    paramsOrState: CalculateSellQuoteParams | PumpMarketState,
    tokenAmountRawArg?: bigint,
    slippageBpsArg?: number,
    jitoTipSolArg?: number,
    priorityFeeLamportsArg?: number,
    modeArg?: ExecutionMode
  ): TradeQuote {
    let state: PumpMarketState;
    let tokenAmountRaw: bigint;
    let slippageBps: number;
    let jitoTipSol: number;
    let priorityFeeLamports: number;
    let executionMode: ExecutionMode;

    if ('state' in paramsOrState) {
      state = paramsOrState.state;
      tokenAmountRaw = paramsOrState.tokenAmountRaw;
      slippageBps = paramsOrState.slippageBps ?? 800;
      jitoTipSol = paramsOrState.jitoTipSol ?? executionConfig.getConfig().defaultJitoTipSol;
      priorityFeeLamports = paramsOrState.priorityFeeLamports ?? 25000;
      executionMode = paramsOrState.executionMode;
    } else {
      state = paramsOrState;
      tokenAmountRaw = tokenAmountRawArg!;
      slippageBps = slippageBpsArg ?? 800;
      jitoTipSol = jitoTipSolArg ?? executionConfig.getConfig().defaultJitoTipSol;
      priorityFeeLamports = priorityFeeLamportsArg ?? 25000;
      if (modeArg !== 'LIVE' && modeArg !== 'PAPER') {
        throw new Error('CRITICAL_CONFIG_ERROR: executionMode ("LIVE" | "PAPER") is strictly required for calculateSellQuote');
      }
      executionMode = modeArg;
    }

    const isLiveMode = executionMode === 'LIVE';
    if (state.complete) {
      throw new Error(
        `BONDING_CURVE_MIGRATED: Token ${state.mint.toBase58()} bonding curve is 100% complete. Trading must route to PumpSwap.`
      );
    }

    if (!state.quoteMint.equals(NATIVE_MINT) && !state.quoteMint.equals(new PublicKey('So11111111111111111111111111111111111111112'))) {
      throw new Error(`UNSUPPORTED_QUOTE_MINT: Quote mint ${state.quoteMint.toBase58()} is not native SOL.`);
    }

    if (tokenAmountRaw <= 0n) {
      throw new Error(`Token sell amount must be greater than zero.`);
    }

    // P1.6 (N-42): a LIVE state whose fee tier could not be verified (see unverifiedFeeCeilingBps) is priced at the highest tier, without
    // the SDK quote, so an exit can still be built; its minimum output is lower than a verified quote's, never higher.
    const feeCeilingBps = isLiveMode ? state.unverifiedFeeCeilingBps : undefined;
    if (isLiveMode && feeCeilingBps === undefined && (!this.cachedGlobal || !this.cachedFeeConfig)) {
      throw new Error('DYNAMIC_FEE_CALCULATION_FAILED: Global fee configuration not available for LIVE trade quote.');
    }

    let grossSolOutLamports: bigint = 0n;
    let sdkQuoteSucceeded = false;
    const protocolFeeBps = state.protocolFeeBps;
    const creatorFeeBps = state.creatorFeeBps;
    const effectiveFeeConfig = Array.isArray(this.cachedFeeConfig?.feeTiers)
      ? this.cachedFeeConfig
      : (this.cachedFeeConfig ? {
          feeTiers: [
            {
              marketCapLamportsThreshold: new BN(0),
              fees: {
                lpFeeBps: new BN(0),
                protocolFeeBps: new BN(protocolFeeBps || (this.cachedFeeConfig as any).feeBps || 100),
                creatorFeeBps: new BN(creatorFeeBps || 0),
              },
            },
          ],
          stableFeeTiers: [],
          flatFees: {
            lpFeeBps: new BN(0),
            protocolFeeBps: new BN(protocolFeeBps || (this.cachedFeeConfig as any).feeBps || 100),
            creatorFeeBps: new BN(creatorFeeBps || 0),
          },
          exoticFlatFees: {
            lpFeeBps: new BN(0),
            protocolFeeBps: new BN(protocolFeeBps || (this.cachedFeeConfig as any).feeBps || 100),
            creatorFeeBps: new BN(creatorFeeBps || 0),
          },
        } : null);

    const effectiveGlobal = {
      tokenTotalSupply: new BN(state.tokenTotalSupply.toString()),
      feeBasisPoints: new BN(protocolFeeBps || 100),
      creatorFeeBasisPoints: new BN(creatorFeeBps || 0),
      creatorFeeConfigurable: false,
      feeRecipient: new PublicKey(this.cachedGlobal?.feeRecipient || CURRENT_FEE_RECIPIENTS[0]),
      ...this.cachedGlobal,
    };
    if (!(effectiveGlobal.tokenTotalSupply instanceof BN)) {
      effectiveGlobal.tokenTotalSupply = new BN(state.tokenTotalSupply.toString());
    }
    if (!(effectiveGlobal.feeBasisPoints instanceof BN)) {
      effectiveGlobal.feeBasisPoints = new BN(protocolFeeBps || 100);
    }
    if (!(effectiveGlobal.creatorFeeBasisPoints instanceof BN)) {
      effectiveGlobal.creatorFeeBasisPoints = new BN(creatorFeeBps || 0);
    }

    if (feeCeilingBps === undefined && this.cachedGlobal && effectiveFeeConfig && typeof getSellSolAmountFromTokenAmount === 'function') {
      try {
        const solOut = getSellSolAmountFromTokenAmount({
          global: effectiveGlobal as any,
          feeConfig: effectiveFeeConfig,
          mintSupply: new BN(state.tokenTotalSupply.toString()),
          bondingCurve: {
            virtualTokenReserves: new BN(state.virtualTokenReserves.toString()),
            virtualQuoteReserves: new BN(state.virtualSolReserves.toString()),
            realTokenReserves: new BN(state.realTokenReserves.toString()),
            realQuoteReserves: new BN(state.realSolReserves?.toString() || '0'),
            tokenTotalSupply: new BN(state.tokenTotalSupply.toString()),
            complete: state.complete,
            quoteMint: state.quoteMint,
            creatorFeeBps: new BN(state.creatorFeeBps),
            creator: state.creator,
            isMayhemMode: state.isMayhemMode,
            isCashbackCoin: false,
            canEditCreatorFee: false,
          },
          amount: new BN(tokenAmountRaw.toString()),
        });
        grossSolOutLamports = BigInt(solOut.toString());
        sdkQuoteSucceeded = true;
      } catch (err: any) {
        if (isLiveMode) {
          throw new Error(`OFFICIAL_PUMP_QUOTE_FAILED: Official SDK sell quote failed in LIVE mode: ${err.message}`, { cause: err });
        }
      }
    }

    if (isLiveMode && !sdkQuoteSucceeded && feeCeilingBps === undefined) {
      throw new Error('OFFICIAL_PUMP_QUOTE_FAILED: Official SDK sell quote calculation failed or unavailable in LIVE mode');
    }

    // Mathematical constant-product model (used for cross-check and fallback in paper mode)
    const k = state.virtualSolReserves * state.virtualTokenReserves;
    const newVirtualTokens = state.virtualTokenReserves + tokenAmountRaw;
    const newVirtualSol = k / newVirtualTokens + 1n;

    if (newVirtualSol >= state.virtualSolReserves) {
      throw new Error(`Invalid curve state for sell quote.`);
    }

    const customGrossSolOut = state.virtualSolReserves - newVirtualSol;

    // The official SDK function returns the NET amount (curve output minus protocol and creator fee, each fee rounded up).
    // Comparing the app's GROSS curve output to it made every LIVE sell fail QUOTE_MATH_DISCREPANCY whenever the fee is
    // non-zero, and treating the SDK value as gross charged the fee twice (found by the localnet end-to-end run).
    const ceilFee = (amount: bigint, bps: number) => (amount * BigInt(bps) + 9999n) / 10000n;
    const grossSolOut = customGrossSolOut;
    const protocolFeeLamports = feeCeilingBps !== undefined ? ceilFee(grossSolOut, feeCeilingBps) : ceilFee(grossSolOut, protocolFeeBps);
    const creatorFeeLamports = feeCeilingBps !== undefined || state.creator.equals(PublicKey.default) ? 0n : ceilFee(grossSolOut, creatorFeeBps);
    let netSolOutLamports = grossSolOut - protocolFeeLamports - creatorFeeLamports;
    if (feeCeilingBps !== undefined) {
      Logger.warn(`[P1.6] SELL quote for ${state.mint.toBase58()} with an unverified fee tier: assuming ${feeCeilingBps} bps in fees (net ${netSolOutLamports} lamports)`);
    }

    if (sdkQuoteSucceeded && isLiveMode && netSolOutLamports !== grossSolOutLamports) {
      // R0.2 cross-check. P1.6 (R1-30): a sell does not fail closed on it. The official SDK's net decides the minimum output, and the
      // disagreement is logged: refusing would leave a stop-loss unsent over a lamport of fee rounding. A buy still fails closed.
      Logger.warn(`QUOTE_MATH_DISCREPANCY (sell, not blocking): custom sell math ${netSolOutLamports} net, official SDK ${grossSolOutLamports} net for ${state.mint.toBase58()}; using the SDK value`);
      netSolOutLamports = grossSolOutLamports;
    }

    // Spot price in SOL per human token
    const spotPriceSol =
      Number(state.virtualSolReserves) /
      Number(state.virtualTokenReserves) /
      (1e9 / Math.pow(10, state.tokenDecimals));

    const tokenHumanQty = Number(tokenAmountRaw) / Math.pow(10, state.tokenDecimals);
    const executionPriceSol = (Number(netSolOutLamports) / 1e9) / tokenHumanQty;

    const impactBps = Math.max(
      0,
      Math.round(((spotPriceSol - executionPriceSol) / spotPriceSol) * 10000)
    );

    // Min SOL output with slippage tolerance
    const minOutputLamports = Number(
      (netSolOutLamports * BigInt(10000 - slippageBps)) / 10000n
    );

    return {
      mint: state.mint.toBase58(),
      side: 'SELL',
      tokenProgram: state.tokenProgram.toBase58(),
      tokenDecimals: state.tokenDecimals,
      tokenAmountRaw: tokenAmountRaw.toString(),
      expectedSolAmountLamports: Number(netSolOutLamports),
      maxInputLamports: 0,
      minOutputLamports,
      protocolFeeLamports: Number(protocolFeeLamports),
      creatorFeeLamports: Number(creatorFeeLamports),
      expectedPriorityFeeLamports: priorityFeeLamports,
      expectedJitoTipLamports: Math.round(jitoTipSol * 1e9),
      estimatedPriceImpactBps: impactBps,
      slippageBps,
      spotPriceSol,
      executionPriceSol,
      marketDataSource: state.marketDataSource,
      marketDataTimestamp: state.marketDataTimestamp,
      quoteTimestamp: Date.now(),
    };
  }
}

