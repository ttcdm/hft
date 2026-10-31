/**
 * Build release.zip from tracked and untracked-but-not-ignored files, minus anything isShippable() refuses and (R13-9) the configured key,
 * database and env file (configuredSecretFiles), whose names need not match any glob. Those paths are read from the environment and from the
 * env file the server would load (APEX_ENV_FILE, else .env), without changing process.env.
 * Run: npm run package:release
 */
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import dotenv from 'dotenv';
import { configuredSecretFiles, isShippableFrom } from '../server/security/secretPaths';

const root = process.cwd();
const envFile = process.env.APEX_ENV_FILE !== undefined ? process.env.APEX_ENV_FILE : '.env';
let fileEnv: Record<string, string> = {};
if (envFile && fs.existsSync(envFile)) {
  try {
    fileEnv = dotenv.parse(fs.readFileSync(envFile));
  } catch (e: any) {
    console.error(`package:release: ${envFile} could not be read (${e?.message ?? e}); refusing to package without knowing the configured secret paths`);
    process.exit(1);
  }
}
// the real environment wins over the file, as in server/loadEnv.ts
const secretFiles = configuredSecretFiles(root, { ...fileEnv, ...process.env });

const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const files = listed.filter((f) => fs.existsSync(f) && isShippableFrom(f, root, secretFiles));
if (fs.existsSync('release.zip')) fs.rmSync('release.zip');
const r = spawnSync('zip', ['-q', 'release.zip', '-@'], { input: files.join('\n') + '\n', stdio: ['pipe', 'inherit', 'inherit'] });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`release.zip: ${files.length} files (${listed.length - files.length} refused by server/security/secretPaths.ts)`);
