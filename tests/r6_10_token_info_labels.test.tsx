import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Keypair } from '@solana/web3.js';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { watchWindow } from '../server/signals/watchWindow';
import { buildBoard } from '../server/board';
import { PumpFunService } from '../server/pumpfunService';
import { authorityBadge } from '../src/utils/authorityBadge';
import { calloutActionLabel, calloutActionTitle, InventedCallerTag } from '../src/components/PumpFunHotCalloutsView';
import { TokenBoardView } from '../src/components/TokenBoard';

/** R6-10 (haiku-attack 2026-10-26): token info under trusted-looking labels that were unverified or computed differently. */
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('R6-10: honest token-info labels', () => {
  it('a revoked authority the third-party feed reported is not a green "Mint Revoked"', () => {
    expect(authorityBadge('Mint', true, 'the pump.fun feed')).toEqual({ text: 'Mint revoked per the pump.fun feed (not checked on chain)', tone: 'unknown' });
    expect(authorityBadge('Mint', false, 'the pump.fun feed').tone).toBe('bad');
    expect(fs.readFileSync('src/components/PumpFunHotCalloutsView.tsx', 'utf8')).toContain("authorityBadge('Mint', c.token.isMintRevoked as boolean | null, 'the pump.fun feed')");
  });

  it('the DexScreener-boost "confluence" and INSTANT_SNIPE are labelled as feed signals with a paid boost, not a confluence hit', () => {
    expect(calloutActionLabel('INSTANT_SNIPE')).toBe('LISTED + BOOSTED');
    expect(calloutActionTitle('INSTANT_SNIPE')).toMatch(/paid boost/);
    expect(calloutActionLabel('DUMP_RISK')).toBe('DUMP RISK');
    const src = fs.readFileSync('src/components/PumpFunHotCalloutsView.tsx', 'utf8');
    expect(src).not.toContain('CONFLUENCE HIT');
    expect(src).not.toContain('Pump.fun Official Top Caller Rankings');
    expect(src).not.toContain('Verifiable on-chain track records');
  });

  it('DEMO_MODE callers are flagged invented, and the tag says so', () => {
    vi.stubEnv('DEMO_MODE', 'true');
    const demo = new PumpFunService();
    const callers = demo.getLeaderboard();
    expect(callers.length).toBeGreaterThan(0);
    expect(callers.every((c) => c.invented === true)).toBe(true);
    expect(renderToStaticMarkup(<InventedCallerTag />)).toContain('INVENTED (DEMO)');
    vi.stubEnv('DEMO_MODE', '');
    expect(new PumpFunService().getLeaderboard()).toEqual([]);
  });

  it('the board Age is measured from the watch window, not the fixed "Just now (WS)"; Top10 says its basis', () => {
    const mint = Keypair.generate().publicKey.toBase58();
    memecoinAggregator.ingestOnChainCreateEvent({
      signature: 's', slot: 1, mint, creator: Keypair.generate().publicKey.toBase58(), bondingCurve: Keypair.generate().publicKey.toBase58(), name: 'R610', symbol: 'R610', uri: '',
      virtualTokenReserves: 1_073_000_000_000_000n, virtualSolReserves: 30_000_000_000n, realTokenReserves: 793_100_000_000_000n, realSolReserves: 0n, tokenTotalSupply: 1_000_000_000_000_000n,
      initialPriceSol: 2.8e-8, initialMarketCapSol: 28, receivedAt: Date.now(), parsedAt: Date.now(), parseLatencyMs: 1, source: 'TEST_FEED',
    } as any);
    const unwatched = buildBoard().launches.find((l) => l.mint === mint)!;
    expect(unwatched.createdAgo).toBeNull();
    const t0 = Date.now() - 42_000;
    watchWindow.watch(mint, Keypair.generate().publicKey.toBase58(), t0);
    const board = buildBoard();
    const row = board.launches.find((l) => l.mint === mint)!;
    expect(row.createdAgo).toMatch(/^\d+s$/); // measured by the watch window
    const html = renderToStaticMarkup(<TokenBoardView board={JSON.parse(JSON.stringify(board))} tab="launches" onTab={() => {}} />);
    expect(html).toContain('Top10 % (off-curve)');
    expect(html).not.toContain('Just now (WS)');
  });
});
