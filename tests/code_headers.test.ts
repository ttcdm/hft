import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

/**
 * The files where money moves keep a header comment that says what the file does, what it must never do, and who calls it. This test only
 * checks that the header is still there (a rewrite that drops it is the usual way it is lost); whether it is true is for review.
 */
const FILES = [
  'server/solana/transactionBuilder.ts',
  'server/solana/pumpSwapService.ts',
  'server/signals/eligibilityFilter.ts',
  'server/core/types.ts',
  'server/solana/transports.ts',
  'server/execution/reconciliation.ts',
];
const UI = ['src/components/MemecoinSocialSniperModal.tsx', 'src/components/PumpFunHotCalloutsView.tsx', 'src/components/PlugAndPlayTradingModal.tsx'];

describe('file headers on the money-moving modules', () => {
  it.each(FILES)('%s opens with a header that says what it must never do and who calls it', (f) => {
    const head = fs.readFileSync(f, 'utf8').split('\n').slice(0, 30).join('\n');
    expect(head.startsWith('/**')).toBe(true);
    expect(head).toMatch(/must never/i);
    expect(head).toMatch(/Called by|Used by/);
  });
  it.each(UI)('%s opens with a header that names the API it calls', (f) => {
    const head = fs.readFileSync(f, 'utf8').split('\n').slice(0, 20).join('\n');
    expect(head.startsWith('/**')).toBe(true);
    expect(head).toMatch(/\/api\//);
  });
});
