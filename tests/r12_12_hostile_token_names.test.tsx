import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, FakeServer } from './helpers/domApp';
import { displayName, displaySymbol, dollarSymbol, HIDDEN_CHAR_MARK, NAME_MAX_CHARS } from '../src/utils/displayName';
import { TokenBoardView, type BoardData } from '../src/components/TokenBoard';
import { panicOutcome } from '../src/utils/tradingCopy';

/**
 * R12-12: a creator-chosen name or symbol could impersonate other text. An RTL override made "SOL" display as "$LOS", a zero-width
 * joiner made "S‌OL" display as "$SOL", and a 5000-character name pushed the price, curve and Snipe columns out of view. Names and
 * symbols are now shown with every hidden or reordering character made visible, and cut to a fixed length.
 */
const RLO = '\u202E';
const ZWNJ = '\u200C';
const huge = 'PAPER LIVE KILL SWITCH ENGAGED '.repeat(170);

describe('R12-12: hostile token names are neutralised for display', () => {
  it('bidi overrides and zero-width characters are made visible; long text is cut', () => {
    expect(displaySymbol(`${RLO}LOS`)).toBe(`${HIDDEN_CHAR_MARK}LOS`);
    expect(dollarSymbol(`S${ZWNJ}OL`)).toBe(`$S${HIDDEN_CHAR_MARK}OL`);
    expect(displaySymbol('\u2066SOL\u2069\uFEFF')).not.toMatch(/[\u2066\u2069\uFEFF]/);
    const n = displayName(huge);
    expect(Array.from(n).length).toBe(NAME_MAX_CHARS);
    expect(n.endsWith('\u2026')).toBe(true);
    expect(displaySymbol('$BONK')).toBe('BONK');
    expect(displayName(null)).toBe('');
  });

  it('the board shows a hostile symbol neutralised and short', () => {
    const board: BoardData = {
      generatedAt: 1, executionMode: 'PAPER', wallet: { balanceSol: null, reserveSol: 0.015, rentLockedSol: null, spendableSol: null, solUsd: null },
      launches: [{ mint: 'So11111111111111111111111111111111111111112', symbol: `${RLO}LOS${huge}`, name: huge, priceSol: null, priceUsd: null, curveProgressPct: null, top10HoldersPct: null, creatorHoldingPct: null, mintRevoked: null, freezeRevoked: null, createdAgo: null }],
      watching: [], holding: [],
    };
    const html = renderToStaticMarkup(<TokenBoardView board={board} tab="launches" onTab={() => undefined} />);
    expect(html).not.toContain(RLO);
    expect(html).toContain(`$${HIDDEN_CHAR_MARK}LOS`);
    expect(html).not.toContain(huge.slice(0, 200));
  });

  it('a panic report names a still-open token neutralised', () => {
    const r = panicOutcome(true, 200, { success: false, data: { failed: [{ symbol: `S${ZWNJ}OL`, error: 'STILL_OPEN' }] } });
    expect(r.text).not.toContain(ZWNJ);
  });

  describe('in the real app', () => {
    let server: FakeServer;
    beforeEach(() => {
      installDom();
      server = { calls: [], routes: {}, killSwitchActive: false };
      installFakeServer(server);
      server.routes['/api/auth/session'] = () => ({ json: { success: true } });
      server.routes['/api/workstation/positions'] = () => ({ json: { success: true, positions: [
        { id: 'h1', mint: 'So11111111111111111111111111111111111111112', symbol: `S${ZWNJ}OL`, name: huge, tokenDecimals: 6, tokenQuantityRaw: '1', costBasisLamports: 1, currentValueSol: 0, status: 'OPEN', executionMode: 'PAPER', lastMarkTimestamp: Date.now() },
      ] } });
    });
    afterEach(async () => { await removeDom(); });

    it('Plug & Play positions show the symbol neutralised and never the raw name', async () => {
      await renderApp();
      await click(document.getElementById('btn-nav-plug-and-play'));
      await flush(10);
      await click([...document.querySelectorAll('button')].find((b) => /^Open Positions/.test((b.textContent || '').trim()))!);
      const text = document.body.innerHTML;
      expect(text).not.toContain(ZWNJ);
      expect(text).toContain(`$S${HIDDEN_CHAR_MARK}OL`);
      expect(text).not.toContain(huge.slice(0, 200));
    });
  });
});
