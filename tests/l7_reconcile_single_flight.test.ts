import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExecutionCoordinator } from '../server/execution/coordinator';

describe('L7: startupReconciliation is single-flight', () => {
  const made: ExecutionCoordinator[] = [];
  const make = () => { const c = new ExecutionCoordinator(); made.push(c); return c; };
  afterEach(() => { vi.restoreAllMocks(); while (made.length) made.pop()!.cleanup(); }); // T14: no coordinator outlives its test

  it('concurrent callers share one run; a later call starts a new one', async () => {
    const coord = make();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = vi.spyOn(coord as any, 'runStartupReconciliation').mockImplementation(async () => {
      await gate;
      return { status: 'EXECUTION_READY', mismatchesCount: 0, details: 'ok' };
    });
    const a = coord.startupReconciliation();
    const b = coord.startupReconciliation(); // e.g. POST /api/execution/reconcile during boot
    expect(b).toBe(a);
    release();
    await Promise.all([a, b]);
    expect(run).toHaveBeenCalledTimes(1);
    await coord.startupReconciliation();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a failed run clears the in-flight slot so the next call can retry', async () => {
    const coord = make();
    const run = vi.spyOn(coord as any, 'runStartupReconciliation').mockRejectedValueOnce(new Error('rpc down')).mockResolvedValue({ status: 'OFFLINE', mismatchesCount: 0, details: '' });
    await expect(coord.startupReconciliation()).rejects.toThrow('rpc down');
    await expect(coord.startupReconciliation()).resolves.toMatchObject({ status: 'OFFLINE' });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
