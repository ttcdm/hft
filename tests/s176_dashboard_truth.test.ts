import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { executionCoordinator } from '../server/execution/coordinator';
import { PumpFunService } from '../server/pumpfunService';
import { socialScanner } from '../server/socialScanner';
import { onChainPoolStats, CURVE_INITIAL_REAL_TOKENS } from '../server/market/poolStats';
import { OperatorSnipeSchema } from '../server/execution/tradeInputs';
import { buildPoolSnipeRequest } from '../src/utils/poolSnipe';
import { formatPctChange, calloutSnipeBlock, formatCalloutMcap, getTokenExternalLinks } from '../src/utils/tokenLinks';
import { autoSnipeController } from '../server/auto/controller';
import { newPumpPool } from './fixtures/auto';
import { pumpCoin, jsonResponse } from './fixtures/socialFeeds';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); memecoinAggregator.setConfluenceGating(true); });

describe('S176 #1: a pool row snipes by its mint, not through a signal id the server never issued', () => {
  it('the request the row builds passes the trade schema and reaches executeTrade for that mint; the old signal route could not find the id', async () => {
    const { mint, pool } = newPumpPool('NONE');
    const body = buildPoolSnipeRequest(pool, 0.01, { jitoTipSol: 0.005, maxSlippagePct: 6 });
    const parsed = OperatorSnipeSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    memecoinAggregator.setConfluenceGating(false);
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('PAPER');
    const trade = vi.spyOn(executionCoordinator, 'executeTrade').mockResolvedValue({ success: true, positionId: 'p1', txHash: 'PAPER-1' } as any);
    const res = await memecoinAggregator.executeSnipe({ ...(parsed as any).data, operatorAmountSol: (parsed as any).data.amountSol, provenance: 'REAL_ONCHAIN', signalTimestamp: Date.now() });
    expect(res.message ?? '').not.toMatch(/Signal not found/);
    expect(trade.mock.calls[0]?.[0].mint).toBe(mint);
    // the id the old button invented is not in the server's list, which is why every click answered 404
    expect(socialScanner.getSignals().some((s) => s.id === `sig-agg-${pool.id}`)).toBe(false);
  });
});

describe('S176 #2: one pool per mint', () => {
  it('getPools returns a mint once even if two entries were created for it', () => {
    const { mint, pool } = newPumpPool('NONE');
    (memecoinAggregator as any).pools.unshift({ ...pool, id: 'pool-dup', name: 'dup' });
    expect(memecoinAggregator.getPools().filter((p) => p.contractAddress === mint)).toHaveLength(1);
  });
  it('a snipe whose curve read finishes after the feed created the pool does not add a second entry', async () => {
    const { mint } = newPumpPool('NONE');
    const before = memecoinAggregator.getPools().filter((p) => p.contractAddress === mint).length;
    memecoinAggregator.setConfluenceGating(false);
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('PAPER');
    vi.spyOn(executionCoordinator, 'executeTrade').mockResolvedValue({ success: false, error: 'stub' } as any);
    await memecoinAggregator.executeSnipe({ contractAddress: mint, amountUsd: 5, provenance: 'REAL_ONCHAIN' });
    expect(memecoinAggregator.getPools().filter((p) => p.contractAddress === mint)).toHaveLength(before);
  });
});

describe('S176 #3: callout market cap and multiple are measured or unknown', () => {
  async function sync(coin: Record<string, any>) {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const svc = new PumpFunService();
    await vi.waitFor(() => expect((svc as any).isPolling).toBe(false));
    vi.restoreAllMocks();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) =>
      String(input).includes('frontend-api-v3.pump.fun') ? jsonResponse([pumpCoin(coin)]) : jsonResponse([]));
    await svc.syncRealWorldData({ evaluateTriggers: false });
    return { svc, fetchMock };
  }
  it('the callout mcap is the mcap first seen, not a fixed $5,000, and the multiple is measured against it', async () => {
    const { svc, fetchMock } = await sync({ usd_market_cap: 80_000 });
    let c = svc.getHotCallouts()[0];
    expect(c.token.marketCapAtCalloutUsd).toBe(80_000);
    expect(c.token.currentMultiple).toBe(1);
    fetchMock.mockImplementation(async (input: any) => String(input).includes('frontend-api-v3.pump.fun') ? jsonResponse([pumpCoin({ usd_market_cap: 160_000 })]) : jsonResponse([]));
    await svc.syncRealWorldData({ evaluateTriggers: false });
    c = svc.getHotCallouts()[0];
    expect(c.token.marketCapAtCalloutUsd).toBe(80_000);
    expect(c.token.currentMultiple).toBe(2);
  });
  it('a feed with no market cap gives unknown and no multiple', async () => {
    const { svc } = await sync({ usd_market_cap: undefined, market_cap: undefined });
    const c = svc.getHotCallouts()[0];
    expect(c.token.marketCapAtCalloutUsd).toBeNull();
    expect(c.token.currentMultiple).toBeNull();
    expect(formatCalloutMcap(c.token.marketCapAtCalloutUsd)).toBe('unknown');
  });
  it('MIGRATED comes only from the feed\'s complete flag, and says so in the note', async () => {
    const live = (await sync({ complete: false, real_token_reserves: 100_000_000_000_000 })).svc.getHotCallouts()[0];
    expect(live.token.complete).toBe(false);
    expect(live.token.bondingCurveProgress).toBeLessThan(100);
    const done = (await sync({ complete: true })).svc.getHotCallouts()[0];
    expect(done.token.complete).toBe(true);
    expect(done.token.bondingCurveProgress).toBe(100);
    expect(done.calloutNote).toMatch(/MIGRATED/);
    expect(done.calloutNote).not.toMatch(/IMMINENT/);
  });
  it('mainnet callouts are not snipeable unless the cluster is mainnet', () => {
    expect(calloutSnipeBlock('devnet')).toMatch(/Mainnet token/);
    expect(calloutSnipeBlock(null)).toMatch(/unknown cluster/);
    expect(calloutSnipeBlock('mainnet-beta')).toBeNull();
  });
});

