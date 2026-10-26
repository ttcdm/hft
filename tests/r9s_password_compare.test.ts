import { describe, it, expect, afterEach, vi } from 'vitest';
import { authManager } from '../server/middleware/auth';

// R9s: the password check compares fixed-length digests; behaviour must be unchanged for every length.
describe('R9s: operator password check', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('accepts the exact password and refuses shorter, longer, prefix and case variants alike', () => {
    vi.stubEnv('OPERATOR_PASSWORD', 'correct horse battery');
    expect(authManager.authenticateOperator({ password: 'correct horse battery' }).success).toBe(true);
    for (const bad of ['', 'c', 'correct horse batter', 'correct horse battery!', 'correct horse batterX', 'CORRECT HORSE BATTERY', 'x'.repeat(500)]) {
      const r = authManager.authenticateOperator({ password: bad });
      expect(r.success, JSON.stringify(bad.slice(0, 12))).toBe(false);
      expect(r.error).toBe('Invalid operator credentials'); // the same answer whatever the length
    }
  });

  it('is disabled when OPERATOR_PASSWORD is unset', () => {
    vi.stubEnv('OPERATOR_PASSWORD', '');
    expect(authManager.authenticateOperator({ password: 'anything' }).success).toBe(false);
  });
});
