import { describe, it, expect, afterEach, vi } from 'vitest';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { executionCoordinator } from '../server/execution/coordinator';
import { autoSnipeController } from '../server/auto/controller';
import { pumpFunService } from '../server/pumpfunService';

/**
 * R5-1: the aggregator's candidate loop stops at 3 active positions. RECOVERED rows (balances found in the wallet) used to count, so three
 * airdrops stopped auto buying for good. The real loop runs on fake timers; positions, mode and callouts are stubbed at their getters.
 */
describe('R5-1: RECOVERED rows do not fill the aggregator loop\'s 3 slots', () => {
  const agg = memecoinAggregator as any;
  let savedEnabled: boolean;
  afterEach(() => {
    if (agg.autoSniperTimer) clearInterval(agg.autoSniperTimer);
    agg.autoSniperTimer = null;
    agg.config.isAutoSnipeEnabled = savedEnabled;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const pos = (i: number, recovered: boolean) => ({ id: `p${i}`, mint: `M${i}`, entryTxSignature: recovered ? `RECOVERED:M${i}` : `sig${i}` });

  const runOnce = async (positions: any[]) => {
    savedEnabled = agg.config.isAutoSnipeEnabled;
    if (agg.autoSniperTimer) clearInterval(agg.autoSniperTimer);
    agg.autoSniperTimer = null;
    agg.config.isAutoSnipeEnabled = true;
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('PAPER');
    vi.spyOn(executionCoordinator, 'getPositions').mockReturnValue(positions);
    vi.spyOn(autoSnipeController, 'getMode').mockReturnValue('PAPER' as any);
    vi.spyOn(pumpFunService, 'getHotCallouts').mockReturnValue([
      { id: 'c1', token: { mint: 'NEWMINT111', symbol: 'NEW', bondingCurveProgress: 10 }, caller: { userId: 'someone' } } as any,
    ]);
    const submit = vi.spyOn(autoSnipeController, 'submitCandidate').mockResolvedValue({ outcome: 'DROPPED' } as any);
    vi.useFakeTimers();
    agg.startAutonomousSniperLoop();
    await vi.advanceTimersByTimeAsync(5_000);
    return submit;
  };

  it('three RECOVERED rows leave the loop free to submit a candidate', async () => {
    const submit = await runOnce([pos(1, true), pos(2, true), pos(3, true)]);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('three positions auto chose still stop it, as before', async () => {
    const submit = await runOnce([pos(1, false), pos(2, false), pos(3, false)]);
    expect(submit).not.toHaveBeenCalled();
  });
});
