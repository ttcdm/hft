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
  /**
   * Q7: a buy quote from the real bonding-curve state (PumpCurveService.calculateBuyQuote, mode PAPER). With it the fill is the curve's
   * own: tokens out and fees from the curve maths, price impact from the reserves. Without it the fill is a MODEL (caller's price, a flat
   * impact and a flat 1% fee) and says so.
   */
  curveQuote?: CurveBuyQuote;
}

export interface CurveBuyQuote {
  tokenAmountRaw: string;
  /** SOL per token actually paid, fees included. */
  executionPriceSol: number;
  /** Curve spot price before the order. */
  spotPriceSol: number;
  protocolFeeLamports: number;
  creatorFeeLamports: number;
  estimatedPriceImpactBps: number;
}

export interface CurveSellQuote {
  /** SOL received after the protocol and creator fees. */
  netSolOutLamports: number;
  executionPriceSol: number;
  spotPriceSol: number;
}

export type PaperPricing = 'CURVE_QUOTE' | 'MODEL';

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
  /** Q7: whether the fill came from the real curve or from the flat model. */
  pricing?: PaperPricing;
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

    const q = req.curveQuote;
    let impactBps: number;
    let fillPriceSol: number;
    let tokensReceived: number;
    const tokenDecimals = req.tokenDecimals || 6;
    let tokenQtyRaw: string;
    if (q) {
      // Q7: the curve's own numbers. The fee is inside the SOL spent (the curve is entered with amount / (1 + fee)).
      impactBps = q.estimatedPriceImpactBps;
      fillPriceSol = q.executionPriceSol;
      tokenQtyRaw = q.tokenAmountRaw;
      tokensReceived = Number(BigInt(q.tokenAmountRaw)) / Math.pow(10, tokenDecimals);
    } else {
      // MODEL: size against pool liquidity, and the flat 1% protocol fee on the SOL spent
      impactBps = Math.min(req.slippageBps, PaperExecutionEngine.estimateImpactBps(req.amountSol, req.liquidityUsd, req.solPriceUsd));
      fillPriceSol = req.currentPriceSol * (1 + impactBps / 10000);
      tokensReceived = (req.amountSol - req.amountSol * 0.01) / fillPriceSol;
      tokenQtyRaw = BigInt(Math.floor(tokensReceived * Math.pow(10, tokenDecimals))).toString();
    }
    const pricing: PaperPricing = q ? 'CURVE_QUOTE' : 'MODEL';

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
      // Marked at the curve's spot price when quoted (the order's own fees and impact show as the immediate loss they are)
      currentPriceSol: q ? q.spotPriceSol : fillPriceSol,
      currentValueSol: tokensReceived * (q ? q.spotPriceSol : fillPriceSol),
      unrealizedPnLSol: tokensReceived * (q ? q.spotPriceSol : fillPriceSol) - (req.amountSol * 1e9 + networkFeeLamports + jitoTipLamports) / 1e9,
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
      pricing,
      ...(q ? { protocolFeeLamports: q.protocolFeeLamports, creatorFeeLamports: q.creatorFeeLamports } : {}),
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
      pricing,
    };
  }

  // Execute a simulated sell supporting partial closes (1-100%)
  public executePaperSell(
    positionId: string,
    currentMarketPriceSol: number,
    sellPct = 100,
    reason = 'Manual Paper Sell',
    /** Q7: the curve's sell quote for the tokens being sold (net of its fees); without it the sell is the flat model below. */
    curveQuote?: CurveSellQuote
  ): { success: boolean; realizedPnLSol: number; position?: NormalizedPosition; error?: string; pricing?: PaperPricing } {
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

    const costPortionLamports = Math.round(pos.costBasisLamports * fraction);
    const costPortionSol = costPortionLamports / 1e9;
    const exitNetworkFeeSol = 0.000015; // 5000 base + 10000 priority
    const exitJitoTipSol = (pos.jitoTipLamports || 2000000) / 1e9;
    let grossProceedsSol: number;
    let netProceedsSol: number;
    if (curveQuote) {
      // Q7: the curve's net SOL out already has the protocol and creator fees taken; what is left to charge is the network fee and tip
      grossProceedsSol = curveQuote.netSolOutLamports / 1e9;
      netProceedsSol = Math.max(0, grossProceedsSol - exitNetworkFeeSol - exitJitoTipSol);
    } else {
      // MODEL: a flat 0.5% price concession (not derived from pool depth) and the 1% protocol fee
      const exitPriceSol = currentMarketPriceSol * 0.995;
      grossProceedsSol = tokensSoldHuman * exitPriceSol;
      const protocolFeeSol = grossProceedsSol * 0.01;
      netProceedsSol = Math.max(0, grossProceedsSol - (protocolFeeSol + exitNetworkFeeSol + exitJitoTipSol));
    }
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
      exitPriceSol: tokensSoldHuman > 0 ? grossProceedsSol / tokensSoldHuman : currentMarketPriceSol,
      pricing: curveQuote ? 'CURVE_QUOTE' : 'MODEL',
    });

    Logger.info(`Paper Sell Executed [${pos.id}]: Sold ${safeSellPct}% (${tokensSoldHuman.toFixed(2)} tokens), Net PnL = ${netRealizedPnLSol >= 0 ? '+' : ''}${netRealizedPnLSol.toFixed(5)} SOL, Status: ${pos.status}`);

    return {
      success: true,
      realizedPnLSol: netRealizedPnLSol,
      position: pos,
      pricing: curveQuote ? 'CURVE_QUOTE' : 'MODEL',
    };
  }
}

export const paperEngine = new PaperExecutionEngine();
