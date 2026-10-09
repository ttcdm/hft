import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { isShippable, dockerignoreLines } from '../scripts/releaseFilter';

const ROOT = process.cwd();

/** Names that must never ship: the real secret and state files seen in this repo's root. */
const SECRET_PATHS = [
  'env.txt', '.env', '.env.local', '.env.production', '.env.bak-20260101', 'sub/dir/.env',
  '.apex_trading_keypair.json', 'keys/my.keypair.json', 'wallet-keypair.json', 'x.signer.json', '.operator_session', '.operator_session.json',
  'apex_workstation.db', 'apex_workstation.db-wal', 'apex_workstation.db-shm', 'apex_engine.wal', 'server.log', 'test.sock', 'release.zip', 'old.zip',
  '.agents/transcript.md', '.antigravity/state.json', '.overnight/inbox/46-ENV.patch', 'target/debug/x', 'dist/server.cjs', 'node_modules/a/b.js', '.git/config', 'a/node_modules/b.js',
];
const SHIPPABLE = ['server.ts', 'src/App.tsx', 'package.json', 'package-lock.json', '.env.example', 'README.md', 'tests/fixtures/auto.ts', 'scripts/smoke.ts', '.gitignore', 'docker-compose.yml'];

describe('K2 #24: release and docker exclusion lists', () => {
  it('refuse every secret / state / agent-transcript path', () => {
    for (const p of SECRET_PATHS) expect(isShippable(p), p).toBe(false);
  });
  it('still ship the source tree and .env.example', () => {
    for (const p of SHIPPABLE) expect(isShippable(p), p).toBe(true);
  });
  it('the old zip globs would have shipped env.txt and the keypair (why this exists)', () => {
    const old = ['.git*', '.env*', '*operator_session*', '*.keypair.json', '*.signer.json', '*.db*', '*.wal', '*.log'];
    const matchesOld = (p: string) => old.some((g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(p));
    expect(matchesOld('env.txt')).toBe(false);
    expect(matchesOld('.apex_trading_keypair.json')).toBe(false);
    expect(matchesOld('.agents/transcript.md')).toBe(false);
  });
  it('.dockerignore is generated from the same list', () => {
    const text = fs.readFileSync('.dockerignore', 'utf8').split('\n');
    for (const l of dockerignoreLines()) expect(text).toContain(l);
    expect(text).toContain('**/env.txt');
    expect(text).toContain('!.env.example');
  });
  it('npm run package:release builds a zip that contains none of the secret paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k2zip-'));
    try {
      const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: dir, encoding: 'utf8' });
      sh('git', ['init', '-q']);
      for (const p of [...SECRET_PATHS.filter((x) => !x.startsWith('.git/')), ...SHIPPABLE]) {
        fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
        fs.writeFileSync(path.join(dir, p), p.endsWith('.json') ? '{}' : 'x');
      }
      // none are git-ignored here on purpose: the filter alone must keep them out
      sh(process.execPath, [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'scripts/package_release.ts')]);
      const listing = sh('unzip', ['-Z1', 'release.zip']).split('\n').filter(Boolean);
      for (const p of SECRET_PATHS) expect(listing, p).not.toContain(p);
      for (const p of SHIPPABLE) expect(listing, p).toContain(p);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
