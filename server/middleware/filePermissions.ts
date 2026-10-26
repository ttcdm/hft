import fs from 'fs';
import path from 'path';

export interface LoosePermissionFinding {
  path: string;
  mode: string;
}

/**
 * Returns the existing files among `paths` that are readable or writable by group or others.
 * POSIX only: on Windows the mode bits are not meaningful, so nothing is reported.
 */
export function findLoosePermissions(
  paths: string[],
  platform: NodeJS.Platform = process.platform
): LoosePermissionFinding[] {
  if (platform === 'win32') return [];
  const findings: LoosePermissionFinding[] = [];
  for (const p of paths) {
    try {
      const stat = fs.statSync(p);
      if (!stat.isFile()) continue;
      if ((stat.mode & 0o077) !== 0) {
        findings.push({ path: p, mode: (stat.mode & 0o777).toString(8).padStart(3, '0') });
      }
    } catch {
      // Missing or unreadable files are not a permissions finding.
    }
  }
  return findings;
}

/** Top-level file names in the project root that hold secrets or state (copies of .env, wallet files, databases, logs). */
const SECRET_NAME_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/, /^env\..*\.txt$/, /^env\.txt$/, /keypair.*\.json$/, /\.signer\.json$/, /^\.operator_session/,
  /\.db(-.+)?$/, /\.wal$/, /\.log$/,
];

/** Secret-bearing files the server reads at startup, plus look-alikes sitting in the project root (env.txt, .env.bak-*, db/wal, server.log). Warn-only: nothing is ever chmod-ed. */
export function defaultSecretFilePaths(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string[] {
  const keypair = env.SIGNER_KEYPAIR_PATH || path.join(cwd, '.apex_trading_keypair.json');
  const found = new Set<string>([path.join(cwd, '.env'), keypair]);
  try {
    for (const name of fs.readdirSync(cwd)) {
      if (name === '.env.example') continue;
      if (SECRET_NAME_PATTERNS.some((r) => r.test(name))) found.add(path.join(cwd, name));
    }
  } catch {
    // unreadable cwd: keep the two fixed paths
  }
  return [...found];
}

export function loosePermissionWarnings(findings: LoosePermissionFinding[]): string[] {
  return findings.map(
    (f) => `Secret file ${f.path} has mode ${f.mode} (readable by group or others). Run: chmod 600 ${f.path}`
  );
}
