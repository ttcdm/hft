import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { acquireLock, releaseAllLocks, readLock, heartbeatHeldLocks, updateHeldLock, LOCK_BOOT_ID } from '../server/system/instanceLock';
import { scratchDir } from './helpers/liveServer';

/**
 * Devnet run 2026-10-27, step (f): the harness released its locks, and the crash child it spawned a moment later exited INSTANCE_LOCKED on
 * the database lock, which named the (still running) harness. The scratch database sits on an rclone FUSE mount; R4-1's heartbeat rewrote
 * the lock as a temp file renamed over it, and after a rename followed by the unlink at release rclone uploads the lock's first version
 * again about 5 s later. A lock this process holds is now rewritten in place (same file, never renamed), and a reader that catches such a
 * rewrite half done reads again instead of calling the lock stale. Real lock module on a scratch directory.
 */
afterEach(() => {
  vi.restoreAllMocks();
  releaseAllLocks();
});

describe('instance lock: a held lock is rewritten in place', () => {
  it('the heartbeat and an update keep the same file (no rename over it) and leave no other file', () => {
    const dir = scratchDir('lock-inplace-');
    const lock = path.join(dir, 'e2e.db.lock');
    const first = acquireLock(lock, { dbPath: '/x.db' });
    const ino = fs.statSync(lock).ino;
    const rename = vi.spyOn(fs, 'renameSync');
    updateHeldLock(lock, { walletPubkey: 'Wallet111' });
    heartbeatHeldLocks(first.heartbeatAt! + 5_000);
    expect(rename).not.toHaveBeenCalled();
    expect(fs.statSync(lock).ino).toBe(ino);
    expect(readLock(lock)).toMatchObject({ bootId: LOCK_BOOT_ID, walletPubkey: 'Wallet111', dbPath: '/x.db', heartbeatAt: first.heartbeatAt! + 5_000 });
    // a shorter rewrite leaves no old bytes behind
    updateHeldLock(lock, { walletPubkey: 'W' });
    expect(JSON.parse(fs.readFileSync(lock, 'utf8')).walletPubkey).toBe('W');
    expect(fs.readdirSync(dir)).toEqual(['e2e.db.lock']);
    releaseAllLocks();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('a heartbeat never re-creates a lock that was removed by hand', () => {
    const dir = scratchDir('lock-inplace-');
    const lock = path.join(dir, 'e2e.db.lock');
    acquireLock(lock);
    fs.unlinkSync(lock);
    heartbeatHeldLocks();
    updateHeldLock(lock, { walletPubkey: 'W' });
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('a read that catches a rewrite half done is read again, not taken for a stale lock', () => {
    const dir = scratchDir('lock-inplace-');
    const lock = path.join(dir, 'e2e.db.lock');
    const info = acquireLock(lock);
    const whole = fs.readFileSync(lock, 'utf8');
    const real = fs.readFileSync;
    let n = 0;
    // caught between the in-place write and the truncate: the new content, then the tail of a longer old one
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, o: any) => (p === lock && n++ === 0 ? `${whole}et111"}` : real(p, o))) as any);
    expect(readLock(lock)).toMatchObject({ pid: process.pid, bootId: info.bootId });
    expect(n).toBe(2); // the torn read, then the whole one
  });
});
