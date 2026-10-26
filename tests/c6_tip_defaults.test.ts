import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { executionCoordinator } from '../server/execution/coordinator';
import { executionConfig } from '../server/solana/executionConfig';
import { solPriceService } from '../server/market/solPriceService';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { OperatorSnipeSchema, CalloutSnipeSchema } from '../server/execution/tradeInputs';
import { MINT_A } from './fixtures/socialFeeds';

describe('C6: one source for Jito tip defaults', () => {
  beforeEach(() => {
    memecoinAggregator.setConfluenceGating(false); // C2: gating is on by default; this test is about something else
  });
  afterEach(() => vi.restoreAllMocks());

  it('executeSnipe with no operator tip passes NO explicit tip to the coordinator', async () => {
    solPriceService.setPrice(150, 'TEST');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('PAPER');
    const exec = vi.spyOn(executionCoordinator, 'executeTrade').mockResolvedValue({ success: false, error: 'stub' } as any);
    await memecoinAggregator.executeSnipe({ contractAddress: MINT_A, amountUsd: 5 });
    expect(exec).toHaveBeenCalled();
    expect(exec.mock.calls[0][0].jitoTipSol).toBeUndefined();
  });

  it('an explicit operator tip is still forwarded (and bounded later by the resolver)', async () => {
    solPriceService.setPrice(150, 'TEST');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('PAPER');
    const exec = vi.spyOn(executionCoordinator, 'executeTrade').mockResolvedValue({ success: false, error: 'stub' } as any);
    await memecoinAggregator.executeSnipe({ contractAddress: MINT_A, amountUsd: 5, jitoTipSol: 0.003 });
    expect(exec.mock.calls[0][0].jitoTipSol).toBe(0.003);
  });

  it('the paper path asks the resolver with no explicit tip and quotes the resolved tip', async () => {
    solPriceService.setPrice(150, 'TEST');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('PAPER');
    const resolver = vi.spyOn(executionConfig, 'resolveDynamicJitoTip');
    await executionCoordinator.executeTrade({
      mint: MINT_A, symbol: 'T', name: 'T', amountSol: 0.02, currentPriceSol: 0.0000001, slippageBps: 800, liquidityUsd: 50000,
    } as any).catch(() => undefined);
    expect(resolver).toHaveBeenCalled();
    expect(resolver.mock.calls[0][0].explicitTipSol).toBeUndefined();
  });

  it('request schemas no longer inject a tip default', () => {
    expect(OperatorSnipeSchema.parse({ contractAddress: MINT_A, amountUsd: 5 }).jitoTipSol).toBeUndefined();
    expect(CalloutSnipeSchema.parse({ calloutId: 'c1' }).jitoTipSol).toBeUndefined();
  });

  it('quote builders fall back to the configured default tip, not a literal', () => {
    expect(executionConfig.getConfig().defaultJitoTipSol).toBeGreaterThan(0);
    const src = fs.readFileSync('server/solana/pumpCurve.ts', 'utf8');
    expect(src).not.toMatch(/jitoTipSol\w*\s*\?\?\s*0\.00\d/);
    expect(typeof PumpCurveService.calculateBuyQuote).toBe('function');
  });

  it('server code has no hard-coded tip literals (0.002 / 0.005) outside executionConfig', () => {
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const files = [...walk('server').filter((f) => f.endsWith('.ts')), 'server.ts'].filter(
      (f) => !f.endsWith('unitTestCases.ts') && !f.endsWith('executionConfig.ts')
    );
    const offenders: string[] = [];
    for (const f of files) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/tip/i.test(code) && /\b0\.00[25]\b/.test(code)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('README tip default matches the code', () => {
    const readme = fs.readFileSync('README.md', 'utf8');
    expect(readme).not.toMatch(/DEFAULT_JITO_TIP_SOL[^\n]*0\.005/);
    expect(readme).toContain('0.00018');
  });
});
