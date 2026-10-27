import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { autoSnipeController } from '../server/auto/controller';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { OnChainPoolStats } from '../server/market/poolStats';
import { WatchWindow } from '../server/signals/watchWindow';
import { wireWatchPins } from '../server/signals/watchPins';
import { PumpFeedListener } from '../server/solana/pumpFeedListener';
import { solPriceService } from '../server/market/solPriceService';
import { setAutoMode, resetAuto, releaseAs } from './fixtures/auto';

function createPool(): string {
  const mint = Keypair.generate().publicKey.toBase58();
  const creator = Keypair.generate().publicKey.toBase58();
  const l = new PumpFeedListener();
  const ev = l.parseLogs({ err: null, signature: 's4', logs: PumpFeedListener.asPumpInvocation(PumpFeedListener.encodeCreateEventLog({ name: 'S4', symbol: 'S4', uri: '', mint, creator })) } as any, { slot: 9 })!;
  memecoinAggregator.ingestOnChainCreateEvent(ev);
  l.destroy();
  return mint;
}

describe('S4a: a watched mint keeps its pool and its trade stats at feed rate', () => {
  afterEach(() => memecoinAggregator.setPoolPinned(() => false));

  it('the aggregator keeps a pinned pool past the newest-200 cut, and drops it once unpinned', () => {
    const first = createPool();
    memecoinAggregator.setPoolPinned((m) => m === first);
    for (let i = 0; i < 230; i++) createPool();
    expect(memecoinAggregator.getPools().some((p) => p.contractAddress === first)).toBe(true);
    expect(memecoinAggregator.getPools().length).toBeLessThanOrEqual(201);
    memecoinAggregator.setPoolPinned(() => false);
    createPool();
    expect(memecoinAggregator.getPools().some((p) => p.contractAddress === first)).toBe(false);
  });

  it('poolStats keeps a pinned mint past the 300-mint cut', () => {
    const stats = new OnChainPoolStats();
    stats.setPinned((m) => m === 'PINNED');
    stats.track('PINNED', { insiders: [] });
    for (let i = 0; i < 400; i++) stats.track(`m${i}`, { insiders: [] });
    // get() returns null for a mint with no trades whether it was kept or evicted, so ask the tracker itself
    expect(stats.isTracking('PINNED')).toBe(true);
    expect(stats.isTracking('m0')).toBe(false);
    expect(stats.getEvictedCount()).toBeGreaterThan(0);
    expect(stats.getTrackedCount()).toBeLessThanOrEqual(300);
  });

  it('wireWatchPins ties both caches to the real watch window', () => {
    const ww = new WatchWindow();
    const stats = new OnChainPoolStats();
    const agg = { setPoolPinned: vi.fn() };
    wireWatchPins(ww, agg, stats);
    const pinned = agg.setPoolPinned.mock.calls[0][0] as (m: string) => boolean;
    ww.watch('W', null);
    expect(pinned('W')).toBe(true);
    expect(pinned('other')).toBe(false);
  });
});

describe('S4b: a release that arrives behind a buy in flight is retried, not lost', () => {
  afterEach(async () => { await resetAuto(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('the second HOT release is bought after the first buy settles', async () => {
    solPriceService.setPrice(150, 'TEST_FIXTURE');
    await setAutoMode('PAPER');
    const mintA = createPool(); const mintB = createPool();
    releaseAs(mintA, 'HOT'); releaseAs(mintB, 'HOT');
    let finishA!: () => void;
    const gate = new Promise<void>((r) => { finishA = r; });
    const bought: string[] = [];
    vi.spyOn(memecoinAggregator, 'executeSnipe').mockImplementation(async (p: any) => {
      bought.push(p.contractAddress);
      if (p.contractAddress === mintA) await gate;
      return { success: true, message: 'ok', txHash: 't', amountSol: 0.005, positionId: `pos-${p.contractAddress.slice(0, 4)}`, feesPaidLamports: 0 } as any;
    });
    const cand = (mint: string) => ({ mint, symbol: 'S4', source: 'WATCH_WINDOW' as const, amountUsd: 0.7, provenance: 'REAL_ONCHAIN' as const });
    const first = autoSnipeController.submitCandidate(cand(mintA));
    await new Promise((r) => setTimeout(r, 20));
    const second = await autoSnipeController.submitCandidate(cand(mintB));
    expect(second.outcome).toBe('DROPPED');
    expect(second.reason).toMatch(/ANOTHER_CANDIDATE_IN_FLIGHT: queued/);
    expect(bought).toEqual([mintA]);
    finishA();
    await first;
    for (let i = 0; i < 50 && !bought.includes(mintB); i++) await new Promise((r) => setTimeout(r, 20));
    expect(bought).toEqual([mintA, mintB]);
  });

  it('a queued release whose verdict is no longer HOT/READY is discarded', async () => {
    await setAutoMode('PAPER');
    const mintA = createPool(); const mintB = createPool();
    releaseAs(mintA, 'HOT');
    let finishA!: () => void;
    const gate = new Promise<void>((r) => { finishA = r; });
    const bought: string[] = [];
    vi.spyOn(memecoinAggregator, 'executeSnipe').mockImplementation(async (p: any) => { bought.push(p.contractAddress); await gate; return { success: false, message: 'x' } as any; });
    const cand = (mint: string) => ({ mint, symbol: 'S4', source: 'WATCH_WINDOW' as const, amountUsd: 0.7, provenance: 'REAL_ONCHAIN' as const });
    const first = autoSnipeController.submitCandidate(cand(mintA));
    await new Promise((r) => setTimeout(r, 20));
    await autoSnipeController.submitCandidate(cand(mintB)); // mintB was never watched: queued, but has no verdict
    finishA();
    await first;
    await new Promise((r) => setTimeout(r, 100));
    expect(bought).toEqual([mintA]);
  });
});
