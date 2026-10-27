import { describe, it, expect, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { PumpCurveService, RPC_SLOT_SKEW_TOLERANCE, SLOT_TIME_ESTIMATE_MS } from '../server/solana/pumpCurve';
import { ExecutionCoordinator, RPC_SLOT_STALL_MS } from '../server/execution/coordinator';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';

/**
 * R4-9: RPC health was latency only and marks carried the local read time, so a lagging node looked healthy and its old prices fresh.
 * Real PumpCurveService.fetchPumpMarketState (the Connection is a scripted stub at the RPC boundary) and the real coordinator heartbeat.
 */
describe('R4-9: curve reads carry their context slot', () => {
  afterEach(() => vi.restoreAllMocks());

  const conn = (slots: number[]) => {
    let i = 0;
    return {
      rpcEndpoint: `http://slot-test-${Math.random()}`,
      getMultipleAccountsInfoAndContext: vi.fn(async (keys: unknown[], _cfg?: unknown) => ({ context: { slot: slots[Math.min(i++, slots.length - 1)] }, value: keys.map(() => null) })),
    } as any;
  };

  it('the next read asks for at least the highest slot seen less the skew bound, and a read further behind is refused, not used', async () => {
    const c = conn([1_000, 1_000 - RPC_SLOT_SKEW_TOLERANCE - 1]);
    const mint = Keypair.generate().publicKey;
    const first = await PumpCurveService.fetchPumpMarketStateResult({ connection: c, mint, executionMode: 'LIVE' });
    expect(first.failure?.reason).toBe('MINT_NOT_FOUND'); // the stub has no accounts; the slot was recorded anyway
    const second = await PumpCurveService.fetchPumpMarketStateResult({ connection: c, mint, executionMode: 'LIVE' });
    expect(c.getMultipleAccountsInfoAndContext.mock.calls[1][1]).toEqual({ minContextSlot: 1_000 - RPC_SLOT_SKEW_TOLERANCE });
    expect(second.failure?.reason).toBe('RPC_ERROR');
    expect(second.failure?.message).toMatch(/behind slot 1000/);
  });

  it('a read from a load-balanced node a slot or two behind is used, not refused, and stamped older than the newest slot', async () => {
    // A load-balanced RPC whose nodes are 1-2 slots apart, or two concurrent reads whose answers arrive out of order: before the
    // bound, the second read was refused as "a lagging node" and a LIVE buy failed MARKET_DATA_UNAVAILABLE.
    const c = conn([1_000, 998]);
    const mint = Keypair.generate().publicKey;
    await PumpCurveService.fetchPumpMarketStateResult({ connection: c, mint, executionMode: 'LIVE' });
    const second = await PumpCurveService.fetchPumpMarketStateResult({ connection: c, mint, executionMode: 'LIVE' });
    expect(second.failure?.reason).toBe('MINT_NOT_FOUND'); // read and used (the stub has no accounts), not RPC_ERROR
  });

  it('data from a slot that has not advanced is stamped with the time that slot was first seen, so it ages', () => {
    const c = conn([]);
    const t0 = 1_700_000_000_000;
    const S = 500_000;
    expect(PumpCurveService.noteContextSlot(c, S, t0)).toBe(t0);
    expect(PumpCurveService.noteContextSlot(c, S, t0 + 20_000)).toBe(t0); // stalled: still t0, 20 s old
    expect(PumpCurveService.noteContextSlot(c, S + 1, t0 + 20_400)).toBe(t0 + 20_400);
    // within the skew bound: used, stamped older than the newest slot by the slots it lags
    expect(PumpCurveService.noteContextSlot(c, S - 1, t0 + 21_000)).toBe(t0 + 20_400 - 2 * SLOT_TIME_ESTIMATE_MS);
    // a node further behind (just past the bound, or minutes): refused
    expect(PumpCurveService.noteContextSlot(c, S + 1 - RPC_SLOT_SKEW_TOLERANCE - 1, t0 + 21_000)).toBeNull();
    expect(PumpCurveService.noteContextSlot(c, S + 1 - 150 * 60, t0 + 21_000)).toBeNull();
  });
});

describe('R4-9: the RPC heartbeat checks the slot, not only latency', () => {
  afterEach(() => vi.restoreAllMocks());

  const make = () => {
    vi.spyOn(ExecutionCoordinator.prototype as any, 'initializeConnection').mockResolvedValue(undefined);
    const c = new ExecutionCoordinator(new MockSolanaRpc().createConnection());
    c.cleanup();
    vi.spyOn(ExecutionCoordinator.prototype as any, 'liveBuyReadinessProblems').mockRestore(); // the suite setup stubs it green
    return c;
  };

  it('a slot that goes backwards is DEGRADED and refuses LIVE buys; an advancing slot is HEALTHY again', () => {
    const c = make();
    c.recordRpcHeartbeat(1_000, 50);
    expect(c.getClusterStatus().rpcHealth).toBe('HEALTHY');
    c.recordRpcHeartbeat(900, 50);
    expect(c.getClusterStatus().rpcHealth).toBe('DEGRADED');
    expect((c as any).liveBuyReadinessProblems().join(' ')).toMatch(/slot cannot be trusted/);
    c.recordRpcHeartbeat(1_001, 50);
    expect(c.getClusterStatus().rpcHealth).toBe('HEALTHY');
  });

  it('a heartbeat a slot or two behind (a load-balanced node) stays HEALTHY; one past the skew bound is DEGRADED', () => {
    const c = make();
    c.recordRpcHeartbeat(1_000, 50);
    c.recordRpcHeartbeat(998, 50);
    expect(c.getClusterStatus().rpcHealth).toBe('HEALTHY');
    expect((c as any).liveBuyReadinessProblems().join(' ')).not.toMatch(/slot cannot be trusted/);
    c.recordRpcHeartbeat(1_000 - RPC_SLOT_SKEW_TOLERANCE - 1, 50);
    expect(c.getClusterStatus().rpcHealth).toBe('DEGRADED');
  });

  it('a slot that stops advancing while time passes is DEGRADED', () => {
    const c = make();
    c.recordRpcHeartbeat(1_000, 50);
    const real = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockImplementation(() => real() + RPC_SLOT_STALL_MS + 1_000);
    c.recordRpcHeartbeat(1_000, 50);
    expect(c.getClusterStatus().rpcHealth).toBe('DEGRADED');
  });
});
