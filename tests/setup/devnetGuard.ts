import net from 'node:net';
import fs from 'node:fs';
import { beforeEach, afterEach, afterAll, vi } from 'vitest';
import { executionCoordinator } from '../../server/execution/coordinator';
import { PumpCurveService } from '../../server/solana/pumpCurve';
import { pumpfunService } from '../../server/pumpfunService';
import { Connection } from '@solana/web3.js';
import { CLUSTER_GENESIS_HASH } from '../../server/solana/clusterGuard';
import { solPriceService } from '../../server/market/solPriceService';

// No test may reach a non-loopback host. Every outbound connection (fetch, node-fetch, ws, tls) ends in
// net.Socket.connect, so refusing there makes a leak to a real RPC fail loudly instead of passing on a
// machine that happens to be offline. This file runs before any test module is imported.
(globalThis as any).__networkGuardHits = [] as string[];
// T15: all of 127.0.0.0/8, ::1, IPv4-mapped loopback and localhost are local. Anything else is refused.
const isLoopback = (h: string): boolean => h === '' || h === 'localhost' || h === '::1' || h === '0.0.0.0' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(h);
const realConnect = net.Socket.prototype.connect;
(net.Socket.prototype as any).connect = function (this: net.Socket, ...args: any[]) {
  // net.connect() hands Socket.connect an already-normalized [options, cb] array; unwrap it, otherwise
  // the host reads as undefined and every plain http/ws connection would pass as "loopback".
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  let host: string | undefined;
  if (first && typeof first === 'object') {
    if (typeof first.path === 'string') return (realConnect as any).apply(this, args);
    host = first.host;
  } else if (typeof first === 'string' && Number.isNaN(Number(first))) {
    return (realConnect as any).apply(this, args); // unix socket path
  } else {
    host = typeof args[1] === 'string' ? args[1] : undefined;
  }
  if (!isLoopback(host ?? '')) {
    (globalThis as any).__networkGuardHits.push(String(host) + ' @ ' + (new Error().stack || '').split('\n').filter((l) => l.includes('/server') && !l.includes('node_modules')).slice(0, 2).map((l) => l.trim().replace(/.*macgit\//, '')).join(' <- '));
    // NETWORK_GUARD_LOG=<file>: one line per refused attempt, so a full run can be audited (deliberate probes by the guard's own test are marked).
    if (process.env.NETWORK_GUARD_LOG) fs.appendFileSync(process.env.NETWORK_GUARD_LOG, `${(globalThis as any).__expectNetworkGuardHits ? 'EXPECTED' : 'UNEXPECTED'} ${String(host)} ${String((globalThis as any).__vitest_worker__?.filepath ?? '')}\n`);
    throw new Error(`TEST_NETWORK_GUARD: a test tried to connect to non-loopback host "${host}"`);
  }
  return (realConnect as any).apply(this, args);
};

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

// T4: hits recorded after the file's last test (a background interval firing during teardown) are not attributed to a later,
// innocent test; they fail the file instead of vanishing.
afterAll(() => {
  const hits = (globalThis as any).__networkGuardHits as string[];
  const leaked = hits.splice(0, hits.length);
  if (leaked.length && !(globalThis as any).__expectNetworkGuardHits) {
    throw new Error(`TEST_NETWORK_GUARD: non-loopback connections after the last test of this file: ${[...new Set(leaked)].join(', ')}`);
  }
});

afterEach(() => {
  // A refused connection that the code under test swallowed is still a leak: fail the test that caused it.
  const hits = (globalThis as any).__networkGuardHits as string[];
  const leaked = hits.splice(0, hits.length);
  if (leaked.length && !(globalThis as any).__expectNetworkGuardHits) {
    throw new Error(`TEST_NETWORK_GUARD: test attempted non-loopback connections: ${[...new Set(leaked)].join(', ')}`);
  }
  if (!snapshot) return;
  for (const f of COORDINATOR_FIELDS) (executionCoordinator as any)[f] = snapshot.coord[f];
  PumpCurveService.cachedGlobal = snapshot.global;
  PumpCurveService.cachedFeeConfig = snapshot.fee;
  (pumpfunService as any).hotCallouts = snapshot.callouts;
});
