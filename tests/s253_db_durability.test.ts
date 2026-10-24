import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WorkstationDatabase } from '../server/db/database';

/** S253 (P2.2, R1-96): a file database runs WAL with synchronous=FULL, so the PENDING row written before a broadcast survives an OS crash. */
describe('S253: database durability pragmas', () => {
  it('a file DB reports journal_mode wal and synchronous 2 (FULL)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's253-'));
    const db = new WorkstationDatabase(path.join(dir, 'durability.db'));
    const raw = (db as any).db; // read-only look at the instance's own connection: synchronous is per connection
    expect(String((raw.prepare('PRAGMA journal_mode').get() as any).journal_mode).toLowerCase()).toBe('wal');
    expect((raw.prepare('PRAGMA synchronous').get() as any).synchronous).toBe(2);
    raw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
