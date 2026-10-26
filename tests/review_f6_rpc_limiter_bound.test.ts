import { describe, it, expect, afterEach, vi } from 'vitest';
import { RpcRateLimiter, RpcLimiterWaitError, boundedRpcFetch, rpcLimiterMaxWaitMs, DEFAULT_RPC_LIMITER_MAX_WAIT_MS } from '../server/solana/rpcConnection';
import { isRateLimitedSendError } from '../server/solana/transports';

/**
 * Review 2026-10-24, finding 6: the wait for an RPC_MAX_REQUESTS_PER_SEC slot is bounded (RPC_LIMITER_MAX_WAIT_MS). Past the bound the request
 * fails with RPC_LIMITER_WAIT, leaves the queue and is never sent. Real RpcRateLimiter and boundedRpcFetch; the network double is
 * globalThis.fetch; time is vitest's fake clock.
 */
const body = (method: string) => JSON.stringify({ jsonrpc: '2.0', id: '1', method, params: [] });
const ok = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', result: 1 }), { status: 200 });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Finding 6: the RPC limiter wait is bounded', () => {
  it('RPC_LIMITER_MAX_WAIT_MS: a positive number, else the default', () => {
    expect(rpcLimiterMaxWaitMs({})).toBe(DEFAULT_RPC_LIMITER_MAX_WAIT_MS);
    expect(rpcLimiterMaxWaitMs({ RPC_LIMITER_MAX_WAIT_MS: '0' })).toBe(DEFAULT_RPC_LIMITER_MAX_WAIT_MS);
    expect(rpcLimiterMaxWaitMs({ RPC_LIMITER_MAX_WAIT_MS: 'soon' })).toBe(DEFAULT_RPC_LIMITER_MAX_WAIT_MS);
    expect(rpcLimiterMaxWaitMs({ RPC_LIMITER_MAX_WAIT_MS: '750' })).toBe(750);
  });

  it('a request whose slot would come after the bound is rejected at the bound and leaves the queue', async () => {
    vi.useFakeTimers();
    const limiter = new RpcRateLimiter(1); // one slot a second
    const outcome: Record<string, string> = {};
    const take = (name: string) => limiter.acquire(false, 1500).then(() => { outcome[name] = 'served'; }, (e) => { outcome[name] = e.message; });
    const all = [take('r1'), take('r2'), take('r3')];
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toEqual({ r1: 'served' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(outcome.r2).toBe('served'); // its slot came inside the bound
    expect(outcome.r3).toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    expect(outcome.r3).toMatch(/^RPC_LIMITER_WAIT: request got no request slot within 1500 ms/);
    expect(limiter.queued).toBe(0);
    await Promise.all(all);
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.getTimerCount()).toBe(0); // no deadline timer left behind for the requests that were served
  });

  it('through boundedRpcFetch: the read past the bound is never sent and not tried twice; the error names the method', async () => {
    vi.useFakeTimers();
    vi.stubEnv('RPC_LIMITER_MAX_WAIT_MS', '300');
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u: any, init: any) => { seen.push(JSON.parse(init.body).method); return ok(); });
    const f = boundedRpcFetch(1500, 3); // about 333 ms apart; a rate no other test uses, so its shared limiter is fresh
    const first = f('http://127.0.0.1:8899', { method: 'POST', body: body('getSlot') });
    const second = f('http://127.0.0.1:8899', { method: 'POST', body: body('getBalance') }).then(() => 'sent', (e: Error) => e);
    await vi.advanceTimersByTimeAsync(2000);
    await first;
    const err = await second;
    expect(err).toBeInstanceOf(RpcLimiterWaitError);
    expect((err as Error).message).toMatch(/^RPC_LIMITER_WAIT: getBalance got no request slot within 300 ms/);
    expect(seen).toEqual(['getSlot']);
  });

  it('a send refused this way takes the rate-limit resend path (the message reads as a rate limit)', () => {
    expect(isRateLimitedSendError(new RpcLimiterWaitError(3000, 10, 'sendTransaction'))).toBe(true);
    // web3.js wraps a failed send's message; the wrapped text still reads as one
    expect(isRateLimitedSendError(new Error(`failed to send transaction: ${new RpcLimiterWaitError(3000, 10, 'sendTransaction').message}`))).toBe(true);
  });
});

describe('S271: the limiter survives the wall clock moving back', () => {
  it('a slot booked under a later clock does not hold requests once the clock is set back', async () => {
    const { RpcRateLimiter } = await import('../server/solana/rpcConnection');
    const real = Date.now;
    const l = new RpcRateLimiter(10);
    try {
      Date.now = () => real() + 18 * 3_600_000; // the clock runs 18 h ahead for one request
      await l.acquire(false, 3_000);
      Date.now = real; // and is set back
      // before S271 this waited for the slot booked 18 h ahead, so it failed with RPC_LIMITER_WAIT after 3 s
      await expect(l.acquire(false, 3_000)).resolves.toBeUndefined();
    } finally {
      Date.now = real;
    }
  });

  it('wall-clock jumps either way while requests queue change neither the spacing nor the order (the limiter reads the monotonic clock)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const l = new RpcRateLimiter(10); // 100 ms apart
    const served: string[] = [];
    const all = ['a', 'b', 'c', 'd'].map((n) => l.acquire(false, 3_000).then(() => served.push(n)));
    await vi.advanceTimersByTimeAsync(0);
    expect(served).toEqual(['a']);
    vi.setSystemTime(Date.now() + 18 * 3_600_000); // forward: no burst
    await vi.advanceTimersByTimeAsync(50);
    expect(served).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(50);
    expect(served).toEqual(['a', 'b']);
    vi.setSystemTime(Date.now() - 2 * 18 * 3_600_000); // back past the start: no stall
    await vi.advanceTimersByTimeAsync(100);
    expect(served).toEqual(['a', 'b', 'c']);
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all(all);
    expect(served).toEqual(['a', 'b', 'c', 'd']);
  });
});
