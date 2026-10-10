import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import express from 'express';
import { Logger, redactUrl, correlationIdMiddleware } from '../server/middleware/enterprise';
import { requireOperatorAuth } from '../server/middleware/auth';

describe('K2 #23: credentials in a query string never reach the logs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('redactUrl masks credential-looking parameters and keeps the rest', () => {
    expect(redactUrl('/api/account/balance?secret=S3CRET&symbol=SOL')).toBe('/api/account/balance?secret=[REDACTED]&symbol=SOL');
    expect(redactUrl('/x?apiKey=K&apiSecret=S&sig=1&signature=2&token=3&password=4&a=b')).toBe('/x?apiKey=[REDACTED]&apiSecret=[REDACTED]&sig=[REDACTED]&signature=[REDACTED]&token=[REDACTED]&password=[REDACTED]&a=b');
    expect(redactUrl('/x?api%5Fsecret=S&ok=1')).toBe('/x?api%5Fsecret=[REDACTED]&ok=1');
    expect(redactUrl('/x?flag&secret')).toBe('/x?flag&secret=[REDACTED]');
    expect(redactUrl('/x?a=1#frag')).toBe('/x?a=1#frag');
    expect(redactUrl('/plain')).toBe('/plain');
    expect(redactUrl(undefined)).toBe('');
  });

  it('a request with ?secret= that fails auth (401) leaves the secret out of every log line', async () => {
    const lines: string[] = [];
    for (const level of ['info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(Logger, level).mockImplementation(((...args: any[]) => { lines.push(JSON.stringify(args)); }) as any);
    }
    const app = express();
    app.use(correlationIdMiddleware); // runs before auth, like server.ts
    app.get('/api/account/balance', requireOperatorAuth, (_req, res) => res.json({ ok: true }));
    const srv = http.createServer(app);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const port = (srv.address() as any).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/account/balance?secret=HUNTER2-SECRET&apiKey=KEY-123&symbol=SOL`);
      expect(res.status).toBe(401);
      await vi.waitFor(() => expect(lines.some((l) => l.includes('[401]'))).toBe(true)); // 'finish' fires after the response
    } finally {
      srv.close();
    }
    const all = lines.join('\n');
    expect(all).toContain('/api/account/balance'); // it did log the request
    expect(all).toContain('symbol=SOL');
    expect(all).not.toContain('HUNTER2-SECRET');
    expect(all).not.toContain('KEY-123');
  });
});
