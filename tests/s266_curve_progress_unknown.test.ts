import { describe, it, expect } from 'vitest';
import { curveProgressPctOfState, curveProgressUnreadable } from '../server/signals/curveProgressCap';
import { CURVE_INITIAL_REAL_TOKENS } from '../server/market/poolStats';

/**
 * S266 (review 2026-10-24, finding 8): curve progress is the share of the curve's tokens sold. With the token reserves unreadable the cap
 * used to fall back to SOL/85 (about 28% at a real 60%), a wrong figure that looked measured. Now the progress is unknown (null), and
 * curveProgressUnreadable names that state (the coordinator refuses a LIVE buy on it: tests/review_f8_live_buy_unreadable_curve.test.ts). The real functions; the states are plain values.
 */
describe('S266: curve progress without readable token reserves is unknown, not a SOL estimate', () => {
  it('62% of the tokens sold reads 62, whatever the SOL reserves say', () => {
    const tok = CURVE_INITIAL_REAL_TOKENS - (CURVE_INITIAL_REAL_TOKENS * 62n) / 100n;
    expect(curveProgressPctOfState({ realTokenReserves: tok, realSolReserves: 24_000_000_000n })).toBeCloseTo(62, 6);
    expect(curveProgressUnreadable({ realTokenReserves: tok, realSolReserves: 24_000_000_000n })).toBe(false);
  });

  it('SOL reserves readable, token reserves not: progress null and the state is unreadable (was SOL/85, about 28%)', () => {
    const st = { realTokenReserves: undefined, realSolReserves: 24_000_000_000n };
    expect(curveProgressPctOfState(st)).toBeNull();
    expect(curveProgressUnreadable(st)).toBe(true);
  });

  it('neither readable (a state that is not a curve): null, and not flagged as an unreadable curve', () => {
    expect(curveProgressPctOfState({})).toBeNull();
    expect(curveProgressUnreadable({})).toBe(false);
  });
});
