import fs from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * L3 (report 5.5 / summary 8): scripts that sign or spawn the server used to run `loadEnv`, which read the real `.env`
 * (wallet key, RPC URL with provider token). Each one must now run with an empty APEX_ENV_FILE.
 */
const SCRIPTS = ['scripts/devnet_e2e.ts', 'scripts/test_devnet_execution.ts', 'scripts/smoke.ts', 'scripts/localnet/e2e.ts'];

describe('L3: scripts never load the real .env', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  for (const f of SCRIPTS) {
    it(`${f} defines APEX_ENV_FILE before anything reads the environment`, () => {
      const src = fs.readFileSync(f, 'utf8');
      const viaHelper = /^import '(\.\.\/)?\.?\/?hermeticEnv';/m.test(src) || /import '\.\/hermeticEnv'|import '\.\.\/hermeticEnv'/.test(src);
      const direct = /APEX_ENV_FILE\s*[:=]\s*''/.test(src);
      expect(viaHelper || direct, `${f} must import ./hermeticEnv or set APEX_ENV_FILE: ''`).toBe(true);
    });

    it(`${f} never prints any part of SOLANA_RPC_URL`, () => {
      // T7: every console.* statement up to its `;`, so template strings and multi-line calls are covered too
      const src = fs.readFileSync(f, 'utf8');
      const prints = src.match(/console\.\w+\([\s\S]*?\);/g) ?? [];
      expect(prints.length).toBeGreaterThan(0); // the scan sees the file's output statements
      for (const stmt of prints) expect(stmt, `${f}: ${stmt.slice(0, 80)}`).not.toMatch(/rpcUrl|RPC_URL|rpcEndpoint/);
    });
  }

  it('the helper empties the env file unless the caller chose one', async () => {
    const saved = process.env.APEX_ENV_FILE;
    try {
      delete process.env.APEX_ENV_FILE;
      await import('../scripts/hermeticEnv?fresh1' as string).catch(async () => import('../scripts/hermeticEnv'));
      expect(process.env.APEX_ENV_FILE).toBe('');
    } finally {
      if (saved === undefined) delete process.env.APEX_ENV_FILE;
      else process.env.APEX_ENV_FILE = saved;
    }
  });

  it('T9: the helper removes an exported private key, which would beat SIGNER_KEYPAIR_PATH in the signer', async () => {
    vi.stubEnv('OPERATOR_PRIVATE_KEY', 'ambient-operator-key');
    vi.stubEnv('SOLANA_PRIVATE_KEY', 'ambient-solana-key');
    vi.resetModules(); // run the helper's top-level code again
    await import('../scripts/hermeticEnv');
    expect(process.env.OPERATOR_PRIVATE_KEY).toBeUndefined();
    expect(process.env.SOLANA_PRIVATE_KEY).toBeUndefined();
  });

  it('the smoke script spawns the server with an empty env file, a scratch DB and a keypair path that does not exist', () => {
    const src = fs.readFileSync('scripts/smoke.ts', 'utf8');
    expect(src).toMatch(/APEX_ENV_FILE: ''/);
    expect(src).toMatch(/APEX_DB_PATH: path\.join\(scratchDir/);
    expect(src).toMatch(/SIGNER_KEYPAIR_PATH: path\.join\(scratchDir, 'no-keypair\.json'\)/);
  });

  it('test_devnet_execution refuses the repo keypair and any non-devnet genesis', () => {
    const src = fs.readFileSync('scripts/test_devnet_execution.ts', 'utf8');
    expect(src).toMatch(/\.apex_trading_keypair\.json/);
    expect(src).toMatch(/genesisHash !== DEVNET_GENESIS_HASH\) \{\s*console\.error[\s\S]*process\.exit\(1\)/);
  });
});
