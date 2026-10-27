import '../suppress-warnings.cjs';
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkstationDatabase, workstationDb } from '../server/db/database';
import { executionCoordinator } from '../server/execution/coordinator';
import { databaseCheck } from '../server/system/systemChecks';

/**
 * Disk floor (Mike, 2026-10-26): the database-writable check warns below 128 MiB free and blocks below 32 MiB (it blocked at 16 MiB
 * with no warning before). The block is isWritable (both readiness checks and the per-buy gate); the warning is a WARN on the System
 * checks database row and a DISK_SPACE_LOW operator alert, neither of which stops a buy.
 */
const MiB = 1024 * 1024;
const dirs: string[] = [];
const fileDb = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-low-'));
  dirs.push(dir);
  return new WorkstationDatabase(path.join(dir, 'w.db'));
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  (executionCoordinator as any).sqliteOkCache = null;
  (executionCoordinator as any).clearOperatorAlert('DISK_SPACE_LOW');
});

describe('the free-disk thresholds', () => {
  it('blocks below 32 MiB and warns below 128 MiB', () => {
    expect(WorkstationDatabase.MIN_FREE_BYTES).toBe(32 * MiB);
    expect(WorkstationDatabase.LOW_FREE_WARN_BYTES).toBe(128 * MiB);
  });

  it('isWritable is false at 31 MiB free and true at 32 MiB and at 100 MiB (a warning, not a block)', () => {
    const db = fileDb();
    const free = vi.spyOn(db as any, 'freeBytes');
    free.mockReturnValue(32 * MiB - 1);
    expect(db.isWritable()).toBe(false);
    free.mockReturnValue(32 * MiB);
    expect(db.isWritable()).toBe(true);
    (db as any).lastWritableOkAt = null;
    free.mockReturnValue(100 * MiB);
    expect(db.isWritable()).toBe(true);
  });

  it('getFreeBytes reads the file database\'s disk, and is null for :memory: or when the read fails', () => {
    const db = fileDb();
    expect(db.getFreeBytes()).toBeGreaterThan(0);
    vi.spyOn(db as any, 'freeBytes').mockImplementation(() => { throw new Error('ENOSYS'); });
    expect(db.getFreeBytes()).toBeNull();
    expect(new WorkstationDatabase(':memory:').getFreeBytes()).toBeNull();
  });
});

describe('the System checks database row', () => {
  it('is OK with 128 MiB or more free', () => {
    vi.spyOn(workstationDb, 'getFreeBytes').mockReturnValue(128 * MiB);
    const c = databaseCheck(true);
    expect(c.status).toBe('OK');
    expect(c.value).toMatch(/128 MiB free/);
  });

  it('is WARN while writable with less than 128 MiB free, and says buys stop at 32 MiB', () => {
    vi.spyOn(workstationDb, 'getFreeBytes').mockReturnValue(100 * MiB);
    const c = databaseCheck(true);
    expect(c.status).toBe('WARN');
    expect(c.value).toMatch(/100 MiB free/);
    expect(c.detail).toMatch(/below 128 MiB/);
    expect(c.detail).toMatch(/32 MiB/);
  });

  it('is FAIL when not writable, whatever the free space', () => {
    vi.spyOn(workstationDb, 'getFreeBytes').mockReturnValue(20 * MiB);
    const c = databaseCheck(false);
    expect(c.status).toBe('FAIL');
    expect(c.value).toMatch(/NOT writable/);
    expect(c.detail).toMatch(/20 MiB free/);
  });

  it('a :memory: database (no free-space figure) stays OK when writable', () => {
    vi.spyOn(workstationDb, 'getFreeBytes').mockReturnValue(null);
    expect(databaseCheck(true).status).toBe('OK');
  });
});

describe('the DISK_SPACE_LOW operator alert', () => {
  const alert = () => executionCoordinator.getOperatorAlerts().find((a) => a.code === 'DISK_SPACE_LOW' && !a.cleared);

  it('is raised by the status read below 128 MiB and cleared once there is room again', () => {
    const free = vi.spyOn(workstationDb, 'getFreeBytes').mockReturnValue(100 * MiB);
    (executionCoordinator as any).checkSqliteJournalOk(1);
    expect(alert()?.message).toMatch(/100 MiB free/);
    free.mockReturnValue(200 * MiB);
    (executionCoordinator as any).checkSqliteJournalOk(1 + 60_000);
    expect(alert()).toBeUndefined();
  });

  it('is not raised with 128 MiB free or with no figure (:memory:)', () => {
    const free = vi.spyOn(workstationDb, 'getFreeBytes').mockReturnValue(128 * MiB);
    (executionCoordinator as any).checkSqliteJournalOk(1);
    expect(alert()).toBeUndefined();
    free.mockReturnValue(null);
    (executionCoordinator as any).checkSqliteJournalOk(1 + 60_000);
    expect(alert()).toBeUndefined();
  });
});
