import { describe, it, expect, afterEach, vi } from 'vitest';
import { RpcRateLimiter, boundedRpcFetch, createTradingConnection, rpcMaxRequestsPerSec } from '../server/solana/rpcConnection';

/**
 * S245: RPC_MAX_REQUESTS_PER_SEC, the optional client-side cap on the trading Connection's request rate (the devnet harness sets 10 against
 * the public devnet RPC). Real RpcRateLimiter, boundedRpcFetch and createTradingConnection; the network double is globalThis.fetch;
 * time is vitest's fake clock, so nothing waits for real and no assertion reads a wall clock.
 */
const body = (method: string) => JSON.stringify({ jsonrpc: '2.0', id: '1', method, params: [] });
const ok = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', result: { context: { slot: 1 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 9 } } }), { status: 200 });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('S245: RPC_MAX_REQUESTS_PER_SEC', () => {
  it('is off unless set to a positive number', () => {
    expect(rpcMaxRequestsPerSec({})).toBe(0);
    expect(rpcMaxRequestsPerSec({ RPC_MAX_REQUESTS_PER_SEC: '0' })).toBe(0);
    expect(rpcMaxRequestsPerSec({ RPC_MAX_REQUESTS_PER_SEC: 'fast' })).toBe(0);
    expect(rpcMaxRequestsPerSec({ RPC_MAX_REQUESTS_PER_SEC: '10' })).toBe(10);
  });

  it('off: every request reaches fetch at once, with no timer queued', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok());
    const f = boundedRpcFetch(1500, 0);
    await Promise.all(Array.from({ length: 20 }, () => f('http://127.0.0.1:8899', { method: 'POST', body: body('getSlot') })));
    expect(fetchSpy).toHaveBeenCalledTimes(20);
  });

  it('spaces request starts 1000/N ms apart, and a waiting send goes before the waiting reads', async () => {
    vi.useFakeTimers();
    const limiter = new RpcRateLimiter(10);
    const order: string[] = [];
    const take = (name: string, send: boolean) => limiter.acquire(send).then(() => order.push(name));
    const all = [take('r1', false), take('r2', false), take('r3', false), take('s1', true), take('r4', false), take('s2', true)];
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['r1']); // the first slot is free
    await vi.advanceTimersByTimeAsync(99);
    expect(order).toEqual(['r1']);
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(['r1', 's1']); // the sends jump the queued reads, in their own order
    await vi.advanceTimersByTimeAsync(100);
    expect(order).toEqual(['r1', 's1', 's2']);
    await vi.advanceTimersByTimeAsync(300);
    await Promise.all(all);
    expect(order).toEqual(['r1', 's1', 's2', 'r2', 'r3', 'r4']);
    expect(limiter.queued).toBe(0);
  });

  it('set through the env, the trading Connection is throttled: three reads at once reach fetch one interval apart', async () => {
    vi.useFakeTimers();
    vi.stubEnv('RPC_MAX_REQUESTS_PER_SEC', '4'); // 250 ms apart; a rate no other test uses, so its shared limiter is fresh
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok());
    const conn = createTradingConnection('http://127.0.0.1:8899');
    const reads = [conn.getLatestBlockhash(), conn.getLatestBlockhash(), conn.getLatestBlockhash()];
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    await Promise.all(reads);
  });

  it('through boundedRpcFetch a sendTransaction queued behind reads reaches fetch right after the one in flight', async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u: any, init: any) => { seen.push(JSON.parse(init.body).method); return ok(); });
    const f = boundedRpcFetch(1500, 5); // 200 ms apart; a rate no other test uses
    const req = (m: string) => f('http://127.0.0.1:8899', { method: 'POST', body: body(m) });
    const all = [req('getSlot'), req('getBalance'), req('getAccountInfo'), req('sendTransaction')];
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(all);
    expect(seen).toEqual(['getSlot', 'sendTransaction', 'getBalance', 'getAccountInfo']);
  });
});
