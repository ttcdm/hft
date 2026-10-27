import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { describeTradingMode, plugAndPlayModeView, MODE_STALE_MS } from '../src/utils/tradingMode';

/**
 * Round 1 #11 (haiku-attack 2026-10-26): Plug & Play showed "PAPER TRADING" / "PAPER SNIPE" from its last good read, which never aged out,
 * while the shared banner said MODE UNKNOWN. It now reads the shared useTradingMode() answer.
 */
describe('Round 1 #11: the Plug & Play mode label goes stale with the shared poller', () => {
  const now = 1_000_000;
  it('a PAPER answer older than MODE_STALE_MS reads MODE UNKNOWN, not PAPER TRADING', () => {
    const v = plugAndPlayModeView(describeTradingMode({ mode: 'PAPER', isLiveArmed: false }, now - MODE_STALE_MS - 1, now));
    expect(v.badge).toBe('MODE UNKNOWN');
    expect(v.snipe).toBe('SNIPE (MODE UNKNOWN)');
  });
  it('fresh answers: PAPER and LIVE armed', () => {
    expect(plugAndPlayModeView(describeTradingMode({ mode: 'PAPER', isLiveArmed: false }, now - 1_000, now))).toMatchObject({ badge: 'PAPER TRADING', snipe: 'PAPER SNIPE' });
    expect(plugAndPlayModeView(describeTradingMode({ mode: 'LIVE', isLiveArmed: true }, now - 1_000, now))).toMatchObject({ badge: 'LIVE BROADCAST ACTIVE', snipe: 'LIVE SNIPE' });
  });
  it('the modal no longer derives the badge or the snipe label from its own systemAudit read', () => {
    const src = fs.readFileSync('src/components/PlugAndPlayTradingModal.tsx', 'utf8');
    expect(src).not.toMatch(/systemAudit\.isLiveArmed \? 'LIVE BROADCAST ACTIVE' : 'PAPER TRADING'/);
    expect(src).not.toMatch(/systemAudit\?\.isLiveArmed \? 'LIVE SNIPE' : 'PAPER SNIPE'/);
    expect(src).toContain('plugAndPlayModeView(tradingMode)');
  });
});
