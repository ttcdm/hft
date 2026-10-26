import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WorkstationDatabase, workstationDb } from '../server/db/database';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';

/**
 * S255 (P2.2, R1-89): a database records the genesis hash of the first verified RPC and then refuses an RPC on another cluster, so a devnet
 * ledger is never reconciled (or traded) against another cluster's chain. Real WorkstationDatabase on a file, real coordinator readiness.
 */
const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
afterEach(() => vi.restoreAllMocks());

describe('S255: the database is stamped with its cluster', () => {
  const fileDb = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's255-'));
    return { db: new WorkstationDatabase(path.join(dir, 'ledger.db')), dir };
  };

  it('the first check stamps it, the same genesis passes, another genesis is refused with the stored hash', () => {
    const { db, dir } = fileDb();
    expect(db.checkClusterStamp(DEVNET)).toEqual({ ok: true, stamped: true });
    expect(db.checkClusterStamp(DEVNET)).toEqual({ ok: true, stamped: false });
    expect(db.checkClusterStamp(MAINNET)).toEqual({ ok: false, stored: DEVNET });
    expect(db.getSetting('cluster_genesis_hash')).toBe(DEVNET);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the stamp survives reopening the file', () => {
    const { db, dir } = fileDb();
    db.checkClusterStamp(DEVNET);
    const again = new WorkstationDatabase(db.getDbPath());
    expect(again.checkClusterStamp(MAINNET)).toEqual({ ok: false, stored: DEVNET });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('an in-memory database is never stamped', () => {
    const mem = new WorkstationDatabase(':memory:');
    expect(mem.checkClusterStamp(DEVNET)).toEqual({ ok: true, stamped: false });
    expect(mem.checkClusterStamp(MAINNET)).toEqual({ ok: true, stamped: false });
  });

  it('a refused stamp fails the cluster check of the coordinator with DB_CLUSTER_MISMATCH', async () => {
    vi.spyOn(workstationDb, 'checkClusterStamp').mockReturnValue({ ok: false, stored: DEVNET });
    const c = new ExecutionCoordinator(new MockSolanaRpc().createConnection());
    expect(await (c as any).verifyCluster()).toBe(false);
    expect((c as any).clusterProblem).toMatch(/DB_CLUSTER_MISMATCH/);
    c.cleanup();
  });
});
