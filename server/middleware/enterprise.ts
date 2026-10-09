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

// Correlation ID Middleware
export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const correlationId = (req.headers['x-correlation-id'] as string) || crypto.randomUUID();
  (req as any).correlationId = correlationId;
  res.setHeader('x-correlation-id', correlationId);

  const start = performance.now();
  res.on('finish', () => {
    const durationMs = Number((performance.now() - start).toFixed(2));
    Logger.info(`${req.method} ${req.originalUrl} [${res.statusCode}] - ${durationMs}ms`, {
      correlationId,
      endpoint: req.originalUrl,
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

export class AppError extends Error {
  public statusCode: number;
  public code: string;
  public details?: any;

  constructor(message: string, statusCode = 500, code = 'INTERNAL_ERROR', details?: any) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
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
    endpoint: req.originalUrl,
    method: req.method,
    statusCode,
    code,
    stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
    details,
  });

  const response: ApiErrorResponse = {
    success: false,
    error: {
      code,
      message,
      details,
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

// SSRF prevention: reject private network addresses, metadata endpoints, and non-standard schemes
export function isSafeExternalUrl(val: string): boolean {
  try {
    const u = new URL(val);
    const proto = u.protocol.toLowerCase();
    if (proto !== 'http:' && proto !== 'https:' && proto !== 'ws:' && proto !== 'wss:') {
      return false;
    }
    const host = u.hostname.toLowerCase();
    // Block AWS / GCP / Azure / OpenStack metadata services
    if (
      host === '169.254.169.254' ||
      host.startsWith('169.254.') ||
      host === 'metadata.google.internal' ||
      host === 'instance-data' ||
      host === 'fd00::'
    ) {
      return false;
    }
    // Block embedded credentials
    if (u.username || u.password) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export const WalletConfigSchema = z.object({
  walletAddress: z
    .string()
    .min(32, 'Solana wallet address must be at least 32 characters')
    .max(44, 'Solana wallet address cannot exceed 44 characters')
    .regex(SOLANA_ADDRESS_REGEX, 'Invalid Base58 Solana public key address'),
  rpcEndpoint: z
    .string()
    .url('RPC Endpoint must be a valid HTTP or HTTPS URL')
    .refine(isSafeExternalUrl, 'RPC Endpoint cannot point to private metadata services or use embedded credentials')
    .default(DEFAULT_RPC_URL),
  wsRpcEndpoint: z
    .string()
    .url('WebSocket RPC must be a valid WS or WSS URL')
    .refine(isSafeExternalUrl, 'WebSocket RPC cannot point to private metadata services')
    .optional(),
  // '' means Jito is disabled (the fail-closed default). There is no mainnet default.
  jitoBlockEngineUrl: z
    .string()
    .refine(
      (v) => v === '' || (z.string().url().safeParse(v).success && isSafeExternalUrl(v)),
      'Jito Block Engine must be empty (disabled) or a valid URL that does not point to private metadata services'
    )
    .default(''),
  jitoTipAccount: z
    .string()
    .regex(SOLANA_ADDRESS_REGEX, 'Invalid Jito tip account public key')
    .default('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'),
  jitoTipSol: z.number().min(0.0001).max(0.2).default(0.002),
  slippageToleranceBps: z.number().min(10).max(5000).default(600), // 6.0% default for meme volatility
  capitalTier: z.enum(['MICRO_10', 'INSTITUTIONAL', 'CUSTOM']).default('MICRO_10'),
  allocatedSol: z.number().min(0.01).max(5000).default(0.07), // ~0.07 SOL = ~$10
  autoStartTrading: z.boolean().default(false), // STRICT SAFETY: Always false by default
  enabledStrategies: z.object({
    pumpFunSniper: z.boolean().default(true),
    marketMaking: z.boolean().default(false),
    crossArb: z.boolean().default(false),
    momentumScalp: z.boolean().default(false),
  }),
  riskLimits: z.object({
    maxDailyLossUsd: z.number().min(1).max(100000).default(2.5),
    maxPositionSizeSol: z.number().min(0.005).max(50).default(0.02),
    stopLossPct: z.number().min(5).max(90).default(20),
    takeProfitMultiple: z.number().min(1.2).max(50).default(1.5),
    requireConfluenceScore: z.number().min(0).max(100).default(70),
  }),
});

export const LiveSnipeOrderSchema = z.object({
  mint: z
    .string()
    .regex(SOLANA_ADDRESS_REGEX, 'Target token mint must be a valid Base58 Solana address'),
  amountSol: z.number().positive('Snipe amount must be greater than 0').max(10.0),
  slippagePct: z.number().min(0.5).max(50.0).default(6.0),
  jitoTipSol: z.number().min(0.0001).max(0.1).default(0.005),
  callerHandle: z.string().optional(),
  confluenceScore: z.number().min(0).max(100).optional(),
});

export const ClosePositionSchema = z.object({
  positionId: z.string().min(1, 'positionId is required'),
  sellPct: z.number().min(1).max(100).default(100),
  priorityTipSol: z.number().min(0.0001).max(0.1).default(0.005),
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

const rateLimitBuckets = new Map<string, RateLimitBucket>();

export function rateLimiter(opts: { maxTokens: number; refillRatePerSec: number }) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = (req.headers['x-api-key'] as string) || req.ip || 'global';
    const now = Date.now();

    let bucket = rateLimitBuckets.get(key);
    if (!bucket) {
      bucket = { tokens: opts.maxTokens, lastRefillMs: now };
      rateLimitBuckets.set(key, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsedSec = (now - bucket.lastRefillMs) / 1000;
    bucket.tokens = Math.min(opts.maxTokens, bucket.tokens + elapsedSec * opts.refillRatePerSec);
    bucket.lastRefillMs = now;

    if (bucket.tokens < 1) {
      res.setHeader('Retry-After', '1');
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
}

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
