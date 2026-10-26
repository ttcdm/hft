import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { startApp, startRpcStub, LOCALNET_STUB_GENESIS } from './helpers/liveServer';
import { hermeticScriptEnv } from '../scripts/scriptEnv';
import { WorkstationDatabase } from '../server/db/database';

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

// ---- R1-121 / N-54 / N-53: what a script really runs with, observed in a child process (the vitest worker's own env is never touched) ----
const tsxEsm = pathToFileURL(createRequire(path.resolve('package.json')).resolve('tsx/esm')).href;
const scratchDirs: string[] = [];
afterAll(() => { for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'l3-hermetic-')); scratchDirs.push(d); return d; };
const keyFile = (dir: string, name: string) => {
  const kp = Keypair.generate();
  const f = path.join(dir, name);
  fs.writeFileSync(f, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return { kp, f };
};
/** Runs `body` after `import hermeticEnv` (and loadEnv, as the devnet scripts do) in a fresh process with only `env` set. */
function runChild(cwd: string, env: Record<string, string>, body: string) {
  const abs = (p: string) => JSON.stringify(pathToFileURL(path.resolve(p)).href);
  const file = path.join(cwd, 'child.mts');
  fs.writeFileSync(file, `import ${abs('scripts/hermeticEnv.ts')};\nimport ${abs('server/loadEnv.ts')};\n${body.replace(/@repo\/([\w/]+)/g, (_m, p) => JSON.parse(abs(`${p}.ts`)))}\n`);
  // TMPDIR passes through as it does for a real script (macOS puts os.tmpdir() under /var/folders, not /tmp)
  const r = spawnSync(process.execPath, ['--import', tsxEsm, file], { cwd, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? cwd, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}), NODE_ENV: 'production', ...env }, encoding: 'utf8', timeout: 60_000 });
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '));
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), result: line ? JSON.parse(line.slice(7)) : null };
}
const PRINT_SIGNER_AND_DB = `const { localSigner } = await import('@repo/server/solana/signer');
const { workstationDb } = await import('@repo/server/db/database');
const st = localSigner.getStatus();
console.log('RESULT ' + JSON.stringify({ opk: process.env.OPERATOR_PRIVATE_KEY ?? null, envFile: process.env.APEX_ENV_FILE, status: st, signer: st === 'READY' ? localSigner.getPublicKey().toBase58() : null, db: workstationDb.getDbPath() }));
process.exit(0);`;

