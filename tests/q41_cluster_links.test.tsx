import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TokenBoardView, BOARD_STALE_MS, type BoardData } from '../src/components/TokenBoard';
import { getTokenExternalLinks } from '../src/utils/tokenLinks';

/** Q41: on devnet / localnet the explorer link needs the cluster, and the mainnet-only sites cannot show the token. */
describe('Q41: external links follow the cluster', () => {
  const mint = 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS';
  const byId = (cluster?: string | null) => Object.fromEntries(getTokenExternalLinks({ mintOrCa: mint, symbol: 'T', cluster }).map((l) => [l.id, l]));

  it('devnet: Solscan carries ?cluster=devnet, the mainnet-only sites are unavailable and say why', () => {
    const l = byId('devnet');
    expect(l.solscan.url).toBe(`https://solscan.io/token/${mint}?cluster=devnet`);
    expect(l.solscan.isAvailable).toBe(true);
    for (const id of ['dexscreener', 'pumpfun', 'gmgn', 'birdeye', 'photon', 'bullx', 'axiom']) {
      expect(l[id].isAvailable, id).toBe(false);
      expect(l[id].description, id).toMatch(/Mainnet only: this token is on devnet/);
    }
    expect(l.twitter.isAvailable).toBe(true);
  });

  it('localnet points Solscan at the local validator; mainnet and unknown clusters are unchanged', () => {
    expect(byId('localnet').solscan.url).toBe(`https://solscan.io/token/${mint}?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899`);
    for (const c of ['mainnet-beta', null, undefined]) {
      const l = byId(c);
      expect(l.solscan.url).toBe(`https://solscan.io/token/${mint}`);
      expect(l.dexscreener.isAvailable).toBe(true);
    }
  });
});

describe('Q41: the board shows how old it is', () => {
  const board: BoardData = {
    generatedAt: 1, executionMode: 'PAPER', wallet: { balanceSol: 1, reserveSol: 0.015, rentLockedSol: null, spendableSol: 1, solUsd: 150 },
    launches: [], watching: [], holding: [], watchCapacity: { active: 60, max: 60, refusedFull: 7, lastRefusedMint: 'M' },
  } as any;
  const html = (ageMs: number | null | undefined) => renderToStaticMarkup(<TokenBoardView board={board} tab="launches" onTab={() => undefined} ageMs={ageMs} />);

  it('fresh is plain, past the limit is marked STALE, never received says so, and a full watch window is reported', () => {
    expect(html(2000)).toMatch(/updated 2s ago/);
    expect(html(2000)).not.toMatch(/STALE/);
    expect(html(BOARD_STALE_MS + 1000)).toMatch(/updated 11s ago \(STALE\)/);
    expect(html(null)).toMatch(/no board received yet/);
    expect(html(2000)).toMatch(/watch full: 7 launches skipped/);
    expect(html(undefined)).not.toMatch(/board-age/);
  });
});
