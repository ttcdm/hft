import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { AddressInfo } from 'net';
import { registerMarketRoutes } from '../server/market/marketRoutes';

async function withApp<T>(fn: (base: string) => Promise<T>) {
  const app = express();
  registerMarketRoutes(app);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

// Only requests to the Binance upstream are intercepted; the test's own loopback calls pass through.
const mockUpstream = (impl: (url: string) => Promise<Response>) => {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) =>
    String(input).startsWith('http://127.0.0.1') ? real(input, init) : impl(String(input)));
};

describe('B2: market routes never generate data', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['orderbook', 'trades', 'ticker'])('%s answers 503 UNAVAILABLE with no data when the upstream fails', async (route) => {
    mockUpstream(async () => { throw new Error('upstream down'); });
    await withApp(async (base) => {
      const res = await fetch(`${base}/api/market/${route}?symbol=BTCUSDT`);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.source).toBe('UNAVAILABLE');
      expect(body.bids).toBeUndefined();
      expect(body.trades).toBeUndefined();
      expect(body.lastPrice).toBeUndefined();
    });
  });

  it('answers 503 on an upstream HTTP error too', async () => {
    mockUpstream(async () => new Response('{}', { status: 451 }));
    await withApp(async (base) => {
      expect((await fetch(`${base}/api/market/orderbook`)).status).toBe(503);
    });
  });

  it('passes real upstream data through unchanged', async () => {
    mockUpstream(async (url) =>
      new Response(JSON.stringify(url.includes('/depth')
        ? { lastUpdateId: 7, bids: [['100.0', '2']], asks: [['100.5', '3']] }
        : [{ id: 1, price: '100', qty: '2', time: 5, isBuyerMaker: true }]), { status: 200 }));
    await withApp(async (base) => {
      const ob = await (await fetch(`${base}/api/market/orderbook?symbol=SOLUSDT`)).json();
      expect(ob.source).toBe('BINANCE_LIVE_EDGE');
      expect(ob.midPrice).toBe(100.25);
      expect(ob.spread).toBe(0.5);
      const tr = await (await fetch(`${base}/api/market/trades?symbol=SOLUSDT`)).json();
      expect(tr.trades[0]).toMatchObject({ price: 100, size: 2, side: 'SELL' });
    });
  });

  it('has no Math.random and no hardcoded prices in the market routes or in server.ts market section', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'server/market/marketRoutes.ts'), 'utf8');
    expect(src).not.toContain('Math.random');
    for (const n of ['142.2', '68940', '2840', 'INTERNAL_FALLBACK']) expect(src).not.toContain(n);
    const server = fs.readFileSync(path.resolve(process.cwd(), 'server.ts'), 'utf8');
    expect(server).not.toContain('INTERNAL_FALLBACK');
    expect(server).toContain('registerMarketRoutes(app)');
  });
});
