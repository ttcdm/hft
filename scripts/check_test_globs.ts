/**
 * R1-122 (P1.2): every test file under tests/ must run in one of the two suites. `npm test` uses vitest.config.ts, which sets no `include`,
 * so vitest's default glob applies; `npm run test:long` (its own CI step) uses vitest.long.config.ts. A file that matches neither
 * (say `tests/foo_test.ts`, or a `*.longtest.ts` outside tests/long) runs nowhere, so its failures are never seen; a long test that also
 * matched the default glob would run inside the fast suite.
 *
 * A "test file" is any source file under tests/ that calls describe/it/test at the start of a line; helpers, fixtures and the setup file
 * register no tests. Checked by tests/test_globs.test.ts, which runs in `npm test` (it imports the vitest configs, so it runs under vitest, not tsx).
 */
import fs from 'node:fs';
import path from 'node:path';
import { configDefaults } from 'vitest/config';
import longConfig from '../vitest.long.config';

const ROOT = path.resolve(__dirname, '..');

export const DEFAULT_INCLUDE: string[] = [...configDefaults.include];
export const LONG_INCLUDE: string[] = [...((longConfig as { test?: { include?: string[] } }).test?.include ?? [])];

export const matchesAny = (rel: string, globs: string[]): boolean => globs.some((g) => path.matchesGlob(rel, g));

/** Repo-relative POSIX paths of the source files under `dir`. */
export function sourceFilesUnder(dir: string): string[] {
  return (fs.readdirSync(path.join(ROOT, dir), { recursive: true }) as string[])
    .map((f) => path.posix.join(dir, String(f).split(path.sep).join('/')))
    .filter((f) => /\.[cm]?[jt]sx?$/.test(f) && fs.statSync(path.join(ROOT, f)).isFile());
}

export const registersTests = (rel: string): boolean => /^\s*(describe|it|test)(\.\w+)*\(/m.test(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

/** Files under `dir` that register tests. */
export const testFilesUnder = (dir = 'tests'): string[] => sourceFilesUnder(dir).filter(registersTests);

/** Test files that neither `npm test` nor `npm run test:long` picks up. */
export const orphanTestFiles = (dir = 'tests'): string[] => testFilesUnder(dir).filter((f) => !matchesAny(f, DEFAULT_INCLUDE) && !matchesAny(f, LONG_INCLUDE));

/** Files both suites would pick up (a long test inside the fast suite). */
export const filesInBothSuites = (dir = 'tests'): string[] => sourceFilesUnder(dir).filter((f) => matchesAny(f, LONG_INCLUDE) && matchesAny(f, DEFAULT_INCLUDE));

