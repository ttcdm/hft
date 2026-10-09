import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { PumpFeedListener, CREATOR_RISK_TIMEOUT_MS } from '../server/solana/pumpFeedListener';
import { curveVelocityEvaluator } from '../server/signals/curveVelocityEvaluator';
import { creatorRiskScorer } from '../server/signals/creatorRiskScorer';
import { ConfluenceEngine } from '../server/signals/confluenceEngine';
import { memecoinAggregator } from '../server/memecoinAggregator';

const mint = Keypair.generate().publicKey;
const creator = Keypair.generate().publicKey;
const trader = Keypair.generate().publicKey;

// A fake connection that records the onLogs callback so a log fixture can be replayed through the real listener.
function fakeConn() {
  let cb: ((logs: any, ctx: any) => void) | null = null;
  const conn: any = {
    onLogs: (_program: PublicKey, fn: any) => {
      cb = fn;
      return 7;
    },
    removeOnLogsListener: async () => undefined,
    getSignaturesForAddress: async () => [],
  };
  return { conn, replay: (logs: string[], slot: number, sig = `sig${slot}`) => cb!({ err: null, logs, signature: sig }, { slot }) };
}

const tradeLog = (sol: number, isBuy: boolean, realSol: number) =>
  PumpFeedListener.encodeTradeEventLog({
    mint, solAmountLamports: BigInt(Math.round(sol * 1e9)), tokenAmount: 1_000_000n, isBuy, user: trader,
    timestampSec: Math.floor(Date.now() / 1000), virtualSolReserves: 40_000_000_000n, virtualTokenReserves: 900_000_000_000_000n,
    realSolReserves: BigInt(Math.round(realSol * 1e9)), realTokenReserves: 700_000_000_000_000n,
  });

