/**
 * P1.1 (N-51): side-effect module, the SECOND import of server.ts (after loadEnv, before any singleton is built). Takes the lock on
 * the database file, so a second server on the same database exits here, before it can reconcile, run the exit loop or restore the
 * auto mode. Skipped under vitest (an in-process import of server.ts is not a server). The signer lock is taken in
 * `ExecutionCoordinator.start()` once the key is known.
 */
import { acquireLock, dbLockPath, InstanceLockError } from './system/instanceLock';
import { resolveDbPath } from './db/dbPath';

export let instanceDbLockPath: string | null = null;

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  const lockPath = dbLockPath(resolveDbPath());
  if (lockPath) {
    try {
      acquireLock(lockPath, { dbPath: resolveDbPath() });
      instanceDbLockPath = lockPath;
    } catch (err: any) {
      // Logger is not imported here on purpose: it would pull in modules (and their singletons) before the lock is held.
      console.error(`[APEX QUANT HFT] ${err instanceof InstanceLockError ? err.message : `could not take the instance lock ${lockPath}: ${err?.message}`}`);
      process.exit(1);
    }
  }
}
