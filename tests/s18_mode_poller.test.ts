import { describe, it, expect, vi, afterEach } from 'vitest';
import * as engineClient from '../src/services/engineClient';
import { subscribeTradingMode } from '../src/utils/tradingMode';

describe('S18: the shared mode poller notifies every subscriber on every tick, even when the poll fails', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('two subscribers are both called on a tick whose poll threw, and polling stops when the last one leaves', async () => {
    vi.useFakeTimers();
    const auth = vi.spyOn(engineClient, 'authFetch').mockRejectedValue(new Error('server down'));
    const a = vi.fn(); const b = vi.fn();
    const offA = subscribeTradingMode(a);
    const offB = subscribeTradingMode(b);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(b).toHaveBeenCalledTimes(2);
    offA(); offB();
    const calls = auth.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(auth.mock.calls.length).toBe(calls);
  });
});
