import { describe, it, expect } from 'vitest';
import { executionCoordinator } from '../server/execution/coordinator';

describe('Q4 follow-up: a failed sell simulation says which program refused and why', () => {
  it('the error carries the tail of the program log, without Program data lines', async () => {
    const c: any = executionCoordinator;
    const saved = c.connection;
    c.connection = { simulateTransaction: async () => ({ value: { err: { InstructionError: [4, 'X'] }, logs: ['Program A invoke [1]', 'Program data: AAAA', 'Program A failed: Could not create program address'] } }) };
    try {
      const r = await c.simulateSell({});
      expect(r.ok).toBe(false);
      expect(r.error).toContain('InstructionError');
      expect(r.error).toContain('Could not create program address');
      expect(r.error).not.toContain('Program data');
    } finally { c.connection = saved; }
  });
  it('no logs, no tail', async () => {
    const c: any = executionCoordinator;
    const saved = c.connection;
    c.connection = { simulateTransaction: async () => ({ value: { err: 'BlockhashNotFound', logs: null } }) };
    try { expect((await c.simulateSell({})).error).toBe('"BlockhashNotFound"'); } finally { c.connection = saved; }
  });
});
