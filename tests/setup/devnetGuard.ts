import { beforeEach, vi } from 'vitest';
import { Connection } from '@solana/web3.js';
import { CLUSTER_GENESIS_HASH } from '../../server/solana/clusterGuard';
import { solPriceService } from '../../server/market/solPriceService';

// Hermetic defaults for every test file:
// - the RPC answers as devnet, so the cluster guard (R1) lets mocked LIVE sends through. Tests that
//   exercise the guard override this spy with another genesis hash.
// - the SOL/USD price (C3) is seeded with a labelled fixture; there is no built-in numeric fallback in server/.
//   Tests of the missing/stale behavior call solPriceService.reset() or setPrice with an old timestamp.
// - Jito points at the in-process mock block engine (tests/e2e/helpers/mockJito.ts), never a real host.
beforeEach(() => {
  vi.spyOn(Connection.prototype, 'getGenesisHash').mockResolvedValue(CLUSTER_GENESIS_HASH.devnet);
  solPriceService.setPrice(150, 'TEST_FIXTURE');
});
