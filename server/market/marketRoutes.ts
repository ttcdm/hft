import type { Express, Request, Response } from 'express';
import { requireOperatorAuth } from '../middleware/auth';

/**
 * Market data proxy routes (B2). When the upstream source fails, these answer 503 with { source: 'UNAVAILABLE' } and
 * no data. They never generate levels, trades or tickers: the old fallbacks invented prices from a random generator.
 */
const unavailable = (res: any, symbol: string, what: string) =>
  res.status(503).json({ source: 'UNAVAILABLE', symbol, error: `${what} unavailable from the upstream source`, timestamp: Date.now() });

const safeSymbol = (q: string) => (q || 'BTCUSDT').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

/** The `symbol` query parameter as a clean string, or null after answering 400 (an array or object, e.g. `?symbol=a&symbol=b`, used to crash the process). */
function symbolOf(req: Request, res: Response): string | null {
  const q: unknown = req.query.symbol;
  if (q !== undefined && typeof q !== 'string') {
    res.status(400).json({ success: false, error: 'symbol must be a single string' });
    return null;
  }
  return safeSymbol((q as string | undefined) ?? '');
}

async function upstream(url: string): Promise<any | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const apiRes = await fetch(url, { signal: controller.signal });
    return apiRes.ok ? await apiRes.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function registerMarketRoutes(app: Express) {
  app.get('/api/market/orderbook', requireOperatorAuth, async (req, res) => {
    const symbol = symbolOf(req, res);
    if (!symbol) return;
    const data = await upstream(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=20`);
    if (!data) return unavailable(res, symbol, 'Order book');
    const bids = (data.bids || []).map((b: [string, string]) => [parseFloat(b[0]), parseFloat(b[1])]);
    const asks = (data.asks || []).map((a: [string, string]) => [parseFloat(a[0]), parseFloat(a[1])]);
    const bestBid = bids[0]?.[0] || 0;
    const bestAsk = asks[0]?.[0] || 0;
    const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;
    const spread = bestBid && bestAsk ? bestAsk - bestBid : null;
    res.json({
      source: 'BINANCE_LIVE_EDGE',
      symbol,
      lastUpdateId: data.lastUpdateId,
      midPrice: mid,
      spread: spread === null ? null : Number(spread.toFixed(4)),
      bids,
      asks,
      timestamp: Date.now(),
    });
  });

  app.get('/api/market/trades', requireOperatorAuth, async (req, res) => {
    const symbol = symbolOf(req, res);
    if (!symbol) return;
    const limit = Math.min(parseInt((req.query.limit as string) || '30', 10) || 30, 100);
    const trades = await upstream(`https://api.binance.com/api/v3/trades?symbol=${symbol}&limit=${limit}`);
    if (!Array.isArray(trades)) return unavailable(res, symbol, 'Trades');
    const mapped = trades.map((t: any) => ({
      id: t.id,
      price: parseFloat(t.price),
      size: parseFloat(t.qty),
      notionalUsd: Number((parseFloat(t.price) * parseFloat(t.qty)).toFixed(2)),
      timestamp: t.time,
      isBuyerMaker: t.isBuyerMaker,
      side: t.isBuyerMaker ? 'SELL' : 'BUY', // if buyer is maker, the aggressive taker was the seller
      symbol,
    }));
    res.json({ source: 'BINANCE_LIVE_TRADES', symbol, count: mapped.length, trades: mapped.reverse() });
  });

  app.get('/api/market/ticker', requireOperatorAuth, async (req, res) => {
    const symbol = symbolOf(req, res);
    if (!symbol) return;
    const data = await upstream(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
    if (!data) return unavailable(res, symbol, 'Ticker');
    res.json({
      source: 'BINANCE_LIVE_TICKER',
      symbol,
      lastPrice: parseFloat(data.lastPrice),
      priceChange24h: parseFloat(data.priceChange),
      priceChangePercent24h: parseFloat(data.priceChangePercent),
      high24h: parseFloat(data.highPrice),
      low24h: parseFloat(data.lowPrice),
      volume24h: parseFloat(data.volume),
      quoteVolume24h: parseFloat(data.quoteVolume),
      timestamp: data.closeTime,
    });
  });
}
