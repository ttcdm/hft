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
