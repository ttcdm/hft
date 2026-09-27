import WebSocket from 'ws';
import {
  EngineStatus,
  EngineOrder,
  EngineTrade,
  EngineTelemetry,
  AvellanedaStoikovConfig,
} from './types';
import { EngineWAL } from './wal';
import { PreTradeRiskEngine } from './risk';

export class HftExecutionEngine {
  private status: EngineStatus = 'STOPPED';
  private symbol: string = 'BTCUSDT';
  private wal: EngineWAL;
  private risk: PreTradeRiskEngine;

  // Real-time market state
  private midPrice: number = 68940.0;
  private microPrice: number = 68940.0;
  private spreadBps: number = 0.5;
  private ofi: number = 0.0;
  private bestBid: number = 68939.5;
  private bestAsk: number = 68940.5;

  // Active resting quotes posted by the engine
  private activeBuyQuote: EngineOrder | null = null;
  private activeSellQuote: EngineOrder | null = null;

  // Portfolio & Inventory
  private inventoryQty: number = 0.0;
  private avgCostPrice: number = 0.0;
  private realizedPnlUsd: number = 0.0;
  private totalFillsCount: number = 0;
  private totalOrdersCount: number = 0;
  private startTimeMs: number = Date.now();

  // Tick-to-trade latency measurement ring buffer (in microseconds)
  private tickToTradeSamples: number[] = [];
  private readonly maxLatencySamples: number = 200;
  private recentOrderTimestamps: number[] = [];
  private eventLoopLagMs: number = 0.05;

  // Avellaneda-Stoikov parameters
  private config: AvellanedaStoikovConfig = {
    symbol: 'BTCUSDT',
    gamma: 0.1, // Risk aversion
    sigma: 0.02, // Volatility estimate
    kappa: 1.5, // Order book liquidity intensity
    timeHorizon: 1.0,
    targetSpreadBps: 2.0,
    baseQuoteSize: 0.05,
    inventoryLimitQty: 5.0,
    minTickIncrement: 0.1,
  };

  // Live Exchange WebSocket connections from backend
  private depthWs: WebSocket | null = null;
  private tradeWs: WebSocket | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private quoteInterval: NodeJS.Timeout | null = null;
  private isDestroyed: boolean = false;

  // Listeners for real-time telemetry streaming
  private telemetryListeners: Set<(t: EngineTelemetry) => void> = new Set();
  private tradeListeners: Set<(t: EngineTrade) => void> = new Set();

  constructor() {
    this.wal = new EngineWAL();
    this.risk = new PreTradeRiskEngine();

    // Start background quote generation & matching daemon
    this.startEngine();
  }

  public getWAL(): EngineWAL {
    return this.wal;
  }

  public getRiskEngine(): PreTradeRiskEngine {
    return this.risk;
  }

  public startEngine() {
    if (this.status === 'RUNNING') return;
    this.status = 'RUNNING';
    this.startTimeMs = Date.now();
    this.wal.record('ENGINE_START', { symbol: this.symbol, config: this.config });

    this.connectExchangeStreams();

    // Main Quoting Evaluation Loop (runs every 100ms)
    if (!this.quoteInterval) {
      this.quoteInterval = setInterval(() => {
        if (this.status === 'RUNNING') {
          this.evaluateAndRequote();
        }
      }, 100);
    }

    this.broadcastTelemetry();
  }

  public stopEngine() {
    this.status = 'STOPPED';
    this.wal.record('ENGINE_STOP', { symbol: this.symbol, inventory: this.inventoryQty });
    this.cancelAllQuotes('ENGINE_STOPPED');
    this.broadcastTelemetry();
  }

  public killSwitch() {
    this.status = 'HALTED_KILL_SWITCH';
    this.cancelAllQuotes('KILL_SWITCH_TRIPPED');
    this.wal.record('KILL_SWITCH_TRIP', {
      symbol: this.symbol,
      inventoryQty: this.inventoryQty,
      realizedPnlUsd: this.realizedPnlUsd,
    });
    this.broadcastTelemetry();
  }

  public resetState() {
    this.inventoryQty = 0.0;
    this.avgCostPrice = 0.0;
    this.realizedPnlUsd = 0.0;
    this.totalFillsCount = 0;
    this.totalOrdersCount = 0;
    this.tickToTradeSamples = [];
    this.risk.resetCircuitBreaker();
    this.risk.updateInventory(0);
    this.cancelAllQuotes('RESET');
    this.broadcastTelemetry();
  }

