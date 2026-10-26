import { describe, it, expect, afterEach } from 'vitest';
import { replayLaunch, replayLaunches, REPLAY_DEFAULTS, type ReplayOptions } from '../server/backtest/replay';
import { restoreStockEngine, type TradeRow } from '../server/backtest/costModel';
import { toRecordedLaunch, type CorpusLaunch } from '../scripts/hfcorpus/replay';

/**
 * 5C: the replay runs the gates live runs at the buy, and the studies stop looking ahead. Every block fails on the 5A + 5B base (e9fecde)
 * without its commit.
 */

const T0 = 1_760_000_000_000;
const CREATOR = 'creator5C';
/** constant-product buys on the chain's curve maths; `first` puts one buy (e.g. the creator's) before the 60 warm-up buys */
function curve(first?: { user: string; sol: number }, t0 = T0): TradeRow[] {
  let vSol = 30e9, vTok = 1.073e15;
  const rows: TradeRow[] = [];
  const buy = (ts: number, sol: number, user: string, sig: string) => {
    const k = vSol * vTok, newS = vSol + sol * 1e9, newT = k / newS;
    rows.push([ts, true, sol, (vTok - newT) / 1e6, user, Math.round(newS), Math.round(newT), sig]);
    vSol = newS; vTok = newT;
  };
  if (first) buy(t0 + 500, first.sol, first.user, 'first');
  for (let i = 0; i < 60; i++) buy(t0 + 1500 + i * 900, 0.3 + (i % 5) * 0.2, 'w' + (i % 40), `w-${i}`);
  return rows;
}
const launch = (rows: TradeRow[], t0 = T0): CorpusLaunch => ({ mint: 'Mint5C', symbol: 'FC', creator: CREATOR, mayhem: false, t0, graduated: false, trades: rows });
const GATE: ReplayOptions = { minScore: 0, readyGate: false, curveCap: false };
const replay = (rows: TradeRow[], o: ReplayOptions = {}) => replayLaunch(toRecordedLaunch(launch(rows), 150), [], 150, { ...GATE, ...o });

describe('5C (R1-105): the replay applies the dev-holding gate executeSnipe applies', () => {
  afterEach(() => restoreStockEngine());

  // 2.25 SOL into a fresh curve buys about 75M of the 1B tokens: 7.5% of the supply
  const devBuy = { user: CREATOR, sol: 2.25 };

  it('a 7% creator buy gives NO_ENTRY with a dev-holding reason at the default 5% limit', () => {
    const r = replay(curve(devBuy));
    expect(r.verdict === 'HOT' || r.verdict === 'READY').toBe(true);
    expect(r.entered).toBe(false);
    expect(r.outcome).toBe('NO_ENTRY');
    expect(r.noEntryReason).toMatch(/^DEV_HOLDING: creator holds 7\.\d\d% \(limit 5%\)/);
  });

  it('the limit is the setting passed in, and 0 turns it off as in live', () => {
    expect(replay(curve(devBuy), { maxDevHoldingPct: 10 }).entered).toBe(true);
    expect(replay(curve(devBuy), { maxDevHoldingPct: 0 }).entered).toBe(true);
    expect(REPLAY_DEFAULTS.maxDevHoldingPct).toBe(5);
  });

  it('the same buy by someone else is not the creator\'s holding', () => {
    expect(replay(curve({ user: 'stranger', sol: 2.25 })).entered).toBe(true);
  });

  it('the report states the gate', () => {
    const rep = replayLaunches([toRecordedLaunch(launch(curve(devBuy)), 150)], [], 150, GATE);
    expect(rep.rules.join(' ')).toMatch(/hold at most 5% of the supply/);
    expect(rep.notReplayed.join(' ')).not.toMatch(/holder concentration\): not recorded/);
  });
});
