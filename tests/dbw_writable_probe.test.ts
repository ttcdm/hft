import '../suppress-warnings.cjs';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkstationDatabase } from '../server/db/database';

/**
 * DBW: isWritable() was `BEGIN IMMEDIATE; ROLLBACK;`, which writes nothing, so it said true on a full disk and on read-only storage.
 * It now commits a one-row upsert into db_health and requires MIN_FREE_BYTES free on the database's filesystem.
 */
const probeSeq = (db: WorkstationDatabase) =>
  ((db as any).db.prepare('SELECT probe_seq AS n FROM db_health WHERE id = 1').get() as { n: number } | undefined)?.n ?? 0;

describe('DBW: isWritable is a real write probe', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('commits a write to db_health', () => {
    const db = new WorkstationDatabase(':memory:');
    expect(probeSeq(db)).toBe(0);
    expect(db.isWritable()).toBe(true);
    expect(probeSeq(db)).toBe(1);
  });

  it('is false when the write fails, even though a write lock can still be taken', () => {
    const db = new WorkstationDatabase(':memory:');
    (db as any).db.exec(`CREATE TRIGGER dbw_fail BEFORE INSERT ON db_health BEGIN SELECT RAISE(ABORT, 'disk full (simulated)'); END`);
    (db as any).db.exec('BEGIN IMMEDIATE; ROLLBACK;'); // what the old check ran: still succeeds
    expect(db.isWritable()).toBe(false);
  });

  it('a passed probe is reused for WRITABLE_CACHE_MS; after that it writes again', () => {
    const db = new WorkstationDatabase(':memory:');
    let t = 1_000_000;
    vi.spyOn(performance, 'now').mockImplementation(() => t);
    expect(db.isWritable()).toBe(true);
    for (let i = 0; i < 50; i++) expect(db.isWritable()).toBe(true);
    expect(probeSeq(db)).toBe(1);
    t += WorkstationDatabase.WRITABLE_CACHE_MS;
    expect(db.isWritable()).toBe(true);
    expect(probeSeq(db)).toBe(2);
  });

  it('a failure is never reused: the next call probes again', () => {
    const db = new WorkstationDatabase(':memory:');
    const raw = (db as any).db;
    raw.exec(`CREATE TRIGGER dbw_fail BEFORE INSERT ON db_health BEGIN SELECT RAISE(ABORT, 'x'); END`);
    expect(db.isWritable()).toBe(false);
    raw.exec('DROP TRIGGER dbw_fail');
    expect(db.isWritable()).toBe(true);
  });

  describe('free-space floor (file database)', () => {
    const dirs: string[] = [];
    const fileDb = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbw-'));
      dirs.push(dir);
      return new WorkstationDatabase(path.join(dir, 'w.db'));
    };
    afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

    it('is false below MIN_FREE_BYTES even though the write commits', () => {
      const db = fileDb();
      vi.spyOn(db as any, 'freeBytes').mockReturnValue(WorkstationDatabase.MIN_FREE_BYTES - 1);
      expect(db.isWritable()).toBe(false);
      expect(probeSeq(db)).toBe(1);
    });

    it('is false when the free space cannot be read (fail closed)', () => {
      const db = fileDb();
      vi.spyOn(db as any, 'freeBytes').mockImplementation(() => { throw new Error('ENOSYS'); });
      expect(db.isWritable()).toBe(false);
    });

    it('is true at MIN_FREE_BYTES and above', () => {
      const db = fileDb();
      vi.spyOn(db as any, 'freeBytes').mockReturnValue(WorkstationDatabase.MIN_FREE_BYTES);
      expect(db.isWritable()).toBe(true);
    });
  });
});

/**
 * The real thing on a small tmpfs. Needs root and `mount` (Linux CI or a container); skipped elsewhere, e.g. on macOS.
 */
const canMount = (() => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) return false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbw-mnt-probe-'));
  try {
    execFileSync('mount', ['-t', 'tmpfs', '-o', 'size=1m', 'tmpfs', dir], { stdio: 'ignore' });
    execFileSync('umount', [dir], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

describe.skipIf(!canMount)('DBW: full disk on a real tmpfs', () => {
  const mounts: string[] = [];
  const mountTmpfs = (sizeMb: number) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbw-tmpfs-'));
    execFileSync('mount', ['-t', 'tmpfs', '-o', `size=${sizeMb}m`, 'tmpfs', dir]);
    mounts.push(dir);
    return dir;
  };
  const dbs: WorkstationDatabase[] = [];
  const open = (dir: string) => { const db = new WorkstationDatabase(path.join(dir, 'w.db')); dbs.push(db); return db; };
  const fill = (file: string) => {
    const fd = fs.openSync(file, 'w');
    const buf = Buffer.alloc(64 * 1024);
    try { for (;;) fs.writeSync(fd, buf); } catch (e: any) { if (e.code !== 'ENOSPC') throw e; } finally { fs.closeSync(fd); }
  };
  const oldCheck = (db: WorkstationDatabase) => { try { (db as any).db.exec('BEGIN IMMEDIATE; ROLLBACK;'); return true; } catch { return false; } };
  const bigInsert = (db: WorkstationDatabase) => (db as any).db.prepare('INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)')
    .run(`k${Math.random()}`, JSON.stringify('x'.repeat(256 * 1024)), Date.now());

  afterEach(() => {
    for (const db of dbs.splice(0)) { try { (db as any).db.close(); } catch { /* already closed */ } }
    for (const d of mounts.splice(0)) { try { execFileSync('umount', ['-l', d]); } catch { /* not mounted */ } fs.rmSync(d, { recursive: true, force: true }); }
  });

  it('a healthy tmpfs with room is writable', () => {
    const db = open(mountTmpfs(64));
    expect(db.isWritable()).toBe(true);
  });

  it('full disk: the old check still passes, real writes fail, isWritable is false', () => {
    const dir = mountTmpfs(4);
    const db = open(dir);
    expect(() => { for (;;) bigInsert(db); }).toThrow(/database or disk is full/);
    expect(oldCheck(db)).toBe(true); // the bug
    expect(db.isWritable()).toBe(false);
  });

  it('disk filled by another file while SQLite still holds spare WAL space: the upsert commits, the free-space floor catches it', () => {
    const dir = mountTmpfs(32);
    const db = open(dir);
    for (let i = 0; i < 8; i++) bigInsert(db); // grow the WAL, then let it be reused from the start
    (db as any).db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    fill(path.join(dir, 'filler'));
    expect(oldCheck(db)).toBe(true);
    const before = probeSeq(db);
    expect(db.isWritable()).toBe(false);
    expect(probeSeq(db)).toBe(before + 1); // the upsert alone would have said writable
    expect(() => { for (let i = 0; i < 64; i++) bigInsert(db); }).toThrow(/database or disk is full/);
  });
});
