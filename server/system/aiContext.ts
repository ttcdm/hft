import { buildSystemChecks } from './systemChecks';
import { computeLatency } from './latencyStats';
import { autoSnipeController } from '../auto/controller';
import { workstationDb } from '../db/database';

/**
 * What Quant AI Diagnostics sends to the model: real state only, built on the server (the client cannot add to it). It contains no key,
 * no token and no full wallet address; mints and counts are what the journal holds.
 */
export function buildDiagnosticsContext(now: number = Date.now()) {
  const checks = buildSystemChecks(now);
  const txs = workstationDb.loadTransactions().sort((a, b) => b.submissionTime - a.submissionTime).slice(0, 2000);
  const queued = workstationDb.loadDecisions({ stage: 'queue', outcome: 'QUEUED', limit: 2000 }).map((d) => ({ ts: d.ts, mint: d.mint }));
  const auto = autoSnipeController.getStatus();
  return {
    capturedAt: new Date(now).toISOString(),
    systemChecks: checks.checks.map((c) => ({ check: c.label, status: c.status, value: c.value })),
    auto: { mode: auto.mode, killed: auto.killed, triggers: auto.triggers.map((t) => t.code), slippageBreaches: auto.slippageBreaches },
    journal: autoSnipeController.getJournalStats(),
    latency: computeLatency(txs, queued),
  };
}
