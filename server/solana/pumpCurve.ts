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
import { Logger } from '../middleware/enterprise';
import { executionConfig } from './executionConfig';
import { ExecutionMode, TriState } from '../core/types';

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
  marketDataTimestamp: number;
  marketDataSource: string;
  token2022Report?: Token2022ExtensionReport;
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
  top10HoldersPct: number;
  devHoldingPct: number;
  topHolders: Array<{ address: string; amount: bigint; pct: number }>;
}

export async function fetchTokenHolderDistribution(
  connection: Connection,
  mint: PublicKey,
  creator?: PublicKey,
  bondingCurve?: PublicKey
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

  // C1: concentration is a share of TOTAL supply. The bonding curve and the
  // creator are excluded from the top-10 list (creator is scored via devHoldingPct).
  const holderAddrs = new Set<string>(creatorAddrsForExclusion);
  const top10Accounts = nonCurveAccounts.filter((acc) => !holderAddrs.has(acc.address.toBase58())).slice(0, 10);
  const top10Amount = top10Accounts.reduce((sum, acc) => sum + BigInt(acc.amount), 0n);
  const pctOfTotal = (amt: bigint) =>
    totalSupply > 0n ? Number(((Number(amt) / Number(totalSupply)) * 100).toFixed(2)) : 0;
  const top10HoldersPct = pctOfTotal(top10Amount);

  const devHoldingPct = pctOfTotal(creatorBalance);

  const topHolders = nonCurveAccounts.map((acc) => {
    const amountBig = BigInt(acc.amount);
    const pct = pctOfTotal(amountBig);
    return {
      address: acc.address.toBase58(),
      amount: amountBig,
      pct,
    };
  });

  return {
    mint: mint.toBase58(),
    totalCirculatingSupply: totalSupply,
    nonBondingCirculatingSupply,
    bondingCurveBalance,
    creatorBalance,
    top10HoldersPct,
    devHoldingPct,
    topHolders,
  };
}

export class PumpCurveService {
  public static cachedGlobal: any = null;
  public static cachedFeeConfig: any = null;
  public static fetchTokenHolderDistribution = fetchTokenHolderDistribution;
  private static cacheTimestamp = 0;
  private static readonly CACHE_TTL_MS = 60000; // 1 minute cache for global fee parameters

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

