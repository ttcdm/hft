import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * docs/ARCHITECTURE.md must not name code that is gone. Two checks, both offline:
 *   1. every file or folder named in backticks exists (paths relative to the repo root, or to docs/ for ../ links);
 *   2. every Mermaid node written as `file.ts: functionName` names a function the file still defines.
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
  const labels = mermaid.flatMap((block) => [...block.matchAll(/\["([^"]+)"\]/g)].map((m) => m[1]));
  const checked = labels.map((l) => l.split(': ')).filter(([file, fn]) => /^[A-Za-z0-9_.]+\.tsx?$/.test(file) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(fn ?? '')).map(([file, fn]) => [fn, file]);

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

/**
 * 3J: diagram 3's send-path edges are in the order the code runs them. The nodes below are matched, in the diagram, by their id, and in
 * `server/execution/coordinator.ts` by the first call that does the thing after the function they sit in starts. An arrow that points the
 * wrong way (signing before the blockhash check, the PENDING row before the cluster guards) fails here instead of in a runbook rehearsal.
 */
describe('diagram 3 send path is in the order the code runs it', () => {
  const block = [...text.matchAll(/```mermaid([\s\S]*?)```/g)].map((m) => m[1]).find((b) => b.includes('subgraph arm'))!;
  const src = fs.readFileSync('server/execution/coordinator.ts', 'utf8');

  // [diagram node id, text the node's label must contain, the call in the source, the function it is found in]
  const steps: Array<[string, string, RegExp, string]> = [
    ['t2b', 'liveBuyReadinessProblems', /this\.liveBuyReadinessProblems\(\)/, 'private async executeTradeUntraced'],
    ['b1', 'capturePreTradeSnapshot', /TradeReconciler\.capturePreTradeSnapshot\(/, 'private async executeTradeUntraced'],
    ['b2', 'buildBuyTransaction', /txBuilder\.buildBuyTransaction\(/, 'private async executeTradeUntraced'],
    ['b3', 'blockhashProblem', /this\.blockhashProblem\(v0Tx, 'BUY'\)/, 'private async executeTradeUntraced'],
    ['b4', 'signTransaction', /localSigner\.signTransaction\(v0Tx\)/, 'private async executeTradeUntraced'],
    ['q17', 'Q17', /const notReadyAtSend = this\.liveBuyReadinessProblems\(\)/, 'private async executeTradeUntraced'],
    ['b5', 'saveOrder', /workstationDb\.saveOrder\(/, 'private async executeTradeUntraced'],
    ['subm', 'assertNotReadOnly', /assertNotReadOnly\(/, 'public async submitAndConfirmWithRetry'],
    ['c1', 'assertSendClusterAllowed', /assertSendClusterAllowed\(\)/, 'public async submitAndConfirmWithRetry'],
    ['c2', 'assertClusterAllowedCached', /assertClusterAllowedCached\(/, 'public async submitAndConfirmWithRetry'],
    ['c3', 'savePendingBuyIfNoneUnresolved', /savePendingBuyIfNoneUnresolved\(/, 'public async submitAndConfirmWithRetry'],
    ['c4', 'submitAndConfirmInner', /this\.submitAndConfirmInner\(params\)/, 'public async submitAndConfirmWithRetry'],
  ];

  it('lists the nodes in the diagram in this order', () => {
    const ids = [...block.matchAll(/(\w+)\["([^"]+)"\]/g)].filter((m) => steps.some((s) => s[0] === m[1]));
    expect(ids.map((m) => m[1])).toEqual(steps.map((s) => s[0]));
    for (const [id, word] of steps.map((s) => [s[0], s[1]])) {
      const label = ids.find((m) => m[1] === id)![2];
      expect(label, `node ${id}`).toContain(word);
    }
  });

  it('has an edge from each node to the next', () => {
    for (let i = 0; i + 1 < steps.length; i++) {
      const [a, b] = [steps[i][0], steps[i + 1][0]];
      if (a === 't2b') continue; // the eligibility, sizing, quote and risk nodes sit between the readiness gate and the snapshot
      const edge = new RegExp(`\\b${a}(?:\\["[^"]*"\\])?\\s*-->\\s*${b}\\b`);
      expect(block, `${a} --> ${b}`).toMatch(edge);
    }
  });

  it('matches the order of the first calls in executeTradeUntraced and submitAndConfirmWithRetry', () => {
    const at = (fn: string, call: RegExp, from = 0): number => {
      const start = src.indexOf(`  ${fn}`);
      expect(start, `${fn} not found`).toBeGreaterThan(-1);
      const m = call.exec(src.slice(Math.max(start, from)));
      expect(m, `${call} after ${fn}`).not.toBeNull();
      return Math.max(start, from) + m!.index;
    };
    let last = -1;
    // within one function the calls must appear in increasing order; each function is searched from its own start
    let prevFn = '';
    for (const [id, , call, fn] of steps) {
      const pos = at(fn, call, fn === prevFn ? last + 1 : 0);
      if (fn !== prevFn) { expect(pos, `${id} starts a new function`).toBeGreaterThan(-1); prevFn = fn; } else expect(pos, id).toBeGreaterThan(last);
      last = pos;
    }
  });

  it('submitAndConfirmInner repeats the guards before it hands the transaction to a transport', () => {
    const start = src.indexOf('  private async submitAndConfirmInner');
    const body = src.slice(start);
    const idx = [/assertNotReadOnly\(/, /assertSendClusterAllowed\(\)/, /assertClusterAllowedCached\(/, /(?:jitoTransport|rpcTransport)\.submit/].map((re) => {
      const m = re.exec(body);
      expect(m, String(re)).not.toBeNull();
      return m!.index;
    });
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });
});
