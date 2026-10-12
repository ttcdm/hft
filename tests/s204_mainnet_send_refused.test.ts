import { describe, it, expect, vi, afterEach } from 'vitest';
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { CLUSTER_GENESIS_HASH, ClusterGuardError, assertSendClusterAllowed } from '../server/solana/clusterGuard';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';

/**
 * S204: Mike decided that nothing in this build may arm LIVE, sign or send on mainnet, even with ALLOWED_CLUSTER=mainnet-beta and an RPC that
 * really reports the mainnet genesis hash. Reading mainnet (read-only watching, paper) must keep working.
 */
const MAINNET = CLUSTER_GENESIS_HASH['mainnet-beta'];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function buildTx() {
  const payer = Keypair.generate();
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  return { tx, payer };
}

describe('S204 assertSendClusterAllowed', () => {
  it('refuses only on mainnet-beta', () => {
    expect(() => assertSendClusterAllowed({ ALLOWED_CLUSTER: 'mainnet-beta' } as any)).toThrow(ClusterGuardError);
    expect(() => assertSendClusterAllowed({} as any)).not.toThrow();
    expect(() => assertSendClusterAllowed({ ALLOWED_CLUSTER: 'devnet' } as any)).not.toThrow();
    expect(() => assertSendClusterAllowed({ ALLOWED_CLUSTER: 'localnet' } as any)).not.toThrow();
  });
});

describe('S204 a mainnet setting never reaches a send', () => {
  it.each(['BUY', 'SELL'] as const)('refuses a %s even when the RPC reports the mainnet genesis hash, and sends nothing', async (side) => {
    vi.stubEnv('ALLOWED_CLUSTER', 'mainnet-beta');
    vi.spyOn(Connection.prototype, 'getGenesisHash').mockResolvedValue(MAINNET);
    vi.spyOn(Connection.prototype, 'getSlot').mockResolvedValue(1);
    vi.spyOn(Connection.prototype, 'getBalance').mockResolvedValue(0);
    const send = vi.spyOn(Connection.prototype, 'sendRawTransaction');
    const journal = vi.spyOn(workstationDb, 'logJournal');
    const coordinator = new ExecutionCoordinator();
    const { tx, payer } = buildTx();
    const orderId = `s199-${side}-${Math.random().toString(36).slice(2)}`;
    const res = await coordinator.submitAndConfirmWithRetry({
      tx, orderId, correlationId: `corr-${orderId}`, side,
      mint: Keypair.generate().publicKey.toBase58(), mintPubkey: Keypair.generate().publicKey, owner: payer.publicKey,
      tokenProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), preSnapshot: {} as any, jitoTipLamports: 0,
    });
    coordinator.cleanup();
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/mainnet-beta/);
    expect(send).not.toHaveBeenCalled();
    expect(journal).toHaveBeenCalledWith('CLUSTER_GUARD_BLOCK', `corr-${orderId}`, 'LIVE', expect.objectContaining({ orderId, side }));
  });

  it('refuses to arm LIVE with the confirmation code and the real-money switch both given', () => {
    vi.stubEnv('ALLOWED_CLUSTER', 'mainnet-beta');
    vi.stubEnv('ALLOW_LIVE_REAL_MONEY_TRADING', 'true');
    vi.spyOn(Connection.prototype, 'getSlot').mockResolvedValue(1);
    const c = new ExecutionCoordinator();
    try {
      const res = c.armLiveTrading(true, 'CONFIRM_LIVE_TRADING_RISK');
      expect(res.success).toBe(false);
      expect(res.message).toMatch(/MAINNET_PROHIBITED/);
      expect(c.isLiveArmed()).toBe(false);
    } finally {
      c.cleanup();
    }
  });

  it('executeTrade in LIVE refuses before it reads the curve, even if the coordinator was somehow armed', async () => {
    vi.stubEnv('ALLOWED_CLUSTER', 'mainnet-beta');
    vi.spyOn(Connection.prototype, 'getSlot').mockResolvedValue(1);
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    const fetchCurve = vi.spyOn(PumpCurveService, 'fetchPumpMarketState');
    const c = new ExecutionCoordinator();
    try {
      (c as any).isLiveTradingArmed = true;
      (c as any).executionMode = 'LIVE';
      const res = await c.executeTrade({
        mint: Keypair.generate().publicKey.toBase58(), symbol: 'T', name: 'T', amountSol: 0.005, slippageBps: 800,
        source: 'MANUAL', provenance: 'MANUAL_OPERATOR', signalTimestamp: Date.now(),
      } as any);
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/mainnet-beta/);
      expect(fetchCurve).not.toHaveBeenCalled();
    } finally {
      c.cleanup();
    }
  });

  it('reading still works: the readiness genesis check passes on mainnet, so a read-only server can watch it', async () => {
    vi.stubEnv('ALLOWED_CLUSTER', 'mainnet-beta');
    vi.spyOn(Connection.prototype, 'getGenesisHash').mockResolvedValue(MAINNET);
    vi.spyOn(Connection.prototype, 'getSlot').mockResolvedValue(1);
    const c = new ExecutionCoordinator();
    try {
      expect(await (c as any).verifyCluster()).toBe(true);
    } finally {
      c.cleanup();
    }
  });
});