  public setSymbol(newSymbol: string) {
    const sym = newSymbol.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    if (this.symbol === sym) return;

    this.symbol = sym;
    this.config.symbol = sym;
    this.cancelAllQuotes('SYMBOL_CHANGED');
    this.disconnectExchangeStreams();
    this.connectExchangeStreams();
    this.broadcastTelemetry();
  }

  public updateConfig(newConfig: Partial<AvellanedaStoikovConfig>) {
    this.config = { ...this.config, ...newConfig };
    this.broadcastTelemetry();
  }

  // --- EXCHANGE STREAM INTEGRATION ---
  private connectExchangeStreams() {
    // Isolate Avellaneda-Stoikov Binance futures behind ENABLE_BINANCE_FUTURES === 'true' (default false) (B17)
    if (process.env.ENABLE_BINANCE_FUTURES !== 'true') {
      return;
    }

    const pair = this.symbol.toLowerCase();

    try {
      // 1. Binance Level 2 Order Depth Stream (Top 20 bids and asks at 100ms)
      const depthUrl = `wss://stream.binance.com:9443/ws/${pair}@depth20@100ms`;
      this.depthWs = new WebSocket(depthUrl);

      this.depthWs.on('message', (data: WebSocket.Data) => {
        if (this.isDestroyed || this.status !== 'RUNNING') return;
        try {
          const parsed = JSON.parse(data.toString());
          this.handleDepthUpdate(parsed);
        } catch {
          // ignore
        }
      });

      this.depthWs.on('error', () => {
        this.scheduleReconnect();
      });

      // 2. Binance Aggregated Public Trade Stream
      const tradeUrl = `wss://stream.binance.com:9443/ws/${pair}@aggTrade`;
      this.tradeWs = new WebSocket(tradeUrl);

      this.tradeWs.on('message', (data: WebSocket.Data) => {
        if (this.isDestroyed || this.status !== 'RUNNING') return;
        try {
          const parsed = JSON.parse(data.toString());
          this.handlePublicTrade(parsed);
        } catch {
          // ignore
        }
      });

      this.tradeWs.on('error', () => {
        this.scheduleReconnect();
      });
    } catch {
      this.scheduleReconnect();
    }
  }

  private disconnectExchangeStreams() {
    if (this.depthWs) {
      try {
        this.depthWs.terminate();
      } catch {}
      this.depthWs = null;
    }
    if (this.tradeWs) {
      try {
        this.tradeWs.terminate();
      } catch {}
      this.tradeWs = null;
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private scheduleReconnect() {
    if (process.env.ENABLE_BINANCE_FUTURES !== 'true') return;
    if (this.reconnectTimeout || this.isDestroyed) return;
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      if (this.status === 'RUNNING') {
        this.connectExchangeStreams();
      }
    }, 3000);
  }

  // --- MARKET DEPTH & AVELLANEDA-STOIKOV CALCULATIONS ---
  private handleDepthUpdate(data: any) {
    if (!data.bids || !data.asks || data.bids.length === 0 || data.asks.length === 0) return;

    const b0Price = parseFloat(data.bids[0][0]);
    const b0Qty = parseFloat(data.bids[0][1]);
    const a0Price = parseFloat(data.asks[0][0]);
    const a0Qty = parseFloat(data.asks[0][1]);

    this.bestBid = b0Price;
    this.bestAsk = a0Price;
    this.midPrice = Number(((b0Price + a0Price) / 2).toFixed(2));
    this.spreadBps = Number((((a0Price - b0Price) / this.midPrice) * 10000).toFixed(2));

    // Calculate Micro-Price (Volume-Weighted Mid)
    const totalTopQty = b0Qty + a0Qty;
    if (totalTopQty > 0) {
      this.microPrice = Number(((b0Qty * a0Price + a0Qty * b0Price) / totalTopQty).toFixed(2));
      this.ofi = Number(((b0Qty - a0Qty) / totalTopQty).toFixed(3));
    }
  }

