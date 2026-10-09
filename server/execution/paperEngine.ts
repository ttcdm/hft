import { solPriceService } from '../market/solPriceService';
import crypto from 'crypto';
import { NormalizedPosition } from '../core/types';
import { workstationDb } from '../db/database';
import { Logger } from '../middleware/enterprise';

export interface PaperOrderRequest {
  mint: string;
  symbol: string;
  name: string;
  tokenDecimals?: number;
  amountSol: number;
  currentPriceSol: number;
  slippageBps: number;
  jitoTipSol: number;
  liquidityUsd?: number;
  solPriceUsd?: number;
}

export interface PaperExecutionResult {
  success: boolean;
  position?: NormalizedPosition;
  paperOrderId: string;
  fillPriceSol: number;
  tokensReceived: number;
  networkFeeLamports: number;
  jitoTipLamports: number;
  simulatedLatencyMs: number;
  effectiveSlippageBps: number;
  error?: string;
}

export class PaperExecutionEngine {
  /** Uncapped modeled price impact in bps for an order against pool liquidity (same model the fill uses). */
  public static estimateImpactBps(amountSol: number, liquidityUsd?: number, solPriceUsd?: number): number {
    const poolLiq = Math.max(2000, liquidityUsd || 15000);
    const solUsd = solPriceUsd || solPriceService.lastKnownPrice();
    // C3: with no SOL/USD price the order's size against the pool is unknown; report unbounded impact (fail closed).
    if (!solUsd) return Number.POSITIVE_INFINITY;
    const participationRate = (amountSol * solUsd) / poolLiq;
    return Math.max(10, Math.round(Math.sqrt(participationRate) * 1200));
  }

