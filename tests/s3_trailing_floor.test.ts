import { describe, it, expect } from 'vitest';
import { ExitEngine } from '../server/exits/exitEngine';

/** S3: at +15% the first trailing stop was HWM * 0.85 = 0.9775 x entry, a stop that exits at a loss of about 5% after fees. */
const run = (price: number, hwm: number, stop = 0, stage = 0) =>
  ExitEngine.evaluate({ entryPriceSol: 1, currentPriceSol: price, highWaterMarkSol: hwm, trailingStopSol: stop, exitStage: stage, entryTimestamp: 0, currentTimestamp: 60_000 });

describe('S3: the first trailing stop is never below entry plus costs', () => {
  it('at +15% the stop is 1.03 x entry, not 0.9775 x entry', () => {
    const d = run(1.15, 1.15);
    expect(d.newTrailingStopSol).toBeCloseTo(1.03, 9);
    expect(d.newTrailingStopSol).toBeGreaterThan(1);
    expect(d.shouldExit).toBe(false);
  });
  it('a pull-back from +15% to the stop exits with the entry plus costs covered (the old stop sold below entry)', () => {
    const armed = run(1.15, 1.15);
    const back = run(1.03, 1.15, armed.newTrailingStopSol);
    expect(back.shouldExit).toBe(true);
    expect(back.reason).toBe('TRAILING_STOP');
    // the same price under the old rule would not even have exited yet: 0.9775 < 1.03
    expect(1.15 * ExitEngine.TRAILING_STOP_RATCHET_RATIO).toBeLessThan(1);
  });
  it('higher peaks still use HWM * 0.85, and the stop never decreases', () => {
    const a = run(1.5, 1.5);
    expect(a.newTrailingStopSol).toBeCloseTo(1.275, 9);
    const b = run(1.2, 1.5, a.newTrailingStopSol);
    expect(b.newTrailingStopSol).toBeCloseTo(1.275, 9);
  });
  it('below +15% there is no trailing stop, and the hard stop still applies', () => {
    expect(run(1.1, 1.1).newTrailingStopSol).toBe(0);
    const loss = run(0.79, 1);
    expect(loss.shouldExit).toBe(true);
    expect(loss.reason).toBe('STOP_LOSS');
  });
});
