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
 */
import dotenv from 'dotenv';

dotenv.config();