    if ('connection' in paramsOrConn) {
      connection = paramsOrConn.connection;
      mint = paramsOrConn.mint;
      executionMode = paramsOrConn.executionMode;
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

    try {
      const now = Date.now();
      const needGlobalRefresh =
        !this.cachedGlobal ||
        !this.cachedFeeConfig ||
        now - this.cacheTimestamp > this.CACHE_TTL_MS;

      const accountsToFetch = [mint, bondingCurve];
      if (needGlobalRefresh) {
        accountsToFetch.push(GLOBAL_PDA, PUMP_FEE_CONFIG_PDA);
      }

      const accountInfos = await connection.getMultipleAccountsInfo(accountsToFetch);
      const mintAccountInfo = accountInfos[0];
      const curveAccountInfo = accountInfos[1];

      if (needGlobalRefresh && accountInfos[2]) {
        try {
          this.cachedGlobal = PUMP_SDK.decodeGlobal(accountInfos[2]);
        } catch {
          this.cachedGlobal = null;
        }
      }
      if (needGlobalRefresh && accountInfos[3]) {
        try {
          this.cachedFeeConfig = PUMP_SDK.decodeFeeConfig(accountInfos[3]);
        } catch {
          this.cachedFeeConfig = null;
        }
      }
      if (needGlobalRefresh) {
        this.cacheTimestamp = now;
      }

      const finalMintInfo = mintAccountInfo;
      const finalCurveInfo = curveAccountInfo;

      if (!finalMintInfo) {
        Logger.warn(`Mint account not found on Solana RPC: ${mint.toBase58()}`);
        return null;
      }

      if (!finalCurveInfo) {
        Logger.warn(`Pump.fun bonding curve account not found: ${bondingCurve.toBase58()}`);
        return null;
      }

      // Determine correct token program (SPL Token vs Token-2022)
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
            return null;
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
          return null;
        }

        // Retain manual binary offset fallback strictly for PAPER/TEST/RESEARCH diagnostics
        const data = finalCurveInfo.data;
        if (data.length < 49) {
          Logger.warn(`Bonding curve account data truncated: ${data.length} bytes`);
          return null;
        }

        const disc = data.subarray(0, 8);
        if (!disc.equals(BONDING_CURVE_DISCRIMINATOR)) {
          Logger.warn(`Invalid bonding curve account discriminator: ${disc.toString('hex')}`);
          return null;
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

      // Explicitly enforce native SOL quote mint only
      if (!quoteMint.equals(NATIVE_MINT) && !quoteMint.equals(new PublicKey('So11111111111111111111111111111111111111112'))) {
        Logger.warn(`UNSUPPORTED_QUOTE_MINT: Mint ${mint.toBase58()} uses exotic quote mint ${quoteMint.toBase58()}. Only native SOL is supported.`);
        if (isLiveMode) {
          return null;
        }
      }

      // Authoritative fee recipient resolution according to Pump V2 protocol
      const { feeRecipient, buybackFeeRecipient } = resolvePumpFeeRecipients(
        this.cachedGlobal,
        isMayhemMode,
        executionMode
      );

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
            return null;
          }
          Logger.debug(`Dynamic fee calculation fallback: ${feeCalcErr.message}`);
        }
      } else if (isLiveMode) {
        Logger.error(`FEE_CONFIG_MISSING in LIVE mode: Cached global or feeConfig not present for ${mint.toBase58()}`);
        return null;
      }

      if (isLiveMode && feeComputationStatus !== 'VERIFIED') {
        Logger.error(`UNVERIFIED_DYNAMIC_FEE in LIVE mode for ${mint.toBase58()}: Status=${feeComputationStatus}`);
        return null;
      }

      const associatedBondingCurve = this.getAssociatedTokenAddress(mint, bondingCurve, baseTokenProgram);

      return {
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
        marketDataTimestamp: now,
        marketDataSource: 'SOLANA_RPC_BONDING_CURVE',
        token2022Report,
      };
    } catch (err: any) {
      Logger.error(`Error querying Pump bonding curve for ${mint.toBase58()}: ${err.message}`);
      return null;
    }
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

    if (solAmountSol <= 0) {
      throw new Error(`Order size must be greater than zero SOL.`);
    }

    const solInputLamports = BigInt(Math.round(solAmountSol * 1e9));

    // Calculate dynamic fee and token output
    let tokensToReceiveRaw: bigint;
    let protocolFeeLamports: bigint;
    let creatorFeeLamports: bigint;

    const protocolFeeBps = state.protocolFeeBps;
    const creatorFeeBps = state.creatorFeeBps;

    // In LIVE mode: strictly verify fee calculation cannot silently assume 100 bps without fee config
    if (isLiveMode && (!this.cachedGlobal || !this.cachedFeeConfig)) {
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
        const totalFeeBps = BigInt(protocolFeeBps + creatorFeeBps);
        const totalFeeLamports = (solInputLamports * totalFeeBps) / 10000n;
        protocolFeeLamports = totalFeeBps > 0n ? (totalFeeLamports * BigInt(protocolFeeBps)) / totalFeeBps : 0n;
        creatorFeeLamports = totalFeeLamports - protocolFeeLamports;
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
    protocolFeeLamports = (solInputLamports * BigInt(protocolFeeBps)) / 10000n;
    creatorFeeLamports = (solInputLamports * BigInt(creatorFeeBps)) / 10000n;
    const totalFeeLamports = protocolFeeLamports + creatorFeeLamports;
    const netSolForCurve = (totalFeeBps > 0n && solInputLamports > 1n)
      ? ((solInputLamports - 1n) * 10000n) / (10000n + totalFeeBps)
      : solInputLamports;

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
      protocolFeeLamports: Number(protocolFeeLamports!),
      creatorFeeLamports: Number(creatorFeeLamports!),
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

    if (isLiveMode && (!this.cachedGlobal || !this.cachedFeeConfig)) {
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

    if (this.cachedGlobal && effectiveFeeConfig && typeof getSellSolAmountFromTokenAmount === 'function') {
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

    if (isLiveMode && !sdkQuoteSucceeded) {
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

    if (!sdkQuoteSucceeded) {
      grossSolOutLamports = customGrossSolOut;
    } else if (isLiveMode) {
      // R0.2: Cross-check custom quote math against official SDK and require exact integer-semantic agreement
      if (customGrossSolOut !== grossSolOutLamports) {
        throw new Error(
          `QUOTE_MATH_DISCREPANCY: Custom sell math (${customGrossSolOut}) diverges from official SDK (${grossSolOutLamports}) in LIVE mode. Failing closed.`
        );
      }
    }

    const totalFeeBps = BigInt(protocolFeeBps + creatorFeeBps);
    const totalFeeLamports = (grossSolOutLamports * totalFeeBps) / 10000n;
    const protocolFeeLamports = totalFeeBps > 0n ? (totalFeeLamports * BigInt(protocolFeeBps)) / totalFeeBps : 0n;
    const creatorFeeLamports = totalFeeLamports - protocolFeeLamports;
    const netSolOutLamports = grossSolOutLamports - totalFeeLamports;

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

