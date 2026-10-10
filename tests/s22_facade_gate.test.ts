import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findFacadeTests, compareToBaseline, facadeKey } from '../scripts/find_facade_tests';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's22-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (name: string, body: string) => { const f = path.join(dir, name); fs.writeFileSync(f, body); return f; };

describe('S22: the facade finder is a CI gate with a baseline', () => {
  it('counts an import from scripts/ as production, scans .test.tsx, and still flags a test that touches nothing real', () => {
    const real = write('real.test.ts', `import { it, expect } from 'vitest';\nimport { planSeed } from '../scripts/devnet_seed';\nit('plans', () => { expect(planSeed({}).buyers).toBe(30); });\n`);
    const facade = write('facade.test.ts', `import { it, expect } from 'vitest';\nit('adds', () => { expect(1 + 1).toBe(2); });\n`);
    const tsx = write('ui.test.tsx', `import { it, expect } from 'vitest';\nit('also adds', () => { expect(2 + 2).toBe(4); });\n`);
    expect(findFacadeTests([real]).length).toBe(0);
    expect(findFacadeTests([facade]).map((f) => f.title)).toEqual(['adds']);
    expect(findFacadeTests([tsx]).map((f) => f.title)).toEqual(['also adds']);
  });

  it('compareToBaseline: only tests not in the baseline are new; entries that disappeared are reported as fixed; line numbers do not matter', () => {
    const f = (file: string, title: string, line = 1) => ({ file, title, line });
    const base = [facadeKey(f('a.test.ts', 'x')), facadeKey(f('b.test.ts', 'gone'))];
    const r = compareToBaseline([f('a.test.ts', 'x', 99), f('c.test.ts', 'new')], base);
    expect(r.added).toEqual(['c.test.ts::new']);
    expect(r.fixed).toEqual(['b.test.ts::gone']);
  });

  it('the CLI exits 1 on a new facade test and 0 against a baseline that lists it', () => {
    const facade = write('cli.test.ts', `import { it, expect } from 'vitest';\nit('local only', () => { expect(true).toBe(true); });\n`);
    const empty = write('empty.json', '[]');
    const listed = write('listed.json', JSON.stringify([facadeKey({ file: facade, title: 'local only', line: 1 })]));
    const run = (b: string) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/find_facade_tests.ts', facade, '--baseline', b], { encoding: 'utf8', timeout: 60_000 });
    const bad = run(empty);
    expect(bad.status, bad.stdout).toBe(1);
    expect(bad.stdout).toMatch(/NEW facade test/);
    expect(run(listed).status).toBe(0);
  });

  it('npm run test:facades passes on the repository with the committed baseline, and CI runs it', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/find_facade_tests.ts', '--baseline', 'tests/facade-baseline.json'], { encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stdout.slice(-500)).toBe(0);
    expect(fs.readFileSync('.github/workflows/ci.yml', 'utf8')).toMatch(/npm run test:facades/);
    expect(JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts['test:facades']).toMatch(/--baseline tests\/facade-baseline\.json/);
  });
});
