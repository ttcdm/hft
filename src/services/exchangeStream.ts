import { OrderBook, OrderBookEntry, PublicMarketTrade } from '../types';
import { calculateOFI, calculateMicroPrice, formatMicrosecondTimestamp } from '../utils/math';

export type DepthCallback = (orderBook: OrderBook) => void;
export type TradeCallback = (trade: PublicMarketTrade) => void;
export type LatencyCallback = (pingMs: number) => void;
export type StatusCallback = (status: ExchangeStreamStatus, exchange: SupportedExchange, details?: string) => void;

export type ExchangeStreamStatus =
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'DISCONNECTED'
  | 'DEGRADED';

export type SupportedExchange = 'BINANCE' | 'COINBASE' | 'BYBIT' | 'INTERNAL_ENGINE';

export interface ExchangeStreamStats {
  status: ExchangeStreamStatus;
  exchange: SupportedExchange;
  symbol: string;
  latencyMs: number;
  messagesCount: number;
  tradesCount: number;
  depthUpdatesCount: number;
  reconnectAttempts: number;
  uptimeSeconds: number;
  lastMessageTime: number;
}

/**
 * Dedicated Institutional WebSocket Manager for Real-Time Crypto Exchange Streams.
 * Establishes persistent, low-latency WSS connections to major exchange feeds (Binance, Coinbase, Bybit),
 * with automatic failover, heartbeat keep-alive, and sub-millisecond market depth & trade normalization.
 */
class ExchangeWebSocketManager {
  private activeWs: WebSocket | null = null;
  private currentSymbol: string = 'BTC/USDT';
  private currentExchange: SupportedExchange = 'BINANCE';
  private status: ExchangeStreamStatus = 'DISCONNECTED';

  // Callbacks
  private depthListeners: Set<DepthCallback> = new Set();
  private tradeListeners: Set<TradeCallback> = new Set();
  private latencyListeners: Set<LatencyCallback> = new Set();
  private statusListeners: Set<StatusCallback> = new Set();

  // Connection Lifecycle & Resilience
  private isDestroyed: boolean = false;
  private reconnectTimer: any = null;
  private heartbeatTimer: any = null;
  private latencyTimer: any = null;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private lastMessageTimestamp: number = 0;
  private connectStartTime: number = 0;
  private currentPingMs: number = 0.85;

  // Stream Metrics
  private messagesCount: number = 0;
  private tradesCount: number = 0;
  private depthUpdatesCount: number = 0;

  // Throttling to prevent client memory leaks & DOM reconciliation crashes
  private lastDepthBroadcastTime: number = 0;
  private pendingDepth: OrderBook | null = null;
  private depthThrottleTimer: any = null;

  private lastTradeBroadcastTime: number = 0;
  private pendingTrade: PublicMarketTrade | null = null;
  private tradeThrottleTimer: any = null;

  // Last known state for instant emission to new subscribers
  private lastKnownOrderBook: OrderBook | null = null;

  constructor() {
    // Automatically start latency probing routine
    this.startLatencyProbing();
  }

  /**
   * Connect to the exchange stream with the specified symbol.
   * Returns an unsubscribe cleanup function that removes only the listeners registered in this call.
   */
  public connect(
    symbol: string = 'BTC/USDT',
    onDepth?: DepthCallback,
    onTrade?: TradeCallback,
    onLatency?: LatencyCallback,
    onStatus?: StatusCallback
  ): () => void {
    this.currentSymbol = symbol;
    if (onDepth) this.depthListeners.add(onDepth);
    if (onTrade) this.tradeListeners.add(onTrade);
    if (onLatency) this.latencyListeners.add(onLatency);
    if (onStatus) this.statusListeners.add(onStatus);

    this.isDestroyed = false;
    this.initiateWebSocket();

    // Return explicit unsubscribe function for React useEffect unmount / cleanup
    return () => {
      if (onDepth) this.depthListeners.delete(onDepth);
      if (onTrade) this.tradeListeners.delete(onTrade);
      if (onLatency) this.latencyListeners.delete(onLatency);
      if (onStatus) this.statusListeners.delete(onStatus);
    };
  }

