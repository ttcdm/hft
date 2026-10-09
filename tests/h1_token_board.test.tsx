import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Keypair } from '@solana/web3.js';
import App from '../src/App';
import { TokenBoardView, WalletStrip, type BoardData } from '../src/components/TokenBoard';
import { buildBoard, nextExitFor } from '../server/board';
import { ExitEngine } from '../server/exits/exitEngine';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { executionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';
import { watchWindow } from '../server/signals/watchWindow';
import { solPriceService } from '../server/market/solPriceService';
import { newPumpPool } from './fixtures/auto';
import { replay, wallet } from './fixtures/watch';

const board: BoardData = {
  generatedAt: 1,
  executionMode: 'PAPER',
  wallet: { balanceSol: 0.0712, reserveSol: 0.015, rentLockedSol: null, spendableSol: 0.0562, solUsd: 148.2 },
  launches: [
    { mint: 'So11111111111111111111111111111111111111112', symbol: 'FRESH', name: 'Fresh', priceSol: 0.00000003, priceUsd: null, curveProgressPct: 4.2, top10HoldersPct: null, creatorHoldingPct: null, mintRevoked: true, freezeRevoked: true, createdAgo: 'On-Chain Verified' },
  ],
  watching: [
    { mint: 'Mint2222222222222222222222222222222222222222', state: 'HOT', reason: '4 strong signals', metrics: { elapsedMs: 30000, cumulativeNetInflowSol: 3.1, uniqueBuyers: 30, rawUniqueBuyers: 30, funderCoverage: 1, buySellRatio: 7.5, largestBuyerShare: 0.04, creatorSold: false, passingSignals: 4, tradeCount: 32, netInflowPer10s: [1, 1, 1.1] } },
    { mint: 'Mint3333333333333333333333333333333333333333', state: 'WATCHING', reason: null, metrics: { elapsedMs: 0, cumulativeNetInflowSol: 0, uniqueBuyers: 0, rawUniqueBuyers: 0, funderCoverage: 0, buySellRatio: null, largestBuyerShare: null, creatorSold: false, passingSignals: 0, tradeCount: 0, netInflowPer10s: [] } },
  ],
  holding: [
    { id: 'p1', mint: 'Mint4444444444444444444444444444444444444444', symbol: 'HOLD', mode: 'PAPER', entryPriceSol: 0.000001, markPriceSol: null, markAgeMs: null, costSol: 0.005, pnlSol: null, nextExit: { kind: 'STOP_LOSS', priceSol: 0.0000008 } },
  ],
};
const render = (tab: 'launches' | 'watching' | 'holding') => renderToStaticMarkup(<TokenBoardView board={board} tab={tab} onTab={() => undefined} />);

describe('H1: token board', () => {
  it('shows the three tabs with counts, and unknown values as an em dash, never a number', () => {
    const l = render('launches');
    expect(l).toContain('New launches');
    expect(l).toContain('Watching');
    expect(l).toContain('Holding');
    expect(l).toContain('$FRESH');
    expect(l).toContain('4.2%');
    // top10 and creator holding are unknown: two dashes in those cells, no 0.0%
    expect(l).not.toMatch(/0\.0%/);
    expect((l.match(/—/g) || []).length).toBeGreaterThanOrEqual(2);
    const w = render('watching');
    expect(w).toContain('HOT');
    expect(w).toContain('4.0%'); // largest buyer share
    expect(w).toContain('—'); // the empty watcher has no metrics yet
    const h = render('holding');
    expect(h).toContain('STOP LOSS');
    expect(h).toMatch(/—/); // mark unknown -> dash, PnL unknown -> dash
  });

  it('the wallet strip shows balance, reserve, rent locked, spendable (rent unknown is a dash)', () => {
    const html = renderToStaticMarkup(<WalletStrip wallet={board.wallet} mode="PAPER" />);
    expect(html).toContain('0.0712 SOL');
    expect(html).toContain('0.015 SOL');
    expect(html).toContain('0.0562 SOL');
    expect(html).toMatch(/Rent locked[\s\S]*—/);
    const none = renderToStaticMarkup(<WalletStrip wallet={{ balanceSol: null, reserveSol: 0.015, rentLockedSol: null, spendableSol: null, solUsd: null }} mode="PAPER" />);
    expect(none).not.toMatch(/0\.0000/);
  });

  it('the home page carries no BTC/ETH/NVDA/XAU/EUR-USD symbols or CEX balances', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('data-testid="token-board"'.replace('token-board', 'home-side'));
    for (const sym of ['BTC', 'ETH', 'NVDA', 'XAU', 'EUR/USD', 'DOGE', 'XRP']) expect(html, sym).not.toContain(sym);
    expect(html).not.toMatch(/Binance|Micro-Capital|165645/);
  });
});

