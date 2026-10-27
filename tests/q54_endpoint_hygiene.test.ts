import { describe, it, expect, vi } from 'vitest';
import { Connection } from '@solana/web3.js';
import { endpointOrigin, rpcEndpointLabel, Logger } from '../server/middleware/enterprise';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { CLUSTER_GENESIS_HASH } from '../server/solana/clusterGuard';

describe('Q54: an RPC / Jito URL never carries its key into a log or a reply', () => {
  it.each([
    ['https://mainnet.helius-rpc.com/?api-key=SECRET123', 'https://mainnet.helius-rpc.com'],
    ['https://solana-devnet.g.alchemy.com/v2/SECRET123', 'https://solana-devnet.g.alchemy.com'],
    ['https://user:SECRET123@rpc.example.com:8899/path?x=1', 'https://rpc.example.com:8899'],
    ['http://127.0.0.1:8899', 'http://127.0.0.1:8899'],
  ])('%s -> %s', (url, out) => {
    expect(endpointOrigin(url)).toBe(out);
    expect(endpointOrigin(url)).not.toContain('SECRET123');
  });
  it('empty stays empty and garbage is not echoed', () => {
    expect(endpointOrigin(undefined)).toBe('');
    expect(endpointOrigin('not a url SECRET123')).toBe('[unparseable endpoint]');
  });
});

describe('the RPC switch log names a private RPC as [custom RPC], not its host', () => {
  it.each([
    ['https://example-name.solana-devnet.quiknode.pro/SECRET123/', '[custom RPC]'],
    ['https://mainnet.helius-rpc.com/?api-key=SECRET123', '[custom RPC]'],
    ['https://api.devnet.solana.com', 'https://api.devnet.solana.com'],
    ['https://api.mainnet-beta.solana.com/', 'https://api.mainnet-beta.solana.com'],
    ['http://127.0.0.1:8899', 'http://127.0.0.1:8899'],
    ['http://localhost:8899/x?k=SECRET123', 'http://localhost:8899'],
  ])('%s -> %s', (url, out) => {
    expect(rpcEndpointLabel(url)).toBe(out);
  });
  it('empty stays empty and garbage is not echoed', () => {
    expect(rpcEndpointLabel(undefined)).toBe('');
    expect(rpcEndpointLabel('not a url SECRET123')).toBe('[unparseable endpoint]');
  });

  it('setRpcEndpoint logs "Switched Solana RPC endpoint to [custom RPC]" for a private host', async () => {
    const base = new Connection('http://127.0.0.1:1', 'confirmed');
    vi.spyOn(base, 'getGenesisHash').mockResolvedValue(CLUSTER_GENESIS_HASH.devnet);
    vi.spyOn(base, 'getSlot').mockResolvedValue(1);
    const c = new ExecutionCoordinator(base);
    vi.spyOn(Connection.prototype, 'getGenesisHash').mockResolvedValue(CLUSTER_GENESIS_HASH.devnet);
    vi.spyOn(Connection.prototype, 'getSlot').mockResolvedValue(1);
    vi.spyOn(Connection.prototype, 'getBalance').mockResolvedValue(0);
    const info = vi.spyOn(Logger, 'info');
    try {
      // a .test host (never resolves), so nothing leaves the machine; the label rule does not look at the name
      const res = await c.setRpcEndpoint('https://example-name.solana-devnet.private-rpc.test/SECRET123/');
      expect(res.success).toBe(true);
      const line = info.mock.calls.map((a) => String(a[0])).find((m) => m.startsWith('Switched Solana RPC endpoint'));
      expect(line).toMatch(/^Switched Solana RPC endpoint to \[custom RPC\] \(\d+ms\)$/);
      expect(info.mock.calls.flat().join(' ')).not.toMatch(/private-rpc|SECRET123/);
    } finally {
      c.cleanup();
      info.mockRestore(); // the Connection spies stay: the coordinator's background reads after this test must not reach the host
    }
  });
});
