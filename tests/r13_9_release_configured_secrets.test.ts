import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

/**
 * R13-9: scripts/package_release.ts filtered with isShippable, which checks names only. With SIGNER_KEYPAIR_PATH=./trader.json (an untracked
 * file that is not gitignored), `npm run package:release` zipped the key. The real packager, run in a scratch git repository.
 */
const ROOT = process.cwd();

function pack(dir: string, extraEnv: Record<string, string>): string[] {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  delete env.APEX_ENV_FILE; // the packager reads .env, as a plain `npm run package:release` would
  delete env.SIGNER_KEYPAIR_PATH;
  delete env.APEX_DB_PATH;
  delete env.TEST_DB_PATH;
  Object.assign(env, extraEnv);
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'scripts/package_release.ts')], { cwd: dir, env, encoding: 'utf8' });
  return execFileSync('unzip', ['-Z1', 'release.zip'], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean);
}

describe('R13-9: the release packager refuses the configured key, database and env file by path', () => {
  it('a key, a database and its -wal named only in .env, and a key named only in the environment, stay out of release.zip', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r139zip-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      const write = (p: string, body = 'x') => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), body); };
      write('.env', 'SIGNER_KEYPAIR_PATH=./trader.json\nAPEX_DB_PATH=./state/ledger.bin\n');
      write('trader.json', '[1,2,3]');
      write('state/ledger.bin');
      write('state/ledger.bin-wal');
      write('ops/hot.json', '[4,5,6]');
      write('server.ts');
      write('README.md');
      const listing = pack(dir, { SIGNER_KEYPAIR_PATH: './ops/hot.json' }); // the environment wins over .env for the key

      expect(listing).not.toContain('ops/hot.json');
      expect(listing).not.toContain('state/ledger.bin');
      expect(listing).not.toContain('state/ledger.bin-wal');
      expect(listing).not.toContain('.env');
      expect(listing).toContain('server.ts');
      expect(listing).toContain('README.md');

      const fromEnvFile = pack(dir, {});
      expect(fromEnvFile).not.toContain('trader.json');
      expect(fromEnvFile).toContain('ops/hot.json'); // no longer configured anywhere: just a file
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
