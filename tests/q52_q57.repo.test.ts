import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const read = (p: string) => fs.readFileSync(p, 'utf8');

describe('Q52 / Q57 source checks', () => {
  it('the Jito loop stops on a definite on-chain revert, and the PumpSwap sell adds a tip transfer only when the tip is above 0', () => {
    const c = read('server/execution/coordinator.ts');
    expect(c).toContain('if (lastConfirmDefinite) break;');
    expect(c).toMatch(/expectedJitoTipLamports > 0\s*\?\s*\[SystemProgram\.transfer/);
  });
  it('the Binance-testnet account route with invented balances is gone', () => {
    const s = read('server.ts');
    expect(s).not.toContain("app.get('/api/account/balance'");
    expect(s).not.toContain('APEX_INSTITUTIONAL_LEDGER');
  });
});