  /**
   * Switch the active traded symbol (e.g., BTC/USDT -> ETH/USDT).
   */
  public setSymbol(symbol: string) {
    if (this.currentSymbol === symbol && this.status === 'CONNECTED') return;
    this.currentSymbol = symbol;

    if (this.activeWs && this.activeWs.readyState === WebSocket.OPEN && this.currentExchange === 'BINANCE') {
      // Re-establish on new symbol stream
      this.closeSocket();
      this.initiateWebSocket();
    } else {
      this.initiateWebSocket();
    }
  }

  /**
   * Switch primary exchange feed (BINANCE, COINBASE, BYBIT, INTERNAL_ENGINE).
   */
  public setExchange(exchange: SupportedExchange) {
    if (this.currentExchange === exchange && this.status === 'CONNECTED') return;
    this.currentExchange = exchange;
    this.reconnectAttempts = 0;
    this.closeSocket();
    this.initiateWebSocket();
  }

  /**
   * Core WebSocket connection initiator with multi-exchange endpoint resolution.
   */
  private initiateWebSocket() {
    if (this.isDestroyed) return;

    this.clearTimers();
    this.setStatus('CONNECTING');
    this.connectStartTime = Date.now();

    const pair = this.getFormattedPair(this.currentSymbol);
    const wsUrl = this.resolveEndpointUrl(pair);

    try {
      this.activeWs = new WebSocket(wsUrl);

      this.activeWs.onopen = () => {
        if (this.isDestroyed) return;
        this.setStatus('CONNECTED');
        this.reconnectAttempts = 0;
        this.lastMessageTimestamp = Date.now();

        // Perform initial exchange protocol handshake if needed
        this.sendExchangeSubscriptions(pair);

        // Start heartbeat watchdog to detect half-open sockets
        this.startHeartbeatWatchdog();
      };

      this.activeWs.onmessage = (event: MessageEvent) => {
        if (this.isDestroyed) return;
        this.lastMessageTimestamp = Date.now();
        this.messagesCount++;

        try {
          const data = typeof event.data === 'string' ? JSON.parse(event.data) : null;
          if (!data) return;

          this.routeExchangeMessage(data);
        } catch {
          // Ignore transient JSON parse noise
        }
      };

      this.activeWs.onerror = () => {
        if (this.isDestroyed) return;
        // On error, mark status as degraded and schedule resilient retry/failover
        this.handleConnectionFailure();
      };

      this.activeWs.onclose = (event: CloseEvent) => {
        if (this.isDestroyed) return;
        if (this.status !== 'DISCONNECTED') {
          this.scheduleReconnection();
        }
      };
    } catch {
      this.handleConnectionFailure();
    }
  }

