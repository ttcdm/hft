import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Keypair } from '@solana/web3.js';
import { WorkstationDatabase } from '../server/db/database';
import { LocalKeypairSigner } from '../server/solana/signer';
import { defaultSecretFilePaths } from '../server/middleware/filePermissions';

const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
const compose = fs.readFileSync('docker-compose.yml', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

const builder = dockerfile.slice(0, dockerfile.lastIndexOf('FROM '));
const runner = dockerfile.slice(dockerfile.lastIndexOf('FROM '));

/** ENV pairs of the runner stage (the last FROM). */
function runnerEnv(): Record<string, string> {
  const block = runner.match(/^ENV\s+((?:.*\\\n)*.*)$/m)?.[1] ?? '';
  const env: Record<string, string> = {};
  for (const m of block.replace(/\\\n/g, ' ').matchAll(/(\w+)=(\S+)/g)) env[m[1]] = m[2];
  return env;
}

/** The container path compose mounts the named volume at, e.g. `apex-data:/app/data` gives /app/data. */
function volumeTarget(): string {
  const m = compose.match(/^\s+-\s+apex-data:(\/\S+)/m);
  if (!m) throw new Error('docker-compose.yml mounts no apex-data volume');
  return m[1];
}

/** Variable names the app service passes into the container (the `- NAME=...` lines). */
function composeEnvNames(): string[] {
  return [...compose.matchAll(/^\s+-\s+([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
}

const KEY_VARS = ['OPERATOR_PRIVATE_KEY', 'SOLANA_PRIVATE_KEY', 'SIGNER_KEYPAIR_PATH', 'TEST_DB_PATH', 'APEX_DB_PATH', 'APEX_READ_ONLY'];
const saved: Record<string, string | undefined> = Object.fromEntries(KEY_VARS.map((k) => [k, process.env[k]]));
let scratch = '';

afterEach(() => {
  for (const k of KEY_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

/** Map a container path under the volume onto a scratch directory standing in for the volume. */
function inVolume(containerPath: string): string {
  scratch = scratch || fs.mkdtempSync(path.join(os.tmpdir(), 's214-'));
  const rel = path.posix.relative(volumeTarget(), containerPath);
  expect(rel.startsWith('..')).toBe(false); // the path is inside the mounted volume
  return path.join(scratch, rel);
}

describe('S214: the Docker image builds', () => {
  it('every file the postinstall script runs is copied into the builder before npm ci', () => {
    const files = [...String(pkg.scripts.postinstall ?? '').matchAll(/node\s+(\S+)/g)].map((m) => m[1]);
    expect(files.length).toBeGreaterThan(0);
    const npmCi = builder.indexOf('RUN npm ci');
    expect(npmCi).toBeGreaterThan(0);
    const copies = builder.slice(0, npmCi).match(/^COPY\s+.*$/gm) ?? [];
    for (const f of files) {
      expect(fs.existsSync(f)).toBe(true);
      expect(copies.some((c) => c.split(/\s+/).slice(1, -1).some((src) => src === f || (src.endsWith('/') && f.startsWith(src))))).toBe(true);
    }
  });
});

describe('S214: what the container writes survives a rebuild', () => {
  it('the database with its WAL files is written into the volume, which the runner creates for node and compose mounts', () => {
    const target = volumeTarget();
    const mk = runner.indexOf(`mkdir -p ${target}`);
    expect(mk).toBeGreaterThan(0);
    expect(mk).toBeLessThan(runner.indexOf('USER node'));
    expect(runner).toMatch(new RegExp(`chmod 700 ${target}`));
    expect(compose).toMatch(/^volumes:\n\s+apex-data:/m);
    const env = runnerEnv();
    const dbPath = inVolume(env.APEX_DB_PATH);
    delete process.env.TEST_DB_PATH; // vitest sets it and it wins over APEX_DB_PATH
    process.env.APEX_DB_PATH = dbPath;
    const db = new WorkstationDatabase();
    expect(db.getDbPath()).toBe(dbPath);
    expect(db.getJournalMode().toLowerCase()).toBe('wal');
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
  });

  it('a key generated in the UI is written into the volume with mode 0600, and the permission check watches that file', () => {
    const env = runnerEnv();
    const keyPath = inVolume(env.SIGNER_KEYPAIR_PATH);
    for (const k of ['OPERATOR_PRIVATE_KEY', 'SOLANA_PRIVATE_KEY', 'APEX_READ_ONLY']) delete process.env[k];
    process.env.SIGNER_KEYPAIR_PATH = keyPath;
    const signer = new LocalKeypairSigner();
    const made = signer.generateDedicatedTradingKeypair();
    expect(made.path).toBe(keyPath);
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(defaultSecretFilePaths({ SIGNER_KEYPAIR_PATH: env.SIGNER_KEYPAIR_PATH }, '/app')).toContain(env.SIGNER_KEYPAIR_PATH);
  });
});

describe('S214: the container gets no signing key from the host', () => {
  it('compose has no env_file and passes no key variable, so with a key in the host shell the signer is NOT_CONFIGURED (PAPER)', () => {
    expect(compose).not.toMatch(/^\s*env_file\s*:/m);
    const names = composeEnvNames();
    expect(names).toContain('OPERATOR_AUTH_TOKEN'); // the parse found the list
    for (const k of ['OPERATOR_PRIVATE_KEY', 'SOLANA_PRIVATE_KEY', 'SIGNER_KEYPAIR_PATH']) expect(names).not.toContain(k);
    const hostKey = JSON.stringify(Array.from(Keypair.generate().secretKey));
    const host: Record<string, string> = { OPERATOR_PRIVATE_KEY: hostKey, SOLANA_PRIVATE_KEY: hostKey, OPERATOR_AUTH_TOKEN: 'x'.repeat(32) };
    const passed = new Set(names);
    // The container sees only the variables compose lists, plus the image ENV (a key path inside the empty volume).
    for (const k of ['OPERATOR_PRIVATE_KEY', 'SOLANA_PRIVATE_KEY', 'APEX_READ_ONLY']) delete process.env[k];
    for (const [k, v] of Object.entries(host)) if (passed.has(k) && KEY_VARS.includes(k)) process.env[k] = v;
    process.env.SIGNER_KEYPAIR_PATH = inVolume(runnerEnv().SIGNER_KEYPAIR_PATH);
    const signer = new LocalKeypairSigner();
    expect(signer.getStatus()).toBe('NOT_CONFIGURED');
  });
});
