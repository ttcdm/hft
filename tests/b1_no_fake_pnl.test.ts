import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { INITIAL_BOTS, makeEmptyKpis } from '../src/App';

describe('B1: the UI does not fabricate PnL', () => {
  it('seeds every bot with zero performance and not running', () => {
    expect(INITIAL_BOTS.length).toBeGreaterThan(0);
    for (const bot of INITIAL_BOTS) {
      expect(bot.pnl, `${bot.id} pnl`).toBe(0);
      expect(bot.winRate, `${bot.id} winRate`).toBe(0);
      expect(bot.tradesCount, `${bot.id} tradesCount`).toBe(0);
      expect(bot.opsPerSec, `${bot.id} opsPerSec`).toBe(0);
      expect(bot.isRunning, `${bot.id} isRunning`).toBe(false);
    }
  });

  it('starts KPIs at zero apart from the starting equity', () => {
    const kpis = makeEmptyKpis(10);
    const { totalEquity, peakEquity, ...rest } = kpis;
    expect(totalEquity).toBe(10);
    expect(peakEquity).toBe(10);
    for (const [key, value] of Object.entries(rest)) {
      expect(value, key).toBe(0);
    }
  });

  it('has no Math.random() or tx-real ids left in App.tsx outside the alert id', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    const randomLines = source.split('\n').filter((l) => l.includes('Math.random'));
    expect(randomLines).toHaveLength(1);
    expect(randomLines[0]).toContain('alert-');
    expect(source).not.toContain('tx-real');
  });
});
