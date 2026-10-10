/**
 * Build release.zip from tracked and untracked-but-not-ignored files, minus anything isShippable() refuses.
 * Run: npm run package:release
 */
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import { isShippable } from '../server/security/secretPaths';

const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const files = listed.filter((f) => fs.existsSync(f) && isShippable(f));
if (fs.existsSync('release.zip')) fs.rmSync('release.zip');
const r = spawnSync('zip', ['-q', 'release.zip', '-@'], { input: files.join('\n') + '\n', stdio: ['pipe', 'inherit', 'inherit'] });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`release.zip: ${files.length} files (${listed.length - files.length} refused by server/security/secretPaths.ts)`);
