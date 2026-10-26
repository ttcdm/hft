import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The sanitation `scripts/hermeticEnv.ts` applies to a script's environment, as a function of the environment object (no other side
 * effect than one `mkdtemp` directory when a default is needed). It mirrors `vitest.config.ts`:
 *  - `APEX_ENV_FILE` is always '' (R1-121): `server/loadEnv` loads no `.env` at all, even when the shell exports a file name.
 *  - `OPERATOR_PRIVATE_KEY` and `SOLANA_PRIVATE_KEY` are removed (T9/T10): an exported key beats `SIGNER_KEYPAIR_PATH` in the signer, so a
 *    script that believes it signs with its throwaway keypair could sign with the shell's key.
 *  - `TEST_DB_PATH` is removed (it beats `APEX_DB_PATH` in `server/db/database.ts`), unless `APEX_SCRIPT_KEEP_TEST_DB_PATH=true` (N-54).
 *  - `APEX_DB_PATH` defaults to a fresh scratch file and `SIGNER_KEYPAIR_PATH` to a file that does not exist, unless the caller passes them.
 * Returns why the result still points at the live database (`./apex_workstation.db`) or the repo keypair (`./.apex_trading_keypair.json`),
 * in `cwd` or in `repoRoot`; empty when it does not or when `APEX_SCRIPT_ALLOW_REPO_STATE=true`.
 */
export function hermeticScriptEnv(env: NodeJS.ProcessEnv, cwd: string, repoRoot: string): string[] {
  env.APEX_ENV_FILE = '';
  delete env.OPERATOR_PRIVATE_KEY;
  delete env.SOLANA_PRIVATE_KEY;
  if (env.APEX_SCRIPT_KEEP_TEST_DB_PATH !== 'true') delete env.TEST_DB_PATH;

  let scratch: string | null = null;
  const scratchDir = () => (scratch ??= fs.mkdtempSync(path.join(os.tmpdir(), 'apex-script-')));
  if (!env.APEX_DB_PATH) env.APEX_DB_PATH = path.join(scratchDir(), 'script.db');
  if (!env.SIGNER_KEYPAIR_PATH) env.SIGNER_KEYPAIR_PATH = path.join(scratchDir(), 'no-keypair.json');

  if (env.APEX_SCRIPT_ALLOW_REPO_STATE === 'true') return [];
  // Symlinks are resolved on both sides (macOS: /var is /private/var, and process.cwd() reports the real path), so a link to the repo
  // file, or the same file named through a linked directory, is still the repo file.
  // S267 (review 2026-10-24, finding 5): when both files exist they are also compared as files (device and inode), so a hard link, or a
  // name that differs only in case on a case-insensitive volume (APFS by default), is still the repo file.
  const isRepoFile = (p: string, name: string) => {
    const target = path.resolve(cwd, p);
    const r = realPath(target);
    return [path.resolve(cwd, name), path.resolve(repoRoot, name)].some((repo) => r === realPath(repo) || sameFile(target, repo));
  };
  const problems: string[] = [];
  const db = env.TEST_DB_PATH || env.APEX_DB_PATH;
  if (db !== ':memory:' && isRepoFile(db, 'apex_workstation.db')) problems.push(`the database would be the live ${db}`);
  if (isRepoFile(env.SIGNER_KEYPAIR_PATH, '.apex_trading_keypair.json')) problems.push(`the signer key would be the repo keypair ${env.SIGNER_KEYPAIR_PATH}`);
  return problems;
}

/** True when both paths exist and are the same file (same device and inode): links, hard links and case variants included. */
function sameFile(a: string, b: string): boolean {
  try {
    const x = fs.statSync(a);
    const y = fs.statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/** `p` with every symlink resolved; for a file that does not exist yet, its nearest existing parent is resolved instead. */
function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    return parent === p ? p : path.join(realPath(parent), path.basename(p));
  }
}
