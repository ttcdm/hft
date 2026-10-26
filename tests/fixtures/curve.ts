import { PublicKey } from '@solana/web3.js';
import type { PumpMarketState } from '../../server/solana/pumpCurve';
import { TOKEN_PROGRAM_ID } from '../../server/solana/programs';

/** A fresh Pump.fun curve (30 SOL / 1.073B tokens virtual reserves) as getAccountInfo would decode it. */
export function curveFixture(over: Partial<PumpMarketState> = {}): PumpMarketState {
  const k = new PublicKey('CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS');
  const bc = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
  return {
    mint: k, bondingCurve: bc, associatedBondingCurve: bc, creator: k,
    feeRecipient: new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM'),
    buybackFeeRecipient: new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD'),
    quoteMint: new PublicKey('So11111111111111111111111111111111111111112'),
    baseTokenProgram: TOKEN_PROGRAM_ID, quoteTokenProgram: TOKEN_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID, tokenDecimals: 6,
    virtualTokenReserves: 1_073_000_000_000_000n, virtualSolReserves: 30_000_000_000n,
    realTokenReserves: 793_000_000_000_000n, realSolReserves: 4_000_000_000n, tokenTotalSupply: 1_000_000_000_000_000n,
    complete: false, isMayhemMode: false, protocolFeeBps: 100, creatorFeeBps: 0,
    mintAuthorityStatus: 'PASS', freezeAuthorityStatus: 'PASS', isMintAuthorityRevoked: true, isFreezeAuthorityRevoked: true,
    feeComputationStatus: 'VERIFIED', marketDataTimestamp: 1_700_000_000_000, marketDataSource: 'SOLANA_RPC_BONDING_CURVE',
    ...over,
  } as PumpMarketState;
}
