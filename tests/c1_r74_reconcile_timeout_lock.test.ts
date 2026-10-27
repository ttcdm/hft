import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';

/**
 * R7-4: the reconcile timeout answers the callers but does not stop the pass, so the single-flight lock must be held until the pass itself
 * ends; otherwise a Reconcile click starts a second pass beside the timed-out one and both run step 4 on the same rows. Real coordinator.
 */
describe('R7-4: a timed-out reconcile pass keeps the single-flight lock until it ends', () => {
  let coordinator: ExecutionCoordinator;
  let mockRpc: MockSolanaRpc;

  beforeEach(async () => {
    mockRpc = new MockSolanaRpc();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(Keypair.generate().publicKey);
    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
    coordinator.orphanRecoveryDelaysMs = [];
    await vi.waitFor(() => expect(coordinator.getReconciliationStatus()).not.toBeNull()); // the boot pass a directly built coordinator starts
    await (coordinator as any).reconcileInFlight?.catch(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    coordinator.cleanup();
    mockRpc.clear();
  });

  it('calls made after the timeout, plain or fresh, join the running pass instead of starting a second one', async () => {
    (coordinator as any).reconcileTimeoutMs = 30;
    let running = 0;
    let maxRunning = 0;
    let endFirst!: () => void;
    const real = (coordinator as any).runStartupReconciliation.bind(coordinator);
    let n = 0;
    vi.spyOn(coordinator as any, 'runStartupReconciliation').mockImplementation(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      try {
        if (++n === 1) await new Promise<void>((r) => { endFirst = r; });
        return await real();
      } finally {
        running--;
      }
    });
    const timedOut = await coordinator.startupReconciliation();
    expect(timedOut.details).toMatch(/did not finish/);
    const plain = coordinator.startupReconciliation();
    const fresh = coordinator.startupReconciliation({ fresh: true });
    await new Promise((r) => setTimeout(r, 60));
    expect(maxRunning).toBe(1); // nothing started beside the hung pass
    expect((await plain).details).toMatch(/still running/);
    expect((await fresh).details).toMatch(/still running/); // a click gets the answer at once, not a second pass
    expect(n).toBe(1);
    endFirst();
    await new Promise((r) => setTimeout(r, 0));
    const after = await coordinator.startupReconciliation({ fresh: true }); // the hung pass has ended: the lock is free again
    expect(after.details).not.toMatch(/did not finish/);
    expect(maxRunning).toBe(1);
    expect(n).toBe(2);
  });
});
