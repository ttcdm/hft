import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { apiAuthGate, normalizeApiPath, isPublicApiRoute } from '../server/middleware/auth';

/**
 * L1 (report X1): `/API/...` skipped the deny-by-default gate because it compared the path case-sensitively, while Express
 * routes case-insensitively. The 5pm report found it exposing the Telegram token, wallet state and the Gemini spend route.
 * This test walks every route that server.ts registers and asks the REAL gate, mounted on an app configured like server.ts.
 */
const src = fs.readFileSync('server.ts', 'utf8');
const routes = [...src.matchAll(/app\.(get|post|put|patch|delete)\(\s*'(\/api\/[^']*)'/g)].map((m) => ({ method: m[1].toUpperCase(), path: m[2] }));
const concrete = (p: string) => p.replace(/:[A-Za-z]+/g, 'x');

const variants = (p: string) => [p, p.toUpperCase(), '/API' + p.slice(4), '/Api' + p.slice(4), p.replace(/\/(\w)/g, (_m, c) => '/' + c.toUpperCase()), '//' + p.slice(1), p + '/'];

let server: http.Server;
let base = '';
beforeAll(async () => {
  const app = express();
  app.set('case sensitive routing', true); // same as server.ts
  app.use(apiAuthGate);
  app.all('*', (_req, res) => res.status(200).json({ leaked: true }));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('L1: the auth gate cannot be skipped by changing the case of /api', () => {
  it('finds the routes it is about to walk', () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  it('normalizes case, slashes and percent-encoding', () => {
    expect(normalizeApiPath('/API/Memecoins/Config?x=1')).toBe('/api/memecoins/config');
    expect(normalizeApiPath('//api//wallet')).toBe('/api/wallet');
    expect(normalizeApiPath('/%41PI/wallet/state')).toBe('/api/wallet/state');
    expect(isPublicApiRoute('POST', '/API/Auth/Login')).toBe(true);
    expect(isPublicApiRoute('GET', '/API/memecoins/config')).toBe(false);
  });

  it('every non-public route answers 401 without a token in every case variant', async () => {
    const leaks: string[] = [];
    for (const r of routes) {
      if (isPublicApiRoute(r.method, r.path)) continue;
      for (const v of variants(concrete(r.path))) {
        const res = await fetch(base + v, { method: r.method, headers: { 'content-type': 'application/json' }, body: r.method === 'GET' ? undefined : '{}' });
        if (res.status !== 401) leaks.push(`${r.method} ${v} -> ${res.status}`);
      }
    }
    expect(leaks).toEqual([]);
  });
});

describe('L1: server.ts keeps the second line of defence and the redaction', () => {
  it('turns on case-sensitive routing', () => {
    expect(src).toMatch(/app\.set\('case sensitive routing', true\)/);
  });
  it('never returns the stored Telegram bot token from /api/memecoins/config', () => {
    const block = src.slice(src.indexOf("app.get('/api/memecoins/config'"), src.indexOf("app.post('/api/memecoins/config'") + 700);
    expect(block).toMatch(/redactSniperConfig\(memecoinAggregator\.getConfig\(\)\)/);
    expect(block).toMatch(/redactSniperConfig\(updated\)/);
    expect(src).toMatch(/telegramBotToken: '', telegramBotTokenSet: Boolean/);
  });
});
