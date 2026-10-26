import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { defaultSecretFilePaths, findLoosePermissions, loosePermissionWarnings } from '../server/middleware/filePermissions';

describe('K2 #22: permission check covers env.txt, db, wal and logs, and never chmods', () => {
  it('warns about world-readable env.txt, .env.bak-*, db, wal and server.log but not .env.example or tight files', () => {
    if (process.platform === 'win32') return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k2perm-'));
    try {
      const mk = (name: string, mode: number) => { const f = path.join(dir, name); fs.writeFileSync(f, 'x', { mode }); fs.chmodSync(f, mode); return f; };
      mk('env.txt', 0o644);
      mk('.env.bak-1', 0o644);
      mk('apex_workstation.db', 0o644);
      mk('apex_workstation.db-wal', 0o644);
      mk('apex_engine.wal', 0o664);
      mk('server.log', 0o644);
      mk('.env.example', 0o644);
      mk('README.md', 0o644);
      mk('.env', 0o600);
      mk('.apex_trading_keypair.json', 0o600);
      const paths = defaultSecretFilePaths({} as any, dir);
      const names = paths.map((p) => path.basename(p));
      expect(names).toEqual(expect.arrayContaining(['env.txt', '.env.bak-1', 'apex_workstation.db', 'apex_workstation.db-wal', 'apex_engine.wal', 'server.log', '.env', '.apex_trading_keypair.json']));
      expect(names).not.toContain('.env.example');
      expect(names).not.toContain('README.md');
      const loose = findLoosePermissions(paths);
      expect(loose.map((f) => path.basename(f.path)).sort()).toEqual(['.env.bak-1', 'apex_engine.wal', 'apex_workstation.db', 'apex_workstation.db-wal', 'env.txt', 'server.log']);
      expect(loosePermissionWarnings(loose).some((w) => w.includes('env.txt') && w.includes('chmod 600'))).toBe(true);
      // warn-only: modes are untouched
      expect(fs.statSync(path.join(dir, 'env.txt')).mode & 0o777).toBe(0o644);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
