/**
 * Import this FIRST in any script that signs or spawns the server. It applies `hermeticScriptEnv` (see `scripts/scriptEnv.ts`) to
 * process.env, so a script can never pick up the real wallet key, the live database, the RPC URL or API keys by accident: no `.env` is
 * loaded, an exported private key or TEST_DB_PATH is dropped, and the database and key path default to scratch files. Pass what the
 * script needs (a throwaway key path, an RPC URL) through the process environment. The process exits with code 2 if the database would
 * be `./apex_workstation.db` or the key the repo keypair, unless APEX_SCRIPT_ALLOW_REPO_STATE=true.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermeticScriptEnv } from './scriptEnv';

const problems = hermeticScriptEnv(process.env, process.cwd(), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
if (problems.length > 0) {
  console.error(`hermeticEnv: refusing to run: ${problems.join('; ')}. Pass a scratch APEX_DB_PATH and a throwaway SIGNER_KEYPAIR_PATH (or set APEX_SCRIPT_ALLOW_REPO_STATE=true if you really mean it).`);
  process.exit(2);
}
