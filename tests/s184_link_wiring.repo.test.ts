import { describe, it, expect } from 'vitest';
import fs from 'fs';

const read = (f: string) => fs.readFileSync(f, 'utf8');

describe('S184 the screens use it', () => {
  it('callout cards always show PUMP / DEX / GMGN / SCAN (callouts come from the mainnet list); the snipe stays MAINNET ONLY off mainnet', () => {
    const s = read('src/components/PumpFunHotCalloutsView.tsx');
    expect(s).toContain('mainnetLinksAvailable(tradingMode.cluster, true');
    expect(s).toContain('https://dexscreener.com/solana/${c.token.mint}');
    expect(s).toContain('https://solscan.io/token/${c.token.mint}');
    expect(s).toContain("'MAINNET ONLY'"); // the snipe is not a link: it still needs the token to exist on this cluster
  });
  it('signals follow their provenance and callout-made pools pass mainnetToken to the link row and its dialog', () => {
    const s = read('src/components/MemecoinSocialSniperModal.tsx');
    expect(s).toContain('isMainnetDataProvenance(sig.provenance)');
    expect(s).toContain("mainnetToken={pool.id.startsWith('pool-callout-')}");
    expect(s).toContain("mainnetToken: pool.id.startsWith('pool-callout-')");
    const v = read('src/components/TokenExternalLinksView.tsx');
    expect(v).toContain("mainnetToken ? 'mainnet-beta'");
    expect(v).toContain("tokenData.mainnetToken ? 'mainnet-beta'");
  });
});
