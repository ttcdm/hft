import { describe, it, expect } from 'vitest';
import { mainnetLinksAvailable, isMainnetDataProvenance, getTokenExternalLinks, MAINNET_ONLY_LINK_IDS } from '../src/utils/tokenLinks';

const MINT = '4gWDfyqELKDoVv1xv3Z7mHcQWoCqxTbNQGDFh2h3pump';

describe('S184 a mainnet token gets its mainnet links even when the server is on devnet', () => {
  it('links are available for a mainnet-sourced token on any cluster, and for any token on mainnet; a devnet-made token on devnet gets none', () => {
    for (const cluster of ['devnet', 'localnet', null, undefined, 'unknown']) {
      expect(mainnetLinksAvailable(cluster, true), String(cluster)).toBe(true);
      expect(mainnetLinksAvailable(cluster, false), String(cluster)).toBe(false);
    }
    expect(mainnetLinksAvailable('mainnet-beta', false)).toBe(true);
  });

  it('only provenances that come from a mainnet source count', () => {
    expect(isMainnetDataProvenance('PUMP_HTTP_API')).toBe(true);
    expect(isMainnetDataProvenance('REAL_SOCIAL')).toBe(true);
    for (const p of ['SYNTHETIC_SIMULATION', 'PAPER_REPLAY', 'MANUAL_OPERATOR', 'LIVE_PUMP_STREAM', undefined, null]) expect(isMainnetDataProvenance(p as any), String(p)).toBe(false);
  });

  it('the link builder, given the mainnet cluster for such a token, returns real DexScreener / pump.fun / GMGN URLs for the mint and Solscan without a cluster suffix', () => {
    const links = getTokenExternalLinks({ mintOrCa: MINT, symbol: 'CURLY', cluster: 'mainnet-beta' });
    const by = (id: string) => links.find((l) => l.id === id)!;
    expect(by('dexscreener').url).toBe(`https://dexscreener.com/solana/${MINT}`);
    expect(by('pumpfun').url).toBe(`https://pump.fun/coin/${MINT}`);
    expect(by('gmgn').url).toContain(MINT);
    expect(by('solscan').url).not.toContain('cluster=');
    for (const id of MAINNET_ONLY_LINK_IDS) expect(links.find((l) => l.id === id)?.mainnetOnly ?? false, id).toBe(false);
  });

  it('on a devnet server the same call still marks them mainnet-only (a devnet-made token has no page)', () => {
    const links = getTokenExternalLinks({ mintOrCa: MINT, symbol: 'X', cluster: 'devnet' });
    expect(links.find((l) => l.id === 'dexscreener')!.mainnetOnly).toBe(true);
    expect(links.find((l) => l.id === 'solscan')!.url).toContain('cluster=devnet');
  });
});
