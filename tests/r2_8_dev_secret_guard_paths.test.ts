import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { secretPathGuard, configuredSecretFiles, isShippable, isServableInDev, viteFsDeny } from '../server/security/secretPaths';

/**
 * R2-8, R8-4: the dev server's secret guard matched basename globs only, and case-sensitively. A key at SIGNER_KEYPAIR_PATH=./trader.json,
 * a database or env file with an unusual name, or `/.ENV` on a case-insensitive disk got past it. Real secretPaths module; the request
 * and response are minimal objects with the fields the guard uses.
 */
const ROOT = path.resolve('/srv/apex-project');
const KEYS = ['SIGNER_KEYPAIR_PATH', 'APEX_DB_PATH', 'APEX_ENV_FILE', 'TEST_DB_PATH'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

function status(guard: ReturnType<typeof secretPathGuard>, url: string): number {
  const res = { statusCode: 200, end: () => undefined };
  let passed = false;
  guard({ url }, res, () => { passed = true; });
  return passed ? 200 : res.statusCode;
}

describe('R2-8: the configured key, database and env file are denied by path', () => {
  it('denies SIGNER_KEYPAIR_PATH, APEX_DB_PATH (and its -wal/-shm/.lock) and APEX_ENV_FILE whatever their names, in any case', () => {
    const env = { SIGNER_KEYPAIR_PATH: './trader.json', APEX_DB_PATH: 'state/ledger', APEX_ENV_FILE: 'config/settings.txt' } as any;
    const guard = secretPathGuard(ROOT, configuredSecretFiles(ROOT, env));
    for (const u of ['/trader.json', '/TRADER.JSON', '/state/ledger', '/state/ledger-wal', '/state/ledger-shm', '/state/ledger.lock', '/STATE/Ledger',
      '/config/settings.txt', '/config/%73ettings.txt', `/@fs${ROOT}/trader.json`, '/src/../trader.json']) {
      expect(status(guard, u), u).toBe(404);
    }
    for (const u of ['/', '/index.html', '/src/main.tsx', '/state/ledgerview.js']) expect(status(guard, u), u).toBe(200);
  });

  it('a key outside the project is denied when asked for by /@fs/ path', () => {
    const guard = secretPathGuard(ROOT, configuredSecretFiles(ROOT, { SIGNER_KEYPAIR_PATH: '/home/op/keys/id.json' } as any));
    expect(status(guard, '/@fs/home/op/keys/id.json')).toBe(404);
    expect(status(guard, '/@fs/HOME/op/keys/ID.json')).toBe(404);
  });

  it('the default guard reads the configuration from the environment; the env file defaults to .env', () => {
    process.env.SIGNER_KEYPAIR_PATH = 'wallets/main.json';
    delete process.env.APEX_ENV_FILE;
    const guard = secretPathGuard(ROOT);
    expect(status(guard, '/wallets/main.json')).toBe(404);
    expect(configuredSecretFiles(ROOT, {} as any)).toEqual([path.join(ROOT, '.env')]);
    expect(viteFsDeny(ROOT)).toContain(`${path.join(ROOT, 'wallets/main.json').replace(/\\/g, '/').replace(/[\\^$*+?.()|{}[\]!]/g, '\\$&')}`);
  });
});

describe('R8-4: the name rules ignore case', () => {
  it('denies case variants of the secret names and folders for dev serving and release packaging', () => {
    for (const p of ['.ENV', '.Env.local', 'ENV.TXT', 'My-KEYPAIR.json', '.APEX_trading_keypair.json', 'APEX_WORKSTATION.DB', 'server.LOG', '.GIT/config', '.Overnight/inbox/x.patch']) {
      expect(isServableInDev(p), p).toBe(false);
      expect(isShippable(p), p).toBe(false);
    }
    const guard = secretPathGuard(ROOT, []);
    for (const u of ['/.ENV', '/%2EENV', '/Env.Txt']) expect(status(guard, u), u).toBe(404);
    expect(isShippable('.env.example')).toBe(true);
    expect(isServableInDev('src/App.tsx')).toBe(true);
  });
});
