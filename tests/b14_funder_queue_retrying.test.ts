import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { FunderLookup } from '../server/signals/funderLookup';

/**
 * B14 (review 2026-10-24, finding 14): the funder queue bound (FUNDER_LOOKUP_MAX_QUEUE) counted only `queue.length`, so jobs waiting in
 * a retry timer were left out and, under a 429 storm, the lookups pending at once could exceed the bound. The production FunderLookup
 * runs against a Connection double whose history read always fails (index lag), so every job goes to a retry timer.
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const wallet = () => Keypair.generate().publicKey.toBase58();

function failingConn() {
  const calls: string[] = [];
  const conn: any = {
    getSignaturesForAddress: async (k: any) => { calls.push(k.toBase58()); return []; }, // "no signatures yet": an ERROR that is retried
    getParsedTransaction: async () => null,
  };
  return { conn, calls };
}

describe('B14: jobs waiting to retry count toward the queue bound', () => {
  it('three jobs in retry timers fill a queue of 3: the fourth request is refused', async () => {
    vi.useFakeTimers();
    const { conn, calls } = failingConn();
    const l = new FunderLookup(() => conn, { concurrency: 2, maxQueue: 3, retryDelaysMs: [60_000, 60_000] });
    for (let i = 0; i < 3; i++) l.request(wallet(), 'A');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(3);
    expect(l.getStats()).toMatchObject({ queued: 0, retrying: 3, inFlight: 0, refusedFull: 0 });
    l.request(wallet(), 'A');
    await vi.advanceTimersByTimeAsync(0);
    expect(l.getStats()).toMatchObject({ queued: 0, retrying: 3, refusedFull: 1 }); // before B14 it was accepted: 4 pending with a bound of 3
    expect(calls).toHaveLength(3);
  });

  it('a full queue drops retrying jobs of released mints first, and their timers never reach the RPC again', async () => {
    vi.useFakeTimers();
    const { conn, calls } = failingConn();
    const watching = new Set(['A', 'B']);
    const l = new FunderLookup(() => conn, { concurrency: 4, maxQueue: 3, retryDelaysMs: [1_000] });
    l.setWanted((m) => watching.has(m));
    const released = [wallet(), wallet(), wallet()];
    for (const w of released) l.request(w, 'A');
    await vi.advanceTimersByTimeAsync(0);
    expect(l.getStats().retrying).toBe(3);
    watching.delete('A');
    const kept = wallet();
    l.request(kept, 'B');
    expect(l.getStats()).toMatchObject({ retrying: 0, dropped: 3, refusedFull: 0 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.filter((c) => released.includes(c))).toHaveLength(3); // the first try only, no retry after the drop
    expect(calls.filter((c) => c === kept)).toHaveLength(2); // the B wallet: first try and its one retry
  });

  it('a retrying wallet asked for again is not looked up twice, and the retry leaves the retry count', async () => {
    vi.useFakeTimers();
    const { conn, calls } = failingConn();
    const l = new FunderLookup(() => conn, { concurrency: 1, maxQueue: 10, retryDelaysMs: [1_000] });
    const w = wallet();
    l.request(w, 'A');
    await vi.advanceTimersByTimeAsync(0);
    l.request(w, 'B');
    expect(l.getStats()).toMatchObject({ queued: 0, retrying: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(l.getStats()).toMatchObject({ queued: 0, retrying: 0, inFlight: 0 });
    expect(calls).toEqual([w, w]);
  });
});
