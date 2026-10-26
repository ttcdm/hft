import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EventEmitter } from 'events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  recorderConfig, recorderConfigProblems, RECORD_READ_ONLY_MAX_ROWS, RECORD_DEFAULT_MAX_ROWS, getRecorderRuntime,
} from '../server/backtest/recorderConfig';
import { LaunchRecorder } from '../server/backtest/launchRecorder';
import { analysePeaks, type ReplayedLaunch } from '../server/backtest/replay';
import { recorderCheck } from '../server/system/systemChecks';
import { PeakAnalysisView } from '../src/components/BacktestModal';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('S190 recorder limits are configurable, with sized defaults', () => {
  it('normal server: 30 min, 2,000 trades, 14 days, 3,000,000 rows', () => {
    expect(recorderConfig({})).toEqual({ mintMs: 30 * 60_000, maxTradesPerMint: 2_000, retentionDays: 14, maxRows: RECORD_DEFAULT_MAX_ROWS });
    expect(RECORD_DEFAULT_MAX_ROWS).toBeGreaterThanOrEqual(3_000_000);
  });
  it('read-only (the paper copy): 180 min, trades scaled to the window, 6,000,000 rows', () => {
    const c = recorderConfig({ APEX_READ_ONLY: 'true' } as any);
    expect(c.mintMs).toBe(180 * 60_000);
    expect(c.maxTradesPerMint).toBe(12_000); // 2,000 per 30 min of window
    expect(c.maxRows).toBe(RECORD_READ_ONLY_MAX_ROWS);
  });
  it('every limit is overridable by env, and an unusable value falls back with a warning', () => {
    const env = { APEX_RECORD_MINT_MINUTES: '240', APEX_RECORD_MAX_TRADES_PER_MINT: '50000', APEX_RECORD_RETENTION_DAYS: '30', APEX_RECORD_MAX_ROWS: '9000000' } as any;
    expect(recorderConfig(env)).toEqual({ mintMs: 240 * 60_000, maxTradesPerMint: 50_000, retentionDays: 30, maxRows: 9_000_000 });
    const bad = { APEX_RECORD_MINT_MINUTES: '0', APEX_RECORD_MAX_ROWS: 'lots', APEX_RECORD_RETENTION_DAYS: '1.5' } as any;
    expect(recorderConfig(bad)).toEqual(recorderConfig({}));
    expect(recorderConfigProblems(bad)).toHaveLength(3);
    expect(recorderConfigProblems({})).toEqual([]);
  });
});