describe('S176 #4: links, authorities and curve progress', () => {
  it('on devnet the mainnet-only sites are flagged, on mainnet they are not, the explorer stays', () => {
    const dev = getTokenExternalLinks({ mintOrCa: Keypair.generate().publicKey.toBase58(), symbol: 'X', cluster: 'devnet' });
    for (const id of ['dexscreener', 'pumpfun', 'gmgn', 'birdeye'] as const) expect(dev.find((l) => l.id === id)!.mainnetOnly).toBe(true);
    expect(dev.find((l) => l.id === 'solscan')!.mainnetOnly).toBeUndefined();
    expect(getTokenExternalLinks({ mintOrCa: 'a', symbol: 'X', cluster: 'unknown' }).find((l) => l.id === 'dexscreener')!.mainnetOnly).toBe(true);
    expect(getTokenExternalLinks({ mintOrCa: 'a', symbol: 'X', cluster: 'mainnet-beta' }).find((l) => l.id === 'dexscreener')!.mainnetOnly).toBeUndefined();
  });

  it('mint and freeze authority are read from the chain (one batched call) and a missing mint stays unknown', async () => {
    const { mint, pool } = newPumpPool('NONE');
    const missing = newPumpPool('NONE');
    expect(pool.authoritiesVerified).toBe(false);
    const mintData = Buffer.alloc(82);
    mintData.writeUInt32LE(0, 0);       // mint authority: none
    mintData.writeUInt32LE(1, 46);      // freeze authority: present
    const getMultipleAccountsInfo = vi.fn(async (keys: any[]) => keys.map((k) => (k.toBase58() === mint ? { data: mintData } : null)));
    vi.spyOn(executionCoordinator, 'getConnection').mockReturnValue({ getMultipleAccountsInfo } as any);
    (memecoinAggregator as any).authorityRetryAt.clear();
    (memecoinAggregator as any).authorityBackoffUntil = 0;
    await memecoinAggregator.verifyPoolAuthorities();
    expect(getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
    expect(pool.authoritiesVerified).toBe(true);
    expect(pool.isMintRevoked).toBe(true);
    expect(pool.isFreezeRevoked).toBe(false);
    expect(missing.pool.authoritiesVerified).toBe(false); // not on this cluster: unknown, not guessed
    await memecoinAggregator.verifyPoolAuthorities();      // inside the one-minute wait: no new read for the missing mint
    expect(getMultipleAccountsInfo).toHaveBeenCalledTimes(1); // the unanswered mints are all waiting, so no second call
  });

  it('an RPC failure backs the verifier off instead of retrying every tick', async () => {
    newPumpPool('NONE');
    const getMultipleAccountsInfo = vi.fn(async () => { throw new Error('429'); });
    vi.spyOn(executionCoordinator, 'getConnection').mockReturnValue({ getMultipleAccountsInfo } as any);
    (memecoinAggregator as any).authorityRetryAt.clear();
    (memecoinAggregator as any).authorityBackoffUntil = 0;
    await memecoinAggregator.verifyPoolAuthorities();
    await memecoinAggregator.verifyPoolAuthorities();
    expect(getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
  });

  it('curve progress is the share of curve tokens sold (pump.fun\'s bar), not SOL over 85', () => {
    const mint = Keypair.generate().publicKey.toBase58();
    onChainPoolStats.track(mint, { insiders: [], supplyRaw: 1_000_000_000_000_000n, createPriceSol: 3e-8, realTokenReserves: CURVE_INITIAL_REAL_TOKENS });
    const half = CURVE_INITIAL_REAL_TOKENS / 2n;
    onChainPoolStats.record({ mint, isBuy: true, user: 'u', solAmountLamports: 21_000_000_000n, tokenAmount: half, virtualSolReserves: 51_000_000_000n, virtualTokenReserves: 1_073_000_000_000_000n - half, realSolReserves: 21_000_000_000n, realTokenReserves: CURVE_INITIAL_REAL_TOKENS - half, timestamp: 1, slot: 1, signature: 's' } as any, Date.now());
    const m = onChainPoolStats.get(mint)!;
    expect(m.curveProgressPct).toBeCloseTo(50, 1); // SOL over 85 would say about 24.7
  });
});

describe('S176 #5: small numbers', () => {
  it('formats without exponents or float residue', () => {
    expect(formatPctChange(9.999998606957661e-8)).toBe('0.00%');
    expect(formatPctChange(-9.99e-8)).toBe('0.00%');
    expect(formatPctChange(31.21242519866727)).toBe('+31.21%');
    expect(formatPctChange(-4.5)).toBe('-4.50%');
    expect(formatPctChange(null)).toBe('—');
    expect(formatPctChange(NaN)).toBe('—');
  });
});

describe('S176 #6: the Auto panel status says whether the server env allows auto', () => {
  it('envEnabled follows AUTO_SNIPE_ENABLED', () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', '');
    expect(autoSnipeController.getStatus().envEnabled).toBe(false);
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    expect(autoSnipeController.getStatus().envEnabled).toBe(true);
  });
});
