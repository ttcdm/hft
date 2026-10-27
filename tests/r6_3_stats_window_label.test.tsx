import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AutoPanelView, type AutoStatusData } from '../src/components/AutoPanel';

const base = (stats: Partial<AutoStatusData['stats']> = {}): AutoStatusData => ({
  mode: 'PAPER', killed: false, killReason: null, downgradeReason: null, haltReason: null, triggers: [], slippageBreaches: 0, session: null,
  budgets: { maxBuys: 5, maxSpendSol: 0.02, maxLossFraction: 0.15, maxDurationMs: 4 * 3600_000 },
  stats: { seen: 1, rejectedByStage: {}, wouldBuy: 0, bought: 0, open: 0, closed: 0, netPnlSol: 0, feesPaidSol: 0, winRate: null, ...stats },
});

/** Batch D's getJournalStats adds mode, window, rows and truncated; the panel labels its figures with them. */
describe('R6-3: the auto stats say which mode and window they cover', () => {
  it('labels mode, window and rows, and flags a truncated read', () => {
    const html = renderToStaticMarkup(<AutoPanelView status={base({ mode: 'PAPER', windowStart: Date.UTC(2026, 9, 27, 6, 0), windowEnd: Date.UTC(2026, 9, 27, 7, 30), rowsCounted: 40, rowsRead: 500, rowLimit: 500, truncated: true, pnlSource: 'position ledger realizedPnLSol', notes: ['SHADOW rows are not counted.'] })} />);
    expect(html).toContain('PAPER only, 06:00 to 07:30 UTC (40 of 500 rows read)');
    expect(html).toContain('data-testid="auto-stats-truncated"');
    expect(html).toContain('SHADOW rows are not counted.');
  });
  it('an untruncated read has no flag; an older server shows no label', () => {
    expect(renderToStaticMarkup(<AutoPanelView status={base({ mode: null, windowStart: null, truncated: false })} />)).toContain('auto has not run, no rows yet');
    expect(renderToStaticMarkup(<AutoPanelView status={base({ mode: 'PAPER', windowStart: 1, truncated: false })} />)).not.toContain('auto-stats-truncated');
    expect(renderToStaticMarkup(<AutoPanelView status={base()} />)).not.toContain('auto-stats-window');
  });
});
