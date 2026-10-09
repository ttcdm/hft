import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import BN from 'bn.js';
import { PublicKey, Keypair } from '@solana/web3.js';
import * as sdk from '@pump-fun/pump-sdk';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';

/**
 * Found by the localnet end-to-end run: the LIVE sell quote compared the app's GROSS curve output to the official SDK's NET
 * output, so every LIVE sell failed QUOTE_MATH_DISCREPANCY whenever the fee was non-zero. Uses the real Global and fee-config
 * accounts dumped from devnet (scripts/localnet/accounts), not hand-made numbers.
 */
const PUMP: any = (sdk as any).PUMP_SDK ?? (sdk as any).default?.PUMP_SDK;
const dump = (name: string) => {
  const j = JSON.parse(fs.readFileSync(`scripts/localnet/accounts/${name}.json`, 'utf8'));
  return { data: Buffer.from(j.account.data[0], 'base64'), owner: new PublicKey(j.account.owner), lamports: 1, executable: false } as any;
};

let savedGlobal: any;
let savedFee: any;
beforeEach(() => {
  savedGlobal = PumpCurveService.cachedGlobal;
  savedFee = (PumpCurveService as any).cachedFeeConfig;
  PumpCurveService.cachedGlobal = PUMP.decodeGlobal(dump('pump_global'));
  (PumpCurveService as any).cachedFeeConfig = PUMP.decodeFeeConfig(dump('pump_fee_config'));
});
afterEach(() => {
  PumpCurveService.cachedGlobal = savedGlobal;
  (PumpCurveService as any).cachedFeeConfig = savedFee;
});

const liveState = (over = {}) =>
  createSimulatedBondingCurveState({
    creator: Keypair.generate().publicKey,
    virtualSolReserves: 38_000_000_000n,
    virtualTokenReserves: 800_000_000_000_000n,
    realTokenReserves: 520_000_000_000_000n,
    realSolReserves: 8_000_000_000n,
    protocolFeeBps: 95,
    creatorFeeBps: 30,
    ...over,
  });

describe('K9: LIVE sell quote is net of fees, once', () => {
  it('does not trip the discrepancy check and equals the official SDK net amount', () => {
    const state = liveState();
    const tokens = 40_000_000_000_000n;
    const q = PumpCurveService.calculateSellQuote({ state, tokenAmountRaw: tokens, executionMode: 'LIVE', slippageBps: 300 } as any);
    const sdkNet = PUMP.constructor && (sdk as any).getSellSolAmountFromTokenAmount({
      global: { ...PumpCurveService.cachedGlobal, tokenTotalSupply: new BN(state.tokenTotalSupply.toString()), feeBasisPoints: new BN(95), creatorFeeBasisPoints: new BN(30) },
      feeConfig: (PumpCurveService as any).cachedFeeConfig,
      mintSupply: new BN(state.tokenTotalSupply.toString()),
      bondingCurve: {
        virtualTokenReserves: new BN(state.virtualTokenReserves.toString()), virtualQuoteReserves: new BN(state.virtualSolReserves.toString()),
        realTokenReserves: new BN(state.realTokenReserves.toString()), realQuoteReserves: new BN(state.realSolReserves.toString()),
        tokenTotalSupply: new BN(state.tokenTotalSupply.toString()), complete: false, quoteMint: state.quoteMint,
        creatorFeeBps: new BN(30), creator: state.creator, isMayhemMode: false, isCashbackCoin: false, canEditCreatorFee: false,
      },
      amount: new BN(tokens.toString()),
    });
    expect(BigInt(q.expectedSolAmountLamports)).toBe(BigInt(sdkNet.toString()));
    // fees are part of the gross, not subtracted a second time
    const gross = BigInt(q.expectedSolAmountLamports) + BigInt(q.protocolFeeLamports) + BigInt(q.creatorFeeLamports);
    expect(Number(gross)).toBeGreaterThan(q.expectedSolAmountLamports);
    expect(q.protocolFeeLamports).toBeGreaterThan(0);
    expect(q.minOutputLamports).toBeLessThan(q.expectedSolAmountLamports);
  });

  it('still fails closed when the app and the SDK really disagree (fee bps differ from the SDK schedule)', () => {
    expect(() => PumpCurveService.calculateSellQuote({ state: liveState({ protocolFeeBps: 5 }), tokenAmountRaw: 40_000_000_000_000n, executionMode: 'LIVE' } as any)).toThrow(/QUOTE_MATH_DISCREPANCY/);
  });
});

describe('K9: a LIVE buy larger than what is left on the curve is refused plainly', () => {
  it('CURVE_NEARLY_COMPLETE, not a math-discrepancy alarm', () => {
    const state = liveState({ realTokenReserves: 5_000_000_000_000n });
    expect(() => PumpCurveService.calculateBuyQuote({ state, amountSol: 3, executionMode: 'LIVE' } as any)).toThrow(/CURVE_NEARLY_COMPLETE/);
  });
});

describe('R0.1: LIVE quotes never fall back to the custom math when the official SDK quote fails', () => {
  // A fee schedule with no tiers makes the official call throw; the custom constant-product math could still
  // price it, so a silent fallback would be reachable here if it existed.
  it('buy: throws OFFICIAL_PUMP_QUOTE_FAILED in LIVE, still prices in PAPER', () => {
    (PumpCurveService as any).cachedFeeConfig = { feeTiers: [] };
    const state = liveState();
    expect(() => PumpCurveService.calculateBuyQuote({ state, amountSol: 0.01, executionMode: 'LIVE', slippageBps: 300 } as any)).toThrow(/OFFICIAL_PUMP_QUOTE_FAILED/);
    expect(PumpCurveService.calculateBuyQuote({ state, amountSol: 0.01, executionMode: 'PAPER', slippageBps: 300 } as any).tokenAmountRaw).toBeDefined();
  });

  it('sell: throws OFFICIAL_PUMP_QUOTE_FAILED in LIVE, still prices in PAPER', () => {
    (PumpCurveService as any).cachedFeeConfig = { feeTiers: [] };
    const state = liveState();
    const args = { state, tokenAmountRaw: 40_000_000_000_000n, slippageBps: 300 };
    expect(() => PumpCurveService.calculateSellQuote({ ...args, executionMode: 'LIVE' } as any)).toThrow(/OFFICIAL_PUMP_QUOTE_FAILED/);
    expect(PumpCurveService.calculateSellQuote({ ...args, executionMode: 'PAPER' } as any).expectedSolAmountLamports).toBeGreaterThan(0);
  });
});
