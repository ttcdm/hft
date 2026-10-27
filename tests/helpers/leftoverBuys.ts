import { workstationDb } from '../../server/db/database';

/**
 * P1.1: the PENDING row of a LIVE buy is now written only when no other buy of that mint is unresolved (the cross-process guard against a
 * double buy). Suites that call `submitAndConfirmWithRetry` directly reuse one mint across tests on the shared in-memory database, so a
 * row an earlier test left PENDING would refuse the next test's buy. Each such suite settles them first, through the real database API.
 */
export function settleLeftoverLiveBuys(): void {
  for (const t of workstationDb.loadTransactionsInStates(['PENDING', 'RECONCILIATION_REQUIRED'])!) {
    if (t.direction === 'BUY' && t.executionMode === 'LIVE') workstationDb.saveTransaction({ ...t, reconciliationState: 'REVERTED', error: 'test cleanup: left by an earlier test' });
  }
}
