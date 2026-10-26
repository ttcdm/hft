/**
 * Venue resolution, pool state, quotes and instruction building for tokens that have migrated from the Pump.fun bonding curve to the
 * canonical PumpSwap AMM pool (via @pump-fun/pump-swap-sdk). SOL-quoted pools only: a pool with any other quote mint is refused
 * (`UNSUPPORTED_PUMPSWAP_QUOTE_MINT`).
 *
 * What it must never do: sign or send (it returns instructions), or treat an unresolved venue as tradable. `resolveVenue` reads the curve
 * with `PumpCurveService.fetchPumpMarketStateResult`, which says why there is no state. An open curve is `PUMP_BONDING_CURVE`, also in LIVE
 * when only its fee tier could not be verified (the sell is then built at the highest fee tier). Any other outcome (no curve, a complete
 * curve, or a curve read that failed) goes on to the canonical pool check in either mode; with no SOL-quoted pool the venue is `UNKNOWN`
 * and, when the curve read itself failed, the result carries that reason (`curveFailure`) so the refusal names it. `getPoolState` and the
 * two instruction builders throw if `executionMode` is not exactly `LIVE` or `PAPER`; `resolveVenue` does not check it.
 *
 * Called by: `ExecutionCoordinator.closePositionImpl` (`resolveVenue`, `buildPumpSwapSellInstructions`: this is how a migrated position is
 * sold) and `RealMarkPriceService.queryOnChainMarkPrices` in `reconciliation.ts` (`getPoolState`, to price an open position whose curve has completed). Buys are never built here in the running app: a
 * LIVE buy of a migrated token is rejected with `BONDING_CURVE_MIGRATED`. `buildPumpSwapBuyInstructions` and the `quotePumpSwap*` helpers
 * have no production caller (only tests), so treat them as unexercised until a send path uses them.
 */
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
  sellBaseInput,
} from '@pump-fun/pump-swap-sdk';
import { Logger } from '../middleware/enterprise';
import { ExecutionMode, TradingVenue } from '../core/types';
import { PumpCurveService, NO_CURVE_REASONS, type MarketStateFailure } from './pumpCurve';

export type { ExecutionMode, TradingVenue };

/** Decoded canonical pool for one mint: reserves, token programs, fee and creator fields, and the spot price in SOL per token. `effectiveQuoteReserve` is real plus virtual quote reserves; the spot price uses it. */
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

/** Static helpers around the PumpSwap pool of one mint. Pool state is cached per mint for 15 s, unless the caller asks for a fresh read. */
export class PumpSwapVenueService {
  private static poolCache: Map<string, { pool: PumpSwapExecutionState | null; timestamp: number }> = new Map(); // timestamp: performance.now(), so a wall clock set back cannot keep a stale pool fresh (S271 review)
  private static readonly CACHE_TTL_MS = 15000;

  /**
   * Which venue trades this mint: `PUMP_BONDING_CURVE` while the curve is open, `PUMPSWAP` once the canonical SOL-quoted pool exists, else `UNKNOWN`.
   * An `UNKNOWN` answer means "do not trade", never a guess; `curveFailure` then says why the curve could not be read, when that was the cause.
   */
  // Resolve trading venue for a token mint: active bonding curve vs migrated canonical PumpSwap pool
  public static async resolveVenue(
    connection: Connection,
    mint: PublicKey,
    executionMode: ExecutionMode
  ): Promise<{ venue: TradingVenue; isMigrated: boolean; poolAddress?: PublicKey; curveFailure?: MarketStateFailure }> {
    const mintStr = mint.toBase58();

    // 1. First check if Pump.fun bonding curve is active using the strict executionMode
    let curveFailure: MarketStateFailure | undefined;
    try {
      const read = await PumpCurveService.fetchPumpMarketStateResult({ connection, mint, executionMode });
      // P1.6 (N-42): in LIVE an open curve whose only problem is the fee tier is still the curve; the sell is built at the highest tier.
      const curveState = read.state ?? read.failure.sellableState;
      if (curveState && !curveState.complete) {
        return {
          venue: 'PUMP_BONDING_CURVE',
          isMigrated: false,
          poolAddress: curveState.bondingCurve,
        };
      }
      if (!read.state && !NO_CURVE_REASONS.has(read.failure.reason) && !curveState) curveFailure = read.failure;
    } catch (err: any) {
      curveFailure = { reason: 'RPC_ERROR', message: err?.message ?? String(err) };
      Logger.warn(`Bonding curve state lookup failed for ${mintStr}: ${curveFailure.message}`);
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

    if (curveFailure && executionMode === 'LIVE') Logger.warn(`LIVE venue for ${mintStr} unknown: the curve read failed (${curveFailure.reason}: ${curveFailure.message}) and no pool was found`);
    return {
      venue: 'UNKNOWN',
      isMigrated: true,
      ...(curveFailure ? { curveFailure } : {}),
    };
  }

  /**
   * Decodes the canonical pool and its vault balances. Returns null when there is no pool (cached as null for 15 s). Throws in LIVE for a
   * non-SOL quote mint; in PAPER it returns null instead. Throws if `executionMode` is not `LIVE` or `PAPER`. `opts.fresh` skips the
   * 15 s cache (P1.6, R1-31: marks of open LIVE positions, so a migrated position's stop sees every price move and a pool created
   * after a cached "no pool" is seen on the next pass); the fresh read still refreshes the cache.
   */
  // Fetch canonical PumpSwap pool state and calculate spot price in SOL using effectiveQuoteReserves
  public static async getPoolState(
    connection: Connection,
    mint: PublicKey,
    executionMode: ExecutionMode,
    opts: { fresh?: boolean } = {}
  ): Promise<PumpSwapExecutionState | null> {
    if (executionMode !== 'LIVE' && executionMode !== 'PAPER') {
      throw new Error('CRITICAL_CONFIG_ERROR: executionMode ("LIVE" | "PAPER") is strictly required for getPoolState');
    }
    const mintStr = mint.toBase58();
    const cached = this.poolCache.get(mintStr);
    if (!opts.fresh && cached && performance.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.pool;
    }

    try {
      const poolKey = canonicalPumpPoolPda(mint);
      const poolAccountInfo = await connection.getAccountInfo(poolKey);
      if (!poolAccountInfo) {
        if (executionMode === 'LIVE') {
          Logger.error(`PUMPSWAP_POOL_NOT_FOUND in LIVE mode: Canonical pool ${poolKey.toBase58()} not found on-chain.`);
        }
        this.poolCache.set(mintStr, { pool: null, timestamp: performance.now() });
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

      this.poolCache.set(mintStr, { pool: state, timestamp: performance.now() });
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

  /** Quote helpers 1 and 3 wrap the SDK's pure maths with this app's pool state. They read nothing from the chain. No production caller; tests only. */
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

  // Build PumpSwap buy instructions using official SDK quoter and instruction builder
  /** Instructions to buy `solAmountLamports` of a migrated token, with the minimum base output at `slippageBps`. No production caller (see the file header). */
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
  /**
   * Instructions to sell `tokenAmountRaw` of a migrated token, with the minimum SOL output at `slippageBps`. The instructions are unsigned; the
   * coordinator wraps them in a transaction and sends them through the same cluster-guarded path as a bonding-curve sell.
   */
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

