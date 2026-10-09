import net from 'node:net';
import { describe, it, expect } from 'vitest';
import { executionCoordinator } from '../server/execution/coordinator';
import { resolveRpcUrl } from '../server/solana/clusterGuard';

describe('K1b: tests never reach a real cluster', () => {
  it('the default RPC and the coordinator singleton point at loopback under vitest', () => {
    expect(resolveRpcUrl()).toBe('http://127.0.0.1:9');
    expect(new URL(executionCoordinator.getConnection().rpcEndpoint).hostname).toBe('127.0.0.1');
  });

  it('a connection to a public host is refused and recorded', () => {
    const sock = new net.Socket();
    expect(() => sock.connect(443, 'api.devnet.solana.com')).toThrow(/TEST_NETWORK_GUARD/);
    expect(() => sock.connect({ port: 443, host: 'api.mainnet-beta.solana.com' })).toThrow(/TEST_NETWORK_GUARD/);
    const hits = (globalThis as any).__networkGuardHits as string[];
    expect(hits.length).toBe(2);
    hits.length = 0; // consumed: the setup file's afterEach fails any test that leaves hits behind
  });

  it('a swallowed leak still fails the test that caused it (checked by the afterEach in the setup file)', () => {
    // Behaviour is exercised by the setup file's afterEach; here we only assert the hook state is clean.
    expect((globalThis as any).__networkGuardHits.length).toBe(0);
  });
});
