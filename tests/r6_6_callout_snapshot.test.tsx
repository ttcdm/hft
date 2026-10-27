import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Keypair } from '@solana/web3.js';
import { pumpFunService, calloutSnapshotFresh, CALLOUT_SNAPSHOT_MAX_AGE_MS, CALLOUT_REFRESH_WITH_WS_MS } from '../server/pumpfunService';
import { pumpFeedListener } from '../server/solana/pumpFeedListener';
import { autoSnipeController } from '../server/auto/controller';
import { CalloutSnapshotAge } from '../src/components/PumpFunHotCalloutsView';

/**
 * R6-6 (haiku-attack 2026-10-26): while the WebSocket streamed, the HTTP poll that refreshes the callouts was skipped, so curve %,
 * market cap, price and multiple froze at creation time and the auto-snipe check read the frozen multiple.
 */
const svc = pumpFunService as any;
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); svc.hotCallouts = []; svc.rawTokensCache = []; });

const createEvent = (receivedAt: number) => ({
  signature: 'sig', slot: 1, mint: Keypair.generate().publicKey.toBase58(), creator: Keypair.generate().publicKey.toBase58(), bondingCurve: Keypair.generate().publicKey.toBase58(),
  name: 'R66', symbol: 'R66', uri: '', virtualTokenReserves: 1_073_000_000_000_000n, virtualSolReserves: 30_000_000_000n, realTokenReserves: 793_100_000_000_000n,
  realSolReserves: 0n, tokenTotalSupply: 1_000_000_000_000_000n, initialPriceSol: 2.8e-8, initialMarketCapSol: 28, receivedAt, parsedAt: receivedAt, parseLatencyMs: 1, source: 'TEST_FEED' as const,
});

describe('R6-6: callout snapshots carry their age, and stay fresh while the WebSocket streams', () => {
  it('a callout built from a create event says when its data is from; the card shows STALE once it is old', () => {
    vi.spyOn(autoSnipeController, 'getMode').mockReturnValue('OFF');
    const at = Date.now() - 40_000;
    pumpFunService.handleOnChainCreateEvent(createEvent(at) as any);
    const c = pumpFunService.getHotCallouts()[0];
    expect(c.dataAsOfMs).toBe(at);
    expect(renderToStaticMarkup(<CalloutSnapshotAge dataAsOfMs={c.dataAsOfMs} now={at + 40_000} />)).toContain('data 40s ago (STALE)');
    expect(renderToStaticMarkup(<CalloutSnapshotAge dataAsOfMs={at} now={at + 3_000} />)).not.toContain('STALE');
  });

  it('the auto-snipe check skips a callout whose snapshot is older than the limit, and reads a fresh one', async () => {
    vi.spyOn(autoSnipeController, 'getMode').mockReturnValue('PAPER');
    const evalSpy = vi.spyOn(pumpFunService, 'evaluateCalloutConfluence');
    const now = Date.now();
    pumpFunService.handleOnChainCreateEvent(createEvent(now - CALLOUT_SNAPSHOT_MAX_AGE_MS - 5_000) as any);
    evalSpy.mockClear();
    await svc.evaluateAutoSnipeTriggers();
    expect(evalSpy).not.toHaveBeenCalled();
    svc.hotCallouts[0].dataAsOfMs = Date.now();
    await svc.evaluateAutoSnipeTriggers();
    expect(evalSpy).toHaveBeenCalledTimes(1);
    expect(calloutSnapshotFresh(undefined, now)).toBe(false);
  });

  it('with the WebSocket active the HTTP refresh still runs every CALLOUT_REFRESH_WITH_WS_MS', () => {
    vi.useFakeTimers();
    vi.spyOn(pumpFeedListener, 'isActive').mockReturnValue(true);
    vi.spyOn(pumpFeedListener, 'getLastEventTimestamp').mockImplementation(() => Date.now());
    const sync = vi.spyOn(pumpFunService, 'syncRealWorldData').mockResolvedValue({});
    svc.initPolling();
    expect(sync).toHaveBeenCalledTimes(1); // the immediate first fetch
    svc.lastHttpSyncAt = Date.now();
    vi.advanceTimersByTime(5_000);
    expect(sync).toHaveBeenCalledTimes(1); // the WebSocket is live and the last refresh is recent
    vi.advanceTimersByTime(CALLOUT_REFRESH_WITH_WS_MS - 5_000); // the next 5 s tick is CALLOUT_REFRESH_WITH_WS_MS after the last refresh
    expect(sync).toHaveBeenCalledTimes(2); // it used to stay at 1 for as long as the WebSocket streamed
  });
});
