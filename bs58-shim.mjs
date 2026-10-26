/**
 * ESM shim for bs58 v5 (CJS).
 *
 * bs58 v5 exports via `module.exports = basex(ALPHABET)` — a dynamic factory
 * whose named members Vite cannot statically analyse. Any ESM consumer that
 * does `import { decode } from 'bs58'` therefore gets a "named export not
 * found" error even when bs58 is in server.deps.inline.
 *
 * This shim loads the CJS package through Node's require (bypassing Vite's
 * alias so there is no recursion) and explicitly re-exports each named member,
 * giving Vitest's ESM runner the static named-export surface it needs.
 *
 * Used only in the Vitest test environment via resolve.alias in vitest.config.ts.
 * NOT bundled by esbuild (esbuild only bundles server.ts, not test config).
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const bs58pkg = require('bs58'); // loads node_modules/bs58 directly via CJS require — no alias loop

export const encode = bs58pkg.encode.bind(bs58pkg);
export const decode = bs58pkg.decode.bind(bs58pkg);
export const decodeUnsafe = bs58pkg.decodeUnsafe
  ? bs58pkg.decodeUnsafe.bind(bs58pkg)
  : undefined;

export default bs58pkg;
