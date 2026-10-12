import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { AutoBudgetEditor } from '../src/components/AutoPanel';
import { ReplayBacktestView, type ReplayResponse } from '../src/components/BacktestModal';

const limits = { maxSpendSol: 0.06, minSpendSol: 0.005, maxBuys: 50 };
const budgets = (maxBuys: number, maxSpendSol: number) => ({ maxBuys, maxSpendSol, maxLossFraction: 0.15, maxDurationMs: 14_400_000 });

describe('S188 (b) the budget editor shows what the server runs with', () => {
  it('a PAPER session\'s 50 buys / 0.7 SOL is shown as a note, not a red validation error, and Save stays off until it is edited', () => {
    const html = renderToStaticMarkup(<AutoBudgetEditor budgets={budgets(50, 0.7)} limits={limits} />);
    expect(html).toMatch(/data-testid="budget-buys"[^>]*value="50"/);
    expect(html).toMatch(/data-testid="budget-spend"[^>]*value="0.7"/);
    expect(html).not.toContain('data-testid="budget-problem"');
    expect(html).toContain('data-testid="budget-running-note"');
    expect(html).toMatch(/PAPER session/);
    expect(html).toMatch(/data-testid="budget-save"[^>]*disabled/);
  });
  it('the default DEVNET budget shows neither a note nor an error', () => {
    const html = renderToStaticMarkup(<AutoBudgetEditor budgets={budgets(5, 0.02)} limits={limits} />);
    expect(html).not.toContain('budget-problem');
    expect(html).not.toContain('budget-running-note');
  });
});

describe('S188 (a) the replay says how many recorded launches it covers', () => {
  const base = { recorded: { launches: 317, events: 9000, oldestTs: 1, newestTs: 2 }, message: null };
  const report: any = { rules: [], notReplayed: [], assumptions: { orderSol: 0.005, entryDelayMs: 1500, feePct: 1, networkFeeSol: 0.000005, tipSol: 0.0001, minScore: 70 },
    summary: { launches: 300, released: {}, entries: 0, closed: 0, openAtEnd: 0, wins: 0, losses: 0, winRate: null, netPnlSol: null, avgHoldMs: null, exitReasons: {} }, launches: [] };
  it('names the cap when it cut launches off', () => {
    const html = renderToStaticMarkup(<ReplayBacktestView data={{ ...base, report, replayedLaunches: 300, replayCap: 300 } as ReplayResponse} />);
    expect(html).toContain('data-testid="replay-capped"');
    expect(html).toMatch(/newest 300 of 317/);
  });
  it('says nothing about a cap when every recorded launch was replayed', () => {
    const html = renderToStaticMarkup(<ReplayBacktestView data={{ ...base, recorded: { ...base.recorded, launches: 120 }, report, replayedLaunches: 120, replayCap: 300 } as ReplayResponse} />);
    expect(html).not.toContain('replay-capped');
  });
});
