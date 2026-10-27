import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { describeTradingMode, snipeBlockedReason, MODE_STALE_MS } from '../src/utils/tradingMode';

/** UI status report 2026-10-26, fix 7: with the kill switch ON the snipe buttons stayed enabled (the server refused the order anyway). */
describe('UI fix 7: snipe buttons are greyed out while the kill switch is on', () => {
  const now = 1_000_000;
  it('the shared mode answer carries the kill switch; on means blocked, off or unknown means not', () => {
    expect(snipeBlockedReason(describeTradingMode({ mode: 'PAPER', killSwitchActive: true }, now - 1000, now))).toMatch(/KILL SWITCH ON/);
    expect(snipeBlockedReason(describeTradingMode({ mode: 'PAPER', killSwitchActive: false }, now - 1000, now))).toBeNull();
    // a stale answer does not claim the switch is on (the button stays usable; the server still decides)
    expect(describeTradingMode({ mode: 'PAPER', killSwitchActive: true }, now - MODE_STALE_MS - 1, now).killSwitch).toBeNull();
  });
  it('every snipe button on the Sniper, callout and Plug & Play screens is disabled by it', () => {
    const sniper = fs.readFileSync('src/components/MemecoinSocialSniperModal.tsx', 'utf8');
    expect(sniper.match(/disabled=\{[^}]*snipeBlocked !== null\}/g)?.length).toBe(3);
    expect(fs.readFileSync('src/components/PumpFunHotCalloutsView.tsx', 'utf8')).toMatch(/calloutSnipeBlock\(tradingMode\.cluster\) !== null \|\| snipeBlocked !== null/);
    expect(fs.readFileSync('src/components/PlugAndPlayTradingModal.tsx', 'utf8')).toMatch(/!manualMint \|\| snipeBlocked !== null/);
  });
});
