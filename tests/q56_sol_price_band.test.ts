import { describe, it, expect } from 'vitest';
import { SolPriceService } from '../server/market/solPriceService';

describe('Q56: the SOL price has a sanity band', () => {
  it('rejects a price outside $1 to $100,000 and a 2x jump against a fresh reading, and accepts a normal move', () => {
    const s = new SolPriceService();
    const t = Date.now();
    expect(s.setPrice(0.5, 'X', t)).toBe(false);
    expect(s.setPrice(250_000, 'X', t)).toBe(false);
    expect(s.setPrice(150, 'A', t)).toBe(true);
    expect(s.setPrice(400, 'B', t + 1000)).toBe(false); // a bad feed, not a market
    expect(s.setPrice(60, 'B', t + 1000)).toBe(false);
    expect(s.lastKnownPrice()).toBe(150);
    expect(s.setPrice(160, 'C', t + 2000)).toBe(true);
    expect(s.setPrice(400, 'D', t + 11 * 60_000)).toBe(true); // an old reading no longer anchors
  });
});
