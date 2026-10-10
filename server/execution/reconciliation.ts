import { Connection, PublicKey } from '@solana/web3.js';
import { PumpCurveService, ExecutionMode } from '../solana/pumpCurve';
import { Logger } from '../middleware/enterprise';

export interface PreTradeSnapshot {
  walletSolLamports: number;
  walletSolBalance?: number;
  tokenBalanceRaw: string;
  tokenDecimals: number;
  timestamp: number;
}

export interface BuyReconciliationResult {
  success: boolean;
  reconciliationState: 'RECONCILED' | 'RECONCILIATION_REQUIRED' | 'ZERO_DELTA' | 'REVERTED' | 'ERROR';
  actualSolSpentLamports: number;
  actualTokensReceivedRaw: string;
  tokenDecimals: number;
  tokensReceivedHuman: number;
  actualNetworkFeeLamports: number;
  actualJitoTipLamports: number;
  /** Price the curve charged per token: SOL that went to the curve (fees included) / tokens. Excludes rent, tip and network fees. This is what marks are comparable with, so it is the exit engine's entry price. */
  effectiveFillPriceSol: number;
  /** Whole wallet SOL delta per token (rent, tip and fees included). The true cost; PnL accounting uses actualSolSpentLamports. */
  allInFillPriceSol?: number;
  /** SOL that went to the curve: wallet delta minus network fee, tip and token-account rent opened by this tx. */
  curveSpendLamports?: number;
  /** Lamports locked in token accounts this tx created (the buyer's ATA). */
  tokenAccountRentLamports?: number;
  /** Rent for other accounts the buyer funded in the same tx (e.g. a pump per-user account on a first buy). */
  otherNewAccountRentLamports?: number;
  slot: number;
  error?: string;
}

export interface SellReconciliationResult {
  success: boolean;
  reconciliationState: 'RECONCILED' | 'RECONCILIATION_REQUIRED' | 'ZERO_DELTA' | 'REVERTED' | 'ERROR';
  actualTokensSoldRaw: string;
  tokensSoldHuman: number;
  tokenDecimals: number;
  actualGrossSolProceedsLamports: number;
  actualNetSolProceedsLamports: number;
  actualNetworkFeeLamports: number;
  actualJitoTipLamports: number;
  actualRealizedPnLSol: number;
  remainingTokensRaw: string;
  isFullyClosed: boolean;
  slot: number;
  error?: string;
}

export class TradeReconciler {
  /**
   * Delays between getTransaction retries when the RPC has not indexed a just-confirmed signature yet (returns null) or errors.
   * About 12s in total. Tests set this to [] to skip waiting.
   */
  public static txFetchRetryDelaysMs: number[] = [400, 800, 1600, 3200, 6400];