describe('R1-121 / N-54: hermeticEnv mirrors the vitest sanitation', () => {
  /** What hermeticScriptEnv makes of `env` in `cwd`, computed in this process on a copy (process.env is not touched). */
  const sanitized = (env: Record<string, string>, cwd: string) => {
    const e: NodeJS.ProcessEnv = { ...env };
    const problems = hermeticScriptEnv(e, cwd, path.resolve('.'));
    for (const f of [e.APEX_DB_PATH, e.SIGNER_KEYPAIR_PATH]) if (f && /apex-script-/.test(path.dirname(f))) scratchDirs.push(path.dirname(f));
    return { env: e, problems };
  };

  it('an exported APEX_ENV_FILE holding a private key is ignored: OPERATOR_PRIVATE_KEY stays unset and the signer is the SIGNER_KEYPAIR_PATH key', () => {
    const d = scratch();
    const envKey = Keypair.generate();
    const envFile = path.join(d, 'operator.env');
    fs.writeFileSync(envFile, `OPERATOR_PRIVATE_KEY=${bs58.encode(envKey.secretKey)}\n`);
    const throwaway = keyFile(d, 'throwaway.json');
    const env = { APEX_ENV_FILE: envFile, SIGNER_KEYPAIR_PATH: throwaway.f, APEX_DB_PATH: path.join(d, 'a.db') };
    expect(sanitized(env, d).env.APEX_ENV_FILE).toBe('');
    const r = runChild(d, env, PRINT_SIGNER_AND_DB);
    expect(r.result, r.out).not.toBeNull();
    expect(r.result.envFile).toBe('');
    expect(r.result.opk).toBeNull();
    expect(r.result.status).toBe('READY');
    expect(r.result.signer).toBe(throwaway.kp.publicKey.toBase58());
    expect(r.result.signer).not.toBe(envKey.publicKey.toBase58());
  });

  it('with a clean environment the database is a scratch file and the signer is NOT_CONFIGURED, even next to a repo keypair', () => {
    const d = scratch();
    keyFile(d, '.apex_trading_keypair.json'); // the default key file the signer would read from the cwd
    const own = sanitized({}, d);
    expect(own.problems).toEqual([]);
    expect(fs.existsSync(own.env.SIGNER_KEYPAIR_PATH!)).toBe(false);
    const r = runChild(d, {}, PRINT_SIGNER_AND_DB);
    expect(r.result, r.out).not.toBeNull();
    expect(r.result.status).toBe('NOT_CONFIGURED');
    expect(path.basename(path.dirname(r.result.db))).toMatch(/^apex-script-/); // a mkdtemp directory
    expect(path.dirname(path.dirname(r.result.db))).toBe(path.dirname(path.dirname(own.env.APEX_DB_PATH!)));
    expect(fs.existsSync(path.join(d, 'apex_workstation.db'))).toBe(false);
  });

  it('an exported TEST_DB_PATH no longer beats the script\'s APEX_DB_PATH (unless APEX_SCRIPT_KEEP_TEST_DB_PATH=true)', () => {
    const d = scratch();
    const mine = path.join(d, 'mine.db');
    expect(sanitized({ TEST_DB_PATH: ':memory:', APEX_DB_PATH: mine }, d).env.TEST_DB_PATH).toBeUndefined();
    expect(runChild(d, { TEST_DB_PATH: ':memory:', APEX_DB_PATH: mine }, PRINT_SIGNER_AND_DB).result.db).toBe(mine);
    expect(runChild(d, { TEST_DB_PATH: ':memory:', APEX_DB_PATH: mine, APEX_SCRIPT_KEEP_TEST_DB_PATH: 'true' }, PRINT_SIGNER_AND_DB).result.db).toBe(':memory:');
  });

  it('exits 2 when the database is ./apex_workstation.db or the key is the repo keypair, unless APEX_SCRIPT_ALLOW_REPO_STATE=true', () => {
    const d = scratch();
    const repoKey = keyFile(d, '.apex_trading_keypair.json');
    expect(sanitized({ APEX_DB_PATH: './apex_workstation.db' }, d).problems).toHaveLength(1);
    expect(sanitized({ SIGNER_KEYPAIR_PATH: path.resolve('.apex_trading_keypair.json') }, d).problems).toHaveLength(1); // the repo's own, from another cwd
    const liveDb = runChild(d, { APEX_DB_PATH: './apex_workstation.db' }, PRINT_SIGNER_AND_DB);
    expect(liveDb.status, liveDb.out).toBe(2);
    expect(liveDb.out).toMatch(/hermeticEnv: refusing to run: the database would be the live/);
    const repoKeyRun = runChild(d, { SIGNER_KEYPAIR_PATH: repoKey.f }, PRINT_SIGNER_AND_DB);
    expect(repoKeyRun.status, repoKeyRun.out).toBe(2);
    expect(repoKeyRun.out).toMatch(/the signer key would be the repo keypair/);
    expect(repoKeyRun.result).toBeNull(); // nothing after the import ran
    const optedIn = runChild(d, { SIGNER_KEYPAIR_PATH: repoKey.f, APEX_DB_PATH: path.join(d, 'x.db'), APEX_SCRIPT_ALLOW_REPO_STATE: 'true' }, PRINT_SIGNER_AND_DB);
    expect(optedIn.status, optedIn.out).toBe(0);
    expect(optedIn.result.signer).toBe(repoKey.kp.publicKey.toBase58());
  });

  it('the repo keypair named through a symlinked directory or a symlink is still refused (macOS /var -> /private/var)', () => {
    const d = fs.realpathSync(scratch());
    keyFile(d, '.apex_trading_keypair.json');
    const linkDir = path.join(fs.realpathSync(scratch()), 'linked');
    fs.symlinkSync(d, linkDir);
    expect(sanitized({ SIGNER_KEYPAIR_PATH: path.join(linkDir, '.apex_trading_keypair.json') }, d).problems).toHaveLength(1);
    expect(sanitized({ SIGNER_KEYPAIR_PATH: '.apex_trading_keypair.json' }, linkDir).problems).toHaveLength(1);
    const fileLink = path.join(path.dirname(linkDir), 'key-link.json');
    fs.symlinkSync(path.join(d, '.apex_trading_keypair.json'), fileLink);
    expect(sanitized({ SIGNER_KEYPAIR_PATH: fileLink }, d).problems).toHaveLength(1);
    const run = runChild(d, { SIGNER_KEYPAIR_PATH: path.join(linkDir, '.apex_trading_keypair.json') }, PRINT_SIGNER_AND_DB);
    expect(run.status, run.out).toBe(2);
  });

  it('S267 (review 2026-10-24, finding 5): a hard link to the repo keypair, or its name in another case on a case-insensitive volume, is still refused', () => {
    const d = fs.realpathSync(scratch());
    keyFile(d, '.apex_trading_keypair.json');
    const hard = path.join(fs.realpathSync(scratch()), 'hard-link.json');
    fs.linkSync(path.join(d, '.apex_trading_keypair.json'), hard);
    expect(sanitized({ SIGNER_KEYPAIR_PATH: hard }, d).problems).toHaveLength(1);
    const upper = path.join(d, '.APEX_TRADING_KEYPAIR.json');
    if (fs.existsSync(upper)) expect(sanitized({ SIGNER_KEYPAIR_PATH: upper }, d).problems).toHaveLength(1); // APFS/HFS+ default: case-insensitive
    // a different file of the same name elsewhere is not the repo keypair
    const other = fs.realpathSync(scratch());
    keyFile(other, 'own-key.json');
    expect(sanitized({ SIGNER_KEYPAIR_PATH: path.join(other, 'own-key.json') }, d).problems).toHaveLength(0);
  });

  it('T9: an exported private key is removed, so it cannot beat SIGNER_KEYPAIR_PATH', () => {
    const d = scratch();
    const shellKey = bs58.encode(Keypair.generate().secretKey);
    const own = sanitized({ OPERATOR_PRIVATE_KEY: shellKey, SOLANA_PRIVATE_KEY: shellKey }, d).env;
    expect([own.OPERATOR_PRIVATE_KEY, own.SOLANA_PRIVATE_KEY]).toEqual([undefined, undefined]);
    const r = runChild(d, { OPERATOR_PRIVATE_KEY: shellKey, SOLANA_PRIVATE_KEY: shellKey }, PRINT_SIGNER_AND_DB);
    expect(r.result, r.out).not.toBeNull();
    expect(r.result.opk).toBeNull();
    expect(r.result.status).toBe('NOT_CONFIGURED');
  });
});

