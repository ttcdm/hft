import fs from 'node:fs';
import { describe, it, expect } from 'vitest';

/** The behavioural proof is `npm run localnet:e2e` step (g) (sell lands, app killed, restart: CLOSED with realized PnL, was 0 before the fix).
 *  This guards the ordering that fix depends on. */
describe('Q18: startup reconciliation applies pending SELLs before the zero-balance close', () => {
  it('step order in startupReconciliation', () => {
    const src = fs.readFileSync('server/execution/coordinator.ts', 'utf8');
    const pending = src.indexOf('// 4. Resolve pending transactions');
    const zero = src.indexOf('RECONCILED_ZERO_BALANCE: no tokens in the wallet at startup');
    expect(pending).toBeGreaterThan(0);
    expect(zero).toBeGreaterThan(pending);
  });
});
