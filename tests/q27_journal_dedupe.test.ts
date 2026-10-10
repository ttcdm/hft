import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { autoSnipeController, DROP_REPEAT_MS } from '../server/auto/controller';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { workstationDb } from '../server/db/database';
import { setAutoMode, resetAuto, newPumpPool, releaseAs } from './fixtures/auto';

/** Q27: the 5 s candidate loops wrote a QUEUED and a DROPPED row for the same unwatched mint on every tick. */
describe('Q27: repeated watch-stage drops are journaled once', () => {
  beforeEach(() => memecoinAggregator.setConfluenceGating(false));
  afterEach(async () => {
    memecoinAggregator.setConfluenceGating(true);
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await resetAuto();
  });
  const cand = (mint: string) => ({ mint, symbol: 'Q27', source: 'AGGREGATOR_LOOP' as const, amountUsd: 5, provenance: 'REAL_ONCHAIN' as const });

  it('100 resubmissions of an unwatched mint write one QUEUED and one DROPPED row', async () => {
    await setAutoMode('SHADOW');
    const { mint } = newPumpPool('NONE');
    for (let i = 0; i < 100; i++) {
      const d = await autoSnipeController.submitCandidate(cand(mint));
      expect(d.outcome).toBe('DROPPED');
      expect(d.reason).toBe('NOT_IN_WATCH_WINDOW');
    }
    const rows = workstationDb.loadDecisions({ mint });
    expect(rows.map((r) => r.stage)).toEqual(['queue', 'watch']);
  });

  it('when the verdict changes the candidate is looked at again, and the dedupe lapses after DROP_REPEAT_MS', async () => {
    await setAutoMode('SHADOW');
    const { mint } = newPumpPool('NONE');
    await autoSnipeController.submitCandidate(cand(mint));
    await autoSnipeController.submitCandidate(cand(mint));
    expect(workstationDb.loadDecisions({ mint })).toHaveLength(2);
    releaseAs(mint, 'HOT');
    const d = await autoSnipeController.submitCandidate(cand(mint));
    expect(d.outcome, d.reason).toBe('WOULD_BUY');

    const other = newPumpPool('NONE');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now());
    await autoSnipeController.submitCandidate(cand(other.mint));
    vi.setSystemTime(Date.now() + DROP_REPEAT_MS + 1);
    await autoSnipeController.submitCandidate(cand(other.mint));
    expect(workstationDb.loadDecisions({ mint: other.mint })).toHaveLength(4);
  });
});
