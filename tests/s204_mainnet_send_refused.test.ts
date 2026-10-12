import { describe, it, expect, vi, afterEach } from 'vitest';
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { CLUSTER_GENESIS_HASH, ClusterGuardError, assertSendClusterAllowed } from '../server/solana/clusterGuard';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { txBuilder } from '../server/solana/transactionBuilder';
import { TradeReconciler } from '../server/execution/reconciliation';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';

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

describe('S204 the exit path: closePosition on a LIVE position', () => {
  it('a stop-loss sell is refused on a mainnet setting and nothing is broadcast, even with a mainnet genesis from the RPC', async () => {
    vi.stubEnv('ALLOWED_CLUSTER', 'mainnet-beta');
    const kp = Keypair.generate();
    const mockRpc = new MockSolanaRpc();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(kp.publicKey);
    const signSpy = vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => tx);
    PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() } as any;
    PumpCurveService.cachedFeeConfig = { feeBps: 100 } as any;
    const c = new ExecutionCoordinator(mockRpc.createConnection());
    const conn = (c as any).connection;
    conn.simulateTransaction = vi.fn(async () => ({ context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 1 } }));
    vi.spyOn(conn, 'getGenesisHash').mockResolvedValue(MAINNET);
    const send = vi.spyOn(conn, 'sendRawTransaction');
    vi.spyOn(c.getJitoTransport(), 'getTipFloorLamports').mockResolvedValue(null as any); // the public tip-floor service is a network call; none in tests
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE' } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
    vi.spyOn(PumpCurveService, 'calculateSellQuote').mockReturnValue({ expectedJitoTipLamports: 0, minOutputLamports: 1 } as any);
    vi.spyOn(txBuilder, 'buildSellTransaction').mockResolvedValue({} as any);
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '1000000000', tokenDecimals: 6, timestamp: Date.now() });
    vi.spyOn(c, 'canExecuteLive').mockReturnValue({ allowed: true, reasons: [], readiness: { ready: true } as any } as any);
    const id = `s204_${Math.random().toString(36).slice(2)}`;
    workstationDb.savePosition({
      id, mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'S204', name: 'S204 Coin', tokenDecimals: 6,
      tokenQuantityRaw: '1000000000', entryPriceSol: 0.0001, currentPriceSol: 0.00005, currentValueSol: 0.05,
      costBasisLamports: 100_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE',
      executionMode: 'LIVE', entryTxSignature: `sig_${id}`, entryTimestamp: Date.now(), lastMarkTimestamp: Date.now(),
      recordUpdatedAt: Date.now(), updatedAt: Date.now(),
    } as any);
    try {
      const journal = vi.spyOn(workstationDb, 'logJournal');
      const saveTx = vi.spyOn(workstationDb, 'saveTransaction');
      const res = await c.closePosition(id, 100, 'STOP_LOSS');
      expect(res.success).toBe(false);
      expect(send).not.toHaveBeenCalled();
      expect(signSpy).not.toHaveBeenCalled(); // S207: refused before signing
      expect(conn.simulateTransaction).not.toHaveBeenCalled(); // and before simulating
      expect(saveTx).not.toHaveBeenCalled(); // no PENDING or REVERTED transaction row
      expect(journal).toHaveBeenCalledWith('CLUSTER_GUARD_BLOCK', expect.any(String), 'LIVE', expect.objectContaining({ side: 'SELL', error: expect.stringMatching(/mainnet-beta/) }));
    } finally {
      c.cleanup();
      PumpCurveService.cachedGlobal = null;
      PumpCurveService.cachedFeeConfig = null;
      mockRpc.clear();
    }
  });
});
