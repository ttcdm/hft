import { describe, it, expect } from 'vitest';
import { armRefusalText } from '../src/utils/tradingCopy';

/** From the 2026-10-26 click-through (overnight/reports/click-through-2026-10-26). Fails on c47125e without its fix. */
describe('UI-4: a refused arm shows the server reason', () => {
  it('uses message (what the arm route sends), then reasons, and says LIVE is not armed', () => {
    const t = armRefusalText(403, { success: false, message: 'Cannot arm live trading. Prerequisites failed: Signer: NOT_CONFIGURED', reasons: ['Signer: NOT_CONFIGURED'] });
    expect(t).toContain('Signer: NOT_CONFIGURED');
    expect(t).toMatch(/NOT armed/);
    expect(armRefusalText(403, { reasons: ['a', 'b'] })).toContain('a; b');
    expect(armRefusalText(502, null)).toContain('HTTP 502');
    expect(armRefusalText(403, { message: 'REAL_MONEY_PROHIBITED: disabled.' })).toBe('Arming refused: REAL_MONEY_PROHIBITED: disabled. Live trading is NOT armed.');
  });
});
