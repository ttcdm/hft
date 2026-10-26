import type { PersistedTransaction } from '../db/database';

export interface LatencyRow { label: string; n: number; p50Ms: number | null; p95Ms: number | null; maxMs: number | null }
export interface LatencyReport {
  /** submission to confirmation, per transport and mode, only for transactions that have both timestamps */
  sendToConfirm: LatencyRow[];
  /** a candidate reaching the auto trader (journal QUEUED row) to the first BUY transaction submitted for that mint */
  signalToSend: LatencyRow[];
  counts: { transactions: number; confirmed: number; unconfirmed: number; reverted: number; signals: number; signalsWithSend: number };
  notes: string[];
}

export function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

function row(label: string, values: number[]): LatencyRow {
  const s = [...values].sort((a, b) => a - b);
  return { label, n: s.length, p50Ms: percentile(s, 50), p95Ms: percentile(s, 95), maxMs: s.length ? s[s.length - 1] : null };
}

const SIGNAL_TO_SEND_MAX_MS = 10 * 60_000;

/**
 * Measured from the journal only: transactions (submission_time, confirmation_time) and decisions (QUEUED ts). Nothing here is assumed;
 * with no rows every figure is null and the screen says so. PAPER "transactions" never touched the network, so they are reported on
 * their own rows and are not mixed into the real send-to-confirm numbers.
 */
export function computeLatency(txs: PersistedTransaction[], queued: Array<{ ts: number; mint: string }>): LatencyReport {
  const groups = new Map<string, number[]>();
  let confirmed = 0, reverted = 0;
  for (const t of txs) {
    if (t.reconciliationState === 'REVERTED') reverted++;
    if (t.confirmationTime && t.submissionTime > 0 && t.confirmationTime >= t.submissionTime) {
      confirmed++;
      const k = `${t.submissionTransport} / ${t.executionMode} / ${t.direction}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(t.confirmationTime - t.submissionTime);
    }
  }
  const buysByMint = new Map<string, number[]>();
  for (const t of txs) {
    if (t.direction !== 'BUY' || t.submissionTime <= 0) continue;
    (buysByMint.get(t.mint) ?? buysByMint.set(t.mint, []).get(t.mint)!).push(t.submissionTime);
  }
  for (const v of buysByMint.values()) v.sort((a, b) => a - b);
  const sig = new Map<string, number[]>();
  let withSend = 0;
  const seenMint = new Set<string>();
  for (const q of [...queued].sort((a, b) => a.ts - b.ts)) {
    if (seenMint.has(q.mint)) continue; // the first time a mint reached the trader is the signal; later ticks are repeats
    seenMint.add(q.mint);
    const send = (buysByMint.get(q.mint) ?? []).find((s) => s >= q.ts && s - q.ts <= SIGNAL_TO_SEND_MAX_MS);
    if (send === undefined) continue;
    withSend++;
    const t = txs.find((x) => x.mint === q.mint && x.direction === 'BUY' && x.submissionTime === send)!;
    const k = `${t.submissionTransport} / ${t.executionMode}`;
    (sig.get(k) ?? sig.set(k, []).get(k)!).push(send - q.ts);
  }
  const notes: string[] = [];
  if (txs.length === 0) notes.push('No transaction has been recorded yet, so there is nothing to measure.');
  if ([...groups.keys()].some((k) => k.startsWith('PAPER'))) notes.push('PAPER rows never touched the network: their times are the engine\'s own bookkeeping, not a send and a confirmation.');
  if (txs.length - confirmed - reverted > 0) notes.push(`${txs.length - confirmed - reverted} transaction(s) have no confirmation time (pending, timed out or errored) and are not in the figures.`);
  return {
    sendToConfirm: [...groups.entries()].map(([k, v]) => row(k, v)).sort((a, b) => a.label.localeCompare(b.label)),
    signalToSend: [...sig.entries()].map(([k, v]) => row(k, v)).sort((a, b) => a.label.localeCompare(b.label)),
    counts: { transactions: txs.length, confirmed, unconfirmed: txs.length - confirmed - reverted, reverted, signals: seenMint.size, signalsWithSend: withSend },
    notes,
  };
}
