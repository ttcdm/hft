import { describe, it, expect } from 'vitest';
import fs from 'fs';

/** UI status report 2026-10-26, fix 3: the Telegram hub showed a hard-coded "STATUS: POLLING ACTIVE" while nothing polls Telegram. */
describe('UI fix 3: the Telegram hub badge says what is true', () => {
  it('no POLLING ACTIVE claim; the badge says it is a local console', () => {
    const src = fs.readFileSync('src/components/MemecoinSocialSniperModal.tsx', 'utf8');
    expect(src).not.toContain('POLLING ACTIVE');
    expect(src).toContain('NOT POLLING TELEGRAM (local console)');
    // the server side it describes: no Telegram polling or webhook registration exists
    expect(fs.readFileSync('server.ts', 'utf8')).not.toMatch(/getUpdates\(|setWebhook\(/);
  });
});
