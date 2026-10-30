import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installDom, removeDom, click } from './helpers/domApp';
import { TokenBoardView, type BoardData } from '../src/components/TokenBoard';

/**
 * R11-11: board rows were mouse-only (<tr onClick> with no tabIndex or key handler), and at 390 px the table's box was overflow-hidden,
 * so the AGE and NEXT EXIT columns were cut off with no scroll. Each row now has a real button for its token (Tab reaches it, Enter and
 * Space press it), and each table scrolls sideways inside its own box.
 */
const m = (c: string) => c.repeat(44);
const metrics = { elapsedMs: 1000, cumulativeNetInflowSol: 0.1, uniqueBuyers: 2, rawUniqueBuyers: 2, funderCoverage: 1, buySellRatio: 1, largestBuyerShare: 0.5, creatorSold: false, passingSignals: 1, tradeCount: 2, netInflowPer10s: [] };
const board: BoardData = {
  generatedAt: 1, executionMode: 'PAPER', wallet: { balanceSol: null, reserveSol: 0.015, rentLockedSol: null, spendableSol: null, solUsd: null },
  launches: [{ mint: m('L'), symbol: 'LNC', name: 'Launch', priceSol: 1e-8, priceUsd: null, curveProgressPct: 3, top10HoldersPct: null, creatorHoldingPct: null, mintRevoked: null, freezeRevoked: null, createdAgo: '5s' }],
  watching: [{ mint: m('W'), state: 'WATCHING', reason: null, metrics }],
  holding: [{ id: 'h', mint: m('H'), symbol: 'HLD', mode: 'PAPER', entryPriceSol: 1e-8, markPriceSol: 1e-8, markAgeMs: 1000, costSol: 0.01, pnlSol: 0, nextExit: null }],
};

describe('R11-11: board rows work from the keyboard and the tables scroll at phone width', () => {
  beforeEach(() => { installDom(390); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
  afterEach(async () => { await removeDom(); });

  for (const [tab, mint, label] of [['launches', m('L'), /\$LNC/], ['watching', m('W'), /WWWW/], ['holding', m('H'), /\$HLD/]] as const) {
    it(`${tab}: each row has a focusable button that selects its mint, and the table can scroll`, async () => {
      const onSelect = vi.fn();
      const el = document.createElement('div');
      document.body.appendChild(el);
      const root = createRoot(el);
      await act(async () => root.render(<TokenBoardView board={board} tab={tab} onTab={() => undefined} onSelect={onSelect} selected={null} />));
      const btn = el.querySelector('tbody button[data-testid="board-row-select"]') as HTMLButtonElement;
      expect(btn).not.toBeNull();
      expect(btn.getAttribute('type')).toBe('button');
      expect(btn.getAttribute('aria-label')).toMatch(label);
      btn.focus();
      expect(document.activeElement).toBe(btn);
      await click(btn);
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith(mint);
      const table = el.querySelector('table')!;
      expect(table.parentElement!.className).toMatch(/overflow-x-auto/);
      await act(async () => root.unmount());
    });
  }
});