  // Execute a simulated buy based strictly on observed market prices and market impact
  public executePaperBuy(req: PaperOrderRequest): PaperExecutionResult {
    const paperOrderId = `PAPER-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const correlationId = `corr-${paperOrderId}`;

    if (req.currentPriceSol <= 0) {
      return {
        success: false,
        paperOrderId,
        fillPriceSol: 0,
        tokensReceived: 0,
        networkFeeLamports: 0,
        jitoTipLamports: 0,
        simulatedLatencyMs: 0,
        effectiveSlippageBps: 0,
        error: 'MARKET_DATA_UNAVAILABLE: Observed price is non-positive or unavailable for paper buy',
      };
    }

    // Realistic slippage model based on order size vs pool liquidity
    const impactBps = Math.min(
      req.slippageBps,
      PaperExecutionEngine.estimateImpactBps(req.amountSol, req.liquidityUsd, req.solPriceUsd)
    );

    // Fill price derived honestly from market price + calculated impact
    const fillPriceSol = req.currentPriceSol * (1 + impactBps / 10000);
    // Pump.fun charges the 1% protocol fee on the SOL spent; only the remainder buys tokens.
    const protocolFeeSol = req.amountSol * 0.01;
    const tokensReceived = (req.amountSol - protocolFeeSol) / fillPriceSol;
    const tokenDecimals = req.tokenDecimals || 6;
    const tokenQtyRaw = BigInt(Math.floor(tokensReceived * Math.pow(10, tokenDecimals))).toString();

    // Fees: base network fee ~5000 lamports + Jito tip
    const networkFeeLamports = 5000;
    const jitoTipLamports = Math.round(req.jitoTipSol * 1e9);
    // Latency is not modeled: a paper fill is instantaneous. Reported as 0 rather than an invented range.
    const simulatedLatencyMs = 0;

    const position: NormalizedPosition = {
      id: paperOrderId,
      mint: req.mint,
      symbol: req.symbol,
      name: req.name,
      tokenDecimals,
      tokenQuantityRaw: tokenQtyRaw,
      // Cost basis is everything paid to enter: the SOL spent (fee included) plus network fee and tip.
      costBasisLamports: Math.round(req.amountSol * 1e9) + networkFeeLamports + jitoTipLamports,
      entryPriceSol: fillPriceSol,
      currentPriceSol: fillPriceSol,
      currentValueSol: tokensReceived * fillPriceSol,
      unrealizedPnLSol: tokensReceived * fillPriceSol - (req.amountSol * 1e9 + networkFeeLamports + jitoTipLamports) / 1e9,
      unrealizedPnLPct: 0,
      realizedPnLSol: 0,
      entryTxSignature: paperOrderId,
      entrySlot: 0,
      entryTimestamp: Date.now(),
      entryFeeLamports: networkFeeLamports,
      priorityFeeLamports: 10000,
      jitoTipLamports,
      markSource: 'PAPER_ENGINE',
      markAgeMs: 0,
      venue: 'PUMP_BONDING_CURVE',
      executionMode: 'PAPER',
      status: 'OPEN',
      lastUpdatedTimestamp: Date.now(),
    };

    workstationDb.savePosition(position);

    // Persist order & transaction records
    workstationDb.saveOrder({
      id: paperOrderId,
      clientOrderId: paperOrderId,
      correlationId,
      mint: req.mint,
      symbol: req.symbol,
      side: 'BUY',
      amountLamports: Math.round(req.amountSol * 1e9),
      expectedTokensRaw: tokenQtyRaw,
      slippageBps: req.slippageBps,
      status: 'RECONCILED',
      executionMode: 'PAPER',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    workstationDb.saveTransaction({
      signature: paperOrderId,
      orderId: paperOrderId,
      correlationId,
      mint: req.mint,
      direction: 'BUY',
      submissionTransport: 'PAPER',
      submissionTime: Date.now(),
      reconciliationState: 'RECONCILED',
      networkFeeLamports,
      jitoTipLamports,
      executionMode: 'PAPER',
    });

    workstationDb.logJournal('PAPER_BUY_FILLED', paperOrderId, 'PAPER', {
      mint: req.mint,
      amountSol: req.amountSol,
      fillPriceSol,
      tokensReceived,
      impactBps,
      simulatedLatencyMs,
    });

    Logger.info(`Paper Buy Executed [${paperOrderId}] for ${req.symbol}: ${req.amountSol} SOL @ ${fillPriceSol.toFixed(8)} SOL`);

    return {
      success: true,
      position,
      paperOrderId,
      fillPriceSol,
      tokensReceived,
      networkFeeLamports,
      jitoTipLamports,
      simulatedLatencyMs,
      effectiveSlippageBps: impactBps,
    };
  }

  // Execute a simulated sell supporting partial closes (1-100%)
  public executePaperSell(
    positionId: string,
    currentMarketPriceSol: number,
    sellPct = 100,
    reason = 'Manual Paper Sell'
  ): { success: boolean; realizedPnLSol: number; position?: NormalizedPosition; error?: string } {
    const positions = workstationDb.loadPositions('PAPER');
    const pos = positions.find((p) => p.id === positionId && (p.status === 'OPEN' || p.status === 'PARTIALLY_CLOSED'));

    if (!pos) {
      return { success: false, realizedPnLSol: 0, error: 'Open paper position not found' };
    }

    if (currentMarketPriceSol <= 0) {
      return { success: false, realizedPnLSol: 0, error: 'Cannot execute sell with non-positive market price' };
    }

    const safeSellPct = Math.min(100, Math.max(1, sellPct));
    const fraction = safeSellPct / 100;

    const totalRawBigInt = BigInt(pos.tokenQuantityRaw);
    const tokensSoldRaw = (totalRawBigInt * BigInt(safeSellPct)) / 100n;
    const remainingRawBigInt = totalRawBigInt - tokensSoldRaw;

    const tokensSoldHuman = Number(tokensSoldRaw) / Math.pow(10, pos.tokenDecimals);

    // Modeled flat 0.5% sell-side price concession (not derived from pool depth)
    const exitPriceSol = currentMarketPriceSol * 0.995;
    const grossProceedsSol = tokensSoldHuman * exitPriceSol;

    const costPortionLamports = Math.round(pos.costBasisLamports * fraction);
    const costPortionSol = costPortionLamports / 1e9;

    // All-in fees on exit: 1% Pump.fun protocol fee + network base/priority fee + Jito bundle tip
    const protocolFeeSol = grossProceedsSol * 0.01;
    const exitNetworkFeeSol = 0.000015; // 5000 base + 10000 priority
    const exitJitoTipSol = (pos.jitoTipLamports || 2000000) / 1e9;
    const totalExitFrictionSol = protocolFeeSol + exitNetworkFeeSol + exitJitoTipSol;
    const netProceedsSol = Math.max(0, grossProceedsSol - totalExitFrictionSol);
    const netRealizedPnLSol = netProceedsSol - costPortionSol;

    pos.realizedPnLSol += Number(netRealizedPnLSol.toFixed(6));

    if (safeSellPct >= 100 || remainingRawBigInt <= 0n) {
      pos.status = 'CLOSED';
      pos.tokenQuantityRaw = '0';
      pos.costBasisLamports = 0;
    } else {
      pos.status = 'PARTIALLY_CLOSED';
      pos.tokenQuantityRaw = remainingRawBigInt.toString();
      pos.costBasisLamports = pos.costBasisLamports - costPortionLamports;
    }

    pos.exitReason = reason;
    const exitTxSignature = `PAPER-EXIT-${Date.now()}`;
    pos.exitTxSignature = exitTxSignature;
    pos.lastUpdatedTimestamp = Date.now();

    workstationDb.savePosition(pos);

    const correlationId = `corr-${exitTxSignature}`;
    workstationDb.saveOrder({
      id: exitTxSignature,
      clientOrderId: exitTxSignature,
      correlationId,
      mint: pos.mint,
      symbol: pos.symbol,
      side: 'SELL',
      amountLamports: Math.round(grossProceedsSol * 1e9),
      expectedTokensRaw: tokensSoldRaw.toString(),
      slippageBps: 100,
      status: 'RECONCILED',
      executionMode: 'PAPER',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    workstationDb.saveTransaction({
      signature: exitTxSignature,
      orderId: exitTxSignature,
      correlationId,
      mint: pos.mint,
      direction: 'SELL',
      submissionTransport: 'PAPER',
      submissionTime: Date.now(),
      reconciliationState: 'RECONCILED',
      networkFeeLamports: 5000,
      jitoTipLamports: 0,
      executionMode: 'PAPER',
    });

    workstationDb.logJournal('PAPER_SELL_FILLED', pos.id, 'PAPER', {
      positionId,
      sellPct: safeSellPct,
      tokensSold: tokensSoldHuman,
      remainingTokensRaw: pos.tokenQuantityRaw,
      grossProceedsSol,
      netRealizedPnLSol,
      status: pos.status,
      reason,
      exitPriceSol,
    });

    Logger.info(`Paper Sell Executed [${pos.id}]: Sold ${safeSellPct}% (${tokensSoldHuman.toFixed(2)} tokens), Net PnL = ${netRealizedPnLSol >= 0 ? '+' : ''}${netRealizedPnLSol.toFixed(5)} SOL, Status: ${pos.status}`);

    return {
      success: true,
      realizedPnLSol: netRealizedPnLSol,
      position: pos,
    };
  }
}

export const paperEngine = new PaperExecutionEngine();
