import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  findLoosePermissions,
  defaultSecretFilePaths,
  loosePermissionWarnings,
} from '../server/middleware/filePermissions';

describe('A2: secret hygiene', () => {
  const tmpDirs: string[] = [];

  function tmpFile(mode: number): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'secret');
    fs.writeFileSync(file, 'x');
    fs.chmodSync(file, mode);
    return file;
  }

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('flags a file readable by group or others and not a 0600 file', () => {
    const loose = tmpFile(0o644);
    const tight = tmpFile(0o600);
    const findings = findLoosePermissions([loose, tight]);
    expect(findings).toEqual([{ path: loose, mode: '644' }]);
    expect(loosePermissionWarnings(findings)[0]).toContain(`chmod 600 ${loose}`);
  });

  it('ignores files that do not exist', () => {
    expect(findLoosePermissions(['/nonexistent/a2-missing-file'])).toEqual([]);
  });

  it('reports nothing on Windows', () => {
    const loose = tmpFile(0o644);
    expect(findLoosePermissions([loose], 'win32')).toEqual([]);
  });

  it('checks .env and the configured keypair path', () => {
    const paths = defaultSecretFilePaths({ SIGNER_KEYPAIR_PATH: '/k/kp.json' } as NodeJS.ProcessEnv, '/proj');
    expect(paths).toEqual(['/proj/.env', '/k/kp.json']);
  });

  it('keeps long hex secrets out of tracked docs and sources', () => {
    const root = process.cwd();
    const files = ['ENV_CONFIG.md', 'README.md', '.env.example'];
    for (const f of files) {
      const text = fs.readFileSync(path.join(root, f), 'utf8');
      expect(text, `${f} contains a 64-char hex string`).not.toMatch(/[0-9a-f]{64}/i);
      expect(text, `${f} contains an RPC URL with an embedded key`).not.toMatch(/quiknode\.pro\/[A-Za-z0-9]{16,}/);
    }
  });
});
