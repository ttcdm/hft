import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CLUSTER_GENESIS_HASH, ClusterGuardError, GENESIS_CHECK_TTL_MS, assertClusterAllowedCached, assertSendClusterAllowed,
} from '../server/solana/clusterGuard';

const DEVNET = CLUSTER_GENESIS_HASH.devnet;
const MAINNET = CLUSTER_GENESIS_HASH['mainnet-beta'];
const conn = (impl: () => Promise<string>) => ({ getGenesisHash: vi.fn(impl) });

afterEach(() => vi.unstubAllEnvs());

describe('S208: the send-path genesis check is cached per Connection', () => {
  it('a second send on the same connection makes no RPC call', async () => {
    const c = conn(async () => DEVNET);
    await assertClusterAllowedCached(c);
    await assertClusterAllowedCached(c);
    expect(c.getGenesisHash).toHaveBeenCalledTimes(1);
  });

  it('a new connection checks again, and a wrong hash on it still blocks', async () => {
    const a = conn(async () => DEVNET);
    await assertClusterAllowedCached(a);
    const b = conn(async () => MAINNET);
    await expect(assertClusterAllowedCached(b)).rejects.toBeInstanceOf(ClusterGuardError);
    expect(b.getGenesisHash).toHaveBeenCalledTimes(1);
  });

  it('a failed lookup is not cached', async () => {
    let fail = true;
    const c = conn(async () => { if (fail) throw new Error('rpc down'); return DEVNET; });
    await expect(assertClusterAllowedCached(c)).rejects.toThrow(/could not read genesis hash/);
    fail = false;
    await expect(assertClusterAllowedCached(c)).resolves.toBeTruthy();
    expect(c.getGenesisHash).toHaveBeenCalledTimes(2);
  });

  it('a wrong hash is not cached either', async () => {
    let hash = MAINNET;
    const c = conn(async () => hash);
    await expect(assertClusterAllowedCached(c)).rejects.toBeInstanceOf(ClusterGuardError);
    hash = DEVNET;
    await expect(assertClusterAllowedCached(c)).resolves.toBeTruthy();
    expect(c.getGenesisHash).toHaveBeenCalledTimes(2);
  });

  it('the entry expires after the TTL', async () => {
    const c = conn(async () => DEVNET);
    const t0 = 1_000_000;
    await assertClusterAllowedCached(c, process.env, t0);
    await assertClusterAllowedCached(c, process.env, t0 + GENESIS_CHECK_TTL_MS - 1);
    expect(c.getGenesisHash).toHaveBeenCalledTimes(1);
    await assertClusterAllowedCached(c, process.env, t0 + GENESIS_CHECK_TTL_MS);
    expect(c.getGenesisHash).toHaveBeenCalledTimes(2);
  });

  it('the mainnet-beta refusal is never cached', async () => {
    const c = conn(async () => DEVNET);
    await assertClusterAllowedCached(c);
    vi.stubEnv('ALLOWED_CLUSTER', 'mainnet-beta');
    expect(() => assertSendClusterAllowed()).toThrow(ClusterGuardError);
    // and a changed cluster setting does not reuse a pass made under another setting
    await assertClusterAllowedCached(conn(async () => MAINNET)).catch(() => undefined);
    const d = conn(async () => MAINNET);
    await assertClusterAllowedCached(d); // mainnet genesis matches the mainnet setting for readiness
    expect(d.getGenesisHash).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
    await expect(assertClusterAllowedCached(d)).rejects.toBeInstanceOf(ClusterGuardError); // now devnet is allowed: the cached mainnet pass is not reused
  });
});
