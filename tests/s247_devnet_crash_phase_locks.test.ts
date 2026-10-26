import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { acquireLock, releaseAllLocks, readLock, dbLockPath } from '../server/system/instanceLock';

/** As the harness checks it: the lock file on disk still names this process. */
const holdsLock = (p: string) => readLock(p)?.pid === process.pid;
import { handOverToChildPhases } from '../scripts/devnet_e2e_steps';

const tsxEsm = pathToFileURL(createRequire(path.resolve('package.json')).resolve('tsx/esm')).href;
const lockModule = pathToFileURL(path.resolve('server/system/instanceLock.ts')).href;

/** A fresh process that takes the same locks, as the (f) crash child's coordinator.start() does. Exit 0 when it got both. */
function childTakes(lockPaths: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's247-child-'));
  const file = path.join(dir, 'child.mts');
  fs.writeFileSync(file, `import { acquireLock } from '${lockModule}';\nfor (const p of ${JSON.stringify(lockPaths)}) acquireLock(p);\nconsole.log('GOT_LOCKS');\n`);
  return spawnSync(process.execPath, ['--import', tsxEsm, file], { encoding: 'utf8', timeout: 60_000 });
}

afterEach(() => releaseAllLocks());

describe('S247 (f): the main process hands its locks to the crash and recover children', () => {
  it('before the hand-over a child exits INSTANCE_LOCKED (the Mac run); after it, the child takes both locks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's247-'));
    const lockPaths = [dbLockPath(path.join(dir, 'e2e.db'))!, path.join(dir, 'locks', 'Wallet111.lock')];
    for (const p of lockPaths) acquireLock(p);

    const blocked = childTakes(lockPaths);
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toMatch(/INSTANCE_LOCKED/);

    const recs: Array<{ step: string; ok: boolean; detail: string }> = [];
    let armed = true;
    let stopped = 0;
    // S268: an exit pass is still running when trading stops; the locks are released only after it settles
    let passDone!: () => void;
    const pass = new Promise<void>((r) => { passDone = r; });
    const order: string[] = [];
    const handing = handOverToChildPhases({ rec: (step, o, detail) => recs.push({ step, ok: o, detail }) }, {
      stopTrading: () => { stopped++; }, isLiveArmed: () => armed, disarm: () => { armed = false; },
      releaseAllLocks: () => { order.push('released'); releaseAllLocks(); }, holdsLock, lockPaths,
      exitPassDone: () => pass.then(() => { order.push('pass done'); }),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]); // still waiting for the pass
    for (const p of lockPaths) expect(fs.existsSync(p)).toBe(true);
    passDone();
    const ok = await handing;
    expect(order).toEqual(['pass done', 'released']);
    expect(ok).toBe(true);
    expect(stopped).toBe(1);
    expect(armed).toBe(false);
    expect(recs).toEqual([expect.objectContaining({ step: '(f) main process stopped trading and released its locks', ok: true })]);
    for (const p of lockPaths) expect(fs.existsSync(p)).toBe(false);

    const free = childTakes(lockPaths);
    expect(free.stdout).toMatch(/GOT_LOCKS/);
    expect(free.status).toBe(0);
  }, 120_000);

  it('reports a lock it could not release, and the harness then does not spawn', async () => {
    const recs: Array<{ ok: boolean; detail: string }> = [];
    const ok = await handOverToChildPhases({ rec: (_s, o, detail) => recs.push({ ok: o, detail }) }, {
      stopTrading: () => undefined, isLiveArmed: () => false, disarm: () => undefined,
      releaseAllLocks: () => undefined, holdsLock: () => true, lockPaths: ['/scratch/e2e.db.lock'], exitPassDone: async () => undefined,
    });
    expect(ok).toBe(false);
    expect(recs[0]).toEqual({ ok: false, detail: expect.stringContaining('/scratch/e2e.db.lock') });
  });
});
