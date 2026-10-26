import fs from 'node:fs';
import { describe, it, expect } from 'vitest';

/** L6 (report F1): the header KILL SWITCH only flipped local React state while announcing "all threads halted". */
describe('L6: the header kill switch calls the server', () => {
  const src = fs.readFileSync('src/App.tsx', 'utf8');
  const fn = src.slice(src.indexOf('const toggleKillSwitch'), src.indexOf('const toggleCapitalTier'));

  it('posts to the authenticated kill-switch endpoint', () => {
    expect(fn).toMatch(/authFetch\('\/api\/execution\/kill-switch'/);
    expect(fn).toMatch(/activate: nextHalted/);
  });

  it('only shows "halted" after the server confirmed it, and says so loudly when it did not', () => {
    expect(fn.indexOf('setIsHalted(nextHalted)')).toBeGreaterThan(fn.indexOf('killSwitchActive !== nextHalted'));
    expect(fn).toMatch(/KILL SWITCH NOT CONFIRMED/);
  });

  it('no longer claims engine threads were halted or liquidation armed', () => {
    expect(fn).not.toMatch(/matching engine threads|Safe liquidation armed|CME\/NY4/);
  });

  // T6: the behaviour behind the button (endpoint -> risk engine, LIVE disarmed, trades refused as KILL_SWITCH_ACTIVE, strict input) is
  // asserted over real HTTP in tests/behaviour_http.test.ts ('PAPER never sends, and the kill switch refuses new trades', 'arming policy
  // and readiness', 'kill switch input is strict'). The three source checks above stay because there is no DOM test environment; they
  // are source reads of App.tsx, not behaviour, and the Chromium click-through (scripts/visual) is the real check of the button.
});
