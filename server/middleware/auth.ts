import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Logger, redactUrl } from './enterprise';

export interface OperatorSession {
  token: string;
  createdAt: number;
  lastActiveAt: number;
  expiresAt: number;
  role: 'OPERATOR' | 'READONLY';
}

export class AuthManager {
  private sessions: Map<string, OperatorSession> = new Map();
  private primaryOperatorToken: string;
  private readonly sessionTtlMs = 24 * 60 * 60 * 1000; // 24 hours

  constructor() {
    // Delete legacy .operator_session file if present to guarantee no credentials on disk
    try {
      const legacyPath = path.join(process.cwd(), '.operator_session');
      if (fs.existsSync(legacyPath)) {
        fs.unlinkSync(legacyPath);
        Logger.warn('Purged legacy .operator_session file from disk for defense-in-depth.');
      }
    } catch {}

    this.primaryOperatorToken = this.initPrimaryToken();
  }

  private initPrimaryToken(): string {
    // If environment variable provides a token, use it
    if (process.env.OPERATOR_AUTH_TOKEN && process.env.OPERATOR_AUTH_TOKEN.length >= 16) {
      const token = process.env.OPERATOR_AUTH_TOKEN;
      this.sessions.set(token, {
        token,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
        role: 'OPERATOR',
      });
      return token;
    }

    // Generate fresh cryptographic 256-bit in-memory token (never persisted to disk)
    const token = crypto.randomBytes(32).toString('hex');
    const session: OperatorSession = {
      token,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      expiresAt: Date.now() + this.sessionTtlMs,
      role: 'OPERATOR',
    };
    this.sessions.set(token, session);

    if (process.env.APEX_CONTAINER === 'true') {
      // Container logs are collected and shipped: never print a credential there. A volatile token nobody can read is useless,
      // so tell the operator to set one (docker-compose.yml requires OPERATOR_AUTH_TOKEN).
      console.log('NO OPERATOR_AUTH_TOKEN CONFIGURED: a volatile token was generated but is NOT printed in a container. Set OPERATOR_AUTH_TOKEN (16+ chars) and restart.');
    } else {
      // Prominently print generated fallback token to stdout in a highlighted banner (B04)
      console.log('\n' + '='.repeat(80));
      console.log('⚠️  NO OPERATOR_AUTH_TOKEN CONFIGURED IN ENVIRONMENT — GENERATED VOLATILE TOKEN:');
      console.log(`🔑  ${token}`);
      console.log('    Use this token to authenticate in the UI, or set OPERATOR_AUTH_TOKEN in .env');
      console.log('='.repeat(80) + '\n');
    }

    Logger.info('Operator session initialized in secure volatile memory (zero disk persistence).');

    return token;
  }

  /**
   * Explicitly invalidate all active sessions and rotate the primary operator credential
   */
  public rotateOperatorToken(): string {
    this.sessions.clear();
    const newToken = crypto.randomBytes(32).toString('hex');
    this.primaryOperatorToken = newToken;
    this.sessions.set(newToken, {
      token: newToken,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      expiresAt: Date.now() + this.sessionTtlMs,
      role: 'OPERATOR',
    });
    Logger.warn('Operator session rotated: all previous tokens revoked, new ephemeral token active.');
    return newToken;
  }

  public getPrimaryToken(): string {
    return this.primaryOperatorToken;
  }

  public validateToken(token?: string | null): boolean {
    if (!token) return false;
    const session = this.sessions.get(token);
    if (!session) return false;

    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      return false;
    }

    session.lastActiveAt = Date.now();
    return true;
  }

  public createSession(role: 'OPERATOR' | 'READONLY' = 'OPERATOR'): OperatorSession {
    const token = crypto.randomBytes(32).toString('hex');
    const session: OperatorSession = {
      token,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      expiresAt: Date.now() + this.sessionTtlMs,
      role,
    };
    this.sessions.set(token, session);
    return session;
  }

  public authenticateOperator(credentials: { password?: string; token?: string }): { success: boolean; token?: string; error?: string } {
    if (credentials.token && this.validateToken(credentials.token)) {
      return { success: true, token: credentials.token };
    }
    const envPassword = process.env.OPERATOR_PASSWORD;
    if (!envPassword || envPassword.length === 0) {
      if (credentials.password) {
        return {
          success: false,
          error: 'Password authentication disabled. Set OPERATOR_PASSWORD environment variable or authenticate via cryptographic token.',
        };
      }
      return { success: false, error: 'Token required. Set OPERATOR_PASSWORD to enable password access.' };
    }

    if (credentials.password) {
      // R9s: compare fixed-length HMACs, so neither the length nor the content of the password shows in the timing.
      const key = crypto.randomBytes(32);
      const digest = (v: string) => crypto.createHmac('sha256', key).update(v, 'utf8').digest();
      if (crypto.timingSafeEqual(digest(credentials.password), digest(envPassword))) {
        const session = this.createSession('OPERATOR');
        return { success: true, token: session.token };
      }
    }
    return { success: false, error: 'Invalid operator credentials' };
  }

  public revokeToken(token: string): boolean {
    return this.sessions.delete(token);
  }

  public getSession(token: string): OperatorSession | undefined {
    return this.sessions.get(token);
  }
}

export const authManager = new AuthManager();

// Extract an operator token from the Authorization / x-session-token / x-operator-auth headers.
// Tokens are never read from query strings.
export function extractOperatorToken(req: Request): string | undefined {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (req.headers['x-session-token']) {
    return String(req.headers['x-session-token']).trim();
  }
  if (req.headers['x-operator-auth']) {
    return String(req.headers['x-operator-auth']).trim();
  }
  return undefined;
}

