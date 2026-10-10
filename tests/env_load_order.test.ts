import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { build } from 'esbuild';

const ROOT = process.cwd();
const firstImport = (file: string) => fs.readFileSync(file, 'utf8').split('\n').find((l) => /^\s*import\s/.test(l));

/** Bundle a tiny entry the way the server is bundled (esbuild, CJS, packages external) and run it in a temp cwd. */
async function pubkeyFrom(entrySource: string, dir: string): Promise<string> {
  const entry = path.join(dir, 'entry.ts');
  fs.writeFileSync(entry, entrySource);
  const out = path.join(dir, 'entry.cjs');
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: out, logLevel: 'silent', absWorkingDir: ROOT });
  const env = { PATH: process.env.PATH ?? '', NODE_PATH: path.join(ROOT, 'node_modules') };
  return execFileSync(process.execPath, [out], { cwd: dir, env, encoding: 'utf8' }).trim().split('\n').pop()!;
}

describe('.env is loaded before import-time singletons (signer, config, db, coordinator)', () => {
  it('server.ts, the coordinator and the devnet script import loadEnv first', () => {
    expect(firstImport('server.ts')).toMatch(/^import '\.\/server\/loadEnv'/);
    expect(firstImport('server/execution/coordinator.ts')).toMatch(/^import '\.\.\/loadEnv'/);
    // L3: the devnet script first pins an empty env file (hermeticEnv), then loads loadEnv, so no .env is read.
    expect(firstImport('scripts/test_devnet_execution.ts')).toMatch(/^import '\.\/hermeticEnv'/);
    expect(fs.readFileSync('scripts/test_devnet_execution.ts', 'utf8')).toMatch(/import '\.\/hermeticEnv'[^\n]*\nimport '\.\.\/server\/loadEnv'/);
    expect(fs.readFileSync('server.ts', 'utf8')).not.toMatch(/dotenv/); // no late dotenv.config() left behind
  });

  it('with loadEnv first, a throwaway OPERATOR_PRIVATE_KEY in .env is the signer key, not the default keypair file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envorder-'));
    try {
      const envKey = Keypair.generate(); // throwaway, never a real key
      const fileKey = Keypair.generate();
      fs.writeFileSync(path.join(dir, '.env'), `OPERATOR_PRIVATE_KEY=${bs58.encode(envKey.secretKey)}\n`);
      fs.writeFileSync(path.join(dir, '.apex_trading_keypair.json'), JSON.stringify(Array.from(fileKey.secretKey)), { mode: 0o600 });
      const signer = path.join(ROOT, 'server/solana/signer');
      const loadEnv = path.join(ROOT, 'server/loadEnv');

      const good = await pubkeyFrom(`import '${loadEnv}';\nimport { localSigner } from '${signer}';\nconsole.log(localSigner.getPublicKey().toBase58());\n`, dir);
      expect(good).toBe(envKey.publicKey.toBase58());
      expect(good).not.toBe(fileKey.publicKey.toBase58());

      // The old order (signer evaluated before .env is loaded) picks the default file key: the bug this test guards.
      const bad = await pubkeyFrom(`import { localSigner } from '${signer}';\nimport '${loadEnv}';\nconsole.log(localSigner.getPublicKey().toBase58());\n`, dir);
      expect(bad).toBe(fileKey.publicKey.toBase58());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('K1: tests never read the repo .env (hermetic under vitest)', () => {
  /** Run a bundle that imports loadEnv in a temp cwd containing a planted .env, with or without VITEST set. */
  async function readVar(dir: string, name: string, vitest: boolean, extra: Record<string, string> = {}): Promise<string> {
    const entry = path.join(dir, 'k1.ts');
    fs.writeFileSync(entry, `import '${path.join(ROOT, 'server/loadEnv')}';\nconsole.log('VALUE=' + (process.env.${name} ?? 'UNSET'));\n`);
    const out = path.join(dir, 'k1.cjs');
    await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: out, logLevel: 'silent', absWorkingDir: ROOT });
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', NODE_PATH: path.join(ROOT, 'node_modules') };
    if (vitest) env.VITEST = 'true';
    Object.assign(env, extra);
    const text = execFileSync(process.execPath, [out], { cwd: dir, env, encoding: 'utf8' });
    return text.split('\n').find((l) => l.startsWith('VALUE='))!.slice(6);
  }

  it('a planted .env with SOLANA_RPC_URL is invisible under VITEST, and visible without it (control)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k1-'));
    try {
      fs.writeFileSync(path.join(dir, '.env'), 'SOLANA_RPC_URL=https://example.invalid\n');
      expect(await readVar(dir, 'SOLANA_RPC_URL', false)).toBe('https://example.invalid');
      expect(await readVar(dir, 'SOLANA_RPC_URL', true)).toBe('UNSET');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('under VITEST a .env.test file is read instead', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k1b-'));
    try {
      fs.writeFileSync(path.join(dir, '.env'), 'K1_VAR=from-dot-env\n');
      fs.writeFileSync(path.join(dir, '.env.test'), 'K1_VAR=from-dot-env-test\n');
      expect(await readVar(dir, 'K1_VAR', true)).toBe('from-dot-env-test');
      expect(await readVar(dir, 'K1_VAR', false)).toBe('from-dot-env');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('APEX_ENV_FILE replaces .env outside tests; set to empty it loads no file at all', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k1c-'));
    try {
      fs.writeFileSync(path.join(dir, '.env'), 'K1_VAR=from-dot-env\nK1_OTHER=real\n');
      fs.writeFileSync(path.join(dir, 'scratch.env'), 'K1_VAR=from-scratch\n');
      expect(await readVar(dir, 'K1_VAR', false, { APEX_ENV_FILE: path.join(dir, 'scratch.env') })).toBe('from-scratch');
      expect(await readVar(dir, 'K1_OTHER', false, { APEX_ENV_FILE: path.join(dir, 'scratch.env') })).toBe('UNSET');
      expect(await readVar(dir, 'K1_VAR', false, { APEX_ENV_FILE: '' })).toBe('UNSET');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('this vitest process did not load the repo .env even if one exists next to package.json', () => {
    // vitest.config.ts forces these; a loaded real .env would override or add to them
    expect(process.env.VITEST).toBeTruthy();
    expect(process.env.ALLOWED_CLUSTER).toBe('devnet');
  });
});
