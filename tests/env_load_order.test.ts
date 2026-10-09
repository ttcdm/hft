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
    expect(firstImport('scripts/test_devnet_execution.ts')).toMatch(/^import '\.\.\/server\/loadEnv'/);
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