describe('H1: board read model (real modules)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists only on-chain launches, with unknown holder data as null', () => {
    const { mint } = newPumpPool();
    const b = buildBoard();
    const row = b.launches.find((l) => l.mint === mint)!;
    expect(row).toBeTruthy();
    expect(row.top10HoldersPct).toBeNull();
    expect(row.creatorHoldingPct).toBeNull();
    // the built-in demo pools are not launches
    expect(b.launches.every((l) => memecoinAggregator.getPools().find((p) => p.contractAddress === l.mint)!.id.startsWith('pool-onchain-'))).toBe(true);
  });

  it('wallet: balance null stays null; spendable = balance - reserve; rent locked is unknown', () => {
    solPriceService.setPrice(150, 'TEST_FIXTURE');
    vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol').mockReturnValue(null);
    expect(buildBoard().wallet).toMatchObject({ balanceSol: null, spendableSol: null, rentLockedSol: null, reserveSol: 0.015 });
    vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol').mockReturnValue(0.5);
    vi.spyOn(executionCoordinator, 'getSpendableBankrollSol').mockReturnValue(0.485); // the coordinator's own number, passed through
    const w = buildBoard().wallet;
    expect(w.balanceSol).toBe(0.5);
    expect(w.spendableSol).toBe(0.485);
    expect(w.solUsd).toBe(150);
  });

  it('watching reflects the real watch window', () => {
    const mint = Keypair.generate().publicKey.toBase58();
    expect(watchWindow.watch(mint, wallet())).toBe(true);
    for (const { trade, at } of replay(mint, Date.now(), [[0, wallet(), 'buy', 0.5]])) watchWindow.onTrade(trade, at);
    const row = buildBoard().watching.find((w) => w.mint === mint)!;
    expect(row.state).toBe('WATCHING');
    expect(row.metrics.cumulativeNetInflowSol).toBeCloseTo(0.5, 9);
  });

  it('holding: a position row with its PnL and the next exit trigger from the ExitEngine constants', () => {
    const id = `h1-${Math.random().toString(36).slice(2, 8)}`;
    workstationDb.savePosition({
      id, mint: Keypair.generate().publicKey.toBase58(), symbol: 'HLD', name: 'H', tokenDecimals: 6, tokenQuantityRaw: '1000000',
      entryPriceSol: 1e-6, currentPriceSol: 1.1e-6, currentValueSol: 0.0055, costBasisLamports: 5_000_000, realizedPnLSol: 0, unrealizedPnLSol: 0.0005, status: 'OPEN',
      venue: 'PUMP_BONDING_CURVE', executionMode: 'PAPER', entryTxSignature: id, entryTimestamp: Date.now(), recordUpdatedAt: Date.now(), updatedAt: Date.now(), lastMarkTimestamp: Date.now(),
    } as any);
    const row = buildBoard().holding.find((h) => h.id === id)!;
    const stored = workstationDb.loadPositions().find((p) => p.id === id)!;
    expect(row.pnlSol).toBeCloseTo((stored.realizedPnLSol ?? 0) + (stored.unrealizedPnLSol ?? 0), 12); // the board adds nothing of its own
    expect(row.costSol).toBeCloseTo(0.005, 9);
    expect(row.nextExit?.kind).toBe('TAKE_PROFIT_1');
    expect(row.nextExit?.priceSol).toBeCloseTo(1e-6 * (1 + ExitEngine.TP1_TRIGGER_PCT / 100), 12);
  });

  it('nextExitFor: stop below the mark, TP1/TP2 by stage, the trailing stop once it exceeds the hard stop, nothing without an entry', () => {
    const base = { entryPriceSol: 1, currentPriceSol: 0.9, trailingStopSol: 0, exitStage: 0 };
    expect(nextExitFor(base)).toMatchObject({ kind: 'STOP_LOSS' });
    expect(nextExitFor({ ...base, currentPriceSol: 1.25 })).toMatchObject({ kind: 'TAKE_PROFIT_1' });
    expect(nextExitFor({ ...base, currentPriceSol: 1.55, exitStage: 1 })).toMatchObject({ kind: 'TAKE_PROFIT_2' });
    expect(nextExitFor({ ...base, currentPriceSol: 2, exitStage: 2, trailingStopSol: 1.7 })).toEqual({ kind: 'TRAILING_STOP', priceSol: 1.7 });
    expect(nextExitFor({ ...base, entryPriceSol: 0 })).toBeNull();
  });
});

import { CurvePanelView } from '../src/components/CurvePanel';
describe('H2: curve panel', () => {
  it('shows the ladder, the sell side only with a position, and honest empty states', () => {
    const curve = { spotPriceSol: 2.8e-8, priceUsd: 4.1e-6, curveProgressPct: 4.7, complete: false, note: null,
      buy: [{ upPct: 1, solNeeded: 0.1505, tokensOut: 5e6, feesSol: 0.0015 }, { upPct: 5, solNeeded: null, tokensOut: null, feesSol: null }], sell: null };
    const html = renderToStaticMarkup(<CurvePanelView mint="Mint1111111111111111111111111111111111111111" curve={curve} tape={{ source: 'NO_DATA', trades: [] }} error={null} />);
    expect(html).toContain('+1%');
    expect(html).toContain('0.1505');
    expect(html).toContain('4.7% to migration');
    expect(html).toContain('No open position');
    expect(html).toContain('No trades seen');
    expect(html).toMatch(/\+5%<\/td><td[^>]*>—/); // unknown rung is a dash
    expect(renderToStaticMarkup(<CurvePanelView mint={null} curve={null} tape={null} error={null} />)).toContain('Select a token');
    expect(renderToStaticMarkup(<CurvePanelView mint="M1111111111" curve={null} tape={null} error="503 UNAVAILABLE" />)).toContain('No market data');
  });
});
