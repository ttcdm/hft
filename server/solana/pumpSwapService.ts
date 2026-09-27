import {
  Connection,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';
import { NATIVE_MINT, AccountLayout } from '@solana/spl-token';
import BN from 'bn.js';
import {
  PUMP_AMM_SDK,
  OnlinePumpAmmSdk,
  canonicalPumpPoolPda,
  buyQuoteInput,
  buyBaseInput,
  sellBaseInput,
  sellQuoteInput,
  computeFeesBps,
} from '@pump-fun/pump-swap-sdk';
import { Logger } from '../middleware/enterprise';
import { ExecutionMode, TradingVenue } from '../core/types';
import { PumpCurveService } from './pumpCurve';

export type { ExecutionMode, TradingVenue };

export { buyQuoteInput, buyBaseInput, sellBaseInput, sellQuoteInput, computeFeesBps, canonicalPumpPoolPda };

export interface PumpSwapExecutionState {
  poolAddress: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseReserve: bigint;
  quoteReserve: bigint;
  virtualQuoteReserves: bigint;
  effectiveQuoteReserve: bigint;
  isCashbackCoin: boolean;
  baseTokenProgram: PublicKey;
  quoteTokenProgram: PublicKey;
  spotPriceSol: number;
  globalConfig?: any;
  feeConfig?: any;
  creator?: PublicKey;
  coinCreator?: PublicKey;
  isMayhemMode?: boolean;
  creatorFeeBps?: bigint;
  marketDataTimestamp: number;
}

// Backwards-compatible type alias
export type PumpSwapPoolState = PumpSwapExecutionState;

export class PumpSwapVenueService {
  private static poolCache: Map<string, { pool: PumpSwapExecutionState | null; timestamp: number }> = new Map();
  private static readonly CACHE_TTL_MS = 15000;

  // Resolve trading venue for a token mint: active bonding curve vs migrated canonical PumpSwap pool
  public static async resolveVenue(
    connection: Connection,
    mint: PublicKey,
    executionMode: ExecutionMode
  ): Promise<{ venue: TradingVenue; isMigrated: boolean; poolAddress?: PublicKey }> {
    const mintStr = mint.toBase58();

    // 1. First check if Pump.fun bonding curve is active using the strict executionMode
    try {
      const curveState = await PumpCurveService.fetchPumpMarketState({
        connection,
        mint,
        executionMode,
      });
      if (curveState && !curveState.complete) {
        return {
          venue: 'PUMP_BONDING_CURVE',
          isMigrated: false,
          poolAddress: curveState.bondingCurve,
        };
      }
    } catch (err: any) {
      if (executionMode === 'LIVE') {
        Logger.warn(`LIVE bonding curve state lookup failed for ${mintStr}: ${err.message}`);
        return {
          venue: 'UNKNOWN',
          isMigrated: true,
        };
      }
    }

    // 2. If bonding curve is complete or not found, check canonical PumpSwap AMM pool
    try {
      const canonicalPool = canonicalPumpPoolPda(mint);
      const poolInfo = await connection.getAccountInfo(canonicalPool);
      if (poolInfo && poolInfo.data && poolInfo.data.length > 0) {
        const pool = PUMP_AMM_SDK.decodePool(poolInfo);
        // Explicitly enforce native SOL quote mint only
        if (
          !pool.quoteMint.equals(NATIVE_MINT) &&
          !pool.quoteMint.equals(new PublicKey('So11111111111111111111111111111111111111112'))
        ) {
          Logger.warn(`UNSUPPORTED_PUMPSWAP_QUOTE_MINT: Migrated pool ${canonicalPool.toBase58()} quote mint is ${pool.quoteMint.toBase58()} (non-SOL)`);
          return {
            venue: 'UNKNOWN',
            isMigrated: true,
          };
        }
        return {
          venue: 'PUMPSWAP',
          isMigrated: true,
          poolAddress: canonicalPool,
        };
      }
    } catch (err: any) {
      Logger.debug(`PumpSwap pool resolution check failed for ${mintStr}: ${err.message}`);
    }

    return {
      venue: 'UNKNOWN',
      isMigrated: true,
    };
  }

  // Fetch canonical PumpSwap pool state and calculate spot price in SOL using effectiveQuoteReserves
  public static async getPoolState(
    connection: Connection,
    mint: PublicKey,
    executionMode: ExecutionMode
  ): Promise<PumpSwapExecutionState | null> {
    if (executionMode !== 'LIVE' && executionMode !== 'PAPER') {
      throw new Error('CRITICAL_CONFIG_ERROR: executionMode ("LIVE" | "PAPER") is strictly required for getPoolState');
    }
    const mintStr = mint.toBase58();
    const cached = this.poolCache.get(mintStr);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.pool;
    }

    try {
      const poolKey = canonicalPumpPoolPda(mint);
      const poolAccountInfo = await connection.getAccountInfo(poolKey);
      if (!poolAccountInfo) {
        if (executionMode === 'LIVE') {
          Logger.error(`PUMPSWAP_POOL_NOT_FOUND in LIVE mode: Canonical pool ${poolKey.toBase58()} not found on-chain.`);
        }
        this.poolCache.set(mintStr, { pool: null, timestamp: Date.now() });
        return null;
      }

      const pool = PUMP_AMM_SDK.decodePool(poolAccountInfo);

      // Enforce native SOL quote asset only
      if (
        !pool.quoteMint.equals(NATIVE_MINT) &&
        !pool.quoteMint.equals(new PublicKey('So11111111111111111111111111111111111111112'))
      ) {
        if (executionMode === 'LIVE') {
          throw new Error(`UNSUPPORTED_PUMPSWAP_QUOTE_MINT: Pool ${poolKey.toBase58()} uses non-SOL quote mint ${pool.quoteMint.toBase58()} in LIVE mode.`);
        }
        Logger.warn(`UNSUPPORTED_PUMPSWAP_QUOTE_MINT: Pool ${poolKey.toBase58()} uses non-SOL quote mint ${pool.quoteMint.toBase58()}`);
        return null;
      }

      const [poolBaseAccountInfo, poolQuoteAccountInfo, mintAccountInfo] =
        await connection.getMultipleAccountsInfo([
          pool.poolBaseTokenAccount,
          pool.poolQuoteTokenAccount,
          pool.baseMint,
        ]);

      if (!poolBaseAccountInfo || !poolQuoteAccountInfo || !mintAccountInfo) {
        if (executionMode === 'LIVE') {
          Logger.error(`PUMPSWAP_ACCOUNT_RESOLUTION_FAILED in LIVE mode: required pool accounts missing for ${poolKey.toBase58()}`);
        }
        return null;
      }

      const decodedBase = AccountLayout.decode(poolBaseAccountInfo.data);
      const decodedQuote = AccountLayout.decode(poolQuoteAccountInfo.data);
      const baseReserve = BigInt(decodedBase.amount.toString());
      const quoteReserve = BigInt(decodedQuote.amount.toString());
      const virtualQuoteReserves = pool.virtualQuoteReserves ? BigInt(pool.virtualQuoteReserves.toString()) : 0n;
      const effectiveQuoteReserve = quoteReserve + virtualQuoteReserves;

      let decimals = 6;
      if (mintAccountInfo.data.length >= 45) {
        decimals = mintAccountInfo.data.readUInt8(44);
      }

      const baseHuman = Number(baseReserve) / Math.pow(10, decimals);
      const quoteSol = Number(effectiveQuoteReserve) / 1e9;
      const spotPriceSol = baseHuman > 0 ? quoteSol / baseHuman : 0;

      const state: PumpSwapExecutionState = {
        poolAddress: poolKey,
        baseMint: pool.baseMint,
        quoteMint: pool.quoteMint,
        baseReserve,
        quoteReserve,
        virtualQuoteReserves,
        effectiveQuoteReserve,
        isCashbackCoin: Boolean(pool.isCashbackCoin),
        baseTokenProgram: mintAccountInfo.owner,
        quoteTokenProgram: poolQuoteAccountInfo.owner,
        spotPriceSol,
        creator: pool.creator,
        coinCreator: pool.coinCreator,
        isMayhemMode: Boolean(pool.isMayhemMode),
        creatorFeeBps: pool.creatorFeeBps ? BigInt(pool.creatorFeeBps.toString()) : 0n,
        marketDataTimestamp: Date.now(),
      };

      this.poolCache.set(mintStr, { pool: state, timestamp: Date.now() });
      return state;
    } catch (err: any) {
      Logger.warn(`Failed to fetch PumpSwap pool state for ${mintStr}: ${err.message}`);
      return null;
    }
  }

  private static normalizeBaseMintAccount(account: any) {
    if (!account) {
      return { decimals: 6, supply: 1_000_000_000_000_000n };
    }
    return {
      supply: 1_000_000_000_000_000n,
      ...account,
    };
  }

  private static normalizeGlobalConfig(globalConfig: any) {
    if (!globalConfig) {
      return {
        lpFeeBasisPoints: new BN(20),
        protocolFeeBasisPoints: new BN(80),
        coinCreatorFeeBasisPoints: new BN(0),
        creatorFeeConfigurable: false,
      };
    }
    return globalConfig;
  }

  // Quoting helper 1: Buy with exact Quote (SOL) input -> Base tokens out
  public static quotePumpSwapBuyQuoteInput(params: {
    solAmountLamports: bigint;
    slippageBps?: number;
    swapState: any;
  }) {
    const { solAmountLamports, slippageBps = 800, swapState } = params;
    const res = buyQuoteInput({
      quote: new BN(solAmountLamports.toString()),
      slippage: slippageBps / 100,
      baseReserve: swapState.poolBaseAmount,
      quoteReserve: swapState.poolQuoteAmount,
      virtualQuoteReserves: swapState.pool.virtualQuoteReserves || new BN(0),
      globalConfig: this.normalizeGlobalConfig(swapState.globalConfig),
      feeConfig: swapState.feeConfig,
      baseMintAccount: this.normalizeBaseMintAccount(swapState.baseMintAccount),
      baseMint: swapState.baseMint,
      coinCreator: swapState.pool.coinCreator,
      creator: swapState.pool.creator,
      quoteMint: swapState.pool.quoteMint,
      isMayhemMode: Boolean(swapState.pool.isMayhemMode),
      creatorFeeBps: new BN(swapState.pool.creatorFeeBps ? swapState.pool.creatorFeeBps.toString() : '0'),
    });
    const minBase = res.base.mul(new BN(10000 - slippageBps)).div(new BN(10000));
    return {
      ...res,
      uiBase: res.base,
      minBase,
    };
  }

  // Quoting helper 2: Buy target Base tokens -> Quote (SOL) input required
  public static quotePumpSwapBuyBaseInput(params: {
    baseAmountTokens: bigint;
    slippageBps?: number;
    swapState: any;
  }) {
    const { baseAmountTokens, slippageBps = 800, swapState } = params;
    return buyBaseInput({
      base: new BN(baseAmountTokens.toString()),
      slippage: slippageBps / 100,
      baseReserve: swapState.poolBaseAmount,
      quoteReserve: swapState.poolQuoteAmount,
      virtualQuoteReserves: swapState.pool.virtualQuoteReserves || new BN(0),
      globalConfig: this.normalizeGlobalConfig(swapState.globalConfig),
      feeConfig: swapState.feeConfig,
      baseMintAccount: this.normalizeBaseMintAccount(swapState.baseMintAccount),
      baseMint: swapState.baseMint,
      coinCreator: swapState.pool.coinCreator,
      creator: swapState.pool.creator,
      quoteMint: swapState.pool.quoteMint,
      isMayhemMode: Boolean(swapState.pool.isMayhemMode),
      creatorFeeBps: new BN(swapState.pool.creatorFeeBps ? swapState.pool.creatorFeeBps.toString() : '0'),
    });
  }

  // Quoting helper 3: Sell exact Base tokens -> Quote (SOL) output proceeds
  public static quotePumpSwapSellBaseInput(params: {
    tokenAmountRaw: bigint;
    slippageBps?: number;
    swapState: any;
  }) {
    const { tokenAmountRaw, slippageBps = 800, swapState } = params;
    return sellBaseInput({
      base: new BN(tokenAmountRaw.toString()),
      slippage: slippageBps / 100,
      baseReserve: swapState.poolBaseAmount,
      quoteReserve: swapState.poolQuoteAmount,
      virtualQuoteReserves: swapState.pool.virtualQuoteReserves || new BN(0),
      globalConfig: this.normalizeGlobalConfig(swapState.globalConfig),
      feeConfig: swapState.feeConfig,
      baseMintAccount: this.normalizeBaseMintAccount(swapState.baseMintAccount),
      baseMint: swapState.baseMint,
      coinCreator: swapState.pool.coinCreator,
      creator: swapState.pool.creator,
      quoteMint: swapState.pool.quoteMint,
      isMayhemMode: Boolean(swapState.pool.isMayhemMode),
      creatorFeeBps: new BN(swapState.pool.creatorFeeBps ? swapState.pool.creatorFeeBps.toString() : '0'),
    });
  }

  // Quoting helper 4: Sell target Quote (SOL) output -> Base tokens required
  public static quotePumpSwapSellQuoteInput(params: {
    solAmountLamports: bigint;
    slippageBps?: number;
    swapState: any;
  }) {
    const { solAmountLamports, slippageBps = 800, swapState } = params;
    return sellQuoteInput({
      quote: new BN(solAmountLamports.toString()),
      slippage: slippageBps / 100,
      baseReserve: swapState.poolBaseAmount,
      quoteReserve: swapState.poolQuoteAmount,
      virtualQuoteReserves: swapState.pool.virtualQuoteReserves || new BN(0),
      globalConfig: this.normalizeGlobalConfig(swapState.globalConfig),
      feeConfig: swapState.feeConfig,
      baseMintAccount: this.normalizeBaseMintAccount(swapState.baseMintAccount),
      baseMint: swapState.baseMint,
      coinCreator: swapState.pool.coinCreator,
      creator: swapState.pool.creator,
      quoteMint: swapState.pool.quoteMint,
      isMayhemMode: Boolean(swapState.pool.isMayhemMode),
      creatorFeeBps: new BN(swapState.pool.creatorFeeBps ? swapState.pool.creatorFeeBps.toString() : '0'),
    });
  }

  // Build PumpSwap buy instructions using official SDK quoter and instruction builder
  public static async buildPumpSwapBuyInstructions(
    connection: Connection,
    userPubkey: PublicKey,
    mint: PublicKey,
    solAmountLamports: bigint,
    slippageBps: number,
    executionMode: ExecutionMode
  ): Promise<{
    instructions: TransactionInstruction[];
    expectedBaseOutputRaw: bigint;
    minBaseOutputRaw: bigint;
    spotPriceSol: number;
  }> {
    if (executionMode !== 'LIVE' && executionMode !== 'PAPER') {
      throw new Error('CRITICAL_CONFIG_ERROR: executionMode ("LIVE" | "PAPER") is strictly required for buildPumpSwapBuyInstructions');
    }
    const poolKey = canonicalPumpPoolPda(mint);
    const poolAccount = await connection.getAccountInfo(poolKey);
    if (!poolAccount || !poolAccount.data || poolAccount.data.length === 0) {
      throw new Error(`PUMPSWAP_POOL_NOT_FOUND: Canonical PumpSwap pool for mint ${mint.toBase58()} does not exist on-chain.`);
    }

    const onlineSdk = new OnlinePumpAmmSdk(connection);
    const swapState = await onlineSdk.swapSolanaState(poolKey, userPubkey);

    if (!swapState || !swapState.pool) {
      throw new Error(`PUMPSWAP_POOL_NOT_FOUND: Canonical PumpSwap pool for mint ${mint.toBase58()} does not exist on-chain.`);
    }

    if (
      !swapState.pool.quoteMint.equals(NATIVE_MINT) &&
      !swapState.pool.quoteMint.equals(new PublicKey('So11111111111111111111111111111111111111112'))
    ) {
      throw new Error(`UNSUPPORTED_PUMPSWAP_QUOTE_MINT: Quote mint ${swapState.pool.quoteMint.toBase58()} is not native SOL.`);
    }

    if (swapState.poolBaseAmount.isZero() || swapState.poolQuoteAmount.isZero()) {
      throw new Error(`PUMPSWAP_INSUFFICIENT_LIQUIDITY: Pool ${poolKey.toBase58()} has zero liquidity.`);
    }

    const quoteResult = this.quotePumpSwapBuyQuoteInput({
      solAmountLamports,
      slippageBps,
      swapState,
    });

    const maxQuoteCost = new BN(solAmountLamports.toString());
    const minBaseOut = quoteResult.minBase;

    const instructions = await PUMP_AMM_SDK.buyInstructions(
      swapState,
      maxQuoteCost,
      minBaseOut
    );

    let decimals = 6;
    if (swapState.baseMintAccount && swapState.baseMintAccount.decimals != null) {
      decimals = swapState.baseMintAccount.decimals;
    }
    const effectiveQuoteBN = swapState.poolQuoteAmount.add(swapState.pool.virtualQuoteReserves || new BN(0));
    const baseHuman = Number(swapState.poolBaseAmount.toString()) / Math.pow(10, decimals);
    const quoteSol = Number(effectiveQuoteBN.toString()) / 1e9;
    const spotPriceSol = baseHuman > 0 ? quoteSol / baseHuman : 0;

    return {
      instructions,
      expectedBaseOutputRaw: BigInt(quoteResult.uiBase.toString()),
      minBaseOutputRaw: BigInt(quoteResult.minBase.toString()),
      spotPriceSol,
    };
  }

  // Build PumpSwap sell instructions using official SDK quoter and instruction builder
  public static async buildPumpSwapSellInstructions(
    connection: Connection,
    userPubkey: PublicKey,
    mint: PublicKey,
    tokenAmountRaw: bigint,
    slippageBps: number,
    executionMode: ExecutionMode
  ): Promise<{
    instructions: TransactionInstruction[];
    expectedSolOutputLamports: bigint;
    minSolOutputLamports: bigint;
    spotPriceSol: number;
  }> {
    if (executionMode !== 'LIVE' && executionMode !== 'PAPER') {
      throw new Error('CRITICAL_CONFIG_ERROR: executionMode ("LIVE" | "PAPER") is strictly required for buildPumpSwapSellInstructions');
    }
    const poolKey = canonicalPumpPoolPda(mint);
    const poolAccount = await connection.getAccountInfo(poolKey);
    if (!poolAccount || !poolAccount.data || poolAccount.data.length === 0) {
      throw new Error(`PUMPSWAP_POOL_NOT_FOUND: Canonical PumpSwap pool for mint ${mint.toBase58()} does not exist on-chain.`);
    }

    const onlineSdk = new OnlinePumpAmmSdk(connection);
    const swapState = await onlineSdk.swapSolanaState(poolKey, userPubkey);

    if (!swapState || !swapState.pool) {
      throw new Error(`PUMPSWAP_POOL_NOT_FOUND: Canonical PumpSwap pool for mint ${mint.toBase58()} does not exist on-chain.`);
    }

    if (
      !swapState.pool.quoteMint.equals(NATIVE_MINT) &&
      !swapState.pool.quoteMint.equals(new PublicKey('So11111111111111111111111111111111111111112'))
    ) {
      throw new Error(`UNSUPPORTED_PUMPSWAP_QUOTE_MINT: Quote mint ${swapState.pool.quoteMint.toBase58()} is not native SOL.`);
    }

    if (swapState.poolBaseAmount.isZero() || swapState.poolQuoteAmount.isZero()) {
      throw new Error(`PUMPSWAP_INSUFFICIENT_LIQUIDITY: Pool ${poolKey.toBase58()} has zero liquidity.`);
    }

    // Use official PumpSwap SDK quoter with dynamic fees and effective virtual quote reserves
    const quoteResult = sellBaseInput({
      base: new BN(tokenAmountRaw.toString()),
      slippage: slippageBps / 100,
      baseReserve: swapState.poolBaseAmount,
      quoteReserve: swapState.poolQuoteAmount,
      virtualQuoteReserves: swapState.pool.virtualQuoteReserves || new BN(0),
      globalConfig: swapState.globalConfig,
      feeConfig: swapState.feeConfig,
      baseMintAccount: swapState.baseMintAccount,
      baseMint: swapState.baseMint,
      coinCreator: swapState.pool.coinCreator,
      creator: swapState.pool.creator,
      quoteMint: swapState.pool.quoteMint,
      isMayhemMode: Boolean(swapState.pool.isMayhemMode),
      creatorFeeBps: new BN(swapState.pool.creatorFeeBps ? swapState.pool.creatorFeeBps.toString() : '0'),
    });

    // Use official PumpSwap SDK instruction builder
    const instructions = await PUMP_AMM_SDK.sellInstructions(
      swapState,
      new BN(tokenAmountRaw.toString()),
      quoteResult.minQuote
    );

    // Calculate effective spot price with virtual quote reserves
    let decimals = 6;
    if (swapState.baseMintAccount && swapState.baseMintAccount.decimals != null) {
      decimals = swapState.baseMintAccount.decimals;
    }
    const effectiveQuoteBN = swapState.poolQuoteAmount.add(swapState.pool.virtualQuoteReserves || new BN(0));
    const baseHuman = Number(swapState.poolBaseAmount.toString()) / Math.pow(10, decimals);
    const quoteSol = Number(effectiveQuoteBN.toString()) / 1e9;
    const spotPriceSol = baseHuman > 0 ? quoteSol / baseHuman : 0;

    return {
      instructions,
      expectedSolOutputLamports: BigInt(quoteResult.uiQuote.toString()),
      minSolOutputLamports: BigInt(quoteResult.minQuote.toString()),
      spotPriceSol,
    };
  }
}

