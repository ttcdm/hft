import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Logger, redactUrl, isEmergencyRoute } from './enterprise';

export interface OperatorSession {
  token: string;
  createdAt: number;
  lastActiveAt: number;
  expiresAt: number;
  role: 'OPERATOR' | 'READONLY';
}

/** The shortest OPERATOR_AUTH_TOKEN the server accepts; a shorter one is ignored and a volatile token is generated instead. */
export const MIN_OPERATOR_TOKEN_LENGTH = 16;

/**
 * R4-11, R4-39: the boot warnings about operator access, never containing a credential. One when OPERATOR_AUTH_TOKEN is set but too short
 * (it is ignored), and one when there is neither a usable OPERATOR_AUTH_TOKEN nor an OPERATOR_PASSWORD: then the volatile token generated at
 * boot is the only way in, and a restart (or `/api/auth/rotate`) changes it.
 */
export function operatorAuthBootWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const token = env.OPERATOR_AUTH_TOKEN ?? '';
  const tokenOk = token.length >= MIN_OPERATOR_TOKEN_LENGTH;
  if (token.length > 0 && !tokenOk) {
    out.push(`OPERATOR_AUTH_TOKEN IS SET BUT SHORTER THAN ${MIN_OPERATOR_TOKEN_LENGTH} CHARACTERS AND WAS IGNORED: a volatile token is used instead. Set a token of ${MIN_OPERATOR_TOKEN_LENGTH}+ characters (openssl rand -hex 32) and restart.`);
  }
  if (!tokenOk && !(env.OPERATOR_PASSWORD && env.OPERATOR_PASSWORD.length > 0)) {
    out.push('NO OPERATOR_AUTH_TOKEN (16+ chars) AND NO OPERATOR_PASSWORD: the volatile token generated at this boot is the ONLY way to reach the kill switch and panic. It does not expire, but a restart replaces it. Set OPERATOR_AUTH_TOKEN or OPERATOR_PASSWORD.');
  }
  return out;
}

export class AuthManager {
  private sessions: Map<string, OperatorSession> = new Map();
  private primaryOperatorToken: string;
  private readonly sessionTtlMs = 24 * 60 * 60 * 1000; // 24 hours, for sessions from a password login or createSession
  /**
   * R4-11: the primary operator token (OPERATOR_AUTH_TOKEN, the volatile boot token, or the token a rotate returns) never expires. It used
   * to expire after 24 h with no way to renew it, which locked the kill switch and panic out until a restart. A logout or a rotate still
   * revokes it.
   */
  private static readonly PRIMARY_EXPIRES_AT = Number.POSITIVE_INFINITY;
  private readonly revokeListeners = new Set<() => void>();

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
    // R4-11, R4-39: say loudly (and without printing any token) when the configured access is missing or was ignored
    for (const w of operatorAuthBootWarnings()) console.error(`\n!!! ${w}\n`);
    // If environment variable provides a token, use it
    if (process.env.OPERATOR_AUTH_TOKEN && process.env.OPERATOR_AUTH_TOKEN.length >= MIN_OPERATOR_TOKEN_LENGTH) {
      const token = process.env.OPERATOR_AUTH_TOKEN;
      this.sessions.set(token, {
        token,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        expiresAt: AuthManager.PRIMARY_EXPIRES_AT,
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
      expiresAt: AuthManager.PRIMARY_EXPIRES_AT,
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
      expiresAt: AuthManager.PRIMARY_EXPIRES_AT,
      role: 'OPERATOR',
    });
    Logger.warn('Operator session rotated: all previous tokens revoked, new ephemeral token active.');
    this.notifyRevoked();
    return newToken;
  }

  /**
   * 3G (N-4): called after a rotate or a logout revokes tokens, so whatever holds a token outside a request (an authenticated
   * WebSocket) can drop it at once instead of at its next use. Returns the unsubscribe function.
   */
  public onRevoke(fn: () => void): () => void {
    this.revokeListeners.add(fn);
    return () => { this.revokeListeners.delete(fn); };
  }

