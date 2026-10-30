import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  acquireLock, releaseAllLocks, heartbeatHeldLocks, isLockHeld, readLock, LOCK_HEARTBEAT_STALE_MS, LOCK_HEARTBEAT_MS,
} from '../server/system/instanceLock';
import { scratchDir } from './helpers/liveServer';

/**
 * R13-10: "nothing signs without the start lock" read only the in-memory held map, and a heartbeat whose rewrite threw only logged. On a
 * slow or failing mount another process may take the lock once the heartbeat is LOCK_HEARTBEAT_STALE_MS old, while this one kept signing.
 * Now a lock whose last confirmed heartbeat is that old counts as held only if it can be confirmed on disk right then. Real lock module on a
 * scratch directory; the failing mount is fs.openSync throwing (the rewrite's open), the only stub.
 */
afterEach(() => {
  vi.restoreAllMocks();
  releaseAllLocks();
});

const eio = () => Object.assign(new Error('EIO: i/o error, open'), { code: 'EIO' });

describe('R13-10: a lock whose heartbeat keeps failing past the stale window is lost', () => {
  it('a heartbeat that throws, then a check past the stale window: not held', () => {
    const lock = path.join(scratchDir('r1310-'), 'app.db.lock');
    const info = acquireLock(lock);
    expect(isLockHeld(lock)).toBe(true);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(fs, 'openSync').mockImplementation(() => { throw eio(); });
    heartbeatHeldLocks(info.heartbeatAt! + LOCK_HEARTBEAT_MS); // fails: only logged
    expect(err).toHaveBeenCalled();
    expect(isLockHeld(lock, info.heartbeatAt! + LOCK_HEARTBEAT_STALE_MS + 1)).toBe(false);
  });

  it('inside the window a failed heartbeat does not drop the lock (one bad write is not a takeover)', () => {
    const lock = path.join(scratchDir('r1310-'), 'app.db.lock');
    const info = acquireLock(lock);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(fs, 'openSync').mockImplementation(() => { throw eio(); });
    heartbeatHeldLocks(info.heartbeatAt! + LOCK_HEARTBEAT_MS);
    expect(isLockHeld(lock, info.heartbeatAt! + 2 * LOCK_HEARTBEAT_MS)).toBe(true);
  });

  it('a heartbeat that was only late (timer starved) is confirmed on disk at the check, and the lock stays held', () => {
    const lock = path.join(scratchDir('r1310-'), 'app.db.lock');
    const info = acquireLock(lock);
    const later = info.heartbeatAt! + LOCK_HEARTBEAT_STALE_MS + 1;
    expect(isLockHeld(lock, later)).toBe(true);
    expect(readLock(lock)?.heartbeatAt).toBe(later); // the check rewrote the heartbeat
  });
});
