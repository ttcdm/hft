import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  acquireLock, releaseAllLocks, readLock, otherLiveLockHolder, liveLockHolder, heartbeatHeldLocks, updateHeldLock, InstanceLockError,
  LOCK_BOOT_ID, LOCK_PID_NAMESPACE, LOCK_HEARTBEAT_STALE_MS,
} from '../server/system/instanceLock';
import { scratchDir } from './helpers/liveServer';

/**
 * R4-1: in Docker every server is PID 1, so a second container on the same volume adopted the first one's lock (same pid) or took it over
 * (its pid is not alive in this namespace). Now a lock carries a per-boot id, a heartbeat and the holder's pid namespace, and a lock of
 * another boot with a fresh heartbeat is refused whatever its pid. Round 1 #23: the lock is written atomically.
 * Real lock module on a scratch directory; the "other container" is a lock file written as that container's server would write it.
 */
afterEach(() => releaseAllLocks());

const OTHER_NS = 'other-container-id|pid:[4026532999]';
function writeForeign(lockPath: string, fields: Record<string, unknown>) {
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 1000, bootId: 'b'.repeat(32), heartbeatAt: Date.now(), pidNs: OTHER_NS, ...fields }));
}

describe('R4-1: the instance lock is held by boot id and heartbeat, not by pid alone', () => {
  it('another container with the same pid (PID 1 in both) and a fresh heartbeat: refused, not adopted', () => {
    const lock = path.join(scratchDir('r41-'), 'app.db.lock');
    writeForeign(lock, {});
    expect(() => acquireLock(lock)).toThrow(InstanceLockError);
    expect(() => acquireLock(lock)).toThrow(/INSTANCE_LOCKED: .*heartbeat/);
    expect(readLock(lock)?.bootId).toBe('b'.repeat(32)); // left as it was
    expect(otherLiveLockHolder(lock)?.bootId).toBe('b'.repeat(32)); // the auto restore and the seed script see it too
  });

  it('another container whose pid is not alive here, with a fresh heartbeat: refused, not taken over', () => {
    const lock = path.join(scratchDir('r41-'), 'app.db.lock');
    writeForeign(lock, { pid: 999_999 });
    expect(() => acquireLock(lock)).toThrow(InstanceLockError);
  });

  it('another boot whose heartbeat is stale (a crashed container, our pid again after a restart): taken over', () => {
    const lock = path.join(scratchDir('r41-'), 'app.db.lock');
    writeForeign(lock, { heartbeatAt: Date.now() - LOCK_HEARTBEAT_STALE_MS - 1000 });
    const mine = acquireLock(lock);
    expect(mine.bootId).toBe(LOCK_BOOT_ID);
    expect(readLock(lock)?.bootId).toBe(LOCK_BOOT_ID);
  });

  it('host behaviour kept: a dead pid in the same namespace is stale at once, even with a fresh heartbeat', () => {
    const lock = path.join(scratchDir('r41-'), 'app.db.lock');
    writeForeign(lock, { pid: 999_999, pidNs: LOCK_PID_NAMESPACE });
    expect(liveLockHolder(lock)).toBeNull();
    expect(acquireLock(lock).bootId).toBe(LOCK_BOOT_ID);
  });

  it('this process re-takes its own lock; the heartbeat moves heartbeatAt; updates and creates leave no temp files', () => {
    const dir = scratchDir('r41-');
    const lock = path.join(dir, 'app.db.lock');
    const first = acquireLock(lock, { dbPath: '/x.db' });
    expect(first).toMatchObject({ pid: process.pid, bootId: LOCK_BOOT_ID, pidNs: LOCK_PID_NAMESPACE });
    expect(acquireLock(lock)).toEqual(first);
    expect(otherLiveLockHolder(lock)).toBeNull();
    heartbeatHeldLocks(first.heartbeatAt! + 7_000);
    expect(readLock(lock)?.heartbeatAt).toBe(first.heartbeatAt! + 7_000);
    updateHeldLock(lock, { walletPubkey: 'Wallet111' });
    expect(readLock(lock)).toMatchObject({ bootId: LOCK_BOOT_ID, walletPubkey: 'Wallet111', dbPath: '/x.db' });
    expect(fs.readdirSync(dir).sort()).toEqual(['app.db.lock']);
    releaseAllLocks();
    expect(fs.existsSync(lock)).toBe(false);
  });
});
