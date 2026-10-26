/**
 * Side-effect module: load `.env` into process.env. It MUST be the first import of every entry point.
 *
 * ES imports are hoisted, so a `dotenv.config()` call written after the import list in server.ts ran only after every
 * imported module had already been evaluated. Singletons built at import time (the signer, executionConfig, the
 * database, the coordinator, auth) therefore saw the environment WITHOUT `.env`: OPERATOR_PRIVATE_KEY in `.env` was
 * ignored and the default keypair file was used. Keeping the load in its own module, imported first, fixes the order in
 * both tsx and the esbuild CJS bundle (the bundle initialises modules in import order).
 *
 * Semantics are unchanged from before: dotenv's default, so a variable already set in the real environment wins.
 *
 * Tests are hermetic: under vitest the repo `.env` is NEVER read (it can point at a real RPC and a real key, which turned
 * startup reconciliation into network I/O on a machine with a populated `.env`). A `.env.test` file is read instead if it exists.
 * APEX_ENV_FILE (set, even to '') replaces `.env` outside tests so scripts that spawn the server never pick up the real one.
 */
import dotenv from 'dotenv';

if (process.env.VITEST) {
  dotenv.config({ path: '.env.test', quiet: true } as any);
} else if (process.env.APEX_ENV_FILE !== undefined) {
  // Hermetic runs (smoke, localnet e2e) name the env file explicitly; an empty value means "load no file at all".
  if (process.env.APEX_ENV_FILE) dotenv.config({ path: process.env.APEX_ENV_FILE, quiet: true } as any);
} else {
  dotenv.config();
}
