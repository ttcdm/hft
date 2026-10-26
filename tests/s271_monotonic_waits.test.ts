import '../suppress-warnings.cjs';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { SolanaRpcTransport } from '../server/solana/transports';
import { ExecutionCoordinator } from '../server/execution/coordinator';

/**
 * S271 review: devnet run 15 set the wall clock 18.69 h ahead and back. The waits on the send path measure elapsed time, so they read the
 * monotonic clock (performance.now) and a wall clock set back mid-wait cannot stretch them. Real SolanaRpcTransport.confirm (with its real
 * confirmPacing) and ExecutionCoordinator.waitForBuysInFlight; vitest fakes setTimeout, performance and Date, and the test moves Date alone.
 */
const HOURS_18 = 18 * 3_600_000;
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('S271 review: send-path waits ignore wall-clock jumps', () => {
  it('confirm: the clock set back 18 h mid-watch, the watch still ends at its own maxWaitMs (TIMED_OUT), not 18 h later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const c = {
      getSignatureStatuses: vi.fn(async () => ({ context: { slot: 1 }, value: [null] })),
      sendRawTransaction: vi.fn(async () => 'sig'),
      getBlockHeight: vi.fn(async () => 100),
    };
    let result: any = null;
    void new SolanaRpcTransport(c as any).confirm('sig', 2_000).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(800);
    vi.setSystemTime(Date.now() - HOURS_18);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(result).toMatchObject({ confirmed: false, lifecycleState: 'TIMED_OUT' });
  });

  it('confirm: the clock set forward 18 h mid-watch does not end the watch early', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const confirmed = { slot: 77, confirmations: 1, err: null, confirmationStatus: 'confirmed' };
    let polls = 0;
    const c = { getSignatureStatuses: vi.fn(async () => ({ context: { slot: 1 }, value: [++polls >= 4 ? confirmed : null] })) };
    let result: any = null;
    void new SolanaRpcTransport(c as any).confirm('sig', 5_000).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(100);
    vi.setSystemTime(Date.now() + HOURS_18);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(result).toMatchObject({ confirmed: true, lifecycleState: 'TX_CONFIRMED' });
  });

  it('waitForBuysInFlight: the clock set back 18 h, the emergency stop still waits only its timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const coordinator = new ExecutionCoordinator();
    try {
      (coordinator as any).liveBuysInFlight.set('MintStillBuying', new Promise<void>(() => {}));
      let left: string[] | null = null;
      void coordinator.waitForBuysInFlight(1_000).then((m) => { left = m; });
      await vi.advanceTimersByTimeAsync(400);
      vi.setSystemTime(Date.now() - HOURS_18);
      await vi.advanceTimersByTimeAsync(700);
      expect(left).toEqual(['MintStillBuying']);
    } finally {
      (coordinator as any).liveBuysInFlight.clear();
      coordinator.cleanup();
    }
  });
});
