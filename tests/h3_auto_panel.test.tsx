import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AutoPanelView, AutoModeBadge, type AutoStatusData } from '../src/components/AutoPanel';
import { Header } from '../src/components/Header';
import { computeJournalStats } from '../server/auto/journalStats';
import { autoSnipeController } from '../server/auto/controller';
import { executionCoordinator } from '../server/execution/coordinator';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { workstationDb } from '../server/db/database';
import { solPriceService } from '../server/market/solPriceService';
import { riskEngine } from '../server/risk/riskEngine';
import { setAutoMode, resetAuto, newPumpPool } from './fixtures/auto';

const status = (over: Partial<AutoStatusData> = {}): AutoStatusData => ({
  mode: 'PAPER', killed: false, killReason: null, downgradeReason: null, haltReason: null, triggers: [], slippageBreaches: 1,
  session: { buys: 1, spentSol: 0.005, sessionPnlSol: 0, budgetsLeft: { buys: 4, spendSol: 0.015, lossSol: 0.01, msLeft: 3 * 60 * 60 * 1000 } },
  budgets: { maxBuys: 5, maxSpendSol: 0.02, maxLossFraction: 0.15, maxDurationMs: 4 * 60 * 60 * 1000 },
  stats: { seen: 12, rejectedByStage: { eligibility: 5, watch: 4 }, wouldBuy: 0, bought: 1, open: 1, closed: 0, netPnlSol: 0, feesPaidSol: 0.00005, winRate: null },
  ...over,
});

describe('H3: auto-snipe panel', () => {
  it('renders mode switch, budgets, stage counts and kill button; PnL and win rate are dashes until something closed', () => {
    const html = renderToStaticMarkup(<AutoPanelView status={status()} />);
    for (const m of ['OFF', 'SHADOW', 'PAPER', 'DEVNET_LIVE']) expect(html).toContain(`data-testid="mode-${m}"`);
    expect(html).toContain('4 / 5');
    expect(html).toContain('0.0150 SOL');
    expect(html).toContain('eligibility 5 · watch 4');
    expect(html).toContain('data-testid="auto-kill"');
    expect(html).toMatch(/Net PnL after fees<\/span><span[^>]*>—/);
    expect(html).toMatch(/Win rate<\/span><span[^>]*>—/);
  });

  it('shows the kill-switch downgrade reason and an all-trading halt with its clear button', () => {
    const html = renderToStaticMarkup(<AutoPanelView status={status({ mode: 'SHADOW', downgradeReason: 'kill switch: NEGATIVE_EXPECTANCY (x)', haltReason: 'wallet changed by an unexplained -0.3 SOL' })} />);
    expect(html).toContain('NEGATIVE_EXPECTANCY');
    expect(html).toContain('ALL TRADING HALTED');
    expect(html).toContain('AUTO HALTED');
  });

  it('the header shows the auto mode badge and no longer offers an exchange selector or fake exchange latencies', () => {
    expect(renderToStaticMarkup(<AutoModeBadge mode="SHADOW" />)).toContain('AUTO: SHADOW');
    expect(renderToStaticMarkup(<AutoModeBadge mode={null} />)).toContain('AUTO: —');
    const html = renderToStaticMarkup(
      <Header kpis={{} as any} isHalted={false} onToggleKillSwitch={() => undefined} onOpenDeployModal={() => undefined} onOpenAiDiagnostics={() => undefined}
        onOpenUnitTests={() => undefined} onOpenGatewayModal={() => undefined} onOpenEngineConsole={() => undefined} activeFeed="CME_AURORA" onSelectFeed={() => undefined}
        capitalTier="MICRO_10" onToggleCapitalTier={() => undefined} />
    );
    expect(html).toContain('data-testid="auto-badge"');
    expect(html).not.toMatch(/CME AURORA|EQUINIX|BINANCE SPOT|TOKYO/);
    expect(html).not.toMatch(/Kernel Bypass|PTP 1588/); // an unverifiable latency claim, removed
  });
});

describe('H3: every stats number traces to a journal row', () => {
  beforeEach(() => { memecoinAggregator.setConfluenceGating(false); solPriceService.setPrice(150, 'TEST_FIXTURE'); });
  afterEach(async () => { await resetAuto(); riskEngine.setKillSwitch(false); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('computeJournalStats counts and sums only journaled rows', () => {
    const rows = [
      { stage: 'queue', outcome: 'QUEUED', positionId: null, solDelta: null, inputs: null },
      { stage: 'queue', outcome: 'QUEUED', positionId: null, solDelta: null, inputs: null },
      { stage: 'queue', outcome: 'QUEUED', positionId: null, solDelta: null, inputs: null },
      { stage: 'watch', outcome: 'DROPPED', positionId: null, solDelta: null, inputs: null },
      { stage: 'fill', outcome: 'BOUGHT', positionId: 'a', solDelta: -0.0055, inputs: { feesSol: 0.0005 } },
      { stage: 'exit', outcome: 'EXIT', positionId: 'a', solDelta: 0.007, inputs: null },
      { stage: 'fill', outcome: 'BOUGHT', positionId: 'b', solDelta: -0.0055, inputs: { feesSol: 0.0005 } },
    ];
    const s = computeJournalStats(rows, (id) => (id === 'a' ? 'CLOSED' : 'OPEN'));
    expect(s).toEqual({ seen: 3, rejectedByStage: { watch: 1 }, wouldBuy: 0, bought: 2, open: 1, closed: 1, netPnlSol: expect.closeTo(0.0015, 9), feesPaidSol: expect.closeTo(0.001, 9), winRate: 1 });
  });

  it('a real paper session: a bought and closed candidate shows up in the controller stats, matching the decision rows', async () => {
    await setAutoMode('PAPER');
    const before = autoSnipeController.getJournalStats();
    const { mint } = newPumpPool('HOT');
    const d = await autoSnipeController.submitCandidate({ mint, symbol: 'H3', source: 'TEST', amountUsd: 0.7, provenance: 'REAL_ONCHAIN' });
    expect(d.outcome, d.reason).toBe('BOUGHT');
    await executionCoordinator.closePosition(d.positionId!, 100, 'MANUAL');
    const after = autoSnipeController.getJournalStats();
    expect(after.seen - before.seen).toBe(1);
    expect(after.bought - before.bought).toBe(1);
    expect(after.closed - before.closed).toBe(1);
    const rows = workstationDb.loadDecisions({ mint });
    const delta = rows.reduce((a, r) => a + (r.solDelta ?? 0), 0);
    expect(after.netPnlSol - before.netPnlSol).toBeCloseTo(delta, 12);
    const fee = rows.find((r) => r.outcome === 'BOUGHT')!.inputs.feesSol;
    expect(after.feesPaidSol - before.feesPaidSol).toBeCloseTo(fee, 12);
  });
});
