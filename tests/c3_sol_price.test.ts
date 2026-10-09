import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SolPriceService, SolPriceUnavailableError, solPriceService } from '../server/market/solPriceService';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { executionCoordinator } from '../server/execution/coordinator';
import { HardenedRiskEngine } from '../server/risk/riskEngine';
import { PaperExecutionEngine } from '../server/execution/paperEngine';
import { MINT_A } from './fixtures/socialFeeds';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

describe('C3: single SOL/USD price service', () => {
  afterEach(() => vi.restoreAllMocks());

  it('has no price until one is read, and no numeric fallback', () => {
    const s = new SolPriceService();
    expect(s.getPrice()).toEqual({ usd: null, ageMs: null, stale: true, source: null });
    expect(() => s.requireFreshPrice()).toThrow(SolPriceUnavailableError);
    expect(s.lastKnownPrice()).toBeNull();
  });

  it('goes stale after maxAgeMs: LIVE throws, PAPER still sees the last known price flagged stale', () => {
    const s = new SolPriceService(1000);
    s.setPrice(200, 'TEST', Date.now() - 5000);
    expect(s.getPrice().stale).toBe(true);
    expect(() => s.requireFreshPrice()).toThrow(/SOL_PRICE_UNAVAILABLE/);
    expect(s.lastKnownPrice()).toBe(200);
    s.setPrice(201, 'TEST');
    expect(s.requireFreshPrice()).toBe(201);
  });

  it('refresh cascades Binance -> Coinbase -> CoinGecko and rejects non-positive or junk values', async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u: any) => {
      const url = String(u);
      calls.push(url);
      if (url.includes('binance')) return json({ price: '0' });
      if (url.includes('coinbase')) return json({ data: { amount: 'abc' } });
      return json({ solana: { usd: 171.5 } });
    });
    const s = new SolPriceService();
    const r = await s.refresh();
    expect(r.usd).toBe(171.5);
    expect(r.source).toBe('COINGECKO');
    expect(calls).toHaveLength(3);
  });

  it('refresh never throws when every source is down and keeps the previous price', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const s = new SolPriceService();
    s.setPrice(123, 'TEST');
    await expect(s.refresh()).resolves.toMatchObject({ usd: 123 });
  });

  it('concurrent refreshes share one request set', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ price: '160' }));
    const s = new SolPriceService();
    await Promise.all([s.refresh(), s.refresh(), s.refresh()]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a stale or missing price rejects a LIVE snipe (fail closed) and a missing one rejects a PAPER snipe', async () => {
    const exec = vi.spyOn(executionCoordinator, 'executeTrade');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    solPriceService.setPrice(150, 'TEST', Date.now() - 10 * 60_000);
    const live = await memecoinAggregator.executeSnipe({ contractAddress: MINT_A, amountUsd: 5 });
    expect(live.success).toBe(false);
    expect(live.message).toContain('SOL_PRICE_UNAVAILABLE');

    vi.mocked(executionCoordinator.getExecutionMode).mockReturnValue('PAPER');
    solPriceService.reset();
    const paper = await memecoinAggregator.executeSnipe({ contractAddress: MINT_A, amountUsd: 5 });
    expect(paper.success).toBe(false);
    expect(paper.message).toContain('SOL_PRICE_UNAVAILABLE');
    expect(exec).not.toHaveBeenCalled();
  });

  it('the risk engine derives the daily-loss SOL cap from the live price unless one is pinned', () => {
    const r = new HardenedRiskEngine();
    solPriceService.setPrice(100, 'TEST');
    const a = r.effectiveMaxDailyLossSol();
    solPriceService.setPrice(200, 'TEST');
    expect(r.effectiveMaxDailyLossSol()).toBeCloseTo(a / 2, 10);
    r.updateLimits({ maxDailyLossSol: 0.02 });
    expect(r.effectiveMaxDailyLossSol()).toBe(0.02);
  });

  it('paper impact is unbounded (fail closed) with no SOL price', () => {
    solPriceService.reset();
    expect(PaperExecutionEngine.estimateImpactBps(0.01, 15000)).toBe(Infinity);
    expect(PaperExecutionEngine.estimateImpactBps(0.01, 15000, 150)).toBeLessThan(600);
  });

  it('server/ has no SOL price literals and no solPriceUsd assignment outside the service', () => {
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const files = [...walk('server').filter((f) => f.endsWith('.ts')), 'server.ts'].filter(
      (f) => !f.endsWith('solPriceService.ts') && !f.endsWith('unitTestCases.ts') // unitTestCases is a self-contained demo suite (see PLACEHOLDER-AUDIT)
    );
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      src.split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/\b(142\.2|145\.0|145|185)\b/.test(code) && /sol|price|usd/i.test(code)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
        if (/^\s*(this\.)?solPriceUsd\s*=[^=]/.test(code)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
