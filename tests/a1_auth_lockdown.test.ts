import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { AddressInfo } from 'net';
import {
  AuthManager,
  apiAuthGate,
  isPublicApiRoute,
  isAllowedClientOrigin,
  isAllowedWsConnection,
  resolveBindHost,
  authManager,
} from '../server/middleware/auth';

type Route = { method: string; path: string };

function extractApiRoutes(source: string): Route[] {
  const re = /^app\.(get|post|put|delete|patch)\(\s*'(\/api[^']*)'/gm;
  const routes: Route[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    routes.push({ method: m[1].toUpperCase(), path: m[2] });
  }
  return routes;
}

async function withGatedApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use(apiAuthGate);
  // Stand-in terminal handler: reaching it means the gate let the request through.
  app.all('/api/*', (_req, res) => res.status(200).json({ reached: true }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('A1: operator auth lockdown', () => {
  const serverSource = fs.readFileSync(path.resolve(process.cwd(), 'server.ts'), 'utf8');
  const routes = extractApiRoutes(serverSource);

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.CORS_ORIGIN;
    delete process.env.APP_URL;
  });

  describe('deny-by-default route walk', () => {
    it('finds the real /api routes declared in server.ts', () => {
      expect(routes.length).toBeGreaterThan(50);
      expect(routes).toContainEqual({ method: 'GET', path: '/api/auth/session' });
      expect(routes).toContainEqual({ method: 'POST', path: '/api/pumpfun/refresh' });
    });

    it('rejects every non-allowlisted /api route without a token and admits it with a valid one', async () => {
      const token = authManager.getPrimaryToken();
      await withGatedApp(async (base) => {
        for (const r of routes) {
          const concretePath = r.path.replace(/:[A-Za-z]+/g, 'x');
          const init: RequestInit = { method: r.method, headers: { 'content-type': 'application/json' } };
          if (r.method !== 'GET') init.body = '{}';

          const anon = await fetch(`${base}${concretePath}`, init);
          const publicRoute = isPublicApiRoute(r.method, r.path);
          expect(anon.status, `${r.method} ${r.path} without token`).toBe(publicRoute ? 200 : 401);

          const authed = await fetch(`${base}${concretePath}`, {
            ...init,
            headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
          });
          expect(authed.status, `${r.method} ${r.path} with token`).toBe(200);
        }
      });
    });

    it('only GET /api/health and POST /api/auth/login are public', () => {
      const publicRoutes = routes.filter((r) => isPublicApiRoute(r.method, r.path));
      expect(publicRoutes).toEqual(
        expect.arrayContaining([
          { method: 'GET', path: '/api/health' },
          { method: 'POST', path: '/api/auth/login' },
        ])
      );
      expect(publicRoutes).toHaveLength(2);
    });

    it('answers an unauthenticated GET /api/auth/session with 401 in every NODE_ENV', async () => {
      for (const env of ['development', 'test', 'production', '']) {
        vi.stubEnv('NODE_ENV', env);
        await withGatedApp(async (base) => {
          const res = await fetch(`${base}/api/auth/session`);
          expect(res.status, `NODE_ENV=${env}`).toBe(401);
          const body = await res.json();
          expect(body.token).toBeUndefined();
        });
      }
    });

    it('never accepts an operator token passed in the query string', async () => {
      const token = authManager.getPrimaryToken();
      await withGatedApp(async (base) => {
        const res = await fetch(`${base}/api/engine/status?token=${token}&sessionToken=${token}`);
        expect(res.status).toBe(401);
      });
    });

    it('rejects a revoked or unknown token', async () => {
      const mgr = new AuthManager();
      const session = mgr.createSession('OPERATOR');
      expect(authManager.validateToken(session.token)).toBe(false);
      await withGatedApp(async (base) => {
        const res = await fetch(`${base}/api/engine/status`, {
          headers: { Authorization: `Bearer ${session.token}` },
        });
        expect(res.status).toBe(401);
      });
    });
  });

  describe('origin allowlist', () => {
    it('rejects the former wildcard cloud domains', () => {
      expect(isAllowedClientOrigin('https://app-123.run.app', 'localhost:3000')).toBe(false);
      expect(isAllowedClientOrigin('https://x.googleusercontent.com', 'localhost:3000')).toBe(false);
      expect(isAllowedClientOrigin('https://ai.google.com', 'localhost:3000')).toBe(false);
      expect(isAllowedClientOrigin('https://x.aistudio.google.com', 'localhost:3000')).toBe(false);
    });

    it('accepts the server own origin and loopback, rejects an unlisted origin', () => {
      expect(isAllowedClientOrigin('http://localhost:3000', 'localhost:3000')).toBe(true);
      expect(isAllowedClientOrigin('https://ops.example.com', 'ops.example.com')).toBe(true);
      expect(isAllowedClientOrigin('https://ops.example.com:9999', 'ops.example.com')).toBe(false);
      expect(isAllowedClientOrigin('https://evil.example.net', 'ops.example.com')).toBe(false);
    });

    it('accepts only exact origins from ALLOWED_ORIGINS', () => {
      process.env.ALLOWED_ORIGINS = 'https://portal.example.com';
      expect(isAllowedClientOrigin('https://portal.example.com', 'other.host')).toBe(true);
      expect(isAllowedClientOrigin('http://portal.example.com', 'other.host')).toBe(false);
      expect(isAllowedClientOrigin('https://portal.example.com.evil.net', 'other.host')).toBe(false);
    });

    it('rejects non-http(s) schemes and malformed origins', () => {
      expect(isAllowedClientOrigin('javascript:alert(1)')).toBe(false);
      expect(isAllowedClientOrigin('file:///etc/passwd')).toBe(false);
      expect(isAllowedClientOrigin('not a url')).toBe(false);
    });
  });

  describe('WebSocket origin rule', () => {
    it('rejects a missing Origin from a non-loopback peer and accepts it from loopback', () => {
      expect(isAllowedWsConnection('', 'host:3000', '203.0.113.9')).toBe(false);
      expect(isAllowedWsConnection(undefined, 'host:3000', undefined)).toBe(false);
      expect(isAllowedWsConnection('', 'localhost:3000', '127.0.0.1')).toBe(true);
      expect(isAllowedWsConnection('', 'localhost:3000', '::ffff:127.0.0.1')).toBe(true);
    });

    it('applies the origin allowlist when an Origin is present', () => {
      expect(isAllowedWsConnection('https://evil.example.net', 'ops.example.com', '127.0.0.1')).toBe(false);
      expect(isAllowedWsConnection('https://ops.example.com', 'ops.example.com', '203.0.113.9')).toBe(true);
    });
  });

  describe('bind host', () => {
    it('defaults to 127.0.0.1', () => {
      expect(resolveBindHost({} as NodeJS.ProcessEnv)).toEqual({ host: '127.0.0.1' });
    });

    it('ignores a public BIND_HOST without ALLOW_PUBLIC_BIND and warns', () => {
      const r = resolveBindHost({ BIND_HOST: '0.0.0.0' } as NodeJS.ProcessEnv);
      expect(r.host).toBe('127.0.0.1');
      expect(r.warning).toMatch(/ALLOW_PUBLIC_BIND/);
    });

    it('honors a public BIND_HOST only with ALLOW_PUBLIC_BIND=true, with a warning', () => {
      const r = resolveBindHost({ BIND_HOST: '0.0.0.0', ALLOW_PUBLIC_BIND: 'true' } as NodeJS.ProcessEnv);
      expect(r.host).toBe('0.0.0.0');
      expect(r.warning).toMatch(/exposes the operator API/);
    });
  });
});
