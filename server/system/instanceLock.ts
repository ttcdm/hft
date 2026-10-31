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
 * A lock holds `{pid, startedAt, bootId, heartbeatAt, ...}`. R4-1: `bootId` is a random id made once per process (`LOCK_BOOT_ID`), and the
 * holder rewrites `heartbeatAt` every LOCK_HEARTBEAT_MS. A lock written under another boot id whose heartbeat is younger than
 * LOCK_HEARTBEAT_STALE_MS is refused whatever its pid: in Docker every server is PID 1, and a pid from another container's namespace reads
 * as "this process" or as dead here. In the same host and pid namespace (`pidNs`, LOCK_PID_NAMESPACE) the pid decides, as it did for
 * host processes: a lock whose pid is alive (and is not this process) is refused, any other is stale and taken over at once. Elsewhere,
 * with no fresh heartbeat, the pid decides the same way. A pid that was reused by an unrelated process reads as alive: the refusal
 * message names the file so the operator can remove it. A lock is created atomically (a temp file, then a hard link), so it never
 * exists empty (round 1 #23); it is rewritten in place (see `rewriteHeld`), and a reader that catches a rewrite half done reads again.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LockInfo {
  pid: number;
  startedAt: number;
  /** R4-1: the holder's per-process random id (LOCK_BOOT_ID). Missing in a lock written by an older build. */
  bootId?: string;
  /** R4-1: when the holder last rewrote the lock (wall clock, ms). Missing in a lock written by an older build. */
  heartbeatAt?: number;
  /** R4-1: the holder's host name and pid namespace (LOCK_PID_NAMESPACE). Only in the same namespace does its pid mean anything here. */
  pidNs?: string;
  dbPath?: string;
  walletPubkey?: string;
}

/** R4-1: how often a held lock's heartbeat is rewritten, and the age past which a heartbeat no longer proves its holder is running. */
export const LOCK_HEARTBEAT_MS = 5_000;
export const LOCK_HEARTBEAT_STALE_MS = 30_000;

/**
 * R4-1: this process's boot id. Kept on `process` so a module loaded twice in one process (vitest, tsx) still knows its own locks.
 */
export const LOCK_BOOT_ID: string = ((process as any).__apexLockBootId ??= crypto.randomBytes(16).toString('hex'));

/**
 * R4-1: this process's host name plus, on Linux, its pid namespace (`/proc/self/ns/pid`, e.g. "pid:[4026531836]"). Two processes with
 * the same value see the same pids, so a holder's pid can be checked with `isPidAlive`; across containers it cannot.
 */
export const LOCK_PID_NAMESPACE: string = (() => {
  let ns = '';
  try { ns = fs.readlinkSync('/proc/self/ns/pid'); } catch { /* not Linux: the host name alone */ }
  return `${os.hostname()}|${ns}`;
})();

/** True when the lock was written by this process (its boot id, or, for an older build's lock with no boot id, its pid). */
export function isOwnLock(info: LockInfo | null): boolean {
  if (!info) return false;
  return info.bootId !== undefined ? info.bootId === LOCK_BOOT_ID : info.pid === process.pid;
}

