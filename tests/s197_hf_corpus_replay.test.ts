import { describe, it, expect } from 'vitest';
import { toRecordedLaunch, launchPeak, V_SOL_INIT, V_TOK_REAL_OFFSET, type CorpusLaunch } from '../scripts/hfcorpus/replay';
import { replayLaunch, tradeFromJson } from '../server/backtest/replay';
import { tradePriceSol } from '../server/market/poolStats';

/** HAND-BUILT corpus rows in the exporter's shape (no dataset is read here): they drive the real converter and the real replay. */
const t0 = 1_780_000_000_000;
function launch(prices: number[]): CorpusLaunch {
  // constant-product curve walked to each target price: vSol / vTok / 1000 = price
  const k = 30_000_000_000 * 1_073_000_000_000_000;
  const trades: CorpusLaunch['trades'] = prices.map((p, i) => {
    const vTok = Math.sqrt(k / (p * 1000));
    const vSol = k / vTok;
    return [t0 + 1000 * (i + 1), true, 0.5, 1_000_000, 'W' + (i % 7), Math.round(vSol), Math.round(vTok), 'sig' + i];
  });
  return { mint: 'MintX', symbol: 'FX', creator: 'Creator', mayhem: false, t0, graduated: false, trades };
}

describe('S197 corpus converter', () => {
  it('turns exported rows into trade events whose price is the corpus price and whose real reserves come from the virtual ones', () => {
    const l = launch([3e-8, 4e-8]);
    const rec = toRecordedLaunch(l, 150);
    expect(rec.events[0].kind).toBe('CREATE');
    expect(rec.events[0].payload.solUsd).toBe(150);
    const t = tradeFromJson(rec.events[1].payload);
    expect(tradePriceSol(t)).toBeCloseTo(3e-8, 12);
    expect(t.realSolReserves).toBe(t.virtualSolReserves - V_SOL_INIT);
    expect(t.realTokenReserves).toBe(t.virtualTokenReserves - V_TOK_REAL_OFFSET);
    expect(t.timestampSec).toBe(Math.floor(rec.events[1].ts / 1000));
  });

  it('measures the launch-referenced peak (first price vs highest later price, minutes from launch)', () => {
    const pk = launchPeak(launch([3e-8, 6e-8, 4.5e-8]))!;
    expect(pk.multiple).toBeCloseTo(2, 6);
    expect(pk.atMin).toBeCloseTo(2 / 60, 6);
    expect(launchPeak(launch([3e-8]))).toBeNull();
  });

  it('feeds the real replay: a launch with no activity inside the window gets a verdict and no entry', () => {
    const r = replayLaunch(toRecordedLaunch(launch([3e-8, 3e-8, 3e-8]), 150), [], 150, { minScore: 70 });
    expect(r.trades).toBe(3);
    expect(['DEAD', 'READY', 'HOT', 'NO_TRADES']).toContain(r.verdict);
    expect(r.entered).toBe(false);
  });
});