function sendUnauthorized(req: Request, res: Response) {
  return res.status(401).json({
    success: false,
    error: {
      code: 'UNAUTHORIZED_MUTATION',
      message: 'Cryptographic operator session token is missing or invalid. Provide a valid Bearer token or x-session-token header.',
      correlationId: (req as any).correlationId || crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    },
  });
}

// Express middleware to protect mutation and sensitive endpoints
export function requireOperatorAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractOperatorToken(req);

  if (!token || !authManager.validateToken(token)) {
    Logger.warn(`Unauthorized mutation attempt blocked on ${req.method} ${redactUrl(req.originalUrl)} from ${req.ip}`);
    return sendUnauthorized(req, res);
  }

  next();
}

// A1: the only /api routes reachable without an operator token. Everything else is denied by default.
export const PUBLIC_API_ALLOWLIST: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'GET', path: '/api/health' },
  { method: 'HEAD', path: '/api/health' }, // R5s: probes (wget --spider, curl -I) send HEAD; Express answers it from the GET route
  { method: 'POST', path: '/api/auth/login' },
  { method: 'OPTIONS', path: '*' },
];

/**
 * The path as the router will see it: percent-decoded, duplicate slashes collapsed, lower-cased. Express matches routes
 * case-insensitively, so an auth check that compares case-sensitively (`/API/...`) is bypassed.
 */
export function normalizeApiPath(raw: string): string {
  // An absolute-form request target (`GET http://x/api/wallet/state`) is routed by its path, so reduce it to the path first.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      raw = new URL(raw).pathname;
    } catch {
      return '/api/__unparseable__'; // cannot be matched to a route; treat as an API path so the gate demands a token
    }
  }
  let p = raw.split('?')[0];
  try {
    p = decodeURIComponent(p);
  } catch {
    // an undecodable path cannot match a route, but keep checking the raw text
  }
  return p.replace(/\/{2,}/g, '/').toLowerCase();
}

export function isPublicApiRoute(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  const norm = normalizeApiPath(pathname);
  const p = norm.length > 1 && norm.endsWith('/') ? norm.slice(0, -1) : norm;
  return PUBLIC_API_ALLOWLIST.some((r) => r.method === m && (r.path === '*' || r.path === p));
}

// Deny-by-default gate for every /api route. Mount it with app.use(apiAuthGate) before any route.
export function apiAuthGate(req: Request, res: Response, next: NextFunction) {
  const pathname = normalizeApiPath(req.originalUrl || req.url || '');
  if (!pathname.startsWith('/api')) return next();
  if (isPublicApiRoute(req.method, pathname)) return next();
  const token = extractOperatorToken(req);
  if (!token || !authManager.validateToken(token)) {
    Logger.warn(`Unauthenticated API request blocked: ${req.method} ${pathname} from ${req.ip}`);
    return sendUnauthorized(req, res);
  }
  next();
}

// A1: bind to loopback unless a public bind is explicitly allowed with ALLOW_PUBLIC_BIND=true.
export function resolveBindHost(env: NodeJS.ProcessEnv = process.env): { host: string; warning?: string } {
  const requested = (env.BIND_HOST || '').trim();
  const isLoopback = requested === '' || requested === '127.0.0.1' || requested === '::1' || requested === 'localhost';
  if (isLoopback) {
    return { host: requested || '127.0.0.1' };
  }
  if (env.ALLOW_PUBLIC_BIND === 'true') {
    return {
      host: requested,
      warning: `BIND_HOST=${requested} exposes the operator API beyond this machine (ALLOW_PUBLIC_BIND=true).`,
    };
  }
  return {
    host: '127.0.0.1',
    warning: `BIND_HOST=${requested} ignored: set ALLOW_PUBLIC_BIND=true to bind beyond loopback. Binding 127.0.0.1.`,
  };
}

// WebSocket connection token validator
export function verifyWsAuth(token?: string | null): boolean {
  if (!token) return false;
  return authManager.validateToken(token);
}

// Helper function: strictly validate client origin against the server's own origin, loopback,
// or exact origins listed in ALLOWED_ORIGINS. No wildcard cloud domains are trusted (A1).
export function isAllowedClientOrigin(origin?: string | null, reqHost?: string | null): boolean {
  if (!origin) return true; // REST only; WebSockets use isAllowedWsConnection
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    // Allow loopback / localhost for local workstation operation
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;

    // Same-origin: scheme-agnostic host:port match against the request Host header
    if (reqHost && u.host.toLowerCase() === reqHost.toLowerCase()) return true;

    // Exact origins configured from environment
    const configuredRaw = process.env.ALLOWED_ORIGINS || process.env.CORS_ORIGIN || process.env.APP_URL || '';
    if (configuredRaw) {
      const allowedList = configuredRaw.split(',').map((s) => s.trim()).filter(Boolean);
      for (const entry of allowedList) {
        try {
          if (entry.includes('://')) {
            if (u.origin === new URL(entry).origin) return true;
          } else if (u.hostname === entry || u.host === entry) {
            return true;
          }
        } catch {
          if (origin === entry) return true;
        }
      }
    }

    return false;
  } catch {
    return false;
  }
}

function isLoopbackAddress(addr?: string | null): boolean {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// WebSocket upgrade check: browsers always send Origin, so a missing Origin is only accepted
// from a loopback peer (local tooling and smoke checks). Anything else must pass the origin allowlist.
export function isAllowedWsConnection(
  origin?: string | null,
  reqHost?: string | null,
  remoteAddress?: string | null
): boolean {
  if (!origin) return isLoopbackAddress(remoteAddress);
  return isAllowedClientOrigin(origin, reqHost);
}
