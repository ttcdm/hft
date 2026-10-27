import { describe, it, expect } from 'vitest';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { CURVE_INITIAL_REAL_TOKENS } from '../server/market/poolStats';
import { curveFixture, devnetCurveFixture, STANDARD_CURVE, DEVNET_CURVE, curveIsConsistent } from './fixtures/curve';
import fixture from './fixtures/devnet_buy_5tVXiM.json';

/**
 * R3-4 (haiku 2026-10-26): the test curve (30 SOL / 1.073e15 virtual) carried real SOL 4 at a fresh token reserve, which no curve can hold, and
 * nothing checked tokens-out against chain. The real devnet buy 5tVXiM got 9,540,846,041,122 raw tokens for 9,876,542 lamports into the curve,
 * which a 30 SOL curve prices at about 0.32M tokens: the devnet curve starts at about 1 SOL virtual.
 */
const CURVE_ATA_INDEX = 7; // the curve's token account (owner 5Mwb9...), pre and post token balances
const CURVE_INDEX = 6; // the bonding curve account itself
const TOKENS_OUT_RAW = 9_540_846_041_122n;

const tokenBalance = (list: typeof fixture.preTokenBalances, i: number) => BigInt(list.find((b) => b.accountIndex === i)!.uiTokenAmount.amount);

const quote = (state: ReturnType<typeof curveFixture>, lamports: number) =>
  PumpCurveService.calculateBuyQuote({ state, amountSol: lamports / 1e9, executionMode: 'PAPER', jitoTipSol: 0, priorityFeeLamports: 0 });

describe('R3-4: the curve fixtures are internally consistent', () => {
  it('the standard fixture is a fresh 30 SOL / 1.073e15 curve: real reserves follow from the virtual ones', () => {
    const s = curveFixture();
    expect(curveIsConsistent(s, STANDARD_CURVE)).toBe(true);
    expect(s.realSolReserves).toBe(s.virtualSolReserves - STANDARD_CURVE.initialVirtualSol);
    expect(s.realTokenReserves).toBe(CURVE_INITIAL_REAL_TOKENS);
  });

  it('the devnet fixture is consistent with a 1 SOL initial virtual reserve', () => {
    expect(curveIsConsistent(devnetCurveFixture(), DEVNET_CURVE)).toBe(true);
  });
});

describe('R3-4: tokens-out against the real devnet buy 5tVXiM', () => {
  it('the fixture spent 10,000,000 lamports and the curve received 9,876,542 (the order net of a 1.25% fee)', () => {
    expect(fixture.postBalances[CURVE_INDEX] - fixture.preBalances[CURVE_INDEX]).toBe(9_876_542);
    expect(tokenBalance(fixture.preTokenBalances, CURVE_ATA_INDEX) - tokenBalance(fixture.postTokenBalances, CURVE_ATA_INDEX)).toBe(TOKENS_OUT_RAW);
  });

  it('the production quote, over reserves rebuilt from the pre-trade curve token account, gives the tokens the chain gave (within 1e-6)', () => {
    const state = devnetCurveFixture({ curveAtaTokensRaw: tokenBalance(fixture.preTokenBalances, CURVE_ATA_INDEX), protocolFeeBps: 95, creatorFeeBps: 30 });
    const q = quote(state, 10_000_000);
    const got = BigInt(q.tokenAmountRaw);
    const rel = Math.abs(Number(got - TOKENS_OUT_RAW)) / Number(TOKENS_OUT_RAW);
    expect(rel).toBeLessThan(1e-6);
    // The rebuilt real SOL sits under the curve account's lamports by a rent-exempt minimum (about 1.5M lamports), as it must
    const rent = fixture.preBalances[CURVE_INDEX] - Number(state.realSolReserves);
    expect(rent).toBeGreaterThan(1_000_000);
    expect(rent).toBeLessThan(2_500_000);
  });

  it('the 30 SOL standard constants would have priced the same buy about 30x short, so they are wrong for devnet', () => {
    const ata = tokenBalance(fixture.preTokenBalances, CURVE_ATA_INDEX);
    const realTokens = ata - (STANDARD_CURVE.tokenTotalSupply - STANDARD_CURVE.initialRealTokens);
    const vT = realTokens + (STANDARD_CURVE.initialVirtualTokens - STANDARD_CURVE.initialRealTokens);
    const vS = (STANDARD_CURVE.initialVirtualSol * STANDARD_CURVE.initialVirtualTokens) / vT;
    const q = quote(curveFixture({ virtualTokenReserves: vT, virtualSolReserves: vS, realTokenReserves: realTokens, realSolReserves: vS - STANDARD_CURVE.initialVirtualSol, protocolFeeBps: 95, creatorFeeBps: 30 }), 10_000_000);
    expect(Number(TOKENS_OUT_RAW) / Number(BigInt(q.tokenAmountRaw))).toBeGreaterThan(25);
  });
});
