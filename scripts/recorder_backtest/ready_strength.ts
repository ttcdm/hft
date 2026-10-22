import '../hermeticEnv';
import fs from 'fs';
import { replayLaunch, type ReplayedLaunch } from '../../server/backtest/replay';
import { HOT_MIN_SIGNALS, READY_MIN_SIGNALS } from '../../server/signals/watchWindow';
import { getConfluenceThreshold } from '../../server/signals/confluenceThreshold';
import { openRecorded } from './recorded';

/**
 * P4.3 (R1-56, feeds L1): how the READY entries the new rule refuses did, against HOT entries, on the app's OWN launch recordings (never merged with
 * the 39-day corpus results). The real replay runs with the READY rule OFF, so every READY release that clears the score gate is entered, then each
 * entry is put in one group:
 *   HOT                      a HOT release
 *   READY_FAILS_CONCENTRATION a READY entry whose largest cluster held 15% or more of the buy volume (refused now)
 *   READY_BELOW_2_SIGNALS    concentration passed, fewer than READY_MIN_SIGNALS (2) strong signals (refused now)
 *   READY_BELOW_3_SIGNALS    concentration passed, READY_MIN_SIGNALS or more but fewer than HOT_MIN_SIGNALS (3) strong signals (still bought)
 *   READY_3_PLUS_SIGNALS     concentration passed and 3 or more strong signals (still bought; the score kept it from HOT)
 * Closed P&L and open marks are reported apart: an OPEN_AT_END row has no realized P&L, only the value of what is held at the last recorded price.
 *   npx tsx scripts/recorder_backtest/ready_strength.ts --recorded <paper.db | snapshot.jsonl> [--threshold 70] [--out result.json]
 */
export type ReadyGroup = 'HOT' | 'READY_FAILS_CONCENTRATION' | 'READY_BELOW_2_SIGNALS' | 'READY_BELOW_3_SIGNALS' | 'READY_3_PLUS_SIGNALS';

export interface GroupStats { entries: number; closed: number; wins: number; closedNetPnlSol: number; openAtEnd: number; openValueSol: number }

export function readyGroupOf(r: ReplayedLaunch): ReadyGroup | null {
  if (!r.entered) return null;
  if (r.verdict === 'HOT') return 'HOT';
  if (r.verdict !== 'READY') return null;
  if (!r.concentrationPass) return 'READY_FAILS_CONCENTRATION';
  const n = r.passingSignals ?? 0;
  if (n < READY_MIN_SIGNALS) return 'READY_BELOW_2_SIGNALS';
  if (n < HOT_MIN_SIGNALS) return 'READY_BELOW_3_SIGNALS';
  return 'READY_3_PLUS_SIGNALS';
}

/** Per-group entry counts and P&L of replay rows (made with `readyGate: false`). `refusedNow` counts the READY entries the P4.3 rule refuses. */
export function summarizeReadyStrength(rows: ReplayedLaunch[]): { groups: Record<ReadyGroup, GroupStats>; readyEntries: number; refusedNow: number } {
  const empty = (): GroupStats => ({ entries: 0, closed: 0, wins: 0, closedNetPnlSol: 0, openAtEnd: 0, openValueSol: 0 });
  const groups: Record<ReadyGroup, GroupStats> = {
    HOT: empty(), READY_FAILS_CONCENTRATION: empty(), READY_BELOW_2_SIGNALS: empty(), READY_BELOW_3_SIGNALS: empty(), READY_3_PLUS_SIGNALS: empty(),
  };
  for (const r of rows) {
    const g = readyGroupOf(r);
    if (!g) continue;
    const s = groups[g];
    s.entries++;
    if (r.outcome === 'CLOSED') { s.closed++; s.closedNetPnlSol += r.netPnlSol ?? 0; if ((r.netPnlSol ?? 0) > 0) s.wins++; }
    if (r.outcome === 'OPEN_AT_END') { s.openAtEnd++; s.openValueSol += r.openValueSol ?? 0; }
  }
  const readyEntries = rows.filter((r) => r.entered && r.verdict === 'READY').length;
  const refusedNow = groups.READY_FAILS_CONCENTRATION.entries + groups.READY_BELOW_2_SIGNALS.entries;
  return { groups, readyEntries, refusedNow };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
  const recordedPath = opt('recorded', '');
  if (!recordedPath) throw new Error('usage: ready_strength.ts --recorded <paper.db|snapshot.jsonl> [--threshold n] [--out f]');
  const minScore = Number(opt('threshold', String(getConfluenceThreshold())));
  const source = await openRecorded(recordedPath);
  const funders = source.funders();
  const fallbackUsd = source.medianSolUsd();
  const rows: ReplayedLaunch[] = [];
  for (const rec of source.launches()) rows.push(replayLaunch(rec, funders, fallbackUsd, { minScore, readyGate: false }));
  source.close();
  const res = { source: 'own recordings (not the 39-day corpus)', input: { recorded: recordedPath, kind: source.kind }, minScore, launches: rows.length, ...summarizeReadyStrength(rows) };
  const out = opt('out', '');
  if (out) fs.writeFileSync(out, JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res, null, 1));
}
if (process.argv[1] && /recorder_backtest[\\/]ready_strength\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
