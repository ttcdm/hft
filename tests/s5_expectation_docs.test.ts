import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

describe('S5: the docs state the measured score ceiling and what the seeded token will do', () => {
  const risks = fs.readFileSync('KNOWN_RISKS.md', 'utf8');
  it('KNOWN_RISKS section 8 gives 72-76 / 62-68, says 81 only at graduation, and says auto is not expected to buy the seeded token', () => {
    const sec = risks.slice(risks.indexOf('## 8.'));
    expect(sec).toMatch(/72-76 at best/);
    expect(sec).toMatch(/62-68/);
    expect(sec).toMatch(/81 only at graduation/);
    expect(sec).toMatch(/not expected to be bought by auto/);
    expect(sec).not.toMatch(/reachable ceiling (is )?90/);
  });
  it('the README points at it and the seed script header says the same', () => {
    expect(fs.readFileSync('README.md', 'utf8')).toMatch(/KNOWN_RISKS\.md.*section 8/);
    expect(fs.readFileSync('scripts/devnet_seed.ts', 'utf8')).toMatch(/auto is NOT expected to buy the seeded token/);
  });
});
