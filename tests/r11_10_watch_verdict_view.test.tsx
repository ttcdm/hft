import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TokenBoardView, type BoardData } from '../src/components/TokenBoard';

/**
 * R11-10 (view half): READY was one green chip whether the score was 7 or 70 and whether the READY gate would refuse it; the reason
 * kept "(threshold 70)" after the operator changed it; the reason was only in a row tooltip, which a keyboard can't reach; and released
 * rows showed a frozen age though the release can be bought only for ~8 s. The tab now shows score, live threshold and gate result,
 * the reason as text in the row with the live threshold beside the one at release, and how old the release is.
 */
const metrics = { elapsedMs: 121000, cumulativeNetInflowSol: 0.4, uniqueBuyers: 2, rawUniqueBuyers: 2, funderCoverage: 1, buySellRatio: 2, largestBuyerShare: 0.6, creatorSold: false, passingSignals: 1, tradeCount: 3, netInflowPer10s: [] };
const board = (rows: any[]): BoardData => ({
  generatedAt: 1, executionMode: 'PAPER', wallet: { balanceSol: null, reserveSol: 0.015, rentLockedSol: null, spendableSol: null, solUsd: null },
  launches: [], holding: [], watching: rows,
});
const render = (rows: any[]) => renderToStaticMarkup(<TokenBoardView board={board(rows)} tab="watching" onTab={() => undefined} />);

describe('R11-10: watch verdicts show the live gate', () => {
  it('a READY the gate refuses is not a green chip, and says why', () => {
    const html = render([{ mint: 'M'.repeat(44), state: 'READY', reason: 'window elapsed with 1 strong signal(s), score 7 (threshold 70)', metrics,
      score: 7, threshold: 40, readyGate: { pass: false, reason: 'READY_TOO_WEAK: concentration fails' }, releasedAgeMs: 3000, signalLimitMs: 8000 }]);
    expect(html).not.toMatch(/bg-emerald-900\/50 text-emerald-300[^>]*>READY</);
    expect(html).toMatch(/READY \(gate refuses\)/);
    expect(html).toMatch(/data-testid="verdict-score"[^>]*>7 \/ 40</);
    expect(html).toMatch(/data-testid="verdict-gate"[^>]*>[^<]*READY_TOO_WEAK: concentration fails/);
    // the reason is visible text with the live threshold beside the one at release
    expect(html).toMatch(/data-testid="verdict-reason"[^>]*>[^<]*threshold 70 at release, 40 now/);
  });

  it('a release older than the signal limit says it can no longer be bought; a fresh one gives its age', () => {
    const old = render([{ mint: 'O'.repeat(44), state: 'HOT', reason: '3 strong signals and score 80 (threshold 70)', metrics, score: 80, threshold: 70, readyGate: null, releasedAgeMs: 60_000, signalLimitMs: 8000 }]);
    expect(old).toMatch(/data-testid="verdict-age"[^>]*>[^<]*1m ago[^<]*expired/);
    const fresh = render([{ mint: 'F'.repeat(44), state: 'HOT', reason: '3 strong signals and score 80 (threshold 70)', metrics, score: 80, threshold: 70, readyGate: null, releasedAgeMs: 2000, signalLimitMs: 8000 }]);
    expect(fresh).toMatch(/data-testid="verdict-age"[^>]*>released 2s ago</);
    expect(fresh).not.toMatch(/threshold \d+ at release/); // the threshold has not changed
  });

  it('a watching row has no verdict fields', () => {
    const html = render([{ mint: 'W'.repeat(44), state: 'WATCHING', reason: null, metrics }]);
    expect(html).toMatch(/data-testid="verdict-score"[^>]*>—</);
  });
});
