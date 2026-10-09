import { beforeEach, vi } from 'vitest';
import { Connection } from '@solana/web3.js';
import { CLUSTER_GENESIS_HASH } from '../../server/solana/clusterGuard';

// Hermetic defaults for every test file:
// - the RPC answers as devnet, so the cluster guard (R1) lets mocked LIVE sends through. Tests that
//   exercise the guard override this spy with another genesis hash.
// - Jito points at the in-process mock block engine (tests/e2e/helpers/mockJito.ts), never a real host.
beforeEach(() => {
  vi.spyOn(Connection.prototype, 'getGenesisHash').mockResolvedValue(CLUSTER_GENESIS_HASH.devnet);
});
