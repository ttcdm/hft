import { describe, it, expect, vi, afterEach } from 'vitest';
import { executionCoordinator } from '../server/execution/coordinator';

afterEach(() => vi.restoreAllMocks());

describe('Q4 follow-up: a failed sell simulation says which program refused and why', () => {
  const sim = (value: unknown) => vi.spyOn(executionCoordinator.getConnection(), 'simulateTransaction').mockResolvedValue({ context: { slot: 1 }, value } as any);

  it('the error carries the tail of the program log, without Program data lines', async () => {
    sim({ err: { InstructionError: [4, 'X'] }, logs: ['Program A invoke [1]', 'Program data: AAAA', 'Program A failed: Could not create program address'] });
    const r = await (executionCoordinator as any).simulateSell({});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('InstructionError');
    expect(r.error).toContain('Could not create program address');
    expect(r.error).not.toContain('Program data');
  });
  it('no logs, no tail', async () => {
    sim({ err: 'BlockhashNotFound', logs: null });
    expect((await (executionCoordinator as any).simulateSell({})).error).toBe('"BlockhashNotFound"');
  });
});
