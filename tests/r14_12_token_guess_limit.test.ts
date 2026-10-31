import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { apiAuthGate, authManager, FAILED_TOKEN_LIMIT } from '../server/middleware/auth';

/**
 * R14-12: operator token guesses on the header path were not throttled (only /api/auth/login had a failure limit), so a weak hand-set token
 * could be guessed at the general /api rate. The real auth gate, mounted as server.ts mounts it; the route behind it is a stand-in that
 * answers 200 when the gate lets a request through.
 */
async function withGatedApp<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use(apiAuthGate);
  app.all('/api/*', (_req, res) => res.status(200).json({ reached: true }));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try { return await fn(`http://127.0.0.1:${port}`); } finally { await new Promise<void>((r) => server.close(() => r())); }
}
const call = (base: string, path: string, token?: string, method = 'GET') =>
  fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method === 'GET' ? {} : { body: '{}' }) });

describe('R14-12: failed operator tokens are limited per peer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('valid tokens never count; guesses lock the peer; emergency routes still take a valid token; the lock refills', async () => {
    const good = authManager.getPrimaryToken();
    await withGatedApp(async (base) => {
      for (let i = 0; i < 40; i++) expect((await call(base, '/api/wallet/state', good)).status).toBe(200);
      for (let i = 0; i < 5; i++) expect((await call(base, '/api/wallet/state')).status).toBe(401); // no token: not a guess

      for (let i = 0; i < FAILED_TOKEN_LIMIT.maxFailures; i++) expect((await call(base, '/api/wallet/state', `guess-${i}-xxxxxxxxxxxx`)).status).toBe(401);
      const locked = await call(base, '/api/wallet/state', 'guess-next-xxxxxxxxxxxx');
      expect(locked.status).toBe(429);
      expect((await locked.json()).error.code).toBe('TOKEN_GUESS_LIMITED');
      expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
      // the lock gives no answer about any token, the right one included, except on the emergency routes
      expect((await call(base, '/api/wallet/state', good)).status).toBe(429);
      expect((await call(base, '/api/auto/kill', good, 'POST')).status).toBe(200);
      expect((await call(base, '/api/execution/kill-switch', 'guess-emergency-xxxxxxxx', 'POST')).status).toBe(401);

      const later = Date.now() + Math.ceil(1000 / FAILED_TOKEN_LIMIT.refillPerSec) + 50;
      vi.spyOn(Date, 'now').mockReturnValue(later);
      expect((await call(base, '/api/wallet/state', good)).status).toBe(200);
    });
  });
});
