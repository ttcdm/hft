import { describe, it, expect } from 'vitest';
import fs from 'fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BacktestModal } from '../src/components/BacktestModal';
import { REPLAY_DEFAULTS } from '../server/backtest/replay';

describe('B4: synthetic results are labelled as synthetic', () => {
  it('the Backtest view has no generator behind it: with no recording it says so and shows no result', () => {
    const html = renderToStaticMarkup(<BacktestModal isOpen={true} onClose={() => undefined} />);
    expect(html).not.toMatch(/synthetic price paths/i); // there is nothing synthetic left to label (S178)
    expect(html).not.toMatch(/Historical Backtest|July 11/i);
    expect(fs.existsSync('src/utils/backtestEngine.ts')).toBe(false);
  });

  it('decision 6: the synthetic benchmark script and its output are gone, and nothing live points at them', () => {
    for (const f of ['scripts/run_benchmarks_and_evaluation.ts', 'synthetic_benchmark_results.json', 'benchmark_results.json']) expect(fs.existsSync(f), f).toBe(false);
    expect(fs.readFileSync('package.json', 'utf8')).not.toMatch(/run_benchmarks_and_evaluation|synthetic_benchmark_results/);
    expect(REPLAY_DEFAULTS.entryDelayMs).toBeGreaterThan(0); // the replay over recorded launches is the backtest that stays
  });

  it('STRATEGY_EVALUATION.md marks the PF 2.36 / +0.000677 SOL claims unverified', () => {
    const md = fs.readFileSync('docs/archive/STRATEGY_EVALUATION.md', 'utf8');
    expect(md).toMatch(/UNVERIFIED/);
    for (const claim of ['2.36', '0.000677']) {
      const lines = md.split('\n').filter((l) => l.includes(claim));
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) expect(l, l).toMatch(/unverified|UNVERIFIED|synthetic/i);
    }
  });
});
