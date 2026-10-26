import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { SELL_SLIPPAGE_LADDER_BPS, EXIT_RETRY_BASE_MS, EXIT_RETRY_MAX_MS } from '../server/execution/coordinator';

/**
 * P1.8 (R1-133): KNOWN_RISKS 2.3 said slippage was capped at 800 bps, while sells widen to 4000 bps after repeated failures. The sell
 * ladder bullet must name the numbers the code uses, so a change to the ladder or the back-off breaks this test until the doc follows.
 */
describe('KNOWN_RISKS 2.3 states the sell slippage ladder the coordinator uses', () => {
  const text = fs.readFileSync('KNOWN_RISKS.md', 'utf8');
  const bullet = text.split('\n').find((l) => l.includes('SELL_SLIPPAGE_LADDER_BPS'));

  it('the ladder numbers are the exported SELL_SLIPPAGE_LADDER_BPS, in order, and the old single-cap claim is gone', () => {
    expect(bullet, 'expected a bullet naming SELL_SLIPPAGE_LADDER_BPS').toBeDefined();
    expect(text).not.toMatch(new RegExp(`strictly enforces an ${SELL_SLIPPAGE_LADDER_BPS[0]} bps`));
    const m = bullet!.match(/ladder ((?:\d[\d,]*(?:, )?)+) bps/);
    expect(m, 'expected "ladder N, N, ... bps"').not.toBeNull();
    const documented = m![1].split(', ').map((n) => Number(n.replace(/,/g, '')));
    expect(documented).toEqual(SELL_SLIPPAGE_LADDER_BPS);
  });

  it('the widest step is stated as a percentage that matches the last rung', () => {
    const pct = bullet!.match(/up to (\d+)% less than quoted/);
    expect(pct).not.toBeNull();
    expect(Number(pct![1]) * 100).toBe(SELL_SLIPPAGE_LADDER_BPS[SELL_SLIPPAGE_LADDER_BPS.length - 1]);
  });

  it('the back-off it names starts at EXIT_RETRY_BASE_MS and stops at EXIT_RETRY_MAX_MS', () => {
    const waits = bullet!.match(/waits ([\d, ]+), then (\d+) s/);
    expect(waits).not.toBeNull();
    expect(Number(waits![1].split(', ')[0]) * 1000).toBe(EXIT_RETRY_BASE_MS);
    expect(Number(waits![2]) * 1000).toBe(EXIT_RETRY_MAX_MS);
  });
});
