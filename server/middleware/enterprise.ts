import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { DEFAULT_RPC_URL } from '../solana/clusterGuard';

// ============================================================================
// 1. CORRELATION ID & STRUCTURED LOGGING
// ============================================================================
export interface LogContext {
  correlationId?: string;
  userId?: string;
  endpoint?: string;
  method?: string;
  statusCode?: number;
  durationMs?: number;
  [key: string]: any;
}

export class Logger {
  private static format(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', message: string, context?: LogContext) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...context,
    };
    try {
      return JSON.stringify(entry, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value
      );
    } catch {
      return `{"timestamp":"${entry.timestamp}","level":"${level}","message":${JSON.stringify(String(message))}}`;
    }
  }

  static info(message: string, context?: LogContext) {
    console.log(this.format('INFO', message, context));
  }

  static warn(message: string, context?: LogContext) {
    console.warn(this.format('WARN', message, context));
  }

  static error(message: string, context?: LogContext) {
    console.error(this.format('ERROR', message, context));
  }

  static debug(message: string, context?: LogContext) {
    if (process.env.NODE_ENV !== 'production' || process.env.DEBUG_LOGS === 'true') {
      console.log(this.format('DEBUG', message, context));
    }
  }
}

/**
 * Q54: an RPC or Jito URL can carry a key in its path (`/v2/<key>`), its query or its user-info. For logs and API replies keep only
 * scheme and host, which is what an operator needs to see which endpoint is in use.
 */
export function endpointOrigin(url: string | undefined | null): string {
  if (!url) return '';
  try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return '[unparseable endpoint]'; }
}

const SENSITIVE_QUERY_PARAM = /secret|key|token|signature|sig|password|passwd|auth|credential|private|mnemonic|seed/i;

/** URL safe to log: values of query parameters whose names look like credentials are replaced with [REDACTED]. */
export function redactUrl(url: string | undefined): string {
  if (!url) return '';
  const q = url.indexOf('?');
  if (q < 0) return url;
  const base = url.slice(0, q);
  const hash = url.indexOf('#', q);
  const query = url.slice(q + 1, hash < 0 ? undefined : hash);
  const tail = hash < 0 ? '' : url.slice(hash);
  const out = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const rawName = eq < 0 ? pair : pair.slice(0, eq);
      let name = rawName;
      try { name = decodeURIComponent(rawName.replace(/\+/g, ' ')); } catch { /* keep raw */ }
      return SENSITIVE_QUERY_PARAM.test(name) ? `${rawName}=[REDACTED]` : pair;
    })
    .join('&');
  return `${base}?${out}${tail}`;
}

// Correlation ID Middleware
export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const correlationId = (req.headers['x-correlation-id'] as string) || crypto.randomUUID();
  (req as any).correlationId = correlationId;
  res.setHeader('x-correlation-id', correlationId);

  const start = performance.now();
  res.on('finish', () => {
    const durationMs = Number((performance.now() - start).toFixed(2));
    Logger.info(`${req.method} ${redactUrl(req.originalUrl)} [${res.statusCode}] - ${durationMs}ms`, {
      correlationId,
      endpoint: redactUrl(req.originalUrl),
      method: req.method,
      statusCode: res.statusCode,
      durationMs,
      ip: req.ip || req.socket.remoteAddress,
    });
  });

  next();
}

// ============================================================================
// 2. UNIFIED ERROR RESPONSE SCHEMA & ERROR HANDLER
// ============================================================================
export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: any;
    correlationId: string;
    timestamp: string;
  };
}

/**
 * T4: the body of GET /api/health, which needs no token, so it says only that the server answers. It used to add the Node version,
 * platform, pid, uptime and memory; nothing read them, and they told an outside caller what to attack and when the process last restarted.
 */
export function publicHealthBody(): { status: 'ONLINE' } {
  return { status: 'ONLINE' };
}

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  const correlationId = (req as any).correlationId || crypto.randomUUID();
  const statusCode = err.statusCode || (err instanceof z.ZodError ? 400 : 500);
  const code = err.code || (err instanceof z.ZodError ? 'VALIDATION_FAILED' : 'INTERNAL_SERVER_ERROR');

  let details = err.details;
  let message = err.message || 'An unexpected error occurred';

  if (err instanceof z.ZodError) {
    message = 'Request validation failed';
    details = err.issues.map((e) => ({
      path: e.path.join('.'),
      message: e.message,
      code: e.code,
    }));
  }

  Logger.error(`Error processing request: ${message}`, {
    correlationId,
    endpoint: redactUrl(req.originalUrl),
    method: req.method,
    statusCode,
    code,
    stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
    details,
  });

  // T4: in production an unclassified server error (500 with no code of its own) returns a generic message: a database, file or RPC
  // error text can name paths, hosts or internals. The full message and details stay in the log under the same correlationId.
  const hide = process.env.NODE_ENV === 'production' && statusCode >= 500 && !err.code && !(err instanceof z.ZodError);
  const response: ApiErrorResponse = {
    success: false,
    error: {
      code,
      message: hide ? `An unexpected error occurred; see the server log for correlationId ${correlationId}` : message,
      details: hide ? undefined : details,
      correlationId,
      timestamp: new Date().toISOString(),
    },
  };

  res.status(statusCode).json(response);
}

