import { describe, it, expect, afterEach, vi } from 'vitest';
import { AuthManager, operatorAuthBootWarnings } from '../server/middleware/auth';

/**
 * R4-11, R4-39: the operator token generated at boot expired after 24 h and could not be renewed, so with no OPERATOR_PASSWORD the kill
 * switch and panic routes answered 401 from hour 24. A too-short OPERATOR_AUTH_TOKEN was replaced by a volatile token with no word said.
 * Real AuthManager; the clock (vi fake timers) and process.env are the only things set.
 */
const KEYS = ['OPERATOR_AUTH_TOKEN', 'OPERATOR_PASSWORD', 'APEX_CONTAINER'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function withEnv(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('R4-11: the primary operator token does not expire', () => {
  it('the volatile boot token still works after 25 h, and a rotated token too', () => {
    withEnv({ APEX_CONTAINER: 'true' }); // nothing printed
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['Date'] });
    const mgr = new AuthManager();
    const token = mgr.getPrimaryToken();
    vi.setSystemTime(Date.now() + 25 * 3_600_000);
    expect(mgr.validateToken(token)).toBe(true);
    expect(mgr.isOperatorToken(token)).toBe(true);
    const rotated = mgr.rotateOperatorToken();
    vi.setSystemTime(Date.now() + 400 * 24 * 3_600_000);
    expect(mgr.validateToken(rotated)).toBe(true);
    expect(mgr.validateToken(token)).toBe(false); // the rotate revoked the old one
  });

  it('an OPERATOR_AUTH_TOKEN from the env does not expire either; a logout still revokes it', () => {
    withEnv({ OPERATOR_AUTH_TOKEN: 'a'.repeat(32) });
    vi.useFakeTimers({ toFake: ['Date'] });
    const mgr = new AuthManager();
    vi.setSystemTime(Date.now() + 400 * 24 * 3_600_000);
    expect(mgr.validateToken('a'.repeat(32))).toBe(true);
    expect(mgr.revokeToken('a'.repeat(32))).toBe(true);
    expect(mgr.validateToken('a'.repeat(32))).toBe(false);
  });

  it('a password-login session still ends after 24 h', () => {
    withEnv({ OPERATOR_AUTH_TOKEN: 'b'.repeat(32), OPERATOR_PASSWORD: 'pw-for-test' });
    vi.useFakeTimers({ toFake: ['Date'] });
    const mgr = new AuthManager();
    const login = mgr.authenticateOperator({ password: 'pw-for-test' });
    expect(login.success).toBe(true);
    vi.setSystemTime(Date.now() + 25 * 3_600_000);
    expect(mgr.validateToken(login.token)).toBe(false);
  });
});

describe('R4-39: boot warns when operator access is missing or ignored, and never prints a token', () => {
  it('warns that a short OPERATOR_AUTH_TOKEN was ignored, and that there is no token or password', () => {
    const short = 'shorttok123';
    withEnv({ OPERATOR_AUTH_TOKEN: short, APEX_CONTAINER: 'true' });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mgr = new AuthManager();
    const printed = err.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toMatch(/OPERATOR_AUTH_TOKEN IS SET BUT SHORTER THAN 16 CHARACTERS AND WAS IGNORED/);
    expect(printed).toMatch(/NO OPERATOR_AUTH_TOKEN \(16\+ chars\) AND NO OPERATOR_PASSWORD/);
    expect(printed).not.toContain(short);
    expect(printed).not.toContain(mgr.getPrimaryToken());
    expect(mgr.validateToken(short)).toBe(false);
  });

  it('a short token with a password set: only the "ignored" warning; a good token: none', () => {
    expect(operatorAuthBootWarnings({ OPERATOR_AUTH_TOKEN: 'short', OPERATOR_PASSWORD: 'x' })).toEqual([
      expect.stringMatching(/WAS IGNORED/),
    ]);
    expect(operatorAuthBootWarnings({ OPERATOR_PASSWORD: 'x' })).toEqual([]);
    expect(operatorAuthBootWarnings({ OPERATOR_AUTH_TOKEN: 'c'.repeat(16) })).toEqual([]);
    expect(operatorAuthBootWarnings({})).toEqual([expect.stringMatching(/NO OPERATOR_PASSWORD/)]);
  });
});
