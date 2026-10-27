import { PublicKey } from '@solana/web3.js';
import type { PumpMarketState } from '../../server/solana/pumpCurve';
import { TOKEN_PROGRAM_ID } from '../../server/solana/programs';

/** The constants a pump.fun curve starts from. Real reserves follow from them: real SOL = virtual SOL - initial virtual SOL, and
 *  real tokens = virtual tokens - (initial virtual tokens - initial real tokens). */
export interface CurveConstants { initialVirtualSol: bigint; initialVirtualTokens: bigint; initialRealTokens: bigint; tokenTotalSupply: bigint }

/** Mainnet's standard curve: 30 SOL / 1.073B tokens virtual, 793.1M tokens sellable, 1B supply. */
export const STANDARD_CURVE: CurveConstants = {
  initialVirtualSol: 30_000_000_000n, initialVirtualTokens: 1_073_000_000_000_000n, initialRealTokens: 793_100_000_000_000n, tokenTotalSupply: 1_000_000_000_000_000n,
};
/**
 * R3-4: the devnet curve the bot trades on starts at 1 SOL virtual (same token constants). Measured from the real devnet buy 5tVXiM
 * (tests/fixtures/devnet_buy_5tVXiM.json): with these constants the production quote gives the tokens that buy got (r3_4 test).
 */
export const DEVNET_CURVE: CurveConstants = { ...STANDARD_CURVE, initialVirtualSol: 1_000_000_000n };

/** True when the state's real reserves are the ones its virtual reserves imply for these constants (k = initial vSol x initial vTokens, within rounding). */
export function curveIsConsistent(s: Pick<PumpMarketState, 'virtualSolReserves' | 'virtualTokenReserves' | 'realSolReserves' | 'realTokenReserves'>, c: CurveConstants): boolean {
  const k = c.initialVirtualSol * c.initialVirtualTokens;
  const kNow = s.virtualSolReserves * s.virtualTokenReserves;
  const kOk = (kNow > k ? kNow - k : k - kNow) <= s.virtualTokenReserves; // integer rounding of one reserve
  return kOk
    && s.realSolReserves === s.virtualSolReserves - c.initialVirtualSol
    && s.realTokenReserves === s.virtualTokenReserves - (c.initialVirtualTokens - c.initialRealTokens);
}

/** A fresh standard Pump.fun curve (30 SOL / 1.073B tokens virtual, nothing sold) as getAccountInfo would decode it. */
export function curveFixture(over: Partial<PumpMarketState> = {}): PumpMarketState {
  const k = new PublicKey('CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS');
  const bc = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
  return {
    mint: k, bondingCurve: bc, associatedBondingCurve: bc, creator: k,
    feeRecipient: new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM'),
    buybackFeeRecipient: new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD'),
    quoteMint: new PublicKey('So11111111111111111111111111111111111111112'),
    baseTokenProgram: TOKEN_PROGRAM_ID, quoteTokenProgram: TOKEN_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID, tokenDecimals: 6,
    // R3-4: real SOL was 4 at a fresh token reserve, which no curve holds; a fresh curve has no real SOL
    virtualTokenReserves: STANDARD_CURVE.initialVirtualTokens, virtualSolReserves: STANDARD_CURVE.initialVirtualSol,
    realTokenReserves: STANDARD_CURVE.initialRealTokens, realSolReserves: 0n, tokenTotalSupply: STANDARD_CURVE.tokenTotalSupply,
    complete: false, isMayhemMode: false, protocolFeeBps: 100, creatorFeeBps: 0,
    mintAuthorityStatus: 'PASS', freezeAuthorityStatus: 'PASS', isMintAuthorityRevoked: true, isFreezeAuthorityRevoked: true,
    feeComputationStatus: 'VERIFIED', marketDataTimestamp: 1_700_000_000_000, marketDataSource: 'SOLANA_RPC_BONDING_CURVE',
    ...over,
  } as PumpMarketState;
}

/**
 * R3-4: a devnet curve rebuilt from its token account balance, the one figure a transaction's token balances show. Real tokens are the
 * curve account's balance less the part of the supply that is never sold; the virtual reserves follow from the DEVNET_CURVE constants.
 * Default: a fresh devnet curve.
 */
export function devnetCurveFixture(opts: { curveAtaTokensRaw?: bigint } & Partial<PumpMarketState> = {}): PumpMarketState {
  const { curveAtaTokensRaw, ...over } = opts;
  const c = DEVNET_CURVE;
  const realTokens = (curveAtaTokensRaw ?? c.initialRealTokens + (c.tokenTotalSupply - c.initialRealTokens)) - (c.tokenTotalSupply - c.initialRealTokens);
  const vT = realTokens + (c.initialVirtualTokens - c.initialRealTokens);
  const vS = (c.initialVirtualSol * c.initialVirtualTokens) / vT;
  return curveFixture({ virtualTokenReserves: vT, virtualSolReserves: vS, realTokenReserves: realTokens, realSolReserves: vS - c.initialVirtualSol, ...over });
}
