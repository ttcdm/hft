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

/** true when `relPath` (POSIX-style, relative to the repo root) may be shipped. */
export function isShippable(relPath: string): boolean {
  const parts = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.slice(0, -1).some((d) => DENY_DIRS.includes(d))) return false;
  const base = parts[parts.length - 1];
  if (allowRes.some((r) => r.test(base))) return true;
  return !denyRes.some((r) => r.test(base));
}

/** Lines for `.dockerignore`, generated from the same lists so the two cannot drift. */
export function dockerignoreLines(): string[] {
  return [
    ...DENY_DIRS.map((d) => `**/${d}`),
    ...DENY_FILE_GLOBS.map((g) => `**/${g}`),
    ...ALLOW_FILE_GLOBS.map((g) => `!${g}`),
  ];
}
