import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Keeps docs/ENV.md and .env.example true to the code. It scans the source for every environment name the server reads (the
 * `process.env.X` form and the `env.X` form used by the helpers that take an env argument) and fails if
 *   - the server reads a name that docs/ENV.md does not list,
 *   - docs/ENV.md lists a name that neither the server nor a script reads,
 *   - .env.example sets a name nothing reads (except the one flagged in KNOWN_UNREAD).
 * It reads source files only, so it runs offline like the rest of the suite.
 */
const NAME = '[A-Z][A-Z0-9_]+';
const READ_PATTERNS = [
  new RegExp(`process\\.env\\.(${NAME})`, 'g'),
  new RegExp(`process\\.env\\[\\s*['"](${NAME})['"]\\s*\\]`, 'g'),
  new RegExp(`\\benv\\??\\.(${NAME})\\b`, 'g'),
  new RegExp(`\\benv\\[\\s*['"](${NAME})['"]\\s*\\]`, 'g'),
];
/** Process-level names scripts read that are not settings of this app. */
const IGNORED = new Set(['HOME', 'PATH']);
/** Listed in .env.example although the server does not read them. Remove an entry when the line leaves .env.example. */
const KNOWN_UNREAD = new Set(['SOLANA_WS_URL']);

function sourceFiles(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    if (!fs.existsSync(p)) return;
    if (fs.statSync(p).isDirectory()) { for (const e of fs.readdirSync(p)) walk(path.join(p, e)); return; }
    if (/\.(ts|tsx|cjs|mjs|js)$/.test(p)) out.push(p);
  };
  roots.forEach(walk);
  return out;
}

function readNames(roots: string[]): Set<string> {
  const names = new Set<string>();
  for (const f of sourceFiles(roots)) {
    const text = fs.readFileSync(f, 'utf8');
    for (const re of READ_PATTERNS) for (const m of text.matchAll(re)) names.add(m[1]);
  }
  IGNORED.forEach((n) => names.delete(n));
  return names;
}

function docNames(): Set<string> {
  const names = new Set<string>();
  for (const line of fs.readFileSync('docs/ENV.md', 'utf8').split('\n')) {
    const m = line.match(/^\|\s*`([A-Z][A-Z0-9_]+)`\s*\|/);
    if (m) names.add(m[1]);
  }
  return names;
}

function exampleNames(): string[] {
  return fs.readFileSync('.env.example', 'utf8').split('\n').map((l) => l.match(/^([A-Z][A-Z0-9_]+)\s*=/)?.[1]).filter((n): n is string => !!n);
}

describe('docs/ENV.md and .env.example match the code', () => {
  const server = readNames(['server.ts', 'server']);
  const scripts = readNames(['scripts']);
  const documented = docNames();

  it('the scan sees the names it should (so an empty scan cannot pass)', () => {
    for (const n of ['ALLOWED_CLUSTER', 'SOLANA_RPC_URL', 'CONFLUENCE_MIN_SCORE', 'APEX_READ_ONLY', 'MIN_LIQUIDITY_USD', 'APEX_RECORD_MAX_ROWS']) expect(server.has(n), n).toBe(true);
    expect(server.size).toBeGreaterThan(50);
  });

  it('every name the server reads is in docs/ENV.md', () => {
    expect([...server].filter((n) => !documented.has(n)).sort()).toEqual([]);
  });

  it('every name docs/ENV.md lists is read by the server or a script, or is a flagged unread one', () => {
    const unknown = [...documented].filter((n) => !server.has(n) && !scripts.has(n) && !KNOWN_UNREAD.has(n));
    expect(unknown.sort()).toEqual([]);
  });

  it('every name .env.example sets is read by the server, or flagged in KNOWN_UNREAD and in docs/ENV.md', () => {
    const bad = exampleNames().filter((n) => !server.has(n) && !KNOWN_UNREAD.has(n));
    expect(bad).toEqual([]);
    for (const n of exampleNames()) expect(documented.has(n), `${n} missing from docs/ENV.md`).toBe(true);
  });

  it('a name in KNOWN_UNREAD really is unread (if the server starts reading it, document it as a setting)', () => {
    for (const n of KNOWN_UNREAD) expect(server.has(n), n).toBe(false);
  });
});