// ============================================================================
// 3. STRICT ZOD SCHEMAS FOR PLUG-AND-PLAY ONBOARDING & EXECUTION
// ============================================================================

// Base58 Solana public key regex (32 to 44 base58 characters)
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Rejects URLs the server must never call: cloud metadata services (169.254.0.0/16 and its IPv4-mapped IPv6 form, link-local and
 * unique-local IPv6, metadata host names), embedded credentials, and schemes other than http(s) and ws(s).
 * T5: loopback and private IPv4 ranges are allowed on purpose. A localnet validator runs on 127.0.0.1, and only a logged-in operator on a
 * loopback-bound server can set these URLs; an RPC switch must also pass the cluster's genesis-hash check before it is used.
 */
export function isSafeExternalUrl(val: string): boolean {
  try {
    const u = new URL(val);
    const proto = u.protocol.toLowerCase();
    if (proto !== 'http:' && proto !== 'https:' && proto !== 'ws:' && proto !== 'wss:') {
      return false;
    }
    // Block embedded credentials
    if (u.username || u.password) {
      return false;
    }
    let host = u.hostname.toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) {
      // T5: URL keeps IPv6 hosts in brackets, so the old `host === 'fd00::'` never matched, and [::ffff:169.254.169.254] (which URL
      // rewrites to [::ffff:a9fe:a9fe]) reached the metadata service.
      host = host.slice(1, -1);
      const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host) || null;
      if (mapped) {
        const hi = parseInt(mapped[1], 16);
        host = `${hi >> 8}.${hi & 0xff}.${parseInt(mapped[2], 16) >> 8}.${parseInt(mapped[2], 16) & 0xff}`;
      } else if (/^::ffff:\d+\.\d+\.\d+\.\d+$/.test(host)) {
        host = host.slice('::ffff:'.length);
      } else if (/^fe[89ab][0-9a-f]?:/.test(host) || /^f[cd][0-9a-f]{0,2}:/.test(host)) {
        return false; // link-local fe80::/10 and unique-local fc00::/7 (fd00:ec2::254 is the AWS IPv6 metadata address)
      }
    }
    // Block AWS / GCP / Azure / OpenStack metadata services
    if (
      host.startsWith('169.254.') ||
      host === 'metadata.google.internal' ||
      host === 'metadata' ||
      host === 'instance-data'
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** T5: the Solana RPC client takes only http(s); a ws(s) URL passed the schema and then failed later with a less clear error. */
export function isHttpUrl(val: string): boolean {
  try {
    const proto = new URL(val).protocol.toLowerCase();
    return proto === 'http:' || proto === 'https:';
  } catch {
    return false;
  }
}

export const WalletConfigSchema = z.object({
  rpcEndpoint: z
    .string()
    .url('RPC Endpoint must be a valid HTTP or HTTPS URL')
    .refine(isHttpUrl, 'RPC Endpoint must be a valid HTTP or HTTPS URL')
    .refine(isSafeExternalUrl, 'RPC Endpoint cannot point to private metadata services or use embedded credentials')
    // Absent leaves the current endpoint alone. (A default here silently re-pointed the RPC at the public devnet URL on every
    // config save, which also fails the cluster check when running against a local validator.)
    .optional(),
  // '' turns Jito off; absent leaves it as it is (3G, N-8: a default of '' here made "absent" and "off" the same, and the update path then
  // skipped '' as falsy, so Jito could never be turned off). Whether a URL is allowed on this cluster is checked in walletTrader.updateConfig.
  jitoBlockEngineUrl: z
    .string()
    .refine(
      (v) => v === '' || (z.string().url().safeParse(v).success && isSafeExternalUrl(v)),
      'Jito Block Engine must be empty (disabled) or a valid URL that does not point to private metadata services'
    )
    .optional(),
  jitoTipSol: z.number().min(0.0001).max(0.2).optional(), // absent leaves the stored value alone (C6)
  // 3G (N-67): every field below is optional with no default. A default here was applied to every save that left the field out, so a save
  // without riskLimits.maxPositionSizeSol reset the risk engine's position cap to 0.02 SOL.
  slippageToleranceBps: z.number().min(10).max(5000).optional(),
  capitalTier: z.enum(['MICRO_10', 'INSTITUTIONAL', 'CUSTOM']).optional(),
  // Audit 2026-10-22: `allocatedSol` and `enabledStrategies` are gone. Nothing read the strategy toggles, and `allocatedSol` was a
  // constant that was echoed back as if it were a wallet figure. Unknown keys are dropped, as for the other removed settings (Q34).
  riskLimits: z
    .object({
      // 3G (N-67): refused, not dropped. The daily-loss limit comes from MAX_DAILY_LOSS_USD (read by the risk engine through
      // executionConfig); a value sent here was stored and echoed back but never used, so a caller believed it had set a limit.
      maxDailyLossUsd: z
        .unknown()
        .refine((v) => v === undefined, 'maxDailyLossUsd cannot be set through the API: set MAX_DAILY_LOSS_USD in the environment and restart')
        .optional(),
      maxPositionSizeSol: z.number().min(0.005).max(50).optional(),
      // Removed (decision 2, KNOWN_RISKS section 6): the stop-loss and take-profit keys were validated and stored but never read; exits follow
      // ExitEngine's fixed rules. A body from an older client that still sends them is accepted and they are dropped, as other removed settings are.
    })
    .optional(),
});

export const LiveSnipeOrderSchema = z.object({
  mint: z
    .string()
    .regex(SOLANA_ADDRESS_REGEX, 'Target token mint must be a valid Base58 Solana address'),
  amountSol: z.number().positive('Snipe amount must be greater than 0').max(10.0),
  slippagePct: z.number().min(0.5).max(50.0).default(6.0),
  jitoTipSol: z.number().min(0.0001).max(0.1).optional(), // absent -> dynamic tip policy (C6)
  callerHandle: z.string().optional(),
  confluenceScore: z.number().min(0).max(100).optional(),
});

export const ClosePositionSchema = z.object({
  positionId: z.string().min(1, 'positionId is required'),
  sellPct: z.number().int().min(1).max(100).default(100), // N-44: whole percent only
});

// Middleware factory for Zod validation
export function validateBody<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      next(err);
    }
  };
}