  // Evaluate Avellaneda-Stoikov Reservation Price & Requote
  private evaluateAndRequote() {
    if (this.status !== 'RUNNING' || this.midPrice <= 0) return;

    const startHr = process.hrtime.bigint();

    // 1. Avellaneda-Stoikov Reservation Price:
    // r(s, q, t) = s - q * gamma * sigma^2 * (T - t)
    const q = this.inventoryQty;
    const gamma = this.config.gamma;
    const sigma = this.config.sigma;
    const timeHorizon = this.config.timeHorizon;

    const inventoryPenalty = q * gamma * Math.pow(sigma, 2) * timeHorizon;
    // Bias mid-price with micro-price OFI skew
    const ofiSkew = (this.microPrice - this.midPrice) * 0.5;
    const reservationPrice = this.midPrice - inventoryPenalty + ofiSkew;

    // 2. Optimal Half-Spread:
    // delta_a + delta_b = gamma * sigma^2 * T + (2 / gamma) * ln(1 + gamma / kappa)
    const kappa = Math.max(0.1, this.config.kappa);
    const halfSpread =
      (gamma * Math.pow(sigma, 2) * timeHorizon + (2 / gamma) * Math.log(1 + gamma / kappa)) *
      this.midPrice *
      0.0005;

    const minHalfSpread = (this.config.targetSpreadBps / 20000) * this.midPrice;
    const effectiveHalfSpread = Math.max(minHalfSpread, halfSpread);

    // Compute Proposed Limit Bids & Asks
    const rawBid = reservationPrice - effectiveHalfSpread;
    const rawAsk = reservationPrice + effectiveHalfSpread;

    const bidPrice = Number((Math.floor(rawBid / this.config.minTickIncrement) * this.config.minTickIncrement).toFixed(2));
    const askPrice = Number((Math.ceil(rawAsk / this.config.minTickIncrement) * this.config.minTickIncrement).toFixed(2));

    // Dynamic quote size scaled by inventory distance from limit
    const invHeadroomBuy = Math.max(0, this.config.inventoryLimitQty - q);
    const invHeadroomSell = Math.max(0, this.config.inventoryLimitQty + q);

    const buySize = Number(Math.min(this.config.baseQuoteSize, invHeadroomBuy).toFixed(3));
    const sellSize = Number(Math.min(this.config.baseQuoteSize, invHeadroomSell).toFixed(3));

    // 3. Pre-Trade Risk Verification
    this.risk.updateInventory(this.inventoryQty);

    // Validate Buy Quote
    if (buySize > 0.001) {
      const riskBuy = this.risk.validateOrder(
        { symbol: this.symbol, side: 'BUY', price: bidPrice, quantity: buySize },
        this.midPrice
      );

      if (riskBuy.passed) {
        if (!this.activeBuyQuote || Math.abs(this.activeBuyQuote.price - bidPrice) > 0.1) {
          this.activeBuyQuote = this.createOrder('BUY', bidPrice, buySize);
          this.wal.record('ORDER_SUBMIT', { order: this.activeBuyQuote });
          this.totalOrdersCount++;
          this.recentOrderTimestamps.push(Date.now());
          if (this.recentOrderTimestamps.length > 200) this.recentOrderTimestamps.shift();
        }
      } else {
        this.wal.record('RISK_VIOLATION', { side: 'BUY', reason: riskBuy.reason });
      }
    } else {
      this.activeBuyQuote = null;
    }

    // Validate Sell Quote
    if (sellSize > 0.001) {
      const riskSell = this.risk.validateOrder(
        { symbol: this.symbol, side: 'SELL', price: askPrice, quantity: sellSize },
        this.midPrice,
        this.activeBuyQuote ? [this.activeBuyQuote] : []
      );

      if (riskSell.passed) {
        if (!this.activeSellQuote || Math.abs(this.activeSellQuote.price - askPrice) > 0.1) {
          this.activeSellQuote = this.createOrder('SELL', askPrice, sellSize);
          this.wal.record('ORDER_SUBMIT', { order: this.activeSellQuote });
          this.totalOrdersCount++;
          this.recentOrderTimestamps.push(Date.now());
          if (this.recentOrderTimestamps.length > 200) this.recentOrderTimestamps.shift();
        }
      } else {
        this.wal.record('RISK_VIOLATION', { side: 'SELL', reason: riskSell.reason });
      }
    } else {
      this.activeSellQuote = null;
    }

    // Measure tick-to-trade internal processing latency
    const endHr = process.hrtime.bigint();
    const micros = Number((endHr - startHr) / 1000n);
    if (micros > 0) {
      this.recordLatencySample(micros);
    }

    this.broadcastTelemetry();
  }

