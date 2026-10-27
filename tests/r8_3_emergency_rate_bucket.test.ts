import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import net from 'node:net';
import { authManager } from '../server/middleware/auth';
import { EMERGENCY_RATE_LIMIT, isEmergencyRoute } from '../server/middleware/enterprise';

/**
 * R8-3: every request from the operator's machine shared one /api rate bucket, so a hostile page firing requests from the operator's
 * browser could drain it and the kill switch, panic and auto kill got 429. Now an authenticated emergency request has its own bucket.
 * The real server.ts, imported in process with a small /api burst so the general bucket drains quickly.
 */
let base = '';
let token = '';
let httpServer: import('node:http').Server;
const savedBurst = process.env.APEX_RATE_LIMIT_BURST;

beforeAll(async () => {
  process.env.APEX_RATE_LIMIT_BURST = '5';
  const mod = await import('../server');
  httpServer = mod.server;
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(httpServer.address() as net.AddressInfo).port}`;
  token = authManager.createSession('OPERATOR').token;
}, 60_000);

afterAll(async () => {
  if (savedBurst === undefined) delete process.env.APEX_RATE_LIMIT_BURST; else process.env.APEX_RATE_LIMIT_BURST = savedBurst;
  await new Promise<void>((r) => httpServer.close(() => r()));
});

const post = (route: string, body: unknown, auth = true) => fetch(base + route, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
});

describe('R8-3: the emergency routes have their own rate bucket', () => {
  it('names exactly the kill switch, panic and auto kill', () => {
    expect(isEmergencyRoute({ method: 'POST', originalUrl: '/api/execution/kill-switch' })).toBe(true);
    expect(isEmergencyRoute({ method: 'POST', originalUrl: '/api/wallet/panic-liquidate?x=1' })).toBe(true);
    expect(isEmergencyRoute({ method: 'POST', originalUrl: '/api/auto/kill/' })).toBe(true);
    expect(isEmergencyRoute({ method: 'GET', originalUrl: '/api/execution/kill-switch' })).toBe(false);
    expect(isEmergencyRoute({ method: 'POST', originalUrl: '/api/auto/mode' })).toBe(false);
  });

  it('with the /api bucket drained by unauthenticated requests, an authenticated kill-switch call still goes through', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); // the buckets refill on Date.now; a frozen clock refills nothing, so the drain is exact
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await fetch(`${base}/api/health`)).status);
      expect(statuses.at(-1)).toBe(429); // the shared bucket (burst 5) is empty
      expect((await fetch(`${base}/api/execution/mode`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(429); // other routes stay limited
      expect((await post('/api/execution/kill-switch', { activate: true }, false)).status).toBe(429); // no token: the shared bucket
      const res = await post('/api/execution/kill-switch', { activate: false });
      expect(res.status).toBe(200);
      expect((await res.json()).success).toBe(true);
      // the emergency bucket is bounded too
      const more: number[] = [];
      for (let i = 0; i < EMERGENCY_RATE_LIMIT.maxTokens; i++) more.push((await post('/api/execution/kill-switch', { activate: false })).status);
      expect(more.filter((s) => s === 200)).toHaveLength(EMERGENCY_RATE_LIMIT.maxTokens - 1);
      expect(more.at(-1)).toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });
});
