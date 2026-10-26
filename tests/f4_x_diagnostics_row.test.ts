import { describe, it, expect } from 'vitest';
import { xTwitterScopeEntry } from '../server/socialScanner';

/**
 * Placeholder inventory B6 (patch set F): the X/Twitter row of the connectivity audit was fixed text ("verified (HTTP 200)", "ready to connect to Twitter API v2") whatever the probe found. Fails on the code before the fix.
 */

describe('B6: the X/Twitter diagnostics row comes from the probe result', () => {
  it('an unreachable probe is reported as unreachable, not "verified (HTTP 200)"', () => {
    const e = xTwitterScopeEntry({ reachable: false, httpStatus: null, bearerAuthorized: false }, 'devnet');
    expect(e.nature).toBe('UNREACHABLE');
    expect(e.details).toMatch(/not reachable/);
    expect(e.details).not.toMatch(/verified \(HTTP 200\)|Ready to connect/);
    expect(e.details).toMatch(/not fetched on devnet/);
  });

  it('a reachable probe names its real status and says nothing reads the X API', () => {
    const e = xTwitterScopeEntry({ reachable: true, httpStatus: 403, bearerAuthorized: false }, 'mainnet-beta');
    expect(e.nature).toBe('PROBE_ONLY');
    expect(e.details).toMatch(/HTTP 403/);
    expect(e.details).toMatch(/nothing reads the X API/);
  });
});
