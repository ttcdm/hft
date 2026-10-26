import { describe, it, expect } from 'vitest';
import { waitForNewHeld } from '../scripts/localnet/heldWait';

const noSleep = async () => undefined;

describe('S220: the localnet e2e waits for its own withheld signature', () => {
  it('does not return an earlier step\'s signature while its own has not landed', async () => {
    const held = ['SIG_F_BUY']; // left over from step (f); the sell has not reached the validator yet
    let polls = 0;
    const got = await waitForNewHeld(async () => { polls += 1; return [...held]; }, held.length, { tries: 5, sleep: noSleep });
    expect(got).toBeNull(); // the old code returned SIG_F_BUY on the first poll
    expect(polls).toBe(5);
  });

  it('returns the new signature once it lands, even when the sell is slow', async () => {
    const held = ['SIG_F_BUY'];
    let polls = 0;
    const got = await waitForNewHeld(async () => { polls += 1; if (polls === 4) held.push('SIG_G_SELL'); return [...held]; }, 1, { sleep: noSleep });
    expect(got).toBe('SIG_G_SELL');
    expect(polls).toBe(4);
  });

  it('with nothing held before, the first signature is the one', async () => {
    expect(await waitForNewHeld(async () => ['SIG_F_BUY'], 0, { sleep: noSleep })).toBe('SIG_F_BUY');
  });
});