describe('S190 the recorder uses its config: window, trades per launch, pruning log', () => {
  const t0 = 1_700_000_000_000;
  function setup(config: any, db: Record<string, unknown> = {}) {
    let now = t0;
    const rows: any[] = [];
    const fakeDb: any = { recordLaunchEvent: (ts: number, mint: string, kind: string, payload: any) => { rows.push({ ts, mint, kind, payload }); return true; }, pruneLaunchRecording: vi.fn(() => 0), ...db };
    const win: any = Object.assign(new EventEmitter(), { isWatching: () => true });
    const rec = new LaunchRecorder(fakeDb, win, () => 150, () => now, config);
    rec.onCreate({ mint: 'M', creator: 'c', user: 'c' } as any);
    const trade = (dtMs: number) => { now = t0 + dtMs; rec.onTrade({ mint: 'M', signature: 's' + dtMs, isBuy: true, solAmountLamports: 1n, tokenAmount: 1n, virtualSolReserves: 1n, virtualTokenReserves: 1n, realSolReserves: 1n, realTokenReserves: 1n, user: 'u', slot: 1, timestampSec: 0 } as any); };
    return { rec, rows, trade, fakeDb, setNow: (n: number) => { now = n; } };
  }
  it('records trades for the configured window and stops after it', () => {
    const { rows, trade } = setup({ mintMs: 180 * 60_000, maxTradesPerMint: 100, retentionDays: 14, maxRows: 1e6 });
    trade(1_000); trade(100 * 60_000); trade(179 * 60_000); trade(181 * 60_000);
    expect(rows.filter((r) => r.kind === 'TRADE')).toHaveLength(3);
  });
  it('the old 30-minute window would have stopped at 30', () => {
    const { rows, trade } = setup({ mintMs: 30 * 60_000, maxTradesPerMint: 100, retentionDays: 14, maxRows: 1e6 });
    trade(1_000); trade(31 * 60_000);
    expect(rows.filter((r) => r.kind === 'TRADE')).toHaveLength(1);
  });
  it('stops at the trades-per-launch limit', () => {
    const { rows, trade } = setup({ mintMs: 180 * 60_000, maxTradesPerMint: 5, retentionDays: 14, maxRows: 1e6 });
    for (let i = 1; i <= 9; i++) trade(i * 1000);
    expect(rows.filter((r) => r.kind === 'TRADE')).toHaveLength(5);
  });
  it('prunes with the configured limits, logs the first pruning loudly and counts it', async () => {
    const { Logger } = await import('../server/middleware/enterprise');
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined as any);
    const prune = vi.fn().mockReturnValueOnce(120).mockReturnValueOnce(30);
    const { rec, trade, setNow } = setup({ mintMs: 180 * 60_000, maxTradesPerMint: 100, retentionDays: 9, maxRows: 12345 }, { pruneLaunchRecording: prune } as any);
    trade(1_000);
    expect(prune).toHaveBeenCalledWith(9, 12345, expect.any(Number));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/pruned 120 recorded row\(s\).*oldest launches are being dropped/);
    setNow(t0 + 2 * 3_600_000); trade(2 * 3_600_000 + 1);
    expect(warn).toHaveBeenCalledTimes(1); // the second pruning is not another warning
    expect(rec.getRuntime()).toMatchObject({ prunedRows: 150, prunings: 2, lastPruneRows: 30 });
    expect(getRecorderRuntime()).toBe(rec.getRuntime());
  });
  it('does not prune, or warn, when nothing is over a limit', () => {
    const { rec, trade } = setup({ mintMs: 180 * 60_000, maxTradesPerMint: 100, retentionDays: 14, maxRows: 1e6 });
    trade(1_000);
    expect(rec.getRuntime().prunedRows).toBe(0);
  });
});

describe('S190 System checks shows the recorder against its limits', () => {
  it('OK with room, WARN once rows pass 80% of the limit or anything was pruned, and it says how long is left at the measured rate', async () => {
    const { workstationDb } = await import('../server/db/database');
    const win: any = Object.assign(new EventEmitter(), { isWatching: () => true });
    const now = Date.now();
    const rec = new LaunchRecorder({ recordLaunchEvent: () => true, pruneLaunchRecording: () => 0 } as any, win, () => 150, () => now, { mintMs: 180 * 60_000, maxTradesPerMint: 100, retentionDays: 14, maxRows: 10_000 });
    const status = vi.spyOn(workstationDb, 'getLaunchRecordingStatus').mockReturnValue({ launches: 7, events: 100, launchRows: 100, funderRows: 0, endedLaunches: 0, oldestTs: now - 86_400_000, newestTs: now, newestCreateTs: now });
    vi.spyOn(workstationDb, 'getLaunchRecordingRows').mockReturnValue(100);
    const ok = recorderCheck(now + 60_000); // past the 30 s rate cache of any earlier call
    expect(ok.status).toBe('OK');
    expect(ok.value).toMatch(/7 launches, 100 of 10000 rows/);
    expect(ok.detail).toMatch(/window 180 min per launch/);
    expect(ok.detail).toMatch(/Last hour: 100 rows, so about 4\.1 days until the row limit/); // 9,900 rows left at 100 an hour
    expect(ok.detail).toMatch(/Nothing has been pruned/);
    status.mockReturnValue({ launches: 70, events: 8_500, launchRows: 8_500, funderRows: 0, endedLaunches: 0, oldestTs: now - 86_400_000, newestTs: now, newestCreateTs: now });
    const near = recorderCheck(now + 120_000);
    expect(near.status).toBe('WARN');
    expect(near.detail).toMatch(/Over 80%/);
    rec.getRuntime().prunedRows = 500; rec.getRuntime().firstPruneAt = now;
    const pruned = recorderCheck(now + 180_000);
    expect(pruned.status).toBe('WARN');
    expect(pruned.value).toMatch(/PRUNING \(500 dropped\)/);
    expect(pruned.detail).toMatch(/OLDEST launches are being dropped/);
  });
});

