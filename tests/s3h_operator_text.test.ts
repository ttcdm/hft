import fs from 'node:fs';
import { describe, it, expect } from 'vitest';

/** 3H: screens, routes and diagnostics say what the code does (notes/placeholder-inventory.md, the items 3H owns). */

/** Every `app.<method>('/api/...')` route the server registers. server.ts is the only place routes are registered (B1 removed the other file). */
function serverRoutes(): string[] {
  const src = fs.readFileSync('server.ts', 'utf8');
  return [...src.matchAll(/app\.(get|post|put|patch|delete)\(\s*'(\/api\/[^']*)'/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
}

describe('3H B1: the Binance market routes left over from the BTC market maker are gone', () => {
  it('the route walk finds no /api/market/orderbook, /trades (without a mint), /ticker or /depth', () => {
    const routes = serverRoutes();
    expect(routes.length).toBeGreaterThan(50);
    expect(routes.filter((r) => /\/api\/market\/(orderbook|ticker|depth|trades)$/.test(r))).toEqual([]);
    // the curve panel's routes are a different thing and stay
    expect(routes).toContain('GET /api/market/curve/:mint');
    expect(routes).toContain('GET /api/market/trades/:mint');
    expect(fs.existsSync('server/market/marketRoutes.ts')).toBe(false);
  });
});

describe('3H B2: the fake PCAP export route is gone', () => {
  it('no /api/export/packets route, and no screen asks for one', () => {
    expect(serverRoutes().filter((r) => r.includes('/api/export/'))).toEqual([]);
    const ui = fs.readdirSync('src', { recursive: true }).map(String).filter((f) => /\.(ts|tsx)$/.test(f));
    for (const f of ui) expect(fs.readFileSync(`src/${f}`, 'utf8'), f).not.toContain('/api/export/packets');
  });
});

describe('3H B3: the exchange-era types are gone from src/types.ts', () => {
  it('none of the BTC market-maker shapes is exported', () => {
    const src = fs.readFileSync('src/types.ts', 'utf8');
    for (const t of ['OrderSide', 'OrderStatus', 'OrderBookEntry', 'OrderBook', 'ExecutedTrade', 'LatencyTestSample', 'PublicMarketTrade', 'ActiveOrder', 'AccountBalance', 'ExchangeGatewayConfig', 'MarketTickerStats']) {
      expect(src, t).not.toMatch(new RegExp(`export (interface|type) ${t}\\b`));
    }
  });
});

describe('3H B9: the engine client has no methods without a caller', () => {
  it('updateSniperConfig, getPumpFunLeaderboard, getPumpFunRules and getPumpFunStatus are gone; the methods the screens call stay', async () => {
    const { engineClient } = await import('../src/services/engineClient');
    for (const m of ['updateSniperConfig', 'getPumpFunLeaderboard', 'getPumpFunRules', 'getPumpFunStatus']) expect(typeof (engineClient as any)[m], m).toBe('undefined');
    for (const m of ['getSniperConfig', 'getPumpFunCallouts', 'updatePumpFunRules', 'refreshPumpFunData']) expect(typeof (engineClient as any)[m], m).toBe('function');
  });
});