  /**
   * Resolves WebSocket endpoint URL based on current exchange and symbol.
   */
  private resolveEndpointUrl(pair: string): string {
    switch (this.currentExchange) {
      case 'BINANCE': {
        // Use Binance Multiplexed Combined Stream (Top 20 bids/asks at 100ms + aggregated trade stream)
        const depthStream = `${pair}@depth20@100ms`;
        const tradeStream = `${pair}@aggTrade`;
        return `wss://stream.binance.com:9443/stream?streams=${depthStream}/${tradeStream}`;
      }

      case 'COINBASE':
        return 'wss://ws-feed.exchange.coinbase.com';

      case 'BYBIT':
        return 'wss://stream.bybit.com/v5/public/spot';

      case 'INTERNAL_ENGINE':
      default: {
        // Connect to local internal HFT engine WebSocket
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${window.location.host}/ws/engine`;
      }
    }
  }

  /**
   * Send exchange subscription payloads upon WebSocket open.
   */
  private sendExchangeSubscriptions(pair: string) {
    if (!this.activeWs || this.activeWs.readyState !== WebSocket.OPEN) return;

    if (this.currentExchange === 'COINBASE') {
      const cbProduct = this.currentSymbol.replace('/', '-');
      const subMsg = {
        type: 'subscribe',
        product_ids: [cbProduct],
        channels: ['level2', 'matches', 'heartbeat'],
      };
      this.activeWs.send(JSON.stringify(subMsg));
    } else if (this.currentExchange === 'BYBIT') {
      const bybitSymbol = pair.toUpperCase();
      const subMsg = {
        op: 'subscribe',
        args: [`orderbook.50.${bybitSymbol}`, `publicTrade.${bybitSymbol}`],
      };
      this.activeWs.send(JSON.stringify(subMsg));
    }
  }

  /**
   * Routes and normalizes incoming exchange messages based on protocol.
   */
  private routeExchangeMessage(data: any) {
    // 1. Binance Multiplexed Stream Handling
    if (data.stream) {
      const streamName: string = data.stream;
      if (streamName.includes('@depth')) {
        this.processBinanceDepth(data.data);
      } else if (streamName.includes('@aggTrade')) {
        this.processBinanceTrade(data.data);
      }
      return;
    }

    // 2. Direct Binance Payload Handling (if individual stream)
    if (data.bids && data.asks) {
      this.processBinanceDepth(data);
      return;
    }
    if (data.e === 'aggTrade') {
      this.processBinanceTrade(data);
      return;
    }

    // 3. Coinbase Pro/Advanced WebSocket Handling
    if (data.type === 'snapshot' || data.type === 'l2update') {
      this.processCoinbaseDepth(data);
      return;
    }
    if (data.type === 'match' || data.type === 'last_match') {
      this.processCoinbaseTrade(data);
      return;
    }

    // 4. Bybit V5 Payload Handling
    if (data.topic && data.topic.startsWith('orderbook')) {
      this.processBybitDepth(data);
      return;
    }
    if (data.topic && data.topic.startsWith('publicTrade')) {
      this.processBybitTrade(data);
      return;
    }

    // 5. Internal Engine WebSocket Payload Handling
    if (data.type === 'TELEMETRY' && data.data?.market) {
      this.processInternalTelemetry(data.data);
      return;
    }
    if (data.type === 'TRADE_FILL' && data.data) {
      this.processInternalTrade(data.data);
      return;
    }
  }

  /**
   * Normalizes Binance depth snapshot into high-precision L2 order book.
   */
  private processBinanceDepth(data: any) {
    if (!data.bids || !data.asks) return;

    let cumAsk = 0;
    let cumBid = 0;

    const rawAsks = data.asks.slice(0, 8);
    const rawBids = data.bids.slice(0, 8);

    const asks: OrderBookEntry[] = rawAsks.map((a: [string, string]) => {
      const price = parseFloat(a[0]);
      const size = parseFloat(a[1]);
      cumAsk += size;
      return {
        price,
        size,
        total: Number(cumAsk.toFixed(3)),
        depthPct: Math.min(100, (cumAsk / 15) * 100),
      };
    });

    const bids: OrderBookEntry[] = rawBids.map((b: [string, string]) => {
      const price = parseFloat(b[0]);
      const size = parseFloat(b[1]);
      cumBid += size;
      return {
        price,
        size,
        total: Number(cumBid.toFixed(3)),
        depthPct: Math.min(100, (cumBid / 15) * 100),
      };
    });

    const bestBid = bids[0]?.price || 0;
    const bestAsk = asks[0]?.price || 0;
    const midPrice = bestBid && bestAsk ? Number(((bestBid + bestAsk) / 2).toFixed(2)) : bestBid;
    const spread = bestBid && bestAsk ? Number((bestAsk - bestBid).toFixed(2)) : 0.01;

    const topBidSize = bids[0]?.size || 1;
    const topAskSize = asks[0]?.size || 1;
    const ofi = calculateOFI(topBidSize, topAskSize);
    const microPrice = calculateMicroPrice(bestBid, bestAsk, topBidSize, topAskSize);

    const orderBook: OrderBook = {
      symbol: this.currentSymbol,
      midPrice,
      spread,
      microPrice: Number(microPrice.toFixed(2)),
      imbalanceRatio: Number(ofi.toFixed(3)),
      asks,
      bids,
      lastTradedPrice: midPrice,
      lastTradedSide: ofi >= 0 ? 'BUY' : 'SELL',
    };

    this.depthUpdatesCount++;
    this.lastKnownOrderBook = orderBook;
    this.broadcastDepth(orderBook);
  }

  /**
   * Normalizes Binance aggregated trade into a PublicMarketTrade tick.
   */
  private processBinanceTrade(t: any) {
    const price = parseFloat(t.p);
    const size = parseFloat(t.q);
    const isBuyerMaker = t.m; // true = seller was aggressive (sell trade)

    const trade: PublicMarketTrade = {
      id: t.a || t.f || Date.now(),
      timestamp: t.E || Date.now(),
      timeStr: new Date(t.E || Date.now()).toLocaleTimeString(),
      microsecondTime: formatMicrosecondTimestamp(),
      symbol: this.currentSymbol,
      price,
      size,
      notionalUsd: Number((price * size).toFixed(2)),
      isBuyerMaker,
      side: isBuyerMaker ? 'SELL' : 'BUY',
    };

    this.tradesCount++;
    this.broadcastTrade(trade);
  }

  /**
   * Process Coinbase Pro Level 2 feeds.
   */
  private processCoinbaseDepth(data: any) {
    const rawBids = (data.bids || []).slice(0, 8);
    const rawAsks = (data.asks || []).slice(0, 8);
    if (rawBids.length === 0 && rawAsks.length === 0) return;

    this.processBinanceDepth({ bids: rawBids, asks: rawAsks });
  }

  private processCoinbaseTrade(data: any) {
    const price = parseFloat(data.price);
    const size = parseFloat(data.size);
    const trade: PublicMarketTrade = {
      id: data.match_id || Date.now(),
      timestamp: new Date(data.time).getTime() || Date.now(),
      timeStr: new Date(data.time).toLocaleTimeString(),
      microsecondTime: formatMicrosecondTimestamp(),
      symbol: this.currentSymbol,
      price,
      size,
      notionalUsd: Number((price * size).toFixed(2)),
      isBuyerMaker: data.side === 'sell',
      side: data.side === 'buy' ? 'BUY' : 'SELL',
    };
    this.tradesCount++;
    this.broadcastTrade(trade);
  }

  /**
   * Process Bybit V5 feeds.
   */
  private processBybitDepth(data: any) {
    const bids = data.data?.b || [];
    const asks = data.data?.a || [];
    if (bids.length > 0 || asks.length > 0) {
      this.processBinanceDepth({ bids, asks });
    }
  }

  private processBybitTrade(data: any) {
    const trades = data.data || [];
    for (const t of trades) {
      const price = parseFloat(t.p);
      const size = parseFloat(t.v);
      const isBuyerMaker = t.S === 'Sell';
      const trade: PublicMarketTrade = {
        id: t.i || Date.now(),
        timestamp: t.T || Date.now(),
        timeStr: new Date(t.T || Date.now()).toLocaleTimeString(),
        microsecondTime: formatMicrosecondTimestamp(),
        symbol: this.currentSymbol,
        price,
        size,
        notionalUsd: Number((price * size).toFixed(2)),
        isBuyerMaker,
        side: isBuyerMaker ? 'SELL' : 'BUY',
      };
      this.tradesCount++;
      this.broadcastTrade(trade);
    }
  }

  /**
   * Process Internal Engine Telemetry Fallback.
   */
  private processInternalTelemetry(data: any) {
    const m = data.market;
    if (!m) return;
    const midPrice = m.midPrice || 68940;
    const spread = m.spread || 0.5;
    const bids: OrderBookEntry[] = [
      { price: midPrice - spread / 2, size: 1.25, total: 1.25, depthPct: 45 },
      { price: midPrice - spread - 0.5, size: 2.15, total: 3.4, depthPct: 75 },
    ];
    const asks: OrderBookEntry[] = [
      { price: midPrice + spread / 2, size: 0.95, total: 0.95, depthPct: 35 },
      { price: midPrice + spread + 0.5, size: 1.85, total: 2.8, depthPct: 65 },
    ];
    const orderBook: OrderBook = {
      symbol: this.currentSymbol,
      midPrice,
      spread,
      microPrice: midPrice,
      imbalanceRatio: 0.1,
      asks,
      bids,
      lastTradedPrice: midPrice,
      lastTradedSide: 'BUY',
    };
    this.broadcastDepth(orderBook);
  }

  private processInternalTrade(data: any) {
    const trade: PublicMarketTrade = {
      id: data.id || Date.now(),
      timestamp: data.timestamp || Date.now(),
      timeStr: new Date(data.timestamp || Date.now()).toLocaleTimeString(),
      microsecondTime: formatMicrosecondTimestamp(),
      symbol: this.currentSymbol,
      price: data.price,
      size: data.size,
      notionalUsd: Number((data.price * data.size).toFixed(2)),
      isBuyerMaker: data.side === 'SELL',
      side: data.side || 'BUY',
    };
    this.tradesCount++;
    this.broadcastTrade(trade);
  }

  /**
   * Heartbeat Watchdog: monitors message flow. If the connection goes silent, triggers reconnection.
   */
  private startHeartbeatWatchdog() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.heartbeatTimer = setInterval(() => {
      if (this.isDestroyed || this.status !== 'CONNECTED') return;

      const elapsedMs = Date.now() - this.lastMessageTimestamp;
      if (elapsedMs > 12000) {
        // Socket is stalled/half-open — initiate proactive reconnection
        this.setStatus('RECONNECTING', 'Heartbeat timeout: stream inactive for >12s');
        this.closeSocket();
        this.scheduleReconnection();
      }
    }, 4000);
  }

  /**
   * Latency probing for RTT measurement across exchange gateways.
   */
  private startLatencyProbing() {
    if (this.latencyTimer) clearInterval(this.latencyTimer);

    const probe = async () => {
      if (this.isDestroyed) return;
      const start = performance.now();
      try {
        const res = await fetch('/api/exchange/time');
        if (res.ok) {
          const elapsed = performance.now() - start;
          this.currentPingMs = Number(elapsed.toFixed(2));
          this.broadcastLatency(this.currentPingMs);
        }
      } catch {
        // Non-critical background telemetry probe
      }
    };

    probe();
    this.latencyTimer = setInterval(probe, 3000);
  }

  /**
   * Resilient reconnection with exponential backoff and randomized jitter.
   */
  private scheduleReconnection() {
    if (this.isDestroyed || this.reconnectTimer) return;

    this.reconnectAttempts++;
    this.setStatus('RECONNECTING');

    // If Binance fails repeatedly (e.g. cloud sandbox network restriction), failover to internal engine
    if (this.reconnectAttempts >= 3 && this.currentExchange === 'BINANCE') {
      this.currentExchange = 'INTERNAL_ENGINE';
    }

    // Exponential backoff: 500ms, 1000ms, 2000ms, up to 8000ms + random jitter
    const baseDelay = Math.min(8000, 500 * Math.pow(1.6, this.reconnectAttempts));
    const jitter = Math.random() * 400;
    const delay = Math.round(baseDelay + jitter);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isDestroyed) {
        this.initiateWebSocket();
      }
    }, delay);
  }

  /**
   * Handle immediate connection failure.
   */
  private handleConnectionFailure() {
    this.setStatus('DEGRADED');
    this.closeSocket();
    this.scheduleReconnection();
  }

  /**
   * Update and broadcast stream status.
   */
  private setStatus(newStatus: ExchangeStreamStatus, details?: string) {
    this.status = newStatus;
    this.statusListeners.forEach((cb) => {
      try {
        cb(newStatus, this.currentExchange, details);
      } catch {}
    });
  }

  /**
   * Broadcasters (with high-frequency throttling to prevent UI freezes, OOM, and DOM errors)
   */
  private broadcastDepth(orderBook: OrderBook) {
    this.pendingDepth = orderBook;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.lastDepthBroadcastTime >= 100) {
      this.lastDepthBroadcastTime = now;
      this.flushDepth();
    } else if (!this.depthThrottleTimer) {
      this.depthThrottleTimer = setTimeout(() => {
        this.depthThrottleTimer = null;
        this.lastDepthBroadcastTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
        this.flushDepth();
      }, 100);
    }
  }

  private flushDepth() {
    if (!this.pendingDepth) return;
    const book = this.pendingDepth;
    this.pendingDepth = null;
    this.depthListeners.forEach((cb) => {
      try {
        cb(book);
      } catch {}
    });
  }

  private broadcastTrade(trade: PublicMarketTrade) {
    this.pendingTrade = trade;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.lastTradeBroadcastTime >= 120) {
      this.lastTradeBroadcastTime = now;
      this.flushTrade();
    } else if (!this.tradeThrottleTimer) {
      this.tradeThrottleTimer = setTimeout(() => {
        this.tradeThrottleTimer = null;
        this.lastTradeBroadcastTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
        this.flushTrade();
      }, 120);
    }
  }

  private flushTrade() {
    if (!this.pendingTrade) return;
    const tr = this.pendingTrade;
    this.pendingTrade = null;
    this.tradeListeners.forEach((cb) => {
      try {
        cb(tr);
      } catch {}
    });
  }

  private broadcastLatency(latencyMs: number) {
    this.latencyListeners.forEach((cb) => {
      try {
        cb(latencyMs);
      } catch {}
    });
  }

  /**
   * Cleanly closes the active socket without unhandled rejection errors.
   */
  private closeSocket() {
    if (this.activeWs) {
      const ws = this.activeWs;
      this.activeWs = null;
      try {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          try {
            ws.close(1000, 'Stream disconnected');
          } catch {}
        }
      } catch {}
    }
  }

  private clearTimers() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.depthThrottleTimer) {
      clearTimeout(this.depthThrottleTimer);
      this.depthThrottleTimer = null;
    }
    if (this.tradeThrottleTimer) {
      clearTimeout(this.tradeThrottleTimer);
      this.tradeThrottleTimer = null;
    }
  }

  private getFormattedPair(symbol: string): string {
    return symbol.replace('/', '').toLowerCase();
  }

  /**
   * Public API Listener Subscriptions (returns unsubscribe cleanup functions).
   */
  public onDepth(cb: DepthCallback): () => void {
    this.depthListeners.add(cb);
    if (this.lastKnownOrderBook) {
      cb(this.lastKnownOrderBook);
    }
    return () => this.depthListeners.delete(cb);
  }

  public onTrade(cb: TradeCallback): () => void {
    this.tradeListeners.add(cb);
    return () => this.tradeListeners.delete(cb);
  }

  public onLatency(cb: LatencyCallback): () => void {
    this.latencyListeners.add(cb);
    if (this.currentPingMs > 0) cb(this.currentPingMs);
    return () => this.latencyListeners.delete(cb);
  }

  public onStatus(cb: StatusCallback): () => void {
    this.statusListeners.add(cb);
    cb(this.status, this.currentExchange);
    return () => this.statusListeners.delete(cb);
  }

  public isStreamConnected(): boolean {
    return this.status === 'CONNECTED';
  }

  public getStatus(): ExchangeStreamStatus {
    return this.status;
  }

  public getActiveExchange(): SupportedExchange {
    return this.currentExchange;
  }

  public getStats(): ExchangeStreamStats {
    const uptime = this.connectStartTime > 0 ? Math.round((Date.now() - this.connectStartTime) / 1000) : 0;
    return {
      status: this.status,
      exchange: this.currentExchange,
      symbol: this.currentSymbol,
      latencyMs: this.currentPingMs,
      messagesCount: this.messagesCount,
      tradesCount: this.tradesCount,
      depthUpdatesCount: this.depthUpdatesCount,
      reconnectAttempts: this.reconnectAttempts,
      uptimeSeconds: uptime,
      lastMessageTime: this.lastMessageTimestamp,
    };
  }

  /**
   * Remove all active event listeners.
   */
  public removeAllListeners() {
    this.depthListeners.clear();
    this.tradeListeners.clear();
    this.latencyListeners.clear();
    this.statusListeners.clear();
  }

  /**
   * Disconnect the stream, optionally clearing all listeners.
   */
  public disconnect(clearListeners: boolean = false) {
    this.clearTimers();
    this.closeSocket();
    this.setStatus('DISCONNECTED');
    if (clearListeners) {
      this.removeAllListeners();
    }
  }

  /**
   * Destroy all resources and listeners.
   */
  public destroy() {
    this.isDestroyed = true;
    this.disconnect();
    if (this.latencyTimer) {
      clearInterval(this.latencyTimer);
      this.latencyTimer = null;
    }
    this.depthListeners.clear();
    this.tradeListeners.clear();
    this.latencyListeners.clear();
    this.statusListeners.clear();
  }
}

// Export singleton instance for app-wide use
export const exchangeStream = new ExchangeWebSocketManager();
