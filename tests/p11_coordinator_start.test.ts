import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'node:path';

/** P1.1 (N-51): own file, because it re-imports the module graph (vi.resetModules), which would detach other suites' spies from dynamic imports. */
afterEach(() => vi.restoreAllMocks());

describe('P1.1 the coordinator singleton starts nothing until start()', () => {
  it('importing the module creates no interval; start() creates the exit loop and the heartbeat', async () => {
    vi.resetModules();
    const stacks: string[] = [];
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((..._args: any[]) => {
      stacks.push(new Error().stack ?? '');
      return { unref() { return this; }, ref() { return this; }, hasRef: () => false, refresh() { return this; }, [Symbol.toPrimitive]: () => 0 } as any; // never runs: the test only records who asked
    }) as any);
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    const mod = await import('../server/execution/coordinator');
    const own = () => stacks.filter((s) => s.includes(`execution${path.sep}coordinator.ts`) || s.includes('execution/coordinator.ts'));
    expect(own()).toHaveLength(0);
    expect(mod.executionCoordinator.isStarted()).toBe(false);
    mod.executionCoordinator.start();
    expect(mod.executionCoordinator.isStarted()).toBe(true);
    expect(own().length).toBeGreaterThanOrEqual(2); // the 3 s exit loop and the 10 s feed heartbeat
    mod.executionCoordinator.cleanup();
  });
});

