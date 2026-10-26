import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { calloutSnipeLabel, calloutSendNote, calloutSnipeBlock } from '../src/utils/tokenLinks';

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
  it('the callout board has no caller marker (S215) and never says "auto-snipe"', () => {
    expect(calloutSnipeLabel('0.01 SOL')).toBe('SNIPE (0.01 SOL)');
    const src = read('src/components/PumpFunHotCalloutsView.tsx');
    expect(src).not.toMatch(/AUTO-SNIPE: (ON|OFF)/);
    expect(src).not.toContain('AUTO-SNIPE ON');
    expect(src).not.toContain('Subscribe to Auto-Snipe');
    expect(src).not.toContain('AUTONOMOUS CALLOUT SNIPER');
    expect(src).not.toMatch(/MARK CALLER|Mark this caller|toggle-autosnipe/);
  });

  it('nothing stores or reads isAutoSnipeSubscribed any more (S215 removed the marker)', () => {
    const readers = [...walk('server'), ...walk('src'), 'server.ts'].filter((f) => /isAutoSnipeSubscribed|toggleCallerAutoSnipe|TOGGLE_CALLER_SNIPE/.test(read(f)));
    expect(readers).toEqual([]);
  });

  it('the snipe button is a plain SNIPE, and its note says what the send path is', () => {
    expect(calloutSnipeLabel('0.01 SOL')).toBe('SNIPE (0.01 SOL)');
    expect(calloutSnipeLabel('0.005 SOL')).toBe('SNIPE (0.005 SOL)');
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
