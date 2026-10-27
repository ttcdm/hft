import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Keypair } from '@solana/web3.js';
import { workstationDb } from '../server/db/database';
import { executionCoordinator } from '../server/execution/coordinator';
import { walletTrader } from '../server/walletTrader';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { socialScanner } from '../server/socialScanner';
import { solPriceService } from '../server/market/solPriceService';
import { readPillState } from '../src/utils/pnlPill';
import { LiveOpenChip } from '../src/components/Header';

/**
 * R6-2 (haiku-attack 2026-10-26): a disarm sets the coordinator to PAPER, and getState then listed PAPER positions only, so the header
 * pill, the open count, Sniper holdings and Telegram /positions said there was no exposure while real LIVE positions were open.
 */
const now = Date.now();
const seed = (id: string, mode: 'LIVE' | 'PAPER', pnl: number) => workstationDb.savePosition({
  id, mint: Keypair.generate().publicKey.toBase58(), symbol: id.toUpperCase().slice(0, 6), name: id, tokenDecimals: 6, tokenQuantityRaw: '1000000000',
  entryPriceSol: 1e-7, currentPriceSol: 1.4e-7, currentValueSol: 0.0014, unrealizedPnLSol: pnl, costBasisLamports: 1_000_000, realizedPnLSol: 0, status: 'OPEN',
  venue: 'PUMP_BONDING_CURVE', executionMode: mode, entryTxSignature: `sig-${id}`, entryTimestamp: now, lastMarkTimestamp: now, recordUpdatedAt: now, updatedAt: now,
} as any);
const ids: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const id of ids.splice(0)) { const p = workstationDb.loadPositions().find((x) => x.id === id); if (p) workstationDb.savePosition({ ...p, status: 'CLOSED' } as any); }
});

describe('R6-2: open LIVE positions stay visible after a disarm', () => {
  it('in PAPER, getState lists the LIVE row (labelled) and reports it in liveOpen, apart from the paper totals', () => {
    vi.spyOn(solPriceService, 'lastKnownPrice').mockReturnValue(100);
    expect(executionCoordinator.getExecutionMode()).toBe('PAPER');
    seed('r62live', 'LIVE', 0.0004); seed('r62paper', 'PAPER', -0.0002); ids.push('r62live', 'r62paper');
    const s = walletTrader.getState();
    const live = s.activePositions.find((p) => p.id === 'r62live');
    expect(live?.executionMode).toBe('LIVE');
    expect(s.liveOpen?.count).toBe(1);
    const paper = s.activePositions.find((p) => p.id === 'r62paper')!;
    expect(s.liveOpen?.unrealizedPnLSol).toBeCloseTo(live!.unrealizedPnLSol as number, 6);
    expect(s.liveOpen?.unrealizedPnLUsd).toBeCloseTo((live!.unrealizedPnLSol as number) * 100, 2);
    // the paper totals do not take the real SOL in
    expect(s.totalUnrealizedPnLSol).toBeCloseTo(paper.unrealizedPnLSol as number, 6);
    expect(s.activePositionsCount).toBe(1);
    const pill = readPillState(JSON.parse(JSON.stringify(s)))!;
    expect(pill.live?.openCount).toBe(1);
    const html = renderToStaticMarkup(<LiveOpenChip live={pill.live} />);
    expect(html).toContain('LIVE 1 open');
    expect(html).toContain('today');
  });

  it('with no LIVE position open there is no LIVE chip', () => {
    expect(walletTrader.getState().liveOpen).toBeNull();
    expect(renderToStaticMarkup(<LiveOpenChip live={readPillState(walletTrader.getState())!.live} />)).toBe('');
  });

  it('Sniper holdings and Telegram /positions list the LIVE row, labelled, and total it apart', async () => {
    seed('r62live2', 'LIVE', 0.001); ids.push('r62live2');
    const rows = memecoinAggregator.getPositions();
    expect(rows.find((p) => p.id === 'r62live2')?.executionMode).toBe('LIVE');
    const r = await socialScanner.processTelegramCommand('/positions');
    expect(r.reply).toMatch(/\[LIVE, real SOL\] \$R62LIV/);
    expect(r.reply).toMatch(/Total Unrealized PnL \(LIVE, real SOL\)/);
  });
});
