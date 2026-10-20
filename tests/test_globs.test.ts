import { describe, it, expect } from 'vitest';
import { DEFAULT_INCLUDE, LONG_INCLUDE, matchesAny, orphanTestFiles, filesInBothSuites, testFilesUnder } from '../scripts/check_test_globs';

/**
 * R1-122 (P1.2): every test file under tests/ is picked up by `npm test` (vitest's default include) or by `npm run test:long`
 * (vitest.long.config.ts), and no long test also runs in the fast suite. The check itself is scripts/check_test_globs.ts.
 */
describe('every test file under tests/ runs in exactly one suite', () => {
  it('reads both include globs, and the matcher tells them apart (guards against a vacuous pass)', () => {
    expect(DEFAULT_INCLUDE.length).toBeGreaterThan(0);
    expect(LONG_INCLUDE).toEqual(['tests/long/**/*.longtest.ts']);
    expect(matchesAny('tests/a.test.ts', DEFAULT_INCLUDE)).toBe(true);
    expect(matchesAny('tests/a.test.tsx', DEFAULT_INCLUDE)).toBe(true);
    expect(matchesAny('tests/a_test.ts', DEFAULT_INCLUDE)).toBe(false);
    expect(matchesAny('tests/long/a.longtest.ts', DEFAULT_INCLUDE)).toBe(false);
    expect(matchesAny('tests/long/a.longtest.ts', LONG_INCLUDE)).toBe(true);
    expect(matchesAny('tests/a.longtest.ts', LONG_INCLUDE)).toBe(false);
  });

  it('no file that registers tests matches neither glob', () => {
    expect(testFilesUnder('tests').length).toBeGreaterThan(100);
    const orphans = orphanTestFiles('tests');
    expect(orphans, `these files run in no suite; rename them to *.test.ts, or *.longtest.ts under tests/long/: ${orphans.join(', ')}`).toEqual([]);
  });

  it('no long test also matches the default glob (it would run inside npm test)', () => {
    expect(filesInBothSuites('tests')).toEqual([]);
    expect(testFilesUnder('tests/long').length).toBeGreaterThanOrEqual(4);
  });
});
