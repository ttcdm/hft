import '../suppress-warnings.cjs';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator, EXIT_RETRY_BASE_MS } from '../server/execution/coordinator';
import { PumpSwapVenueService as PumpSwapService } from '../server/solana/pumpSwapService';

/**
 * S271 review: devnet run 15 set the wall clock 18.69 h ahead and back. Three exit-path timers took a wall-clock time stamped under the
 * later clock as "still in the future" after it was set back: a failed sell's retry backoff, the PumpSwap pool cache and the pending-sell
 * window. Real coordinator and PumpSwapService; vitest fakes Date (and performance where the cache reads it); the RPC is a double.
 */
const HOURS_18 = 18 * 3_600_000;
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('S271 review: exit-path timers after the wall clock is set back', () => {
  it('a failed LIVE sell recorded under a clock 18 h ahead backs off its own wait, not 18 h', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const c = new ExecutionCoordinator();
    try {
      vi.setSystemTime(Date.now() + HOURS_18);
      (c as any).recordExitOutcome('pos-clock', { success: false, error: 'custom program error: 0x1772 (slippage)' }, 'LIVE');
      vi.setSystemTime(Date.now() - HOURS_18);
      const wait = c.exitRetryWaitMs('pos-clock');
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(EXIT_RETRY_BASE_MS); // was about 18 h
    } finally {
      c.cleanup();
    }
  });

  it('a PumpSwap pool cached under a clock 18 h ahead expires after its TTL once the clock is set back', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    const conn = { getAccountInfo: vi.fn(async () => null) }; // "no pool", which is cached too
    const mint = Keypair.generate().publicKey;
    vi.setSystemTime(Date.now() + HOURS_18);
    expect(await PumpSwapService.getPoolState(conn as any, mint, 'PAPER')).toBeNull();
    vi.setSystemTime(Date.now() - HOURS_18);
    vi.advanceTimersByTime(16_000); // past the 15 s TTL
    await PumpSwapService.getPoolState(conn as any, mint, 'PAPER');
    expect(conn.getAccountInfo).toHaveBeenCalledTimes(2); // re-read, not served from a cache the old clock kept "fresh"
  });
});
