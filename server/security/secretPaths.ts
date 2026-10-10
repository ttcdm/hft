/**
 * Which files may go into a release archive or a Docker image. One list, used by `npm run package:release` and checked by
 * tests/k2_release_hygiene.test.ts against the real secret file names (env.txt, .apex_trading_keypair.json, *.db, ...).
 * The previous zip globs missed env.txt and .apex_trading_keypair.json.
 */
export const DENY_DIRS = ['.git', '.agents', '.antigravity', '.overnight', 'node_modules', 'dist', 'coverage', 'target', 'build'];

/** Basename globs (`*` only). A leading `!` re-allows a name that an earlier glob denied. */
export const DENY_FILE_GLOBS = [
  '.env', '.env.*', 'env.txt', 'env.*.txt',
  '*keypair*.json', '*.signer.json', '.apex_*', '.operator_session*',
  '*.pem', '*.key',
  '*.db', '*.db-*', '*.db.*', '*.wal', '*.shm', '*.sqlite', '*.sqlite3',
  '*.log', '*.sock', '*.zip',
  '.DS_Store',
];
export const ALLOW_FILE_GLOBS = ['.env.example'];

const toRegex = (glob: string) => new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
const denyRes = DENY_FILE_GLOBS.map(toRegex);
const allowRes = ALLOW_FILE_GLOBS.map(toRegex);

/**
 * F2: the dev server must still reach Vite's own client and pre-bundled deps under node_modules (/@vite/client,
 * /node_modules/.vite/deps/...). node_modules holds no secrets, so it is denied for releases but not for dev serving.
 */
export const DEV_DENY_DIRS = DENY_DIRS.filter((d) => d !== 'node_modules');

function allowedPath(relPath: string, denyDirs: string[]): boolean {
  const parts = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.slice(0, -1).some((d) => denyDirs.includes(d))) return false;
  const base = parts[parts.length - 1];
  if (allowRes.some((r) => r.test(base))) return true;
  return !denyRes.some((r) => r.test(base));
}

/** true when `relPath` (POSIX-style, relative to the repo root) may be shipped. */
export function isShippable(relPath: string): boolean {
  return allowedPath(relPath, DENY_DIRS);
}

/** true when the dev server may serve `relPath`: same secret-file rules, but node_modules is allowed (F2). */
export function isServableInDev(relPath: string): boolean {
  return allowedPath(relPath, DEV_DENY_DIRS);
}

/** Lines for `.dockerignore`, generated from the same lists so the two cannot drift. */
export function dockerignoreLines(): string[] {
  return [
    ...DENY_DIRS.map((d) => `**/${d}`),
    ...DENY_FILE_GLOBS.map((g) => `**/${g}`),
    ...ALLOW_FILE_GLOBS.map((g) => `!${g}`),
  ];
}

/** Vite `server.fs.deny` globs from the same lists (replaces Vite's default list, so its own defaults are repeated). */
export function viteFsDeny(): string[] {
  return [
    '.env', '.env.*', '*.{crt,pem}',
    ...DEV_DENY_DIRS.map((d) => `**/${d}/**`),
    ...DENY_FILE_GLOBS.filter((g) => !ALLOW_FILE_GLOBS.includes(g)).map((g) => `**/${g}`),
  ];
}

export function viteDevServerOptions() {
  return { middlewareMode: true as const, hmr: false as const, fs: { strict: true, deny: viteFsDeny() } };
}

/**
 * Express middleware placed BEFORE the Vite dev middleware: answers 404 for any URL whose path is a secret or state file
 * (decoded up to twice, backslashes and `/@fs/` prefixes handled), whatever Vite's own deny list does.
 * `npm run dev` serves the project root, and the /api auth gate does not cover static paths.
 */
export function secretPathGuard(root: string) {
  const rootPosix = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return (req: { url?: string }, res: { statusCode: number; end: (s?: string) => void }, next: () => void) => {
    let p = (req.url || '/').split('?')[0].split('#')[0];
    for (let i = 0; i < 2; i++) {
      try { p = decodeURIComponent(p); } catch { break; }
    }
    p = p.replace(/\\/g, '/');
    if (p.startsWith('/@fs/')) p = p.slice(4);
    if (p.startsWith(rootPosix + '/')) p = p.slice(rootPosix.length);
    const segments = p.split('/').filter((s) => s && s !== '.');
    const normalized: string[] = [];
    for (const s of segments) { if (s === '..') normalized.pop(); else normalized.push(s); }
    if (normalized.length > 0 && !isServableInDev(normalized.join('/'))) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    next();
  };
}