  private notifyRevoked() {
    for (const fn of this.revokeListeners) {
      try { fn(); } catch (err: any) { Logger.warn(`Token revoke listener failed: ${err?.message || err}`); }
    }
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

  /**
   * T3: a valid token whose session has the OPERATOR role. Only OPERATOR sessions are issued today, so this changes nothing yet; it stops
   * a READONLY session (createSession('READONLY')) from ever trading, changing config or holding a trading WebSocket.
   */
  public isOperatorToken(token?: string | null): boolean {
    if (!this.validateToken(token)) return false;
    return this.sessions.get(token as string)?.role === 'OPERATOR';
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
    const removed = this.sessions.delete(token);
    if (removed) this.notifyRevoked();
    return removed;
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

  if (!token || !authManager.isOperatorToken(token)) {
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

/**
 * R14-12: operator tokens guessed on the header path. Only POST /api/auth/login had a failure limit; the general /api bucket allows about 30
 * requests a second per peer, so a weak hand-set token could be guessed through any route. Per TCP peer address (like LOGIN_RATE_LIMIT), only a
 * request that PRESENTS a token that is not a valid session counts: valid tokens and requests with no token never do. Once a peer has used up
 * `maxFailures` (refilled at `refillPerSec`), its token-bearing requests are answered 429 TOKEN_GUESS_LIMITED WITHOUT checking the token, valid
 * or not, until a failure has refilled: answering a valid token during the lock would still tell a guesser when it was right. The emergency
 * routes (EMERGENCY_ROUTES: kill switch, panic, auto kill) always check the token, so the operator can always stop trading; their failures
 * still count. The UI drops a refused token at the first 401, so a stale tab does not keep a peer locked.
 */
export const FAILED_TOKEN_LIMIT = { maxFailures: 10, refillPerSec: 10 / 60 } as const;

export class FailedTokenLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly opts: { maxFailures: number; refillPerSec: number } = FAILED_TOKEN_LIMIT) {}

  private bucket(peer: string, now: number): { tokens: number; at: number } {
    let b = this.buckets.get(peer);
    if (!b) b = { tokens: this.opts.maxFailures, at: now };
    b.tokens = Math.min(this.opts.maxFailures, b.tokens + ((now - b.at) / 1000) * this.opts.refillPerSec);
    b.at = now;
    if (b.tokens >= this.opts.maxFailures) this.buckets.delete(peer); // a full bucket is the same as none: the map holds only recent guessers
    else this.buckets.set(peer, b);
    return b;
  }

  /** Seconds until the peer may present a token again; 0 when it may now. */
  public lockedForSec(peer: string, now = Date.now()): number {
    const b = this.bucket(peer, now);
    return b.tokens >= 1 ? 0 : Math.max(1, Math.ceil((1 - b.tokens) / this.opts.refillPerSec));
  }

  public recordFailure(peer: string, now = Date.now()): void {
    const b = this.bucket(peer, now);
    b.tokens = Math.max(0, b.tokens - 1);
    this.buckets.set(peer, b);
  }

  public peerCount(): number {
    return this.buckets.size;
  }
}

export const failedTokenLimiter = new FailedTokenLimiter();

// Deny-by-default gate for every /api route. Mount it with app.use(apiAuthGate) before any route.
export function apiAuthGate(req: Request, res: Response, next: NextFunction) {
  const pathname = normalizeApiPath(req.originalUrl || req.url || '');
  if (!pathname.startsWith('/api')) return next();
  if (isPublicApiRoute(req.method, pathname)) return next();
  const token = extractOperatorToken(req);
  // R14-12: a peer that has guessed too many tokens gets no answer about the next one (emergency routes excepted, see FAILED_TOKEN_LIMIT)
  const peer = req.socket?.remoteAddress || 'unknown-peer';
  const emergency = isEmergencyRoute(req);
  if (token && !emergency) {
    const waitSec = failedTokenLimiter.lockedForSec(peer);
    if (waitSec > 0) {
      res.setHeader('Retry-After', String(waitSec));
      return res.status(429).json({
        success: false,
        error: {
          code: 'TOKEN_GUESS_LIMITED',
          message: `Too many invalid operator tokens from this address; tokens are not checked for ${waitSec} s. The kill switch, panic and auto kill routes still accept a valid token.`,
          correlationId: (req as any).correlationId || crypto.randomUUID(),
          timestamp: new Date().toISOString(),
        },
      });
    }
  }
  // T3: any valid session may read (GET/HEAD); everything else needs the OPERATOR role, whether or not the route adds requireOperatorAuth.
  const readOnly = req.method === 'GET' || req.method === 'HEAD';
  if (!token || !(readOnly ? authManager.validateToken(token) : authManager.isOperatorToken(token))) {
    if (token && !authManager.validateToken(token)) failedTokenLimiter.recordFailure(peer); // R14-12: a guess, not a READONLY session's POST
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

// WebSocket token check: server.ts uses it for the AUTHENTICATE handshake and for every mutating WebSocket command
export function verifyWsAuth(token?: string | null): boolean {
  if (!token) return false;
  return authManager.isOperatorToken(token); // T3: the trading socket is operator-only
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
