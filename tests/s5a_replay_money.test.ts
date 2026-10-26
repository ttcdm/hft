import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import BN from 'bn.js';
import { PublicKey, Keypair } from '@solana/web3.js';
import * as sdk from '@pump-fun/pump-sdk';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';

/**
 * 5A: one cost and latency model for the in-app replay and the offline studies (server/backtest/costModel.ts), and the buy quote's fee split.
 * Every block here fails on 767c13a without its commit.
 */

const PUMP: any = (sdk as any).PUMP_SDK ?? (sdk as any).default?.PUMP_SDK;
const dump = (name: string) => {
  const j = JSON.parse(fs.readFileSync(`scripts/localnet/accounts/${name}.json`, 'utf8'));
  return { data: Buffer.from(j.account.data[0], 'base64'), owner: new PublicKey(j.account.owner), lamports: 1, executable: false } as any;
};

describe('5A (N-41): the buy quote charges the fee on the curve input, split by bps with ceil as the SDK does', () => {
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

  // the audit's fixture: vS 30 SOL, vT 1.073e15, 95 + 30 bps, a 0.1 SOL buy
  const state = createSimulatedBondingCurveState({
    creator: Keypair.generate().publicKey,
    virtualSolReserves: 30_000_000_000n,
    virtualTokenReserves: 1_073_000_000_000_000n,
    realTokenReserves: 793_100_000_000_000n,
    realSolReserves: 0n,
    protocolFeeBps: 95,
    creatorFeeBps: 30,
  });
  const sdkBuyCost = (tokens: bigint, feeConfig: any) => BigInt(sdk.getBuySolAmountFromTokenAmount({
    global: { ...PumpCurveService.cachedGlobal, tokenTotalSupply: new BN(state.tokenTotalSupply.toString()), creatorFeeConfigurable: false } as any,
    feeConfig,
    mintSupply: new BN(state.tokenTotalSupply.toString()),
    bondingCurve: {
      virtualTokenReserves: new BN(state.virtualTokenReserves.toString()), virtualQuoteReserves: new BN(state.virtualSolReserves.toString()),
      realTokenReserves: new BN(state.realTokenReserves.toString()), realQuoteReserves: new BN(state.realSolReserves.toString()),
      tokenTotalSupply: new BN(state.tokenTotalSupply.toString()), complete: false, quoteMint: state.quoteMint,
      creatorFeeBps: new BN(30), creator: state.creator, isMayhemMode: false, isCashbackCoin: false, canEditCreatorFee: false,
    } as any,
    amount: new BN(tokens.toString()),
  } as any).toString());
  const zero = { lpFeeBps: new BN(0), protocolFeeBps: new BN(0), creatorFeeBps: new BN(0) };
  const noFees = { feeTiers: [{ marketCapLamportsThreshold: new BN(0), fees: zero }], stableFeeTiers: [], flatFees: zero, exoticFlatFees: zero };

  it('protocol + creator fee equals the SDK cost of the tokens minus their curve cost (LIVE and PAPER)', () => {
    for (const executionMode of ['LIVE', 'PAPER'] as const) {
      const q = PumpCurveService.calculateBuyQuote({ state, amountSol: 0.1, executionMode, slippageBps: 300 } as any);
      const tokens = BigInt(q.tokenAmountRaw);
      const fee = sdkBuyCost(tokens, (PumpCurveService as any).cachedFeeConfig) - sdkBuyCost(tokens, noFees);
      expect(BigInt(q.protocolFeeLamports + q.creatorFeeLamports)).toBe(fee);
      // and the split: what the program pays the protocol and the creator, each rounded up
      expect(q.protocolFeeLamports).toBe(938_272);
      expect(q.creatorFeeLamports).toBe(296_297);
    }
  });
});
