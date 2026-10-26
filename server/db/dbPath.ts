import path from 'node:path';

/** The database file the app uses (P1.1: shared by the database singleton and the instance lock, so both name the same file). */
export function resolveDbPath(customDbPath?: string): string {
  return customDbPath || process.env.TEST_DB_PATH || process.env.APEX_DB_PATH || path.join(process.cwd(), 'apex_workstation.db');
}