  // --- MATCHING ENGINE LOGIC (Crossed with real public exchange trades) ---
  private handlePublicTrade(t: any) {
    if (this.status !== 'RUNNING') return;

    const startHr = process.hrtime.bigint();
    const tradePrice = parseFloat(t.p);
    const tradeQty = parseFloat(t.q);
    const isBuyerMaker = t.m; // true = seller taker hit bid, false = buyer taker lifted ask

    // Case 1: Real market seller aggressive -> hits bids. Check if our active buy quote gets filled!
    if (this.activeBuyQuote && tradePrice <= this.activeBuyQuote.price) {
      this.executeFill(this.activeBuyQuote, tradePrice, Math.min(this.activeBuyQuote.quantity, tradeQty), true);
    }

    // Case 2: Real market buyer aggressive -> lifts asks. Check if our active sell quote gets filled!
    if (this.activeSellQuote && tradePrice >= this.activeSellQuote.price) {
      this.executeFill(this.activeSellQuote, tradePrice, Math.min(this.activeSellQuote.quantity, tradeQty), false);
    }

    const endHr = process.hrtime.bigint();
    const micros = Number((endHr - startHr) / 1000n);
    if (micros > 0) {
      this.recordLatencySample(micros);
    }
  }

  private executeFill(order: EngineOrder, fillPrice: number, fillQty: number, isBuy: boolean) {
    const notional = fillPrice * fillQty;
    const fee = notional * 0.0002; // 2 bps maker rebate/fee

    let tradeRealizedPnl = 0.0;
    if (isBuy) {
      // Increasing long or closing short
      if (this.inventoryQty < 0) {
        // closing short: realized = (entry - exit) * qty
        tradeRealizedPnl = (this.avgCostPrice - fillPrice) * Math.min(Math.abs(this.inventoryQty), fillQty);
      }
      this.inventoryQty += fillQty;
      this.avgCostPrice =
        this.inventoryQty > 0
          ? (this.avgCostPrice * (this.inventoryQty - fillQty) + fillPrice * fillQty) / this.inventoryQty
          : fillPrice;
    } else {
      // Increasing short or closing long
      if (this.inventoryQty > 0) {
        // closing long: realized = (exit - entry) * qty
        tradeRealizedPnl = (fillPrice - this.avgCostPrice) * Math.min(this.inventoryQty, fillQty);
      }
      this.inventoryQty -= fillQty;
      this.avgCostPrice =
        this.inventoryQty < 0
          ? (this.avgCostPrice * (Math.abs(this.inventoryQty) - fillQty) + fillPrice * fillQty) / Math.abs(this.inventoryQty)
          : fillPrice;
    }

    this.realizedPnlUsd += tradeRealizedPnl - fee;
    this.totalFillsCount++;
    this.risk.recordPnl(tradeRealizedPnl - fee);

    const nowHr = process.hrtime.bigint();
    const trade: EngineTrade = {
      tradeId: `TRD-${Date.now()}-${Math.floor(Math.random() * 900 + 100)}`,
      seqId: this.wal.getCurrentSeq() + 1,
      orderId: order.orderId,
      symbol: this.symbol,
      side: order.side,
      price: fillPrice,
      quantity: fillQty,
      notionalUsd: Number(notional.toFixed(2)),
      feeUsd: Number(fee.toFixed(4)),
      realizedPnl: Number(tradeRealizedPnl.toFixed(2)),
      maker: true,
      matchTimestampNs: nowHr.toString(),
      matchTimeIso: new Date().toISOString(),
      tickToTradeMicros: this.getMedianLatency(),
    };

    // Log Fill Event into Write-Ahead Log
    this.wal.record('ORDER_FILL', { trade, newInventory: this.inventoryQty });

    // Reset filled quote so engine requotes on next cycle
    if (isBuy) {
      this.activeBuyQuote = null;
    } else {
      this.activeSellQuote = null;
    }

    // Broadcast to listeners
    this.tradeListeners.forEach((l) => l(trade));
    this.broadcastTelemetry();
  }

  private createOrder(side: 'BUY' | 'SELL', price: number, quantity: number): EngineOrder {
    const nowHr = process.hrtime.bigint();
    return {
      orderId: `AQE-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 900 + 100)}`,
      clientOrderId: `CL-${side[0]}-${Date.now()}`,
      seqId: this.wal.getCurrentSeq() + 1,
      symbol: this.symbol,
      side,
      type: 'LIMIT',
      price,
      quantity,
      filledQty: 0,
      avgFillPrice: 0,
      state: 'ACTIVE',
      submitTimeNs: nowHr.toString(),
      submitTimeIso: new Date().toISOString(),
      lastUpdateTimeNs: nowHr.toString(),
      botName: 'Avellaneda-Stoikov Core Daemon',
    };
  }

