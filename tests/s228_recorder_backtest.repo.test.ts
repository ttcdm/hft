import { describe, it, expect } from 'vitest';
import fs from 'fs';

/** Source scan: the recorder-backtest scripts read recordings only, never write them, and stay apart from the 39-day corpus code. */
describe('S228 the recorder backtest cannot change the recording or mix with the corpus', () => {
  const adapter = fs.readFileSync('scripts/recorder_backtest/recorded.ts', 'utf8');
  const scripts = ['recorded.ts', 'exit_variants.ts', 'late_rule.ts'].map((f) => fs.readFileSync(`scripts/recorder_backtest/${f}`, 'utf8'));
  it('opens SQLite read-only and issues only SELECT statements', () => {
    expect(adapter).toMatch(/new DatabaseSync\(abs, \{ readOnly: true \}\)/);
    const stmts = [...adapter.matchAll(/prepare\(`([^`]*)`/g)].map((m) => m[1].trim());
    expect(stmts.length).toBeGreaterThan(3);
    for (const s of stmts) expect(s).toMatch(/^SELECT /);
    expect(adapter).not.toMatch(/\.exec\(|INSERT |UPDATE |DELETE |DROP |ALTER /);
  });
  it('imports nothing from the corpus scripts and writes only its --out file', () => {
    for (const src of scripts) expect(src.split('\n').filter((l) => /^import /.test(l)).join('\n')).not.toContain('hfcorpus');
    for (const src of scripts) for (const m of src.matchAll(/writeFileSync\(([^,]+),/g)) expect(m[1].trim()).toBe('outPath');
  });
  it('labels its results as its own', () => {
    for (const f of ['exit_variants.ts', 'late_rule.ts']) expect(fs.readFileSync(`scripts/recorder_backtest/${f}`, 'utf8')).toContain("source: 'own recordings (not the 39-day corpus)'");
  });
});
