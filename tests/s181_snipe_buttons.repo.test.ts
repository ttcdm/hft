import { describe, it, expect } from 'vitest';
import fs from 'fs';

describe('S181 every snipe button reads the shared amount', () => {
  const read = (f: string) => fs.readFileSync(f, 'utf8');
  it('no snipe handler has a hardcoded $5 / $25 size any more, and the requests carry amountSol', () => {
    for (const f of ['src/components/PumpFunHotCalloutsView.tsx', 'src/components/MemecoinSocialSniperModal.tsx', 'src/components/PlugAndPlayTradingModal.tsx']) {
      const src = read(f);
      expect(src, f).toContain('useSnipeAmount()');
      expect(src, f).not.toContain('Snipe with $5 Micro');
      expect(src, f).not.toMatch(/Snipe \$\{capitalTier/);
    }
    expect(read('src/components/PumpFunHotCalloutsView.tsx')).not.toMatch(/const defaultAmount/);
    expect(read('src/components/MemecoinSocialSniperModal.tsx')).not.toMatch(/const amount = capitalTier/);
    expect(read('src/components/PumpFunHotCalloutsView.tsx')).toContain('<SnipeAmountControl />');
    expect(read('src/components/PlugAndPlayTradingModal.tsx')).toContain('<SnipeAmountControl compact />');
    expect(read('src/services/engineClient.ts')).toMatch(/signalId, amountSol, jitoTipSol/);
    expect(read('src/services/engineClient.ts')).toMatch(/calloutId, amountSol, jitoTipSol/);
    expect(read('src/utils/poolSnipe.ts')).toContain('amountSol,');
  });
});