// ============================================================================
// 4. RATE LIMITING (SLIDING WINDOW TOKEN BUCKET)
// ============================================================================
interface RateLimitBucket {
  tokens: number;
  lastRefillMs: number;
}

export type RateLimitMiddleware = ((req: Request, res: Response, next: NextFunction) => void) & {
  /** How many peers this limiter is tracking now (idle ones are dropped). */
  bucketCount(): number;
};

/**
 * Token bucket per peer. 3G (N-5): the key is the TCP peer address only. It used to be the client-chosen `x-api-key` header, checked
 * before the auth gate, so a new header value on every POST /api/auth/login got a fresh bucket (no throttle on password guessing) and
 * a new map entry that was never removed. `req.ip` is not used: it follows X-Forwarded-For when `trust proxy` is set.
 * Each limiter has its own buckets. A bucket idle long enough to have refilled completely is the same as a new one, so it is dropped
 * (swept at most once per refill period, on a request); the map holds only peers seen within that period.
 */
export function rateLimiter(opts: { maxTokens: number; refillRatePerSec: number }): RateLimitMiddleware {
  const buckets = new Map<string, RateLimitBucket>();
  const fullRefillMs = (opts.maxTokens / opts.refillRatePerSec) * 1000;
  let lastSweepMs = Date.now();

  const middleware = (req: Request, res: Response, next: NextFunction) => {
    const key = req.socket?.remoteAddress || 'unknown-peer';
    const now = Date.now();

    if (now - lastSweepMs >= fullRefillMs) {
      for (const [k, b] of buckets) if (now - b.lastRefillMs >= fullRefillMs) buckets.delete(k);
      lastSweepMs = now;
    }

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: opts.maxTokens, lastRefillMs: now };
      buckets.set(key, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsedSec = (now - bucket.lastRefillMs) / 1000;
    bucket.tokens = Math.min(opts.maxTokens, bucket.tokens + elapsedSec * opts.refillRatePerSec);
    bucket.lastRefillMs = now;

    if (bucket.tokens < 1) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((1 - bucket.tokens) / opts.refillRatePerSec))));
      return res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Rate limit exceeded. Please throttle your HFT requests.',
          correlationId: (req as any).correlationId || crypto.randomUUID(),
          timestamp: new Date().toISOString(),
        },
      });
    }

    bucket.tokens -= 1;
    res.setHeader('X-RateLimit-Remaining', Math.floor(bucket.tokens).toString());
    next();
  };
  return Object.assign(middleware, { bucketCount: () => buckets.size });
}

/** 3G (N-5): POST /api/auth/login on top of the /api limiter: 5 attempts at once, then one every 12 s, per peer address. */
export const LOGIN_RATE_LIMIT = { maxTokens: 5, refillRatePerSec: 5 / 60 } as const;

// ============================================================================
// 5. SECURITY HEADERS & SANITIZATION
// ============================================================================
export function securityHeadersMiddleware(req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(), microphone=(), camera=(), payment=(), usb=()'
  );
  next();
}
