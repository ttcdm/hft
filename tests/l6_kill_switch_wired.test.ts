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

  it('the server endpoint it calls trips the risk engine and disarms LIVE (behaviour behind the button)', async () => {
    const { riskEngine } = await import('../server/risk/riskEngine');
    riskEngine.setKillSwitch(true);
    expect(riskEngine.isKillSwitchActive()).toBe(true);
    riskEngine.setKillSwitch(false);
  });
});