  private static async fetchConfirmedTx(connection: Connection, signature: string) {
    const delays = TradeReconciler.txFetchRetryDelaysMs;
    let lastErr: any = null;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        if (tx && tx.meta) return tx;
        lastErr = null;
      } catch (e: any) {
        lastErr = e;
      }
      if (attempt < delays.length) await new Promise((r) => setTimeout(r, delays[attempt]));
    }
    if (lastErr) throw lastErr;
    return null;
  }

  // Capture pre-trade on-chain state
  public static async capturePreTradeSnapshot(
    connection: Connection,
    wallet: PublicKey,
    mint: PublicKey,
    tokenProgram: PublicKey,
    executionMode: ExecutionMode = 'PAPER'
  ): Promise<PreTradeSnapshot> {
    const timestamp = Date.now();
    let walletSolLamports = 0;
    let tokenBalanceRaw = '0';
    let tokenDecimals = 6;

    try {
      walletSolLamports = await connection.getBalance(wallet, 'confirmed');
    } catch (e: any) {
      Logger.warn(`Failed to query pre-trade SOL balance: ${e.message}`);
      if (executionMode === 'LIVE') {
        throw new Error(`PRE_TRADE_SNAPSHOT_FAILED: Cannot query wallet balance in LIVE mode: ${e.message}`, {
          cause: e,
        });
      }
    }

    try {
      const ata = PumpCurveService.getAssociatedTokenAddress(mint, wallet, tokenProgram);
      const tokenBalRes = await connection.getTokenAccountBalance(ata, 'confirmed');
      if (tokenBalRes && tokenBalRes.value) {
        tokenBalanceRaw = tokenBalRes.value.amount;
        tokenDecimals = tokenBalRes.value.decimals;
      }
    } catch (e: any) {
      // ATA likely does not exist yet (common for fresh buys) -> 0 balance
      tokenBalanceRaw = '0';
    }

    return {
      walletSolLamports,
      walletSolBalance: walletSolLamports / 1e9,
      tokenBalanceRaw,
      tokenDecimals,
      timestamp,
    };
  }

  // Rigorous Buy Fill Reconciliation
  public static async reconcileBuyTransaction(
    connection: Connection,
    signature: string,
    wallet: PublicKey,
    mint: PublicKey,
    tokenProgram: PublicKey,
    preSnapshot: PreTradeSnapshot,
    expectedJitoTipLamports: number
  ): Promise<BuyReconciliationResult> {
    const walletStr = wallet.toBase58();
    const mintStr = mint.toBase58();

    try {
      const tx = await TradeReconciler.fetchConfirmedTx(connection, signature);

      if (!tx || !tx.meta) {
        return {
          success: false,
          reconciliationState: 'RECONCILIATION_REQUIRED',
          actualSolSpentLamports: 0,
          actualTokensReceivedRaw: '0',
          tokenDecimals: preSnapshot.tokenDecimals,
          tokensReceivedHuman: 0,
          actualNetworkFeeLamports: 0,
          actualJitoTipLamports: expectedJitoTipLamports,
          effectiveFillPriceSol: 0,
          slot: 0,
          error: 'Transaction metadata could not be fetched from RPC for verification',
        };
      }

      if (tx.meta.err) {
        return {
          success: false,
          reconciliationState: 'REVERTED',
          actualSolSpentLamports: 0,
          actualTokensReceivedRaw: '0',
          tokenDecimals: preSnapshot.tokenDecimals,
          tokensReceivedHuman: 0,
          actualNetworkFeeLamports: tx.meta.fee || 5000,
          actualJitoTipLamports: 0,
          effectiveFillPriceSol: 0,
          slot: tx.slot,
          error: `Transaction reverted on-chain: ${JSON.stringify(tx.meta.err)}`,
        };
      }

      const slot = tx.slot;
      const actualNetworkFeeLamports = tx.meta.fee || 5000;

      // 1. Calculate actual SOL delta for wallet
      const accountKeys = tx.transaction.message.getAccountKeys();
      let walletIndex = -1;
      for (let i = 0; i < accountKeys.length; i++) {
        if (accountKeys.get(i)?.toBase58() === walletStr) {
          walletIndex = i;
          break;
        }
      }

      let actualSolSpentLamports = 0;
      if (walletIndex >= 0 && tx.meta.preBalances[walletIndex] !== undefined && tx.meta.postBalances[walletIndex] !== undefined) {
        const preSol = tx.meta.preBalances[walletIndex];
        const postSol = tx.meta.postBalances[walletIndex];
        actualSolSpentLamports = Math.max(0, preSol - postSol);
      }

      // 2. Calculate actual Token delta from meta token balances
      let preTokenAmount = BigInt(preSnapshot.tokenBalanceRaw);
      let postTokenAmount = preTokenAmount;
      let tokenDecimals = preSnapshot.tokenDecimals;

      const postTokenEntries = tx.meta.postTokenBalances?.filter(
        (b) => b.owner === walletStr && b.mint === mintStr
      );
      const preTokenEntries = tx.meta.preTokenBalances?.filter(
        (b) => b.owner === walletStr && b.mint === mintStr
      );

      if (postTokenEntries && postTokenEntries.length > 0) {
        postTokenAmount = BigInt(postTokenEntries[0].uiTokenAmount.amount);
        tokenDecimals = postTokenEntries[0].uiTokenAmount.decimals;
      }
      if (preTokenEntries && preTokenEntries.length > 0) {
        preTokenAmount = BigInt(preTokenEntries[0].uiTokenAmount.amount);
      }

      let actualTokensReceivedRaw = (postTokenAmount - preTokenAmount).toString();

      // Double-check via current live ATA balance if meta token balances were empty
      if (BigInt(actualTokensReceivedRaw) <= 0n) {
        try {
          const ata = PumpCurveService.getAssociatedTokenAddress(mint, wallet, tokenProgram);
          const liveAtaBal = await connection.getTokenAccountBalance(ata, 'confirmed');
          if (liveAtaBal?.value) {
            const currentTotal = BigInt(liveAtaBal.value.amount);
            if (currentTotal > BigInt(preSnapshot.tokenBalanceRaw)) {
              actualTokensReceivedRaw = (currentTotal - BigInt(preSnapshot.tokenBalanceRaw)).toString();
              tokenDecimals = liveAtaBal.value.decimals;
            }
          }
        } catch {}
      }

      const tokensReceivedBigInt = BigInt(actualTokensReceivedRaw);
      if (tokensReceivedBigInt <= 0n) {
        Logger.warn(`RECONCILIATION FAILED: Transaction confirmed but zero tokens credited to wallet ${walletStr}`);
        return {
          success: false,
          reconciliationState: 'RECONCILIATION_REQUIRED',
          actualSolSpentLamports,
          actualTokensReceivedRaw: '0',
          tokenDecimals,
          tokensReceivedHuman: 0,
          actualNetworkFeeLamports,
          actualJitoTipLamports: expectedJitoTipLamports,
          effectiveFillPriceSol: 0,
          slot,
          error: 'Confirmed transaction resulted in zero token balance increase. Position cannot be marked OPEN.',
        };
      }

      const tokensReceivedHuman = Number(tokensReceivedBigInt) / Math.pow(10, tokenDecimals);
      // Split the wallet delta: rent opened for the buyer's token account, the tip and the network/priority fee are not
      // what the curve charged. Marks come from the curve, so the stop-loss must compare against the curve price paid.
      let tokenAccountRentLamports = 0;
      const ataKey = PumpCurveService.getAssociatedTokenAddress(mint, wallet, tokenProgram).toBase58();
      for (let i = 0; i < accountKeys.length; i++) {
        if (accountKeys.get(i)?.toBase58() === ataKey) {
          const pre = tx.meta.preBalances[i] ?? 0;
          const post = tx.meta.postBalances[i] ?? 0;
          tokenAccountRentLamports = Math.max(0, post - pre);
          break;
        }
      }
      // F1: the pump program can also make the buyer fund other new accounts in the same tx (on devnet, a pump-owned per-user
      // account of 1,346,200 lamports on the first buy). That rent is not curve spend either. Any account other than the
      // wallet and its token account that had no lamports before and has some after was created (and funded) by this tx.
      let otherNewAccountRentLamports = 0;
      for (let i = 0; i < accountKeys.length; i++) {
        const key = accountKeys.get(i)?.toBase58();
        if (!key || key === walletStr || key === ataKey) continue;
        const pre = tx.meta.preBalances[i] ?? 0;
        const post = tx.meta.postBalances[i] ?? 0;
        if (pre === 0 && post > 0) otherNewAccountRentLamports += post;
      }
      const nonCurveLamports =
        actualNetworkFeeLamports + expectedJitoTipLamports + tokenAccountRentLamports + otherNewAccountRentLamports;
      let curveSpendLamports = actualSolSpentLamports - nonCurveLamports;
      if (!(curveSpendLamports > 0)) curveSpendLamports = actualSolSpentLamports; // cannot split: fall back to the whole delta
      const effectiveFillPriceSol = (curveSpendLamports / 1e9) / tokensReceivedHuman;
      const allInFillPriceSol = (actualSolSpentLamports / 1e9) / tokensReceivedHuman;

      Logger.info(`Reconciled BUY fill for ${mintStr}: ${tokensReceivedHuman.toFixed(4)} tokens for ${(actualSolSpentLamports / 1e9).toFixed(5)} SOL (effective price: ${effectiveFillPriceSol.toFixed(8)} SOL)`);

      return {
        success: true,
        reconciliationState: 'RECONCILED',
        actualSolSpentLamports,
        actualTokensReceivedRaw,
        tokenDecimals,
        tokensReceivedHuman,
        actualNetworkFeeLamports,
        actualJitoTipLamports: expectedJitoTipLamports,
        effectiveFillPriceSol,
        allInFillPriceSol,
        curveSpendLamports,
        tokenAccountRentLamports,
        otherNewAccountRentLamports,
        slot,
      };
    } catch (err: any) {
      Logger.error(`Reconciliation exception for ${signature}: ${err.message}`);
      return {
        success: false,
        reconciliationState: 'ERROR',
        actualSolSpentLamports: 0,
        actualTokensReceivedRaw: '0',
        tokenDecimals: preSnapshot.tokenDecimals,
        tokensReceivedHuman: 0,
        actualNetworkFeeLamports: 0,
        actualJitoTipLamports: 0,
        effectiveFillPriceSol: 0,
        slot: 0,
        error: err.message,
      };
    }
  }

  // Rigorous Sell Fill Reconciliation
  public static async reconcileSellTransaction(
    connection: Connection,
    signature: string,
    wallet: PublicKey,
    mint: PublicKey,
    tokenProgram: PublicKey,
    preSnapshot: PreTradeSnapshot,
    costBasisLamports: number,
    sellFraction: number,
    expectedJitoTipLamports: number
  ): Promise<SellReconciliationResult> {
    const walletStr = wallet.toBase58();
    const mintStr = mint.toBase58();

    try {
      const tx = await TradeReconciler.fetchConfirmedTx(connection, signature);

      if (!tx || !tx.meta) {
        return {
          success: false,
          reconciliationState: 'RECONCILIATION_REQUIRED',
          actualTokensSoldRaw: '0',
          tokensSoldHuman: 0,
          tokenDecimals: preSnapshot.tokenDecimals,
          actualGrossSolProceedsLamports: 0,
          actualNetSolProceedsLamports: 0,
          actualNetworkFeeLamports: 0,
          actualJitoTipLamports: expectedJitoTipLamports,
          actualRealizedPnLSol: 0,
          remainingTokensRaw: preSnapshot.tokenBalanceRaw,
          isFullyClosed: false,
          slot: 0,
          error: 'Sell transaction metadata not retrievable',
        };
      }

      if (tx.meta.err) {
        return {
          success: false,
          reconciliationState: 'REVERTED',
          actualTokensSoldRaw: '0',
          tokensSoldHuman: 0,
          tokenDecimals: preSnapshot.tokenDecimals,
          actualGrossSolProceedsLamports: 0,
          actualNetSolProceedsLamports: 0,
          actualNetworkFeeLamports: tx.meta.fee || 5000,
          actualJitoTipLamports: 0,
          actualRealizedPnLSol: 0,
          remainingTokensRaw: preSnapshot.tokenBalanceRaw,
          isFullyClosed: false,
          slot: tx.slot,
          error: `Sell transaction reverted on-chain: ${JSON.stringify(tx.meta.err)}`,
        };
      }

      const slot = tx.slot;
      const actualNetworkFeeLamports = tx.meta.fee || 5000;

      // 1. SOL delta for wallet (proceeds)
      const accountKeys = tx.transaction.message.getAccountKeys();
      let walletIndex = -1;
      for (let i = 0; i < accountKeys.length; i++) {
        if (accountKeys.get(i)?.toBase58() === walletStr) {
          walletIndex = i;
          break;
        }
      }

      let actualNetSolProceedsLamports = 0;
      if (walletIndex >= 0 && tx.meta.preBalances[walletIndex] !== undefined && tx.meta.postBalances[walletIndex] !== undefined) {
        const preSol = tx.meta.preBalances[walletIndex];
        const postSol = tx.meta.postBalances[walletIndex];
        actualNetSolProceedsLamports = Math.max(0, postSol - preSol);
      }

      // 2. Token delta
      let preTokenAmount = BigInt(preSnapshot.tokenBalanceRaw);
      let postTokenAmount = 0n;
      let tokenDecimals = preSnapshot.tokenDecimals;

      const postTokenEntries = tx.meta.postTokenBalances?.filter(
        (b) => b.owner === walletStr && b.mint === mintStr
      );
      const preTokenEntries = tx.meta.preTokenBalances?.filter(
        (b) => b.owner === walletStr && b.mint === mintStr
      );

      if (postTokenEntries && postTokenEntries.length > 0) {
        postTokenAmount = BigInt(postTokenEntries[0].uiTokenAmount.amount);
        tokenDecimals = postTokenEntries[0].uiTokenAmount.decimals;
      }
      if (preTokenEntries && preTokenEntries.length > 0) {
        preTokenAmount = BigInt(preTokenEntries[0].uiTokenAmount.amount);
      }

      const actualTokensSoldRaw = (preTokenAmount - postTokenAmount).toString();
      const tokensSoldBigInt = BigInt(actualTokensSoldRaw);

      const tokensSoldHuman = Number(tokensSoldBigInt) / Math.pow(10, tokenDecimals);
      const costPortionLamports = costBasisLamports * sellFraction;
      const actualRealizedPnLSol =
        (actualNetSolProceedsLamports - costPortionLamports) / 1e9;

      const remainingTokensRaw = postTokenAmount.toString();
      const isFullyClosed = postTokenAmount <= 0n;

      Logger.info(`Reconciled SELL fill for ${mintStr}: Sold ${tokensSoldHuman.toFixed(4)} tokens for net ${(actualNetSolProceedsLamports / 1e9).toFixed(5)} SOL (PnL: ${actualRealizedPnLSol >= 0 ? '+' : ''}${actualRealizedPnLSol.toFixed(5)} SOL)`);

      return {
        success: true,
        reconciliationState: 'RECONCILED',
        actualTokensSoldRaw,
        tokensSoldHuman,
        tokenDecimals,
        actualGrossSolProceedsLamports: actualNetSolProceedsLamports + actualNetworkFeeLamports,
        actualNetSolProceedsLamports,
        actualNetworkFeeLamports,
        actualJitoTipLamports: expectedJitoTipLamports,
        actualRealizedPnLSol,
        remainingTokensRaw,
        isFullyClosed,
        slot,
      };
    } catch (err: any) {
      Logger.error(`Reconcile sell error: ${err.message}`);
      return {
        success: false,
        reconciliationState: 'ERROR',
        actualTokensSoldRaw: '0',
        tokensSoldHuman: 0,
        tokenDecimals: preSnapshot.tokenDecimals,
        actualGrossSolProceedsLamports: 0,
        actualNetSolProceedsLamports: 0,
        actualNetworkFeeLamports: 0,
        actualJitoTipLamports: 0,
        actualRealizedPnLSol: 0,
        remainingTokensRaw: preSnapshot.tokenBalanceRaw,
        isFullyClosed: false,
        slot: 0,
        error: err.message,
      };
    }
  }

  // Authoritative recovery of interrupted transactions from on-chain transaction records
  public static async recoverInterruptedTransaction(
    connection: Connection,
    signature: string,
    wallet: PublicKey,
    expectedJitoTipLamports: number = 0
  ): Promise<{
    recovered: boolean;
    type: 'BUY' | 'SELL';
    mint?: string;
    tokenDecimals?: number;
    baseTokenProgram?: string;
    tokenQuantityRaw?: string;
    tokenBeforeRaw?: string;
    tokenAfterRaw?: string;
    tokensSoldRaw?: string;
    remainingTokensRaw?: string;
    solBeforeLamports?: number;
    solAfterLamports?: number;
    solSpentLamports?: number;
    solReceivedLamports?: number;
    networkFeeLamports?: number;
    /** BUY only: SOL that went to the curve (wallet delta minus fee, tip and rent of the token account this tx opened). */
    curveSpendLamports?: number;
    tokenAccountRentLamports?: number;
    slot?: number;
    blockTime?: number;
    error?: string;
  }> {
    try {
      const txDetails = await TradeReconciler.fetchConfirmedTx(connection, signature);

      if (!txDetails) {
        return { recovered: false, type: 'BUY', error: 'Transaction not found on-chain' };
      }

      if (txDetails.meta?.err) {
        return {
          recovered: false,
          type: 'BUY',
          error: `Transaction reverted: ${JSON.stringify(txDetails.meta.err)}`,
        };
      }

      const networkFeeLamports = txDetails.meta?.fee || 5000;
      const walletStr = wallet.toBase58();

      // Look up wallet index in static accounts
      const staticKeys = txDetails.transaction.message.getAccountKeys().staticAccountKeys;
      const walletIdx = staticKeys.findIndex((k) => k.equals(wallet));

      let solBeforeLamports = 0;
      let solAfterLamports = 0;
      let solSpentLamports = 0;
      let solReceivedLamports = 0;

      if (walletIdx >= 0 && txDetails.meta?.preBalances && txDetails.meta?.postBalances) {
        solBeforeLamports = txDetails.meta.preBalances[walletIdx];
        solAfterLamports = txDetails.meta.postBalances[walletIdx];
        if (solBeforeLamports > solAfterLamports) {
          solSpentLamports = solBeforeLamports - solAfterLamports;
        } else if (solAfterLamports > solBeforeLamports) {
          solReceivedLamports = solAfterLamports - solBeforeLamports;
        }
      }

      const preTokens = txDetails.meta?.preTokenBalances?.filter((tb) => tb.owner === walletStr) || [];
      const postTokens = txDetails.meta?.postTokenBalances?.filter((tb) => tb.owner === walletStr) || [];

      let matchedMint = '';
      let tokenDecimals = 6;
      let baseTokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
      let tokenBeforeRaw = '0';
      let tokenAfterRaw = '0';
      let tokenDelta = 0n;
      let type: 'BUY' | 'SELL' = 'BUY';

      // Check if tokens increased (BUY)
      for (const post of postTokens) {
        const pre = preTokens.find((p) => p.mint === post.mint);
        const preAmount = pre?.uiTokenAmount?.amount ? BigInt(pre.uiTokenAmount.amount) : 0n;
        const postAmount = post.uiTokenAmount?.amount ? BigInt(post.uiTokenAmount.amount) : 0n;
        if (postAmount > preAmount) {
          matchedMint = post.mint;
          tokenDecimals = post.uiTokenAmount.decimals;
          baseTokenProgram = post.programId || 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
          tokenDelta = postAmount - preAmount;
          tokenBeforeRaw = preAmount.toString();
          tokenAfterRaw = postAmount.toString();
          type = 'BUY';
          break;
        }
      }

      // If not increased, check if tokens decreased (SELL)
      if (!matchedMint) {
        for (const pre of preTokens) {
          const post = postTokens.find((p) => p.mint === pre.mint);
          const preAmount = pre.uiTokenAmount?.amount ? BigInt(pre.uiTokenAmount.amount) : 0n;
          const postAmount = post?.uiTokenAmount?.amount ? BigInt(post.uiTokenAmount.amount) : 0n;
          if (preAmount > postAmount) {
            matchedMint = pre.mint;
            tokenDecimals = pre.uiTokenAmount.decimals;
            baseTokenProgram = pre.programId || 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
            tokenDelta = preAmount - postAmount;
            tokenBeforeRaw = preAmount.toString();
            tokenAfterRaw = postAmount.toString();
            type = 'SELL';
            break;
          }
        }
      }

      let tokenAccountRentLamports = 0;
      if (type === 'BUY' && matchedMint) {
        const tb = postTokens.find((p) => p.mint === matchedMint);
        if (tb && txDetails.meta?.preBalances && txDetails.meta?.postBalances) {
          tokenAccountRentLamports = Math.max(0, (txDetails.meta.postBalances[tb.accountIndex] ?? 0) - (txDetails.meta.preBalances[tb.accountIndex] ?? 0));
        }
      }
      let curveSpendLamports = solSpentLamports - networkFeeLamports - expectedJitoTipLamports - tokenAccountRentLamports;
      if (!(curveSpendLamports > 0)) curveSpendLamports = solSpentLamports;

      if (matchedMint && tokenDelta > 0n) {
        return {
          recovered: true,
          type,
          mint: matchedMint,
          tokenDecimals,
          baseTokenProgram,
          tokenQuantityRaw: tokenDelta.toString(),
          tokenBeforeRaw,
          tokenAfterRaw,
          tokensSoldRaw: type === 'SELL' ? tokenDelta.toString() : undefined,
          remainingTokensRaw: type === 'SELL' ? tokenAfterRaw : undefined,
          solBeforeLamports,
          solAfterLamports,
          solSpentLamports,
          solReceivedLamports,
          networkFeeLamports,
          curveSpendLamports,
          tokenAccountRentLamports,
          slot: txDetails.slot,
          blockTime: txDetails.blockTime ? txDetails.blockTime * 1000 : Date.now(),
        };
      }

      return {
        recovered: false,
        type: 'BUY',
        error: 'Unable to detect token balance delta from on-chain balances',
      };
    } catch (err: any) {
      return { recovered: false, type: 'BUY', error: err.message };
    }
  }
}

