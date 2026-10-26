import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { autoSnipeController } from '../server/auto/controller';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { workstationDb } from '../server/db/database';
import { setAutoMode, resetAuto, newPumpPool, releaseAs } from './fixtures/auto';

/** Q6f: a watch-window release is the auto candidate. Nothing submitted it before, so auto could not buy. */
describe('Q6f: HOT and READY watch releases become auto candidates', () => {
  beforeEach(() => { memecoinAggregator.setConfluenceGating(false); autoSnipeController.attachWatchWindow(); }); // the gates under test are the controller's; the score is covered by the Q6 pool tests
  afterEach(async () => {
    autoSnipeController.detachWatchWindow();
    memecoinAggregator.setConfluenceGating(true);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await resetAuto();
  });

  const rowsFor = (mint: string) => workstationDb.loadDecisions({ mint });

  it('a HOT release reaches the gates and is decided (SHADOW: would buy), journaled as source WATCH_WINDOW', async () => {
    await setAutoMode('SHADOW');
    const { mint } = newPumpPool('NONE');
    releaseAs(mint, 'HOT');
    await vi.waitFor(() => expect(rowsFor(mint).some((r) => r.outcome === 'WOULD_BUY')).toBe(true));
    expect(rowsFor(mint).find((r) => r.stage === 'queue')?.source).toBe('WATCH_WINDOW');
  });

  it('a DEAD release is not a candidate, and OFF journals nothing', async () => {
    await setAutoMode('SHADOW');
    const dead = newPumpPool('NONE');
    releaseAs(dead.mint, 'DEAD');
    await new Promise((r) => setTimeout(r, 20));
    expect(rowsFor(dead.mint)).toHaveLength(0);

    await resetAuto();
    const off = newPumpPool('NONE');
    releaseAs(off.mint, 'HOT');
    await new Promise((r) => setTimeout(r, 20));
    expect(rowsFor(off.mint)).toHaveLength(0);
  });

  it('attaching twice listens once', async () => {
    autoSnipeController.attachWatchWindow();
    autoSnipeController.attachWatchWindow();
    await setAutoMode('SHADOW');
    const { mint } = newPumpPool('NONE');
    releaseAs(mint, 'HOT');
    await vi.waitFor(() => expect(rowsFor(mint).some((r) => r.outcome === 'WOULD_BUY')).toBe(true));
    expect(rowsFor(mint).filter((r) => r.stage === 'queue')).toHaveLength(1);
  });
});
