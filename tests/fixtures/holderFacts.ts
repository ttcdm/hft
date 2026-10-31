import { vi } from 'vitest';
import * as pumpCurve from '../../server/solana/pumpCurve';

/**
 * R12-10: PAPER refuses a buy whose holder facts it asked for and could not read, as LIVE does. Tests of the paper fill path whose fake RPC
 * has no holder endpoints use this: the holder read (fetchTokenHolderDistribution, an RPC reader) answers a clean distribution, 1% creator
 * and 10% top-10, both under the caps. Call it in the test (vi.restoreAllMocks clears it).
 */
export function stubCleanHolderFacts(over: Partial<pumpCurve.TokenHolderDistribution> = {}) {
  return vi.spyOn(pumpCurve, 'fetchTokenHolderDistribution').mockImplementation(async (_c, mint) => ({
    mint: mint.toBase58(), totalCirculatingSupply: 1_000_000_000_000_000n, nonBondingCirculatingSupply: 200_000_000_000_000n,
    bondingCurveBalance: 800_000_000_000_000n, creatorBalance: 10_000_000_000_000n, creatorClusterBalance: 0n, unknownHolderBalance: 0n,
    unseenBalance: 0n, top10HoldersPct: 10, devHoldingPct: 1, topHolders: [], ...over,
  }));
}
