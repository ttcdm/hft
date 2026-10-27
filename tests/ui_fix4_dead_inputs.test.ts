import { describe, it, expect } from 'vitest';
import fs from 'fs';

/**
 * UI status report 2026-10-26, fix 4: two Sniper inputs said "not used". The take-profit box was dead (its value was read only by the box:
 * the modal never posts the config, and exits use the fixed ExitEngine rules), so it is gone. The Jito tip box is NOT dead: every snipe
 * from this screen sends its value, so it stays (flagged for Mike, not removed).
 */
describe('UI fix 4: no dead Sniper inputs', () => {
  const src = fs.readFileSync('src/components/MemecoinSocialSniperModal.tsx', 'utf8');
  it('the take-profit box is gone, and nothing on the screen sends the config it edited', () => {
    expect(src).not.toContain('Take-Profit Target');
    expect(src).not.toMatch(/takeProfitPct: Number\(e\.target\.value\)/);
    expect(src).not.toMatch(/updateSniperConfig|method: 'POST'[^\n]*memecoins\/config/);
  });
  it('the Jito tip box stays because snipes read it', () => {
    expect(src).toContain('data-testid="jito-tip-label"');
    expect(src).toMatch(/snipeSocialSignal\(sig\.id, amount, sniperConfig\.jitoTipSol/);
  });
});
