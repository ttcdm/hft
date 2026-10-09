import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import type { SignalProvenance } from '../core/types';

/**
 * Validation for every client-reachable trade and close entry point (HTTP and WebSocket).
 *
 * Rules enforced here:
 * - Provenance is set by the server, never read from a client. Operator-initiated trades are always
 *   MANUAL_OPERATOR. Clients cannot choose provenance, confluence gating, eligibility reports,
 *   execution mode or signal/market timestamps; those keys are rejected or stripped.
 * - Numbers must be finite and inside sanity bounds. Position sizing and risk limits are still
 *   enforced downstream by CapitalSizer and RiskEngine; these bounds only stop malformed input.
 */

/** Provenance given to every trade a signed-in operator starts by hand. */
export const OPERATOR_PROVENANCE: SignalProvenance = 'MANUAL_OPERATOR';

export const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Keys a client must never supply on a trade request. Presence is a 400, not a silent strip. */
const FORBIDDEN_TRADE_KEYS = [
  'provenance',
  'enforceConfluence',
  'minConfluenceScore',
  'eligibilityReport',
  'executionMode',
  'signalTimestamp',
  'marketDataTimestamp',
  'source',
] as const;

function rejectForbiddenKeys(value: unknown, ctx: z.RefinementCtx) {
  if (!value || typeof value !== 'object') return;
  for (const key of FORBIDDEN_TRADE_KEYS) {
    if (key in (value as Record<string, unknown>)) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} is set by the server and cannot be supplied by a client`,
      });
    }
  }
}

const address = z.string().trim().regex(SOLANA_ADDRESS, 'must be a valid Base58 Solana address');
const id = z.string().trim().min(1).max(128);

const amountUsd = z.coerce.number().positive().max(100_000).default(5.0);
const jitoTipSol = z.coerce.number().min(0).max(0.1).default(0.005);
const slippagePct = z.coerce.number().min(0.5).max(50).default(8.0);
const sellPct = z.coerce.number().min(1).max(100).default(100);

/** POST /api/memecoins/trade, WS SNIPE_MEMECOIN, POST /api/social/signals/snipe (plus signalId). */
export const OperatorSnipeSchema = z
  .object({
    contractAddress: address,
    amountUsd,
    platform: z.string().trim().max(32).optional(),
    jitoTipSol,
    slippagePct,
    signalId: id.optional(),
  })
  .loose()
  .superRefine(rejectForbiddenKeys)
  .transform(({ contractAddress, amountUsd, platform, jitoTipSol, slippagePct, signalId }) => ({
    contractAddress,
    amountUsd,
    platform,
    jitoTipSol,
    slippagePct,
    signalId,
  }));
export type OperatorSnipe = z.output<typeof OperatorSnipeSchema>;

/** POST /api/social/signals/snipe: the signal supplies the contract, so the client sends only the signal id. */
export const SignalSnipeSchema = z
  .object({
    signalId: id,
    amountUsd,
    platform: z.string().trim().max(32).optional(),
    jitoTipSol,
    slippagePct,
  })
  .loose()
  .superRefine(rejectForbiddenKeys)
  .transform(({ signalId, amountUsd, platform, jitoTipSol, slippagePct }) => ({
    signalId,
    amountUsd,
    platform,
    jitoTipSol,
    slippagePct,
  }));

/** POST /api/pumpfun/callouts/snipe, WS SNIPE_PUMP_CALLOUT. */
export const CalloutSnipeSchema = z
  .object({
    calloutId: id,
    amountUsd,
    jitoTipSol,
    slippagePct: z.coerce.number().min(0.5).max(50).default(6.0),
  })
  .loose()
  .superRefine(rejectForbiddenKeys)
  .transform(({ calloutId, amountUsd, jitoTipSol, slippagePct }) => ({ calloutId, amountUsd, jitoTipSol, slippagePct }));

/** POST /api/memecoins/close, POST /api/execution/close, WS CLOSE_POSITION. */
export const OperatorCloseSchema = z
  .object({
    positionId: id,
    sellPct,
    reason: z.string().trim().max(200).optional(),
  })
  .loose()
  .transform(({ positionId, sellPct, reason }) => ({ positionId, sellPct, reason }));

/** POST /api/execution/trade. Server sets provenance and source. */
export const OperatorExecuteTradeSchema = z
  .object({
    mint: address,
    symbol: z.string().trim().min(1).max(32),
    name: z.string().trim().min(1).max(64),
    amountSol: z.coerce.number().positive().max(1000),
    currentPriceSol: z.coerce.number().positive().optional(),
    slippageBps: z.coerce.number().int().min(1).max(5000).optional(),
    jitoTipSol: z.coerce.number().min(0).max(0.1).optional(),
    liquidityUsd: z.coerce.number().min(0).optional(),
  })
  .loose()
  .superRefine(rejectForbiddenKeys)
  .transform(({ mint, symbol, name, amountSol, currentPriceSol, slippageBps, jitoTipSol, liquidityUsd }) => ({
    mint,
    symbol,
    name,
    amountSol,
    currentPriceSol,
    slippageBps,
    jitoTipSol,
    liquidityUsd,
  }));

/** POST /api/execution/arm and POST /api/wallet/toggle-trading. */
export const ArmSchema = z.object({
  arm: z.coerce.boolean().optional(),
  active: z.coerce.boolean().optional(),
  confirmationCode: z.string().max(64).optional(),
});

/** WS TOGGLE_CALLER_SNIPE, POST /api/pumpfun/callouts/toggle-autosnipe. */
export const ToggleCallerSchema = z.object({ userId: id }).loose().transform(({ userId }) => ({ userId }));

/** POST /api/memecoins/config: a whitelist of the sniper bot settings. Everything else is dropped. */
const SniperConfigFields = z
  .object({
    isAutoSnipeEnabled: z.boolean(),
    minConfidenceScore: z.coerce.number().min(0).max(100),
    defaultSnipeAmountUsd: z.coerce.number().positive().max(100_000),
    maxSlippagePct: z.coerce.number().min(0.5).max(50),
    jitoTipSol: z.coerce.number().min(0).max(0.1),
    takeProfitPct: z.coerce.number().min(0).max(100_000),
    stopLossPct: z.coerce.number().min(0).max(100),
    trailingStopEnabled: z.boolean(),
    requireMintRevoked: z.boolean(),
    requireFreezeRevoked: z.boolean(),
    maxDevHoldingPct: z.coerce.number().min(0).max(100),
    telegramBotToken: z.string().max(256),
    telegramChatId: z.string().max(64),
    telegramWebhookActive: z.boolean(),
  })
  .partial();
const SNIPER_CONFIG_KEYS = new Set(Object.keys(SniperConfigFields.shape));
export const SniperConfigPatchSchema = SniperConfigFields.loose().transform((value) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => SNIPER_CONFIG_KEYS.has(key)))
);

export type ValidationFailure = { status: 'invalid'; error: string; issues: Array<{ path: string; message: string }> };

export function validateTradeInput<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown
): { status: 'valid'; data: z.output<S> } | ValidationFailure {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return { status: 'valid', data: parsed.data };
  return {
    status: 'invalid',
    error: 'INVALID_REQUEST',
    issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  };
}

/** Express middleware: replaces req.body with the validated, server-trusted shape or answers 400. */
export function validateTradeBody(schema: z.ZodTypeAny) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = validateTradeInput(schema, req.body);
    if (result.status === 'invalid') {
      return res.status(400).json({ success: false, status: 'REJECTED', error: result.error, issues: result.issues });
    }
    req.body = result.data;
    next();
  };
}
