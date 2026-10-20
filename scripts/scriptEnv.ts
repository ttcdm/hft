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
  const isRepoFile = (p: string, name: string) => {
    const r = path.resolve(cwd, p);
    return r === path.resolve(cwd, name) || r === path.resolve(repoRoot, name);
  };
  const problems: string[] = [];
  const db = env.TEST_DB_PATH || env.APEX_DB_PATH;
  if (db !== ':memory:' && isRepoFile(db, 'apex_workstation.db')) problems.push(`the database would be the live ${db}`);
  if (isRepoFile(env.SIGNER_KEYPAIR_PATH, '.apex_trading_keypair.json')) problems.push(`the signer key would be the repo keypair ${env.SIGNER_KEYPAIR_PATH}`);
  return problems;
}
