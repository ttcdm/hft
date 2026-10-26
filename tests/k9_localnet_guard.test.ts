import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  CLUSTER_GENESIS_HASH,
  ClusterGuardError,
  DEFAULT_LOCALNET_RPC_URL,
  allowedCluster,
  assertClusterAllowed,
  isLoopbackUrl,
  resolveJitoUrl,
  resolveRpcUrl,
} from '../server/solana/clusterGuard';

const LOCAL = '11111111111111111111111111111111LocalnetGenesisAAAA'.slice(0, 44);
const env = (o: Record<string, string>) => ({ ...o }) as NodeJS.ProcessEnv;
const conn = (hash: string, rpcEndpoint?: string) => ({ getGenesisHash: vi.fn().mockResolvedValue(hash), rpcEndpoint });

afterEach(() => vi.restoreAllMocks());

describe('K9: localnet in the cluster guard', () => {
  it('is only selected by an explicit ALLOWED_CLUSTER=localnet', () => {
    expect(allowedCluster(env({}))).toBe('devnet');
    expect(allowedCluster(env({ ALLOWED_CLUSTER: 'LOCALNET' }))).toBe('devnet');
    expect(allowedCluster(env({ ALLOWED_CLUSTER: 'localnet' }))).toBe('localnet');
  });

  it('accepts the local genesis hash on a loopback endpoint', async () => {
    const e = env({ ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCAL });
    await expect(assertClusterAllowed(conn(LOCAL, 'http://127.0.0.1:8899'), e)).resolves.toEqual({ cluster: 'localnet', genesisHash: LOCAL });
  });

  it('refuses a non-loopback endpoint even with the right hash', async () => {
    const e = env({ ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCAL });
    await expect(assertClusterAllowed(conn(LOCAL, 'https://rpc.example.com'), e)).rejects.toBeInstanceOf(ClusterGuardError);
    await expect(assertClusterAllowed(conn(LOCAL, undefined), e)).rejects.toThrow(/loopback/);
  });

  it('refuses when LOCALNET_GENESIS_HASH is missing', async () => {
    await expect(assertClusterAllowed(conn(LOCAL, 'http://localhost:8899'), env({ ALLOWED_CLUSTER: 'localnet' }))).rejects.toThrow(/LOCALNET_GENESIS_HASH/);
  });

  it('LOCALNET_GENESIS_HASH set to a public hash never unlocks that cluster', async () => {
    for (const h of [CLUSTER_GENESIS_HASH['mainnet-beta'], CLUSTER_GENESIS_HASH.devnet]) {
      const e = env({ ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: h });
      await expect(assertClusterAllowed(conn(h, 'http://127.0.0.1:8899'), e)).rejects.toThrow(/public cluster/);
    }
  });

  it('a mainnet node behind a loopback tunnel is still refused', async () => {
    const e = env({ ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCAL });
    await expect(assertClusterAllowed(conn(CLUSTER_GENESIS_HASH['mainnet-beta'], 'http://127.0.0.1:8899'), e)).rejects.toThrow(/does not match/);
  });

  it('devnet mode still rejects the local hash and mainnet still needs its own flag', async () => {
    await expect(assertClusterAllowed(conn(LOCAL), env({ LOCALNET_GENESIS_HASH: LOCAL }))).rejects.toThrow(/does not match/);
    await expect(assertClusterAllowed(conn(CLUSTER_GENESIS_HASH['mainnet-beta']), env({ LOCALNET_GENESIS_HASH: CLUSTER_GENESIS_HASH['mainnet-beta'] }))).rejects.toThrow(/does not match/);
  });

  it('RPC URL resolution stays on loopback and Jito is off', () => {
    const e = { ALLOWED_CLUSTER: 'localnet' } as NodeJS.ProcessEnv;
    expect(resolveRpcUrl('https://api.mainnet-beta.solana.com', e)).toBe(DEFAULT_LOCALNET_RPC_URL);
    expect(resolveRpcUrl('https://api.devnet.solana.com', e)).toBe(DEFAULT_LOCALNET_RPC_URL);
    expect(resolveRpcUrl('http://localhost:9000', e)).toBe('http://localhost:9000');
    expect(resolveJitoUrl('https://frankfurt.mainnet.block-engine.jito.wtf', e)).toBe('');
    expect(resolveJitoUrl('http://127.0.0.1:1234', e)).toBe('');
  });

  it('isLoopbackUrl rejects lookalikes', () => {
    expect(isLoopbackUrl('http://127.0.0.1:8899')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:8899')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackUrl('http://evil.com/127.0.0.1')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
  });
});
