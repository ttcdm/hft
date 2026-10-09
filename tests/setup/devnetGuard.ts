import { beforeEach, afterEach, vi } from 'vitest';
import { executionCoordinator } from '../../server/execution/coordinator';
import { PumpCurveService } from '../../server/solana/pumpCurve';
import { pumpfunService } from '../../server/pumpfunService';
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

// Tests poke private fields of the shared singletons (arming LIVE, seeding a balance, caching a Global,
// planting callouts). Snapshot them before each test and put them back afterwards so one test's setup
// can never leak into the next, whatever order the files run in.
const COORDINATOR_FIELDS = ['executionMode', 'isLiveTradingArmed', 'realWalletBalanceSol', 'inFlightReservedSol'] as const;
let snapshot: { coord: Record<string, unknown>; global: unknown; fee: unknown; callouts: unknown } | undefined;

beforeEach(() => {
  const coord: Record<string, unknown> = {};
  for (const f of COORDINATOR_FIELDS) coord[f] = (executionCoordinator as any)[f];
  snapshot = {
    coord,
    global: PumpCurveService.cachedGlobal,
    fee: PumpCurveService.cachedFeeConfig,
    callouts: (pumpfunService as any).hotCallouts,
  };
});

afterEach(() => {
  if (!snapshot) return;
  for (const f of COORDINATOR_FIELDS) (executionCoordinator as any)[f] = snapshot.coord[f];
  PumpCurveService.cachedGlobal = snapshot.global;
  PumpCurveService.cachedFeeConfig = snapshot.fee;
  (pumpfunService as any).hotCallouts = snapshot.callouts;
});
