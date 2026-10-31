import { describe, it, expect, vi, afterEach } from 'vitest';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { PumpFeedListener } from '../server/solana/pumpFeedListener';
import { executionCoordinator } from '../server/execution/coordinator';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { buildSystemChecks } from '../server/system/systemChecks';
import { CLUSTER_GENESIS_HASH, isClusterMismatch } from '../server/solana/clusterGuard';

/**
 * R14-11: resolveRpcUrl filters by name only, so a mainnet node whose URL does not say "mainnet" passed, and the genesis check guarded the
 * LIVE send path only: the pump feed and the aggregator kept feeding PAPER and SHADOW decisions from it. The coordinator's own cluster check
 * (its heartbeat, verifyCluster) runs against the RPC with getGenesisHash answering mainnet's hash (the RPC boundary).
 */
async function rpcGenesis(hash: string): Promise<void> {
  vi.spyOn(Connection.prototype, 'getGenesisHash').mockResolvedValue(hash);
  await (executionCoordinator as any).verifyCluster();
}

describe('R14-11: the read paths refuse an RPC on another cluster', () => {
  const listeners: PumpFeedListener[] = [];
  afterEach(async () => {
    while (listeners.length) listeners.pop()!.destroy();
    await rpcGenesis(CLUSTER_GENESIS_HASH.devnet);
    vi.restoreAllMocks();
  });

  it('only a definite mismatch counts, not an unreadable genesis', () => {
    expect(isClusterMismatch('CLUSTER_GUARD: genesis hash X does not match allowed cluster devnet (Y); refusing to send')).toBe(true);
    expect(isClusterMismatch('CLUSTER_GUARD: could not read genesis hash (fetch failed); refusing to send')).toBe(false);
    expect(isClusterMismatch(null)).toBe(false);
  });

  it('the pump feed drops logs and reports ERROR while the RPC is on mainnet, and delivers again once it is back on devnet', async () => {
    let cb: ((logs: any, ctx: any) => void) | null = null;
    const conn: any = { onLogs: (_p: PublicKey, fn: any) => { cb = fn; return 1; }, removeOnLogsListener: async () => undefined, getSignaturesForAddress: async () => [] };
    const listener = new PumpFeedListener(conn);
    listeners.push(listener);
    const creates: string[] = [];
    listener.on('create_event', (e) => creates.push(e.mint));
    await listener.start();
    const log = () => {
      const mint = Keypair.generate().publicKey;
      cb!({ err: null, signature: `r1411-${mint.toBase58().slice(0, 6)}`, logs: PumpFeedListener.asPumpInvocation(PumpFeedListener.encodeCreateEventLog({ name: 'R', symbol: 'R', uri: '', mint, creator: Keypair.generate().publicKey })) }, { slot: 9 });
    };

    await rpcGenesis(CLUSTER_GENESIS_HASH['mainnet-beta']);
    log();
    expect(creates).toHaveLength(0);
    const t = listener.getTelemetry();
    expect(t.status).toBe('ERROR');
    expect(t.clusterMismatch).toMatch(/does not match allowed cluster/);
    expect(t.clusterRefused).toBe(1);
    expect(listener.isActive()).toBe(false);

    await rpcGenesis(CLUSTER_GENESIS_HASH.devnet);
    log();
    expect(creates).toHaveLength(1);
    expect(listener.getTelemetry().clusterMismatch).toBeNull();
  });

  it('a PAPER or SHADOW snipe is refused CLUSTER_GUARD, and authorities are not read', async () => {
    await rpcGenesis(CLUSTER_GENESIS_HASH['mainnet-beta']);
    expect(executionCoordinator.getExecutionMode()).toBe('PAPER');
    const r = await memecoinAggregator.executeSnipe({ contractAddress: Keypair.generate().publicKey.toBase58(), amountUsd: 1, dryRun: true });
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/^CLUSTER_GUARD: the RPC is on another cluster/);
    const read = vi.spyOn(Connection.prototype, 'getMultipleAccountsInfo');
    const pools = (memecoinAggregator as any).pools as any[];
    const fake = { contractAddress: Keypair.generate().publicKey.toBase58(), authoritiesVerified: false };
    pools.push(fake);
    try {
      expect(await memecoinAggregator.verifyPoolAuthorities()).toBe(0);
      expect(read).not.toHaveBeenCalled();
    } finally {
      pools.splice(pools.indexOf(fake), 1);
    }
  });

  it('System checks shows the feed row FAIL on a mismatch', async () => {
    await rpcGenesis(CLUSTER_GENESIS_HASH['mainnet-beta']);
    const row = buildSystemChecks().checks.find((c) => c.id === 'feed')!;
    expect(row.status).toBe('FAIL');
    expect(row.value).toMatch(/another cluster/);
  });
});
