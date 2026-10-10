import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { autoSnipeController } from '../server/auto/controller';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { executionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';
import { setAutoMode, resetAuto, newPumpPool } from './fixtures/auto';

/** Q29: kill() and setMode() changed the mode and the session under a buy that was already past the gates. */
describe('Q29: a kill or a mode change during a buy waits for it', () => {
  beforeEach(() => memecoinAggregator.setConfluenceGating(false));
  afterEach(async () => {
    memecoinAggregator.setConfluenceGating(true);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await resetAuto();
  });

  const slowBuy = () => {
    const real = memecoinAggregator.executeSnipe.bind(memecoinAggregator);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    vi.spyOn(memecoinAggregator, 'executeSnipe').mockImplementation(async (p) => { entered(); await gate; return real(p); });
    return { release, started };
  };

  it('kill with exitAll sells a position whose buy finished after the kill began, and the row keeps the mode it was bought in', async () => {
    await setAutoMode('PAPER');
    const { mint } = newPumpPool('HOT');
    const { release, started } = slowBuy();
    const buying = autoSnipeController.submitCandidate({ mint, symbol: 'Q29', source: 'TEST', amountUsd: 0.7, provenance: 'REAL_ONCHAIN' });
    await started;
    const killing = autoSnipeController.kill({ exitAll: true, reason: 'test' });
    expect(autoSnipeController.getMode()).toBe('OFF'); // no new candidate can start
    release();
    const [d, k] = await Promise.all([buying, killing]);
    expect(d.outcome, d.reason).toBe('BOUGHT');
    expect(d.mode).toBe('PAPER');
    expect(workstationDb.loadDecisions({ mint }).find((r) => r.outcome === 'BOUGHT')?.autoMode).toBe('PAPER');
    expect(k.closed).toBe(1);
    expect(executionCoordinator.getPositions('PAPER', 'ACTIVE').some((p) => p.mint === mint)).toBe(false);
  });

  it('setMode waits for a buy in flight and books it in the session it started in', async () => {
    await setAutoMode('PAPER');
    const { mint } = newPumpPool('HOT');
    const { release, started } = slowBuy();
    const buying = autoSnipeController.submitCandidate({ mint, symbol: 'Q29', source: 'TEST', amountUsd: 0.7, provenance: 'REAL_ONCHAIN' });
    await started;
    let switched = false;
    const switching = autoSnipeController.setMode('SHADOW').then((r) => { switched = true; return r; });
    await new Promise((r) => setTimeout(r, 10));
    expect(switched).toBe(false);
    release();
    await buying;
    await switching;
    expect(autoSnipeController.getMode()).toBe('SHADOW');
    expect(workstationDb.loadDecisions({ mint }).find((r) => r.outcome === 'BOUGHT')?.autoMode).toBe('PAPER');
  });
});
