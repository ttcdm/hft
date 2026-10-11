import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { calloutSnipeLabel, calloutSendNote, CALLER_MARK_LABEL, CALLER_MARK_TITLE, calloutSnipeBlock } from '../src/utils/tokenLinks';

const read = (f: string) => fs.readFileSync(f, 'utf8');
const walk = (d: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
};

describe('S179 callout button labels', () => {
  it('the caller button says it marks, never "auto-snipe"', () => {
    expect(CALLER_MARK_LABEL(false)).toBe('MARK CALLER');
    expect(CALLER_MARK_LABEL(true)).toBe('CALLER MARKED');
    expect(CALLER_MARK_TITLE(false)).toContain('nothing buys');
    const src = read('src/components/PumpFunHotCalloutsView.tsx');
    expect(src).not.toMatch(/AUTO-SNIPE: (ON|OFF)/);
    expect(src).not.toContain('AUTO-SNIPE ON');
    expect(src).not.toContain('Subscribe to Auto-Snipe');
    expect(src).not.toContain('AUTONOMOUS CALLOUT SNIPER');
    expect(src).toContain('CALLER_MARK_LABEL(c.caller.isAutoSnipeSubscribed)');
  });

  it('nothing but the marker itself reads isAutoSnipeSubscribed (the flag drives no trade)', () => {
    const readers = [...walk('server'), ...walk('src'), 'server.ts']
      .filter((f) => /isAutoSnipeSubscribed/.test(read(f)))
      .map((f) => f.replace(/\\/g, '/'))
      .sort();
    expect(readers).toEqual(['server.ts', 'server/pumpfunService.ts', 'src/components/PumpFunHotCalloutsView.tsx', 'src/types.ts']);
    // server.ts only echoes it in the leaderboard payload; in the service the flag appears only as seed data and in the toggle
    const svc = read('server/pumpfunService.ts').split('\n').filter((l) => l.includes('isAutoSnipeSubscribed'));
    expect(svc.every((l) => /isAutoSnipeSubscribed: (true|false),$|caller\.isAutoSnipeSubscribed = !caller\.isAutoSnipeSubscribed;/.test(l.trim()))).toBe(true);
  });

  it('the snipe button is a plain SNIPE, and its note says what the send path is', () => {
    expect(calloutSnipeLabel(5)).toBe('SNIPE ($5)');
    expect(calloutSnipeLabel(25)).toBe('SNIPE ($25)');
    const note = calloutSendNote(0.00018);
    expect(note).toContain('normal RPC path');
    expect(note).toContain('only if the server has Jito configured');
    expect(note).toContain('devnet: never');
    const src = read('src/components/PumpFunHotCalloutsView.tsx');
    expect(src).not.toContain('1-CLICK JITO');
    expect(src).not.toContain('Jito MEV {rules');
    expect(src).toContain('calloutSnipeLabel(');
  });

  it('on devnet the snipe is still blocked as mainnet-only (S176), so the label never promises a send there', () => {
    expect(calloutSnipeBlock('devnet')).not.toBeNull();
    expect(calloutSnipeBlock('mainnet-beta')).toBeNull();
    expect(read('src/components/PumpFunHotCalloutsView.tsx')).toContain("'MAINNET ONLY'");
  });
});
