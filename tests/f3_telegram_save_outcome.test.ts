import { describe, it, expect } from 'vitest';
import { telegramSaveOutcome } from '../src/components/MemecoinSocialSniperModal';

/**
 * Placeholder inventory B5 (patch set F): the Telegram "Save Config" click said "saved securely" without waiting for the server, on a screen that promised alerts no code sends. Fails on the code before the fix.
 */

describe('B5: Telegram "Save Config" reports what the server answered', () => {
  it('a confirmed save says where it is kept and that nothing is sent automatically', () => {
    const ok = telegramSaveOutcome({ status: 'OK', config: { chatId: '1', botToken: '', botTokenSet: true } });
    expect(ok.level).toBe('INFO');
    expect(ok.message).toMatch(/until the next restart/);
    expect(ok.message).toMatch(/No alerts are sent automatically/);
    expect(ok.message).not.toMatch(/securely/);
  });

  it('no answer, or an error, is reported as not saved', () => {
    expect(telegramSaveOutcome(undefined).title).toBe('TELEGRAM SETTINGS NOT SAVED');
    expect(telegramSaveOutcome({ error: 'Unauthorized' }).message).toContain('Unauthorized');
  });
});