// Real Mark Price Service (No synthetic random walks)
export class RealMarkPriceService {
  private lastFetchTimestamp: number = 0;

  // Query on-chain bonding curve reserves for active open positions
  public static async queryOnChainMarkPrices(
    connection: Connection,
    mints: string[],
    executionMode: ExecutionMode = 'PAPER'
  ): Promise<Record<string, { priceSol: number; source: string; timestamp: number; poolAddress?: string }>> {
    const result: Record<string, { priceSol: number; source: string; timestamp: number; poolAddress?: string }> = {};
    if (mints.length === 0) return result;

    const uniqueMints = Array.from(new Set(mints));
    const now = Date.now();

    for (const mintStr of uniqueMints) {
      try {
        const mintPubkey = new PublicKey(mintStr);
        const state = await PumpCurveService.fetchPumpMarketState({
          connection,
          mint: mintPubkey,
          executionMode,
        });
        if (state && !state.complete && state.virtualTokenReserves > 0n) {
          const spotPriceSol =
            Number(state.virtualSolReserves) /
            Number(state.virtualTokenReserves) /
            (1e9 / Math.pow(10, state.tokenDecimals));

          if (spotPriceSol > 0) {
            result[mintStr] = {
              priceSol: spotPriceSol,
              source: 'ON_CHAIN_BONDING_CURVE',
              timestamp: now,
            };
          }
        } else if (!state && PumpCurveService.getMintRejection(mintStr)) {
          // R19: the mint is not a token mint at all; asking PumpSwap about it would only hide that. The caller alerts.
          continue;
        } else {
          // If bonding curve completed or not found, check canonical PumpSwap AMM pool
          const { PumpSwapVenueService } = await import('../solana/pumpSwapService');
          const poolState = await PumpSwapVenueService.getPoolState(connection, mintPubkey, executionMode);
          if (poolState && poolState.spotPriceSol > 0) {
            result[mintStr] = {
              priceSol: poolState.spotPriceSol,
              source: 'ON_CHAIN_PUMPSWAP_POOL',
              // N16: the pool state is cached for up to 15 s; stamping it "now" would hide a stale price from the staleness check.
              timestamp: poolState.marketDataTimestamp || now,
              poolAddress: poolState.poolAddress.toBase58(),
            };
          }
        }
      } catch (err: any) {
        Logger.debug(`Could not query mark price for ${mintStr}: ${err.message}`);
      }
    }

    return result;
  }
}
