import { describe, it, expect } from 'vitest';
import fs from 'fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BacktestModal } from '../src/components/BacktestModal';

describe('B4: synthetic results are labelled as synthetic', () => {
  it('the Backtest view has no generator behind it: with no recording it says so and shows no result', () => {
    const html = renderToStaticMarkup(<BacktestModal isOpen={true} onClose={() => undefined} />);
    expect(html).not.toMatch(/synthetic price paths/i); // there is nothing synthetic left to label (S178)
    expect(html).not.toMatch(/Historical Backtest|July 11/i);
    expect(fs.existsSync('src/utils/backtestEngine.ts')).toBe(false);
  });

  it('the benchmark output is renamed and carries a header note saying its inputs are hand-written', () => {
    expect(fs.existsSync('benchmark_results.json')).toBe(false);
    const j = JSON.parse(fs.readFileSync('synthetic_benchmark_results.json', 'utf8'));
    expect(j._note).toMatch(/SYNTHETIC/);
    expect(j._note).toMatch(/hand-written/);
    const script = fs.readFileSync('scripts/run_benchmarks_and_evaluation.ts', 'utf8');
    expect(script).toContain("'synthetic_benchmark_results.json'");
    expect(script).not.toContain("'benchmark_results.json'");
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
