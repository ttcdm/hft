import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * docs/ARCHITECTURE.md must not name code that is gone. Two checks, both offline:
 *   1. every file or folder named in backticks exists (paths relative to the repo root, or to docs/ for ../ links);
 *   2. every Mermaid node written as `functionName<br/>file.ts` names a function the file still defines.
 * It cannot tell whether an arrow still points the right way; a person has to read the diagram against the code for that.
 */
const DOC = 'docs/ARCHITECTURE.md';
const text = fs.readFileSync(DOC, 'utf8');

function allFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', 'coverage'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) allFiles(full, out); else out.push(full);
  }
  return out;
}
const repoFiles = allFiles('.').map((f) => f.replace(/^\.\//, ''));

describe('docs/ARCHITECTURE.md matches the tree', () => {
  const prose = text.replace(/```mermaid[\s\S]*?```/g, '');
  const paths = [...new Set([...prose.matchAll(/`([A-Za-z0-9_.\-/]+)`/g)].map((m) => m[1]).filter((t) => (t.includes('/') || /\.(ts|tsx|md|cjs|mjs|json)$/.test(t)) && !t.startsWith('/')))];

  it('names a useful number of paths (so the extraction cannot silently match nothing)', () => {
    expect(paths.length).toBeGreaterThan(30);
  });

  it.each(paths)('path %s exists', (p) => {
    const rel = p.replace(/\/$/, '');
    const exists = fs.existsSync(rel) || fs.existsSync(path.join('docs', rel));
    expect(exists, `${rel} is named in ${DOC} but does not exist`).toBe(true);
  });

  const mermaid = [...text.matchAll(/```mermaid([\s\S]*?)```/g)].map((m) => m[1]);
  const nodes = mermaid.flatMap((block) => [...block.matchAll(/\["([^"]+)"\]/g)].map((m) => m[1])).filter((l) => l.includes('<br/>'));
  const checked = nodes.map((l) => l.split('<br/>')).filter(([fn, file]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(fn.trim()) && /\.tsx?$/.test(file.trim()));

  it('has function nodes to check', () => {
    expect(checked.length).toBeGreaterThan(15);
  });

  it.each(checked.map(([fn, file]) => [fn.trim(), file.trim()]))('%s is defined in %s', (fn, file) => {
    const matches = repoFiles.filter((f) => path.basename(f) === file && (f.startsWith('server') || f.startsWith('src')));
    expect(matches.length, `${file} not found under server/ or src/`).toBeGreaterThan(0);
    // a declaration, not just a call: `function fn`, a method or property declaration such as `public async fn(`, or `const fn =`
    const decl = new RegExp(`(?:function\\s+${fn}\\b|^\\s*(?:export\\s+)?(?:public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+)*${fn}\\s*[<(]|(?:const|let)\\s+${fn}\\s*=)`, 'm');
    const defined = matches.some((f) => decl.test(fs.readFileSync(f, 'utf8')));
    expect(defined, `${fn} is not defined in ${file}`).toBe(true);
  });
});
