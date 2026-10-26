import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { ExitEngine, exitRulesSummary } from '../server/exits/exitEngine';
import { ExitRulesNote, formatExitRules } from '../src/components/MemecoinSocialSniperModal';
import { startApp, scratchDir, type AppHandle } from './helpers/liveServer';

/**
 * Placeholder inventory A1 (patch set F): the sniper screen's "Auto TP / Auto SL" label showed sniper-config numbers that no exit used; it now shows ExitEngine's fixed rules, sent by GET /api/memecoins/config. Fails on the code before the fix.
 */

describe('A1: the sniper screen shows the exit rules the exit engine really applies', () => {
  const r = exitRulesSummary();
  const at = (pct: number, extra: Partial<Parameters<typeof ExitEngine.evaluate>[0]> = {}) =>
    ExitEngine.evaluate({ entryPriceSol: 1, currentPriceSol: 1 + pct / 100, entryTimestamp: 0, currentTimestamp: 1, ...extra });

  it('every number in the summary is the one evaluate() acts on', () => {
    expect(at(r.stopLossPct).reason).toBe('STOP_LOSS');
    expect(at(r.stopLossPct + 0.5).reason).not.toBe('STOP_LOSS');
    const tp1 = at(r.takeProfit[0].atPct);
    expect([tp1.reason, tp1.sellPercentage]).toEqual(['TAKE_PROFIT_1', r.takeProfit[0].sellPct]);
    const tp2 = at(r.takeProfit[1].atPct, { exitStage: 1 });
    expect([tp2.reason, tp2.sellPercentage]).toEqual(['TAKE_PROFIT_2', r.takeProfit[1].sellPct]);
    expect(at(r.trailingStartPct - 0.5).newTrailingStopSol).toBe(0);
    expect(at(r.trailingStartPct).newTrailingStopSol).toBeGreaterThan(0);
    const staleMs = r.staleAfterMinutes * 60_000;
    expect(at(r.staleBelowPct - 1, { currentTimestamp: staleMs }).reason).toBe('STALE_POSITION');
    expect(at(r.staleBelowPct - 1, { currentTimestamp: staleMs - 1 }).reason).toBe('HOLD');
  });

  it('the note renders those rules, and no longer the sniper config take-profit / stop-loss', () => {
    const html = renderToStaticMarkup(React.createElement(ExitRulesNote, { rules: r }));
    expect(html).toContain(formatExitRules(r));
    expect(html).toContain('stop -20%');
    expect(html).toContain('sell 33% at +30%');
    expect(html).not.toMatch(/Auto TP|Auto SL/);
    expect(renderToStaticMarkup(React.createElement(ExitRulesNote, { rules: null }))).toContain('not loaded');
  });

  describe('GET /api/memecoins/config', () => {
    let app: AppHandle;
    const dir = scratchDir('f-exit-rules-');
    beforeAll(async () => { app = await startApp(dir, {}); }, 90_000);
    afterAll(async () => { await app?.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

    it('carries exitRules equal to the exit engine summary', async () => {
      const cfg = await app.call('GET', '/api/memecoins/config');
      expect(cfg.status).toBe(200);
      expect(cfg.json.exitRules).toEqual(exitRulesSummary());
    });
  });
});