describe('N-53: the visual fixture server never loads a signing key', () => {
  it('booted in a directory holding a .apex_trading_keypair.json, its signer is NOT_CONFIGURED and it adopts nothing from that wallet', async () => {
    const d = scratch();
    keyFile(d, '.apex_trading_keypair.json');
    const dbPath = path.join(d, 'fixture.db');
    const rpc = await startRpcStub(LOCALNET_STUB_GENESIS);
    // the fixture is booted like server.ts in the behaviour tests, with no key path given: it must choose a missing one itself
    const app = await startApp(d, { SOLANA_RPC_URL: rpc.url, SIGNER_KEYPAIR_PATH: '', APEX_DB_PATH: dbPath }, { entry: 'scripts/visual/serve_fixture.ts' });
    try {
      for (let i = 0; i < 240 && !/\[visual-fixture\] seeded/.test(app.logs()); i++) await new Promise((r) => setTimeout(r, 250));
      expect(app.logs()).toMatch(/\[visual-fixture\] seeded/);
      expect((await app.call('GET', '/api/signer/status')).json.status).toBe('NOT_CONFIGURED');
      expect(rpc.count('getTokenAccountsByOwner')).toBe(0); // the wallet scan never ran: there is no wallet
    } finally { await app.stop(); await rpc.close(); }
    const db = new WorkstationDatabase(dbPath);
    const ids = db.loadPositions().map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['visual-fixture-3', 'visual-fixture-4'])); // the fixture's own rows: this is its database
    expect(ids.filter((id) => id.startsWith('recovered-'))).toEqual([]);
    expect(fs.existsSync(path.join(d, 'apex_workstation.db'))).toBe(false);
  }, 150_000);
});