/** R4-1: true when another boot's heartbeat in this lock is recent enough to prove its holder is running (a future time counts as fresh). */
export function hasFreshHeartbeat(info: LockInfo | null, now: number = Date.now()): boolean {
  return !!info && typeof info.heartbeatAt === 'number' && now - info.heartbeatAt < LOCK_HEARTBEAT_STALE_MS;
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

/** How often a lock that does not parse is read again before it counts as stale: a rewrite in place (rewriteHeld) can be caught half done. */
const TORN_READ_RETRIES = 3;
const TORN_READ_WAIT_MS = 5;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function readLock(lockPath: string): LockInfo | null {
  for (let attempt = 0; ; attempt++) {
    let raw: string;
    try {
      raw = fs.readFileSync(lockPath, 'utf8');
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      return { pid: -1, startedAt: 0 }; // unreadable: treated as stale
    }
    try {
      const j = JSON.parse(raw);
      return j && typeof j.pid === 'number' ? (j as LockInfo) : { pid: -1, startedAt: 0 };
    } catch {
      // Half written (a holder's rewrite in progress), or left half written by a crash: read again, then treat it as stale.
      if (attempt >= TORN_READ_RETRIES) return { pid: -1, startedAt: 0 };
      sleepSync(TORN_READ_WAIT_MS);
    }
  }
}

/** True when the holder recorded in `info` is a running server: this process, a fresh heartbeat, or (no fresh heartbeat) a live pid of another process. */
function holderIsLive(info: LockInfo): boolean {
  if (isOwnLock(info)) return true;
  const pidLive = info.pid !== process.pid && isPidAlive(info.pid); // our own pid under another boot id is a previous boot
  // Same host and pid namespace: the pid is checkable, as it always was for host processes (a crashed server's lock is stale at once).
  if (info.pidNs !== undefined && info.pidNs === LOCK_PID_NAMESPACE) return pidLive;
  // Another container (or an older build's lock): its pid means nothing here, so a fresh heartbeat proves it runs; with none, the pid decides.
  return hasFreshHeartbeat(info) || pidLive;
}

/** The live process holding `lockPath`, or null when there is none (no file, or the holder is gone). This process's own lock counts. */
export function liveLockHolder(lockPath: string): LockInfo | null {
  const info = readLock(lockPath);
  return info && holderIsLive(info) ? info : null;
}

/** R4-1: the live holder of `lockPath` when it is another process (another container's PID 1 included), else null. */
export function otherLiveLockHolder(lockPath: string): LockInfo | null {
  const info = liveLockHolder(lockPath);
  return info && !isOwnLock(info) ? info : null;
}

const held = new Map<string, LockInfo>();
let exitHooked = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Rewrites a lock this process holds, in place: the new content over the old from offset 0, then the file cut to its length, so it is
 * never empty. Not a temp file renamed over it: on a FUSE mount with delayed write-back (rclone; the cloud devnet harness keeps its scratch
 * database, and so `<db>.lock`, on one), a rename over the lock followed by the unlink at release made rclone upload the lock's FIRST
 * version again about 5 s after the release. The file came back naming this live pid, and the next process on that database exited
 * INSTANCE_LOCKED (devnet run 2026-10-27, step (f), the crash child). In-place writes do not bring it back. 'r+' never creates the file,
 * so a lock removed by hand is not re-created. A reader that catches the write half done (new bytes, then old) reads again (readLock).
 */
function rewriteHeld(lockPath: string, info: LockInfo): void {
  const buf = Buffer.from(JSON.stringify(info));
  const fd = fs.openSync(lockPath, 'r+');
  try {
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.ftruncateSync(fd, buf.length);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * R4-1: rewrites `heartbeatAt` in every lock this process holds. Run every LOCK_HEARTBEAT_MS (timer unref'd, so it never holds the
 * process open). A lock that is no longer ours on disk (deleted by hand, or taken over) is not rewritten; it is dropped from `held`.
 */
export function heartbeatHeldLocks(now: number = Date.now()): void {
  for (const lockPath of [...held.keys()]) heartbeatOne(lockPath, now);
}

/**
 * One heartbeat of a held lock: re-read it, drop it from `held` when it is no longer ours, else rewrite `heartbeatAt`. True when the
 * heartbeat was written. A failed rewrite (a slow or failing mount) only logs, and the held entry keeps its last confirmed heartbeatAt, which
 * isLockHeld then ages (R13-10).
 */
function heartbeatOne(lockPath: string, now: number): boolean {
  const info = held.get(lockPath);
  if (!info) return false;
  try {
    if (!isOwnLock(readLock(lockPath))) {
      held.delete(lockPath);
      console.error(`[INSTANCE LOCK] ${lockPath} is no longer held by this process (removed or taken over); its heartbeat stopped`);
      return false;
    }
    const next = { ...info, heartbeatAt: now };
    rewriteHeld(lockPath, next);
    held.set(lockPath, next);
    return true;
  } catch (e: any) {
    console.error(`[INSTANCE LOCK] heartbeat of ${lockPath} failed: ${e?.message ?? e}`);
    return false;
  }
}

/**
 * R13-10: the age of this process's last confirmed heartbeat past which its hold is not trusted without a fresh one. One heartbeat interval
 * short of LOCK_HEARTBEAT_STALE_MS (when another boot may take the lock over), so this process stops signing before anyone can take it.
 */
export const LOCK_HELD_CONFIRM_MS = LOCK_HEARTBEAT_STALE_MS - LOCK_HEARTBEAT_MS;

function hookExit(): void {
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => heartbeatHeldLocks(), LOCK_HEARTBEAT_MS);
    heartbeatTimer.unref?.();
  }
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

/**
 * Creates `lockPath` with `info` only if it does not exist. Round 1 #23: the content is written to a temp file first and hard-linked into
 * place (link fails with EEXIST when the lock exists), so the lock never exists empty or half-written.
 */
function tryCreate(lockPath: string, info: LockInfo): boolean {
  const tmp = `${lockPath}.${LOCK_BOOT_ID}.${process.pid}.new`;
  fs.writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  try {
    fs.linkSync(tmp, lockPath);
    return true;
  } catch (e: any) {
    if (e?.code === 'EEXIST') return false;
    if (e?.code !== 'EPERM' && e?.code !== 'ENOTSUP' && e?.code !== 'ENOSYS') throw e;
    // A filesystem without hard links: create exclusively and write in place (the empty window round 1 #23 describes, microseconds).
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try { fs.writeSync(fd, JSON.stringify(info)); } finally { fs.closeSync(fd); }
      return true;
    } catch (e2: any) {
      if (e2?.code === 'EEXIST') return false;
      throw e2;
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/** The refusal for a lock held by another live server. */
function lockedError(lockPath: string, holder: LockInfo): InstanceLockError {
  const beat = hasFreshHeartbeat(holder) ? `, heartbeat ${Math.max(0, Math.round((Date.now() - holder.heartbeatAt!) / 1000))} s ago, boot id ${String(holder.bootId).slice(0, 8)}` : '';
  return new InstanceLockError(
    `INSTANCE_LOCKED: ${lockPath} is held by running process ${holder.pid} (started ${new Date(holder.startedAt).toISOString()}${beat}). ` +
      'Only one server may use a database or a signing key at a time. Stop that process (or container) first. ' +
      `If it is gone, the lock frees itself ${LOCK_HEARTBEAT_STALE_MS / 1000} s after its last heartbeat; if it is not an Apex server (a reused pid), delete the lock file.`,
    lockPath,
    holder
  );
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
  const now = Date.now();
  const info: LockInfo = { pid: process.pid, startedAt: now, bootId: LOCK_BOOT_ID, heartbeatAt: now, pidNs: LOCK_PID_NAMESPACE, ...extra };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (tryCreate(lockPath, info)) {
      held.set(lockPath, info);
      hookExit();
      return info;
    }
    const holder = readLock(lockPath);
    if (holder && holder.bootId === LOCK_BOOT_ID) {
      // Written by this process earlier (for example a module reloaded in a test): adopt it.
      held.set(lockPath, holder);
      hookExit();
      return holder;
    }
    // R4-1: another boot (another container's PID 1 included) with a fresh heartbeat, or a live pid that is not ours: refuse.
    if (holder && holderIsLive(holder)) throw lockedError(lockPath, holder);
    // Stale: take it over, guarded so only one process replaces it. A guard is held for microseconds; one older than the heartbeat
    // window was left by a process that died mid-takeover.
    const guard = `${lockPath}.takeover`;
    const guardHolder = readLock(guard);
    if (guardHolder && (!isPidAlive(guardHolder.pid) || isOwnLock(guardHolder) || Date.now() - guardHolder.startedAt > LOCK_HEARTBEAT_STALE_MS)) {
      try { fs.unlinkSync(guard); } catch { /* another process removed it */ }
    }
    if (!tryCreate(guard, { pid: process.pid, startedAt: Date.now(), bootId: LOCK_BOOT_ID })) continue; // someone else is taking it over: re-read
    try {
      const again = readLock(lockPath);
      if (again && !isOwnLock(again) && holderIsLive(again)) continue; // taken over meanwhile: the next attempt reports it
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
  const next = { ...mine, ...extra, heartbeatAt: Date.now() };
  rewriteHeld(lockPath, next);
  held.set(lockPath, next);
}

/**
 * True while this process holds `lockPath`: taken by acquireLock, not released, not found removed or taken over by the heartbeat, and
 * R13-10: its heartbeat confirmed within LOCK_HELD_CONFIRM_MS. A heartbeat older than that (its rewrite kept failing, or the timer was
 * starved) is confirmed on disk now; if that fails, or the file is no longer ours, the lock counts as lost, since another boot may take
 * a lock whose heartbeat is LOCK_HEARTBEAT_STALE_MS old.
 */
export function isLockHeld(lockPath: string, now: number = Date.now()): boolean {
  const info = held.get(lockPath);
  if (!info) return false;
  if (typeof info.heartbeatAt === 'number' && now - info.heartbeatAt < LOCK_HELD_CONFIRM_MS) return true;
  return heartbeatOne(lockPath, now);
}

export function releaseLock(lockPath: string): void {
  if (!held.has(lockPath)) return;
  held.delete(lockPath);
  const holder = readLock(lockPath);
  if (isOwnLock(holder)) {
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  }
  if (held.size === 0 && heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
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
