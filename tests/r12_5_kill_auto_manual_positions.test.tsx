import { describe, it, expect } from 'vitest';
import { killReportFor } from '../src/components/AutoPanel';

/**
 * R12-5 (client half): KILL AUTO with manual positions open said "Auto is OFF. It had no open position to sell." It sells only auto's own
 * positions, which is correct, but never said that the manual ones are still open. The server reply now carries `manualOpen` (S3); an
 * older reply without it still says manual positions are not sold.
 */
describe('R12-5: the KILL AUTO report says manual positions stay open', () => {
  it('names the count of manual positions the reply gives', () => {
    const r = killReportFor({ success: true, mode: 'OFF', attempted: 0, closed: 0, refused: [], failed: [], stillOpen: 0, manualOpen: 2 })!;
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/It had no open position to sell/);
    expect(r.text).toMatch(/2 position\(s\) you opened by hand stay open: KILL AUTO does not sell them/);
  });

  it('no count in the reply: says manual positions are not sold', () => {
    const r = killReportFor({ success: true, mode: 'OFF', closed: 0, refused: [], failed: [], stillOpen: 0 })!;
    expect(r.text).toMatch(/manual positions are not sold/i);
  });

  it('a count of 0 says none is open; a failed kill says it too', () => {
    expect(killReportFor({ success: true, attempted: 1, closed: 1, failed: [], stillOpen: 0, manualOpen: 0 })!.text).toMatch(/No position opened by hand is open/);
    const bad = killReportFor({ success: false, attempted: 2, closed: 1, failed: [{ symbol: 'AAA', error: 'RPC down' }], stillOpen: 1, manualOpen: 1 })!;
    expect(bad.ok).toBe(false);
    expect(bad.text).toMatch(/1 position\(s\) you opened by hand stay open/);
  });
});
