/**
 * P1.1 (N-51, N-52, N-56, N-57, N-59): one server process per database and per signing key.
 *
 * Every guard against a double sell or a double buy (in-flight exits, pending sells, reserved SOL, in-flight buy mints) lives in
 * process memory, so two processes on one database or one wallet both sell the same stop-loss and both buy the same mint. A lock
 * file is the cross-process guard:
 *
 * - `<dbPath>.lock`, taken by server.ts before any singleton is built (see `server/instanceLockBoot.ts`).
 * - `<APEX_LOCK_DIR>/<pubkey>.lock` (default `~/.apex/locks`), taken when this process first signs with a key, so a second process on a
 *   different database but the same key refuses to sign.
 *
 * A lock holds `{pid, startedAt, ...}`. A lock whose pid is no longer alive is stale and is taken over. A pid that was reused by an
 * unrelated process reads as alive: the refusal message names the file so the operator can remove it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LockInfo {
  pid: number;
  startedAt: number;
  dbPath?: string;
  walletPubkey?: string;
}

export class InstanceLockError extends Error {
  constructor(message: string, readonly lockPath: string, readonly holder: LockInfo | null) {
    super(message);
    this.name = 'InstanceLockError';
  }
}

/** True when `pid` is a running process (EPERM: it exists but belongs to another user, which still counts). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

export function readLock(lockPath: string): LockInfo | null {
  try {
    const j = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return j && typeof j.pid === 'number' ? (j as LockInfo) : { pid: -1, startedAt: 0 };
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    return { pid: -1, startedAt: 0 }; // unreadable or half-written: treated as stale
  }
}

/** The live process holding `lockPath`, or null when there is none (no file, or the holder is dead). */
export function liveLockHolder(lockPath: string): LockInfo | null {
  const info = readLock(lockPath);
  return info && isPidAlive(info.pid) ? info : null;
}

const held = new Map<string, LockInfo>();
let exitHooked = false;

function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', releaseAllLocks);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      releaseAllLocks();
      // Another handler owns shutdown (it exits when it is done; 'exit' releases again, harmlessly). Alone, keep the default: exit.
      if (process.listenerCount(sig) <= 1) process.exit(sig === 'SIGINT' ? 130 : 143);
    });
  }
}

function tryCreate(lockPath: string, info: LockInfo): boolean {
  try {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(info));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (e: any) {
    if (e?.code === 'EEXIST') return false;
    throw e;
  }
}

/**
 * Take `lockPath` for this process, or throw InstanceLockError naming the live holder. Re-entrant: a lock this process already holds
 * is returned as is. A stale lock (dead pid) is replaced under a short `<lock>.takeover` guard, so two processes that both find the same
 * stale lock cannot both take it.
 */
export function acquireLock(lockPath: string, extra: Omit<LockInfo, 'pid' | 'startedAt'> = {}): LockInfo {
  const mine = held.get(lockPath);
  if (mine) return mine;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const info: LockInfo = { pid: process.pid, startedAt: Date.now(), ...extra };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (tryCreate(lockPath, info)) {
      held.set(lockPath, info);
      hookExit();
      return info;
    }
    const holder = readLock(lockPath);
    if (holder && holder.pid === process.pid) {
      // Written by this process earlier (for example a module reloaded in a test): adopt it.
      held.set(lockPath, holder);
      hookExit();
      return holder;
    }
    if (holder && isPidAlive(holder.pid)) {
      throw new InstanceLockError(
        `INSTANCE_LOCKED: ${lockPath} is held by running process ${holder.pid} (started ${new Date(holder.startedAt).toISOString()}). ` +
          'Only one server may use a database or a signing key at a time. Stop that process first; if it is not an Apex server (a reused pid), delete the lock file.',
        lockPath,
        holder
      );
    }
    // Stale: take it over, guarded so only one process replaces it.
    const guard = `${lockPath}.takeover`;
    const guardHolder = readLock(guard);
    if (guardHolder && !isPidAlive(guardHolder.pid)) {
      try { fs.unlinkSync(guard); } catch { /* another process removed it */ }
    }
    if (!tryCreate(guard, { pid: process.pid, startedAt: Date.now() })) continue; // someone else is taking it over: re-read
    try {
      const again = readLock(lockPath);
      if (again && isPidAlive(again.pid) && again.pid !== process.pid) continue; // taken over meanwhile: the next attempt reports it
      try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
    } finally {
      try { fs.unlinkSync(guard); } catch { /* already gone */ }
    }
  }
  const holder = readLock(lockPath);
  throw new InstanceLockError(`INSTANCE_LOCKED: could not take ${lockPath} (holder ${holder?.pid ?? 'unknown'}).`, lockPath, holder);
}

/** Add fields (the wallet pubkey once the signer is known) to a lock this process holds. */
export function updateHeldLock(lockPath: string, extra: Partial<Omit<LockInfo, 'pid'>>): void {
  const mine = held.get(lockPath);
  if (!mine) return;
  const next = { ...mine, ...extra };
  fs.writeFileSync(lockPath, JSON.stringify(next), { mode: 0o600 });
  held.set(lockPath, next);
}

export function releaseLock(lockPath: string): void {
  if (!held.has(lockPath)) return;
  held.delete(lockPath);
  const holder = readLock(lockPath);
  if (holder && holder.pid === process.pid) {
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

export function releaseAllLocks(): void {
  for (const p of [...held.keys()]) releaseLock(p);
}

/** No lock for an in-memory database: nothing is shared between processes. */
export function dbLockPath(dbPath: string): string | null {
  if (!dbPath || dbPath === ':memory:' || dbPath.startsWith('file::memory:')) return null;
  return `${path.resolve(dbPath)}.lock`;
}

export function signerLockDir(): string {
  return process.env.APEX_LOCK_DIR || path.join(os.homedir(), '.apex', 'locks');
}

export function signerLockPath(pubkey: string): string {
  return path.join(signerLockDir(), `${pubkey}.lock`);
}
