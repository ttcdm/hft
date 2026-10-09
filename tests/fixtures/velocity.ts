import { curveVelocityEvaluator } from '../../server/signals/curveVelocityEvaluator';

/**
 * C2: confluence no longer awards velocity points from curve progress. Tests that need a hot curve record real
 * trade flow and reserve transitions for the mint, exactly as the feed listener does. 12 SOL of buys inside
 * 10s with the reserves rising scores the full 15 velocity points.
 */
export function seedSurge(mint: string): void {
  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    curveVelocityEvaluator.recordTradeFlow(mint, 2, true, now - i * 1000, 100 + i);
    curveVelocityEvaluator.recordTransition(mint, 100 + i, 10 + i * 2, now - (5 - i) * 1000);
  }
}

export function clearVelocity(mint?: string): void {
  curveVelocityEvaluator.clear(mint);
}