  private cancelAllQuotes(reason: string) {
    if (this.activeBuyQuote) {
      this.wal.record('ORDER_CANCEL', { orderId: this.activeBuyQuote.orderId, reason });
      this.activeBuyQuote = null;
    }
    if (this.activeSellQuote) {
      this.wal.record('ORDER_CANCEL', { orderId: this.activeSellQuote.orderId, reason });
      this.activeSellQuote = null;
    }
  }

  private recordLatencySample(micros: number) {
    this.tickToTradeSamples.push(micros);
    if (this.tickToTradeSamples.length > this.maxLatencySamples) {
      this.tickToTradeSamples.shift();
    }
  }

  private getMedianLatency(): number {
    if (this.tickToTradeSamples.length === 0) return 0;
    const sorted = [...this.tickToTradeSamples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  // --- TELEMETRY BROADCAST ---
  public getTelemetry(): EngineTelemetry {
    const mem = process.memoryUsage();
    const sortedLatency = [...this.tickToTradeSamples].sort((a, b) => a - b);
    const count = sortedLatency.length;

    const minMicros = count > 0 ? sortedLatency[0] : 0;
    const medianMicros = count > 0 ? sortedLatency[Math.floor(count * 0.5)] : 0;
    const p99Micros = count > 0 ? sortedLatency[Math.floor(count * 0.99)] : 0;
    const maxMicros = count > 0 ? sortedLatency[count - 1] : 0;

    // Unrealized PnL: (midPrice - avgCost) * inventory
    const unrealized =
      this.inventoryQty !== 0 ? (this.midPrice - this.avgCostPrice) * this.inventoryQty : 0.0;

    const q = this.inventoryQty;
    const reservationPrice =
      this.midPrice - q * this.config.gamma * Math.pow(this.config.sigma, 2) * this.config.timeHorizon;

    return {
      status: this.status,
      symbol: this.symbol,
      seqId: this.wal.getCurrentSeq(),
      uptimeSeconds: Math.floor((Date.now() - this.startTimeMs) / 1000),
      inventoryQty: Number(this.inventoryQty.toFixed(4)),
      inventoryUsd: Number((this.inventoryQty * this.midPrice).toFixed(2)),
      reservationPrice: Number(reservationPrice.toFixed(2)),
      midPrice: this.midPrice,
      microPrice: this.microPrice,
      spreadBps: this.spreadBps,
      ofi: this.ofi,
      activeBuyQuote: this.activeBuyQuote
        ? { price: this.activeBuyQuote.price, size: this.activeBuyQuote.quantity }
        : null,
      activeSellQuote: this.activeSellQuote
        ? { price: this.activeSellQuote.price, size: this.activeSellQuote.quantity }
        : null,
      realizedPnlUsd: Number(this.realizedPnlUsd.toFixed(2)),
      unrealizedPnlUsd: Number(unrealized.toFixed(2)),
      totalPnlUsd: Number((this.realizedPnlUsd + unrealized).toFixed(2)),
      totalFillsCount: this.totalFillsCount,
      totalOrdersCount: this.totalOrdersCount,
      rejectionsCount: this.risk.getRejectionsCount(),
      ordersPerSec: this.recentOrderTimestamps.filter((t) => Date.now() - t <= 1000).length,
      tickToTradeStats: {
        minMicros,
        medianMicros,
        p99Micros,
        maxMicros,
        samplesCount: count,
      },
      walTotalEntries: this.wal.getCurrentSeq(),
      memoryUsageMb: Number((mem.heapUsed / 1024 / 1024).toFixed(2)),
      gcPauseEstimateMs: this.eventLoopLagMs,
      environment: 'SIMULATED_ORDERBOOK',
      isSimulatedEngine: true,
    };
  }

  public onTelemetry(listener: (t: EngineTelemetry) => void) {
    this.telemetryListeners.add(listener);
    return () => this.telemetryListeners.delete(listener);
  }

  public onTrade(listener: (t: EngineTrade) => void) {
    this.tradeListeners.add(listener);
    return () => this.tradeListeners.delete(listener);
  }

  private broadcastTelemetry() {
    const tel = this.getTelemetry();
    this.telemetryListeners.forEach((l) => l(tel));
  }

  public destroy() {
    this.isDestroyed = true;
    this.stopEngine();
    this.disconnectExchangeStreams();
    if (this.quoteInterval) {
      clearInterval(this.quoteInterval);
      this.quoteInterval = null;
    }
  }
}

// Global Singleton for the Express & WebSocket Server
export const hftEngine = new HftExecutionEngine();
export { HftExecutionEngine as AvellanedaStoikovEngine };
