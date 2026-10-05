import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Logger } from './enterprise';

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

    // Prominently print generated fallback token to stdout in a highlighted banner (B04)
    console.log('\n' + '='.repeat(80));
    console.log('⚠️  NO OPERATOR_AUTH_TOKEN CONFIGURED IN ENVIRONMENT — GENERATED VOLATILE TOKEN:');
    console.log(`🔑  ${token}`);
    console.log('    Use this token to authenticate in the UI, or set OPERATOR_AUTH_TOKEN in .env');
    console.log('='.repeat(80) + '\n');

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
      const inputBuffer = Buffer.from(credentials.password, 'utf8');
      const expectedBuffer = Buffer.from(envPassword, 'utf8');
      if (inputBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(inputBuffer, expectedBuffer)) {
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

// Express middleware to protect mutation and sensitive endpoints
export function requireOperatorAuth(req: Request, res: Response, next: NextFunction) {
  // Check authorization header or x-session-token or x-operator-auth header
  const authHeader = req.headers['authorization'];
  let token: string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (req.headers['x-session-token']) {
    token = String(req.headers['x-session-token']).trim();
  } else if (req.headers['x-operator-auth']) {
    token = String(req.headers['x-operator-auth']).trim();
  }

  if (!token || !authManager.validateToken(token)) {
    Logger.warn(`Unauthorized mutation attempt blocked on ${req.method} ${req.originalUrl} from ${req.ip}`);
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

  next();
}

// WebSocket connection token validator
export function verifyWsAuth(token?: string | null): boolean {
  if (!token) return false;
  return authManager.validateToken(token);
}

// Helper function: strictly validate client origin against host or configured exact origins
export function isAllowedClientOrigin(origin?: string | null, reqHost?: string | null): boolean {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    // Allow loopback / localhost for development & test suites
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;

    // Check same-origin against current HTTP request Host header
    if (reqHost) {
      const hostWithoutPort = reqHost.split(':')[0];
      if (u.hostname === hostWithoutPort) return true;
    }

    // Allow Google Cloud Run, AI Studio, and Google sandbox preview domains
    if (
      u.hostname.endsWith('.run.app') ||
      u.hostname.endsWith('.googleusercontent.com') ||
      u.hostname.endsWith('.google.com') ||
      u.hostname.endsWith('.aistudio.google.com')
    ) {
      return true;
    }

    // Check configured exact origins from environment
    const configuredRaw = process.env.ALLOWED_ORIGINS || process.env.CORS_ORIGIN || process.env.APP_URL || '';
    if (configuredRaw) {
      const allowedList = configuredRaw.split(',').map((s) => s.trim()).filter(Boolean);
      for (const entry of allowedList) {
        try {
          const entryUrl = entry.includes('://') ? new URL(entry) : new URL(`https://${entry}`);
          if (u.origin === entryUrl.origin || u.hostname === entryUrl.hostname) {
            return true;
          }
        } catch {
          if (origin === entry || u.hostname === entry) return true;
        }
      }
    }

    return false;
  } catch {
    return false;
  }
}

