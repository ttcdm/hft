import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  getConfluenceThreshold, setConfluenceThreshold, resetConfluenceThreshold, checkConfluenceThreshold, envConfluenceThreshold, envConfluenceProblem,
  confluenceThresholdInfo, CONFLUENCE_DEFAULT_THRESHOLD,
} from '../server/signals/confluenceThreshold';
import { isConfluencePassed, ConfluenceEngine, MIN_CONFLUENCE_SCORE } from '../server/signals/confluenceEngine';
import { WatchWindow, HOT_MIN_SCORE } from '../server/signals/watchWindow';
import { AutoSnipeController } from '../server/auto/controller';
import { workstationDb } from '../server/db/database';
import { replayLaunches } from '../server/backtest/replay';
import { Keypair } from '@solana/web3.js';
import { replay, buyers, wallet } from './fixtures/watch';
import { parseThreshold, thresholdWarning, THRESHOLD_DEFAULT, THRESHOLD_WARN_BELOW } from '../src/utils/confluenceThreshold';
import { CONFLUENCE_WARN_BELOW } from '../server/signals/confluenceThreshold';

const T0 = 1_700_000_000_000;
const mintOf = () => Keypair.generate().publicKey.toBase58();

afterEach(() => { resetConfluenceThreshold(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('S187 the one threshold', () => {
  it('defaults to 70 and both old constants are that default', () => {
    expect(getConfluenceThreshold()).toBe(70);
    expect(MIN_CONFLUENCE_SCORE).toBe(70);
    expect(HOT_MIN_SCORE).toBe(70);
    expect(CONFLUENCE_DEFAULT_THRESHOLD).toBe(THRESHOLD_DEFAULT);
    expect(CONFLUENCE_WARN_BELOW).toBe(THRESHOLD_WARN_BELOW);
  });
  it('takes whole numbers 0..100 and refuses everything else without changing the value', () => {
    for (const bad of [-1, 101, 55.5, NaN, 'abc', '', null, undefined]) {
      const r = setConfluenceThreshold(bad as any);
      expect(r.ok, String(bad)).toBe(false);
    }
    expect(getConfluenceThreshold()).toBe(70);
    expect(checkConfluenceThreshold('0').ok).toBe(true);
    expect(checkConfluenceThreshold(100).ok).toBe(true);
    const r = setConfluenceThreshold(45);
    expect(r).toMatchObject({ ok: true, value: 45, previous: 70 });
    expect(getConfluenceThreshold()).toBe(45);
  });
  it('CONFLUENCE_MIN_SCORE is the default, an invalid value falls back to 70 and is reported, and the operator wins over it', () => {
    vi.stubEnv('CONFLUENCE_MIN_SCORE', '60');
    expect(getConfluenceThreshold()).toBe(60);
    expect(confluenceThresholdInfo()).toMatchObject({ value: 60, defaultValue: 60, source: 'env' });
    setConfluenceThreshold(40);
    expect(confluenceThresholdInfo()).toMatchObject({ value: 40, defaultValue: 60, source: 'operator' });
    resetConfluenceThreshold();
    vi.stubEnv('CONFLUENCE_MIN_SCORE', '150');
    expect(envConfluenceThreshold()).toBe(70);
    expect(envConfluenceProblem()).toMatch(/ignored/);
    expect(confluenceThresholdInfo().source).toBe('default');
  });
  it('warns plainly below 50 and not at 50', () => {
    setConfluenceThreshold(49);
    expect(confluenceThresholdInfo().warning).toMatch(/more buys of weaker coins/);
    setConfluenceThreshold(50);
    expect(confluenceThresholdInfo().warning).toBeNull();
  });
});

describe('S187 the two gates move together', () => {
  it('isConfluencePassed and the engine minimum follow the threshold', () => {
    expect(isConfluencePassed(60)).toBe(false);
    setConfluenceThreshold(60);
    expect(isConfluencePassed(60)).toBe(true);
    expect(isConfluencePassed(59)).toBe(false);
    expect(ConfluenceEngine.MIN_PASSING_SCORE).toBe(60);
    expect(isConfluencePassed(59, 50)).toBe(true); // a what-if override
  });
  it('the watch window releases HOT at exactly the score the execution gate asks for (one value, no divergence)', () => {
    const verdictAt = (score: number, opts: { minScore?: number } = {}) => {
      const w = new WatchWindow({ scoreOf: () => score, ...opts });
      const mint = mintOf();
      w.watch(mint, wallet(), T0 - 1_000);
      const b = buyers(30, 25);
      b.wallets.forEach((x, i) => w.setFunder(x, `funder-${i}`));
      for (const { trade, at } of replay(mint, T0, [...b.steps, [26, wallet(), 'sell', 0.05], [27, wallet(), 'sell', 0.05]])) w.onTrade(trade, at);
      return w.evaluate(mint, T0 + 30_000)!;
    };
    expect(verdictAt(60).state).toBe('WATCHING'); // 60 < 70
    setConfluenceThreshold(60);
    const hot = verdictAt(60);
    expect(hot.state).toBe('HOT');
    expect(hot.reason).toMatch(/threshold 60/);
    expect(isConfluencePassed(60)).toBe(true); // the execution gate agrees at the same score
    expect(verdictAt(59).state).toBe('WATCHING');
    expect(isConfluencePassed(59)).toBe(false);
    resetConfluenceThreshold();
    expect(verdictAt(60, { minScore: 60 }).state).toBe('HOT'); // a what-if window uses its own value
  });
});

describe('S187 the controller journals the change', () => {
  it('writes a decision row naming the old and new value, and a refusal writes none', () => {
    const log = vi.spyOn(workstationDb, 'logDecision').mockImplementation(() => undefined as any);
    const c = new AutoSnipeController();
    expect(c.setConfluenceThreshold(200).ok).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(c.setConfluenceThreshold(50)).toMatchObject({ ok: true, value: 50 });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String((log.mock.calls[0][0] as any).reason)).toMatch(/70 -> 50/);
    expect(c.getStatus().confluence).toMatchObject({ value: 50, defaultValue: 70, source: 'operator' });
  });
});

describe('S187 the replay what-if', () => {
  it('reports the threshold it replayed at, in its rules and assumptions, and defaults to the one in force', () => {
    const r70 = replayLaunches([], [], null);
    expect(r70.assumptions.minScore).toBe(70);
    const r40 = replayLaunches([], [], null, { minScore: 40 });
    expect(r40.assumptions.minScore).toBe(40);
    expect(r40.rules.join(' ')).toMatch(/at least 40/);
    setConfluenceThreshold(55);
    expect(replayLaunches([], [], null).assumptions.minScore).toBe(55);
  });
});

describe('S187 client rules match the server', () => {
  it('parseThreshold refuses what the server refuses', () => {
    for (const t of ['', 'x', '-1', '101', '5.5']) expect(parseThreshold(t).ok, t).toBe(false);
    expect(parseThreshold(' 70 ')).toEqual({ ok: true, value: 70 });
    expect(parseThreshold('0')).toEqual({ ok: true, value: 0 });
    expect(thresholdWarning(49)).toMatch(/more buys of weaker coins/);
    expect(thresholdWarning(50)).toBeNull();
  });
});
