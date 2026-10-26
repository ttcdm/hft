import { describe, it, expect } from 'vitest';
import { connectivityAuditSummary } from '../src/utils/probeBadge';

/** From the 2026-10-26 click-through (overnight/reports/click-through-2026-10-26). Fails on c47125e without its fix. */
describe('UI-1: the connectivity audit toast counts services that answered', () => {
  const probe = (reachable: boolean) => ({ service: 'Svc (host)', testResult: { reachable } });
  it('every service unreachable: a warning that says so, never "Verified"', () => {
    const s = connectivityAuditSummary({ connections: { xTwitter: { service: 'X.com / Twitter API v2 (api.twitter.com)', testResult: { reachable: false } }, telegram: probe(false), pumpFun: probe(false) } });
    expect(s.level).toBe('WARNING');
    expect(s.message).toMatch(/^0 of 3 external services answered/);
    expect(s.message).toContain('X.com / Twitter API v2');
    expect(s.message).not.toMatch(/Verified/);
  });
  it('all answered: INFO; none returned: a warning', () => {
    expect(connectivityAuditSummary({ connections: { a: probe(true), b: probe(true) } })).toMatchObject({ level: 'INFO', message: 'All 2 external services answered.' });
    expect(connectivityAuditSummary(undefined).level).toBe('WARNING');
  });
});
