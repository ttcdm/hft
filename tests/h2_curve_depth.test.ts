import { describe, it, expect } from 'vitest';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { buildCurveDepth, spotPriceSol, postBuySpot, BUY_STEPS_PCT } from '../server/market/curveDepth';
import { TradeTape, TAPE_PER_MINT } from '../server/market/tradeTape';
import { curveFixture } from './fixtures/curve';
import { replay, wallet } from './fixtures/watch';

const quote = (state: ReturnType<typeof curveFixture>, lamports: number) =>
  PumpCurveService.calculateBuyQuote({ state, amountSol: lamports / 1e9, executionMode: 'PAPER', jitoTipSol: 0, priorityFeeLamports: 0 });

describe('H2: curve depth ladder uses the coordinator quote function', () => {
  const state = curveFixture();
  const depth = buildCurveDepth(state, { mode: 'PAPER' });

  it('the +5% rung is the smallest input whose fresh quote moves the spot price by 5%', () => {
    const spot = spotPriceSol(state);
    const rung = depth.buy.find((r) => r.upPct === 5)!;
    const lamports = Math.round(rung.solNeeded! * 1e9);
    // a fresh quote from the same function reaches the target at the rung and not one lamport below it
    expect(postBuySpot(state, quote(state, lamports))).toBeGreaterThanOrEqual(spot * 1.05);
    expect(postBuySpot(state, quote(state, lamports - 1))).toBeLessThan(spot * 1.05);
    // and the rung's tokens/fees are that quote's own numbers
    const q = quote(state, lamports);
    expect(rung.tokensOut).toBeCloseTo(Number(q.tokenAmountRaw) / 1e6, 6);
    expect(rung.feesSol).toBeCloseTo((q.protocolFeeLamports + q.creatorFeeLamports) / 1e9, 9);
    expect(rung.avgPriceSol).toBe(q.executionPriceSol);
  });

  it('SOL needed rises with the price move, and matches the constant-product closed form within fees', () => {
    const sols = depth.buy.map((r) => r.solNeeded!);
    expect(sols).toEqual([...sols].sort((a, b) => a - b));
    expect(depth.buy.map((r) => r.upPct)).toEqual([...BUY_STEPS_PCT]);
    // closed form: net SOL = vSol * (sqrt(1+x) - 1); gross = net / (1 - fee)
    const net = 30 * (Math.sqrt(1.05) - 1);
    expect(depth.buy[1].solNeeded!).toBeCloseTo(net / 0.99, 2);
  });

  it('sell rungs are the sell quote for 25/50/100% of the held tokens; no position means no sell ladder', () => {
    const held = 50_000_000_000n;
    const withPos = buildCurveDepth(state, { mode: 'PAPER', positionTokensRaw: held });
    expect(withPos.sell!.map((s) => s.sellPct)).toEqual([25, 50, 100]);
    const direct = PumpCurveService.calculateSellQuote({ state, tokenAmountRaw: held / 2n, executionMode: 'PAPER', jitoTipSol: 0, priorityFeeLamports: 0 });
    expect(withPos.sell![1].solReceived).toBeCloseTo(direct.expectedSolAmountLamports / 1e9, 9);
    expect(withPos.sell![2].solReceived!).toBeGreaterThan(withPos.sell![0].solReceived!);
    expect(depth.sell).toBeNull();
  });

  it('reports progress toward migration from real reserves, and a migrated curve has no ladder', () => {
    expect(depth.curveProgressPct).toBeCloseTo((4 / 85) * 100, 6);
    expect(depth.spotPriceSol).toBeCloseTo(spotPriceSol(state), 15);
    const done = buildCurveDepth(curveFixture({ complete: true }), { mode: 'PAPER', positionTokensRaw: 1n });
    expect(done.buy.every((r) => r.solNeeded === null)).toBe(true);
    expect(done.sell).toBeNull();
  });
});

describe('H2: trade tape', () => {
  const mint = 'MintTape1111111111111111111111111111111111';
  it('records decoded trades newest first with creator and own flags; empty means no data', () => {
    const creator = wallet(), me = wallet(), other = wallet();
    const tape = new TradeTape(() => creator, () => me);
    expect(tape.get(mint)).toEqual([]);
    for (const { trade, at } of replay(mint, 1_700_000_000_000, [[0, other, 'buy', 0.5], [1, me, 'buy', 0.005], [2, creator, 'sell', 0.1]])) tape.record(trade, at);
    const rows = tape.get(mint);
    expect(rows.map((r) => r.side)).toEqual(['SELL', 'BUY', 'BUY']);
    expect(rows[0]).toMatchObject({ creator: true, own: false, sol: 0.1 });
    expect(rows[1]).toMatchObject({ own: true, creator: false });
    expect(rows[2]).toMatchObject({ own: false, creator: false, sol: 0.5 });
    expect(rows[2].walletShort).toMatch(/^\w{4}…\w{4}$/);
  });

  it('ignores a repeated event and keeps only the latest 100 per mint', () => {
    const tape = new TradeTape();
    const steps = Array.from({ length: TAPE_PER_MINT + 20 }, (_, i): [number, string, 'buy', number] => [i, wallet(), 'buy', 0.01]);
    const events = replay(mint, 1_700_000_000_000, steps);
    for (const { trade, at } of events) tape.record(trade, at);
    tape.record(events[events.length - 1].trade, 0);
    expect(tape.get(mint, 500)).toHaveLength(TAPE_PER_MINT);
    expect(tape.get(mint, 1)[0].signature).toBe(events[events.length - 1].trade.signature);
  });
});
