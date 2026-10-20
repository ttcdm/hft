import { describe, it, expect, vi, afterEach } from 'vitest';
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { CLUSTER_GENESIS_HASH, assertClusterAllowedCached, forgetGenesisCheck, rememberGenesisCheck } from '../server/solana/clusterGuard';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { executionConfig } from '../server/solana/executionConfig';

/**
 * R1-1 / N-27: a wrong-cluster answer seen by the heartbeat's cluster check (verifyCluster, reached here through the public
 * startupReconciliation) must stop every send at once. It used to leave the 60 s send-path pass in place, so buys and sells kept going.
 */
const DEVNET = CLUSTER_GENESIS_HASH.devnet;
const MAINNET = CLUSTER_GENESIS_HASH['mainnet-beta'];

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function signedTx(payer: Keypair): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  return tx;
}

async function submit(coordinator: ExecutionCoordinator, side: 'BUY' | 'SELL') {
  const payer = Keypair.generate();
  const orderId = `s208e-${side}-${Math.random().toString(36).slice(2)}`;
  return coordinator.submitAndConfirmWithRetry({
    tx: signedTx(payer), orderId, correlationId: `corr-${orderId}`, side,
    mint: Keypair.generate().publicKey.toBase58(), mintPubkey: Keypair.generate().publicKey, owner: payer.publicKey,
    tokenProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), preSnapshot: {} as any, jitoTipLamports: 0,
  });
}

/** A coordinator whose boot-time and heartbeat checks never run: getSlot is held, so the only cluster checks are the ones the test makes. */
function quietCoordinator(genesis: { hash: string }) {
  const real = executionConfig.getConfig();
  vi.spyOn(executionConfig, 'getConfig').mockReturnValue({ ...real, jitoBlockEngineUrl: '' }); // devnet: no block engine, RPC sends
  vi.spyOn(Connection.prototype, 'getSlot').mockReturnValue(new Promise<number>(() => undefined));
  vi.spyOn(Connection.prototype, 'getBalance').mockResolvedValue(0);
  const genesisSpy = vi.spyOn(Connection.prototype, 'getGenesisHash').mockImplementation(async () => genesis.hash);
  const send = vi.spyOn(Connection.prototype, 'sendRawTransaction').mockResolvedValue('never-sent');
  return { coordinator: new ExecutionCoordinator(), genesisSpy, send };
}

describe('S208 cache eviction: a failed cluster check stops sends at once', () => {
  it('heartbeat sees DEVNET, then MAINNET: a BUY and then a SELL are both refused with CLUSTER_GUARD and nothing is sent', async () => {
    const genesis = { hash: DEVNET };
    const { coordinator, genesisSpy, send } = quietCoordinator(genesis);
    try {
      await coordinator.startupReconciliation({ fresh: true }); // verifyCluster #1: passes and warms the send-path cache
      expect(coordinator.getClusterStatus().problem).toBeNull();
      genesis.hash = MAINNET; // the RPC behind the same URL now answers for another cluster
      await coordinator.startupReconciliation({ fresh: true }); // verifyCluster #2: fails
      expect(coordinator.getClusterStatus().problem).toMatch(/CLUSTER_GUARD/);
      expect(genesisSpy).toHaveBeenCalledTimes(2);

      const buy = await submit(coordinator, 'BUY');
      expect(buy.success).toBe(false);
      expect(buy.error).toMatch(/CLUSTER_GUARD/);
      const sell = await submit(coordinator, 'SELL');
      expect(sell.success).toBe(false);
      expect(sell.error).toMatch(/CLUSTER_GUARD/);
      expect(send).not.toHaveBeenCalled();
    } finally { coordinator.cleanup(); }
  });

  it('while the heartbeat has flagged the RPC, a send is refused even if the RPC answers DEVNET again on the send path', async () => {
    const genesis = { hash: DEVNET };
    const { coordinator, send } = quietCoordinator(genesis);
    try {
      await coordinator.startupReconciliation({ fresh: true });
      genesis.hash = MAINNET;
      await coordinator.startupReconciliation({ fresh: true });
      genesis.hash = DEVNET; // flapping RPC: the send-path genesis call alone would now pass
      for (const side of ['BUY', 'SELL'] as const) {
        const r = await submit(coordinator, side);
        expect(r.error, side).toMatch(/CLUSTER_GUARD: the RPC is not trusted/);
      }
      expect(send).not.toHaveBeenCalled();
      await coordinator.startupReconciliation({ fresh: true }); // a later check that passes clears the problem
      expect(coordinator.getClusterStatus().problem).toBeNull();
    } finally { coordinator.cleanup(); }
  });

  it('forgetGenesisCheck makes the next send-path check ask the RPC again', async () => {
    let hash = DEVNET;
    const c = { getGenesisHash: vi.fn(async () => hash) };
    rememberGenesisCheck(c);
    hash = MAINNET;
    await expect(assertClusterAllowedCached(c)).resolves.toBeTruthy(); // the remembered pass, no RPC call
    expect(c.getGenesisHash).not.toHaveBeenCalled();
    forgetGenesisCheck(c);
    await expect(assertClusterAllowedCached(c)).rejects.toThrow(/CLUSTER_GUARD/);
    expect(c.getGenesisHash).toHaveBeenCalledTimes(1);
  });
});