describe('C2: TradeEvent decoding and real signals', () => {
  beforeEach(() => curveVelocityEvaluator.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    creatorRiskScorer.clearCache();
    curveVelocityEvaluator.clear();
  });

  it('decodes a TradeEvent log (fields round-trip)', () => {
    const l = new PumpFeedListener(fakeConn().conn);
    const [t] = l.parseTradeLogs({ err: null, signature: 's', logs: ['Program log: x', tradeLog(1.5, true, 12)] } as any, { slot: 55 });
    expect(t.mint).toBe(mint.toBase58());
    expect(t.user).toBe(trader.toBase58());
    expect(t.isBuy).toBe(true);
    expect(Number(t.solAmountLamports) / 1e9).toBe(1.5);
    expect(Number(t.realSolReserves) / 1e9).toBe(12);
    expect(t.slot).toBe(55);
    l.destroy();
  });

  it('ignores failed transactions, create events and truncated data', () => {
    const l = new PumpFeedListener(fakeConn().conn);
    const good = tradeLog(1, true, 5);
    expect(l.parseTradeLogs({ err: { InstructionError: 1 }, signature: 's', logs: [good] } as any)).toEqual([]);
    expect(l.parseTradeLogs({ err: null, signature: 's', logs: [PumpFeedListener.encodeCreateEventLog({ name: 'a', symbol: 'b', uri: 'c', mint, creator })] } as any)).toEqual([]);
    expect(l.parseTradeLogs({ err: null, signature: 's', logs: ['Program data: AAAA'] } as any)).toEqual([]);
    l.destroy();
  });

  it('log-fixture replay through the real listener gives non-zero velocity', async () => {
    const { conn, replay } = fakeConn();
    const l = new PumpFeedListener(conn);
    await l.start();
    expect(curveVelocityEvaluator.hasData(mint.toBase58())).toBe(false);
    const seen: string[] = [];
    l.on('trade_event', (t) => seen.push(t.mint));
    for (let i = 0; i < 6; i++) replay([tradeLog(2, true, 10 + i * 2)], 100 + i);
    const m = curveVelocityEvaluator.getMetrics(mint.toBase58());
    expect(seen).toHaveLength(6);
    expect(m.volume10sSol).toBeGreaterThan(0);
    expect(m.buyVolume10sSol).toBeGreaterThan(0);
    expect(m.velocityScore).toBeGreaterThan(0);
    expect(l.getTelemetry().tradesParsed).toBe(6);
    l.destroy();
  });

  it('confluence: no measured velocity scores 0 curve points however far along the curve is; replayed flow scores', async () => {
    const base = {
      mint: mint.toBase58(), priceChange5mPct: 20, liquidityUsd: 40000, top10HoldersPct: 12, bondingCurveProgress: 97,
      buys5m: 60, sells5m: 20, devHoldingPct: 0, hasVerifiedSocialCall: false, socialCallCount: 0,
    };
    const without = ConfluenceEngine.calculate(base);
    expect(without.bondingCurveVelocityScore).toBe(0);
    expect(without.explanation).toContain('velocity');

    const { conn, replay } = fakeConn();
    const l = new PumpFeedListener(conn);
    await l.start();
    for (let i = 0; i < 6; i++) replay([tradeLog(2, true, 10 + i * 2)], 100 + i);
    const withFlow = ConfluenceEngine.calculate(base);
    expect(withFlow.bondingCurveVelocityScore).toBeGreaterThan(0);
    expect(withFlow.compositeScore).toBeGreaterThan(without.compositeScore);
    l.destroy();
  });

  it('creator lookup on a create event is capped at 300ms, keeps running, and a cached report then scores', async () => {
    vi.useFakeTimers();
    const conn = fakeConn().conn;
    let release: (v: any[]) => void = () => undefined;
    conn.getSignaturesForAddress = () => new Promise((res) => { release = res; });
    const l = new PumpFeedListener(conn);
    const event = l.parseLogs({ err: null, signature: 'c1', logs: [PumpFeedListener.encodeCreateEventLog({ name: 'n', symbol: 's', uri: 'u', mint, creator })] } as any, { slot: 1 })!;
    const pending = l.scoreCreator(event);
    await vi.advanceTimersByTimeAsync(CREATOR_RISK_TIMEOUT_MS);
    expect(await pending).toBe(false); // gave up waiting
    expect(creatorRiskScorer.getCachedReport(creator.toBase58())).toBeUndefined();
    expect(l.getCreatorForMint(mint.toBase58())).toBe(creator.toBase58());

    // the lookup finishes later: a seasoned wallet's history lands in the cache
    const nowSec = Math.floor(Date.now() / 1000);
    release(Array.from({ length: 40 }, (_, i) => ({ signature: `s${i}`, slot: i, err: null, memo: null, blockTime: nowSec - 86400 * 90 + i * 3600 })));
    await vi.advanceTimersByTimeAsync(1);
    const cached = creatorRiskScorer.getCachedReport(creator.toBase58());
    expect(cached).toBeDefined();

    const input = { mint: mint.toBase58(), creatorAddress: creator.toBase58(), priceChange5mPct: null, liquidityUsd: null, top10HoldersPct: null, bondingCurveProgress: 10, buys5m: null, sells5m: null, devHoldingPct: null, hasVerifiedSocialCall: false, socialCallCount: 0 };
    expect(ConfluenceEngine.calculate(input).creatorRiskScore).toBe(cached!.confluenceScore);
    l.destroy();
  });

  it('a creator lookup that errors earns 0 creator-risk points and is not cached as a report', async () => {
    const conn = fakeConn().conn;
    conn.getSignaturesForAddress = async () => { throw new Error('rpc down'); };
    const report = await creatorRiskScorer.evaluateCreator(conn, creator);
    expect(report.confluenceScore).toBe(0);
    expect(report.riskFlags).toContain('RPC_HISTORY_QUERY_FAILED');
    expect(creatorRiskScorer.getCachedReport(creator.toBase58())).toBeUndefined();
  });

  it('the aggregator no longer infers a "social call" from trending rank or volume, and unknown metrics are null', () => {
    const pool: any = {
      id: 'p', contractAddress: Keypair.generate().publicKey.toBase58(), symbol: 'X', name: 'X',
      trendingRank: 1, volume5mUsd: 90_000, bondingCurveProgress: 99, // buys5m / sells5m / liquidity / priceChange unknown
    };
    const b = memecoinAggregator.evaluateTokenConfluence(pool).breakdown;
    expect(b.socialSignalScore).toBe(0);
    expect(b.compositeScore).toBe(0);
    expect(b.explanation).toMatch(/missing data/);
  });

  it('confluence gating is ON by default in a fresh aggregator', async () => {
    vi.resetModules();
    const fresh = await import('../server/memecoinAggregator');
    expect(fresh.memecoinAggregator.getConfluenceGating()).toBe(true);
  });
});
