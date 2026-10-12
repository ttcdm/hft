import { describe, it, expect } from 'vitest';
import fs from 'fs';

/** Source scan: the recorded-data adapter must open a SQLite database read-only and never write to it. */
describe('S228 the SQLite adapter cannot change the recording', () => {
  const src = fs.readFileSync('scripts/hfcorpus/recorded.ts', 'utf8');
  it('opens read-only', () => { expect(src).toMatch(/new DatabaseSync\(abs, \{ readOnly: true \}\)/); });
  it('issues only SELECT statements', () => {
    const stmts = [...src.matchAll(/prepare\(`([^`]*)`/g)].map((m) => m[1].trim());
    expect(stmts.length).toBeGreaterThan(3);
    for (const s of stmts) expect(s).toMatch(/^SELECT /);
    expect(src).not.toMatch(/\.exec\(|INSERT |UPDATE |DELETE |DROP |ALTER /);
  });
});
