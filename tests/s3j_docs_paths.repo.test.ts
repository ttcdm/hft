import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 3J: repository-file checks on the documents, kept apart from s3j_docs_constants.test.ts because they read files and call no production
 * code (*.repo.test.ts, as the facade checker expects): every path docs/LATENCY.md and docs/RUNBOOK.md name exists, and every code
 * reference in LATENCY.md (a file and a piece of code in it) is still in that file.
 */
const read = (f: string) => fs.readFileSync(f, 'utf8');
const doc = { latency: read('docs/LATENCY.md'), runbook: read('docs/RUNBOOK.md') };

describe('paths and code references in LATENCY.md and RUNBOOK.md', () => {
  const targets: Array<[string, string]> = [['docs/LATENCY.md', doc.latency], ['docs/RUNBOOK.md', doc.runbook]];

  for (const [name, text] of targets) {
    const prose = text.replace(/```[\s\S]*?```/g, '');
    const tokens = [...new Set([...prose.matchAll(/`([A-Za-z0-9_.\-/]+)(?::\d+)?`/g)].map((m) => m[1]))]
      .filter((t) => (t.includes('/') || /\.(ts|tsx|md|cjs|mjs|json)$/.test(t)) && !t.startsWith('/') && !t.startsWith('$') && !/^(api|GET|POST)/.test(t) && !/apex_trading_keypair/.test(t)); // the keypair file is a runtime file, not in the repository

    it(`${name} names a useful number of repo paths`, () => {
      expect(tokens.length).toBeGreaterThan(name.includes('LATENCY') ? 15 : 2);
    });

    it.each(tokens)(`${name}: path %s exists`, (p) => {
      const rel = p.replace(/\/$/, '');
      expect(fs.existsSync(rel) || fs.existsSync(path.join('docs', rel)), `${rel} is named in ${name} but does not exist`).toBe(true);
    });
  }

  // A reference names a file and a piece of code in it, not a line number: lines move with every patch (3B shifted all of them).
  const refs = [...doc.latency.matchAll(/`([A-Za-z0-9_./-]+\.tsx?)` \(`([^`]+)`\)/g)].map((m) => [m[1], m[2]] as [string, string]);
  it('LATENCY.md has code references to check', () => {
    expect(refs.length).toBeGreaterThan(40);
    expect(doc.latency).not.toMatch(/`[A-Za-z0-9_./-]+\.tsx?:\d+`/); // no file:line left
  });
  it.each(refs)('%s still contains %j', (file, anchor) => {
    expect(read(file), `${file} no longer contains ${anchor}`).toContain(anchor);
  });

});

