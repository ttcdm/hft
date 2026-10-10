import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { isMainnetCluster, solscanAccountUrl } from '../src/utils/tokenLinks';

const read = (p: string) => fs.readFileSync(p, 'utf8');

describe('S19/S20 UI truth', () => {
  it('unknown cluster is not mainnet', () => {
    expect(isMainnetCluster(null)).toBe(false);
    expect(isMainnetCluster('devnet')).toBe(false);
    expect(isMainnetCluster('mainnet-beta')).toBe(true);
  });
  it('solscan account links name the cluster and refuse an unknown one', () => {
    expect(solscanAccountUrl('A', 'devnet')).toContain('?cluster=devnet');
    expect(solscanAccountUrl('A', 'localnet')).toContain('cluster=custom');
    expect(solscanAccountUrl('A', null)).toBeNull();
  });
  it('components have no unconditional mainnet hrefs or unconditional LIVE badges', () => {
    for (const f of ['src/components/MemecoinSocialSniperModal.tsx', 'src/components/PumpFunHotCalloutsView.tsx']) {
      const s = read(f);
      expect(s).toContain('isMainnetCluster(tradingMode.cluster)');
      expect(s).not.toMatch(/href=\{`https:\/\/solscan\.io\/account/);
      expect(s).not.toContain('LIVE INGESTION');
      expect(s).not.toContain('LIVE API v3');
      expect(s).not.toContain('SNIPED IN BLOCK SLOT');
    }
  });
  it('migrated tokens do not report an invented 0% dev holding', () => {
    expect(read('server/pumpfunService.ts')).not.toMatch(/devHoldingPct: c\.complete \? 0/);
  });
});
