import { describe, it, expect } from 'vitest';
import { closeOutcomeText } from '../src/utils/closeOutcome';

/**
 * R11-5 (haiku-attack round 11): tab A held a Dump 100% confirm, tab B sold the position, tab A confirmed and was told
 * "CLOSE NOT DONE: ... Position not found or already closed ... is still open". Every failure got that suffix. It is now said only
 * when it is true: a refusal before any send leaves the row open; a position the server no longer has open is not "still open"; a
 * failure after a send may or may not have sold, and says so.
 */
describe('R11-5: a failed close says "still open" only when it is', () => {
  it('a position already closed elsewhere is reported as no longer open', () => {
    const t = closeOutcomeText({ success: false, pnlSol: 0, error: 'Position not found or already closed', notSent: true }, 100, '$GONE');
    expect(t.text).not.toMatch(/still open/);
    expect(t.text).toMatch(/\$GONE is no longer open/);
    expect(t.text).toMatch(/nothing was sold by this request/i);
  });
  it('a refusal before any send says the position is still open', () => {
    const t = closeOutcomeText({ success: false, pnlSol: 0, error: 'TRADING_HALTED: no', notSent: true }, 100, '$OPEN');
    expect(t.text).toMatch(/\$OPEN is still open/);
    const q = closeOutcomeText({ success: false, pnlSol: 0, error: 'EXIT_IN_PROGRESS: An exit transaction for this position is already in progress.' }, 100, '$OPEN');
    expect(q.text).toMatch(/still open/);
  });
  it('a failure after a send is not called "still open": it may have sold', () => {
    const t = closeOutcomeText({ success: false, pnlSol: 0, error: 'RPC down' }, 100, '$MAYBE');
    expect(t.text).toMatch(/^Close failed: RPC down/);
    expect(t.text).not.toMatch(/is still open/);
    expect(t.text).toMatch(/may still be open/);
  });
});