describe('S190 time to peak, bucketed', () => {
  const row = (peak: ReplayedLaunch['peak']) => ({ peak } as ReplayedLaunch);
  const pk = (mult: number, ttpMin: number, observedMin: number) => ({ refPriceSol: 1, peakPriceSol: mult, peakMultiple: mult, timeToPeakMs: ttpMin * 60_000, observedMs: observedMin * 60_000 });
  const a = analysePeaks([row(pk(1.2, 1, 30)), row(pk(3, 4.99, 30)), row(pk(2, 5, 60)), row(pk(6, 45, 180)), row(pk(2.5, 90, 180)), row(pk(1.5, 200, 240)), row(null)]);
  const by = Object.fromEntries(a.buckets.map((b) => [b.label, b]));
  it('puts each launch in the bucket of its peak time; a boundary belongs to the later bucket; no-peak rows are left out', () => {
    expect(a.launches).toBe(6);
    expect(by['< 5 min'].launches).toBe(2);
    expect(by['5 to 30 min'].launches).toBe(1); // exactly 5 min
    expect(by['30 to 60 min'].launches).toBe(1);
    expect(by['60 to 180 min'].launches).toBe(1);
    expect(by['over 180 min'].launches).toBe(1);
  });
  it('medians and the 2x / 5x counts are per bucket', () => {
    expect(by['< 5 min'].medianPeakMultiple).toBeCloseTo(2.1, 9); // median of 1.2 and 3
    expect(by['< 5 min'].peakAtLeast2x).toBe(1);
    expect(by['30 to 60 min'].peakAtLeast5x).toBe(1);
    expect(by['over 180 min'].medianPeakMultiple).toBe(1.5);
  });
  it('reports how much data reaches 30 / 60 / 180 minutes, and counts late 2x spikes against it', () => {
    expect(a.coverage).toEqual({ atLeast30Min: 6, atLeast60Min: 4, atLeast180Min: 3 });
    expect(a.late).toEqual({ peakAfter30MinAtLeast2x: 2, ofLaunchesWithAtLeast60MinData: 4, peakAfter60MinAtLeast2x: 1, ofLaunchesWithAtLeast180MinData: 3 });
  });
  it('an empty recording gives an empty, honest analysis', () => {
    const e = analysePeaks([]);
    expect(e.launches).toBe(0);
    expect(e.buckets.every((b) => b.launches === 0 && b.medianPeakMultiple === null)).toBe(true);
  });
  it('the screen shows the buckets, the late-spike line, and warns when no launch has 60+ minutes of data', () => {
    const html = renderToStaticMarkup(<PeakAnalysisView a={a} />);
    expect(html).toContain('data-testid="peak-buckets"');
    expect(html).toContain('60 to 180 min');
    expect(html).toMatch(/2 launch\(es\) peaked 2x\+ more than 30 min after the release \(of 4 with 60\+ min of data\)/);
    expect(html).not.toContain('peak-no-coverage');
    const none = renderToStaticMarkup(<PeakAnalysisView a={analysePeaks([row(pk(2, 1, 30))])} />);
    expect(none).toContain('data-testid="peak-no-coverage"');
  });
});
