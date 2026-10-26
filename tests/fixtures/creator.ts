import { creatorRiskScorer } from '../../server/signals/creatorRiskScorer';

/**
 * P4.1 (R1-53): a known creator with no report scores 0 creator points (dev holding is no longer its stand-in). A fixture that wants the
 * creator factor to count gets the report the way the feed does: the real scorer reads a fake RPC's history of a seasoned wallet
 * (60 signatures, the oldest about 41 days back) into its cache.
 */
export async function seedSeasonedCreator(address: string): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const history = Array.from({ length: 60 }, (_, i) => ({ signature: `seasoned-${i}`, slot: 1_000 - i, err: null, memo: null, blockTime: nowSec - i * 60_000 }));
  await creatorRiskScorer.evaluateCreator({ getSignaturesForAddress: async () => history }, address, { bypassCache: true });
}
