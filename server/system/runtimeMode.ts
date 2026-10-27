/**
 * R5-14: which way the server serves the UI. `npm start` runs `node dist/server.cjs` with no NODE_ENV, and server.ts used to take the
 * development branch (Vite dev middleware over the whole project folder, behind only the secret-file guard) whenever NODE_ENV was not
 * `production`. npm scripts cannot set an environment variable portably (Windows needs cross-env), so the bundle decides for itself: the
 * esbuild bundle (`dist/server.cjs`) always runs as production, and only `tsx server.ts` (`npm run dev`) can run the dev middleware.
 *
 * Called by: server.ts (before `express()` is built, so express also sees production).
 */
import path from 'node:path';

/** True when this code runs from the esbuild CJS bundle, `server.cjs`. In the bundle every module shares the bundle's `__filename`. */
export function isBundledServer(filename: string = typeof __filename === 'string' ? __filename : ''): boolean {
  return path.basename(filename) === 'server.cjs';
}

/**
 * Makes the bundled server run as production: when it runs with NODE_ENV unset or set to anything but `production` (and not `test`,
 * which never starts a server), NODE_ENV is set to `production` and a line says so. Returns that line, or null when nothing changed.
 */
export function defaultBundledToProduction(env: NodeJS.ProcessEnv = process.env, bundled: boolean = isBundledServer()): string | null {
  if (!bundled || env.NODE_ENV === 'production' || env.NODE_ENV === 'test') return null;
  const was = env.NODE_ENV === undefined ? 'unset' : `"${String(env.NODE_ENV).slice(0, 20)}"`;
  env.NODE_ENV = 'production';
  return `[APEX QUANT HFT] NODE_ENV was ${was}; the bundled server (dist/server.cjs) always runs in production mode and serves dist/, never the dev middleware.`;
}

/** Whether to mount the Vite dev middleware: only outside the bundle and outside production. */
export function useDevMiddleware(env: NodeJS.ProcessEnv = process.env, bundled: boolean = isBundledServer()): boolean {
  return !bundled && env.NODE_ENV !== 'production';
}
