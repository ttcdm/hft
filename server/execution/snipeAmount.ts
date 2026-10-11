import { executionConfig } from '../solana/executionConfig';

/** Smallest manual snipe the operator can ask for. Below this the fixed network fee and the token account rent swallow the order. */
export const SNIPE_AMOUNT_MIN_SOL = 0.001;
/** What the screens start with when nothing was saved: smaller than the old $5 default, well inside MAX_POSITION_SIZE_SOL's default. */
export const SNIPE_AMOUNT_DEFAULT_SOL = 0.01;

export type SnipeAmountCheck = { ok: true; amountSol: number } | { ok: false; code: 'INVALID' | 'BELOW_MINIMUM' | 'ABOVE_POSITION_CAP'; reason: string };

/**
 * S181: judge an operator-chosen snipe size. It is refused with a plain reason, never clamped: a smaller order than the one asked for
 * would be a trade the operator did not choose. The bankroll ceiling, fees and rent are still enforced downstream by the coordinator.
 */
export function checkSnipeAmountSol(amountSol: unknown, maxPositionSol: number = executionConfig.getConfig().maxPositionSizeSol): SnipeAmountCheck {
  if (typeof amountSol !== 'number' || !Number.isFinite(amountSol) || amountSol <= 0) {
    return { ok: false, code: 'INVALID', reason: 'REJECTED: SNIPE_AMOUNT_INVALID: the snipe amount must be a number of SOL above 0.' };
  }
  if (amountSol < SNIPE_AMOUNT_MIN_SOL) {
    return { ok: false, code: 'BELOW_MINIMUM', reason: `REJECTED: SNIPE_AMOUNT_TOO_SMALL: ${amountSol} SOL is below the ${SNIPE_AMOUNT_MIN_SOL} SOL minimum; the network fee and token account rent would eat the order.` };
  }
  if (amountSol > maxPositionSol + 1e-9) {
    return { ok: false, code: 'ABOVE_POSITION_CAP', reason: `REJECTED: SNIPE_AMOUNT_ABOVE_CAP: ${amountSol} SOL is above the ${maxPositionSol} SOL maximum position size (MAX_POSITION_SIZE_SOL). Lower the amount, or raise MAX_POSITION_SIZE_SOL in .env and restart.` };
  }
  return { ok: true, amountSol };
}

/** What the screens need to show and pre-check the amount. */
export function getSnipeLimits(solPriceUsd: number | null) {
  return {
    minSol: SNIPE_AMOUNT_MIN_SOL,
    maxSol: executionConfig.getConfig().maxPositionSizeSol,
    defaultSol: SNIPE_AMOUNT_DEFAULT_SOL,
    solPriceUsd: solPriceUsd !== null && Number.isFinite(solPriceUsd) && solPriceUsd > 0 ? solPriceUsd : null,
  };
}
