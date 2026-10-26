import '../suppress-warnings.cjs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ExecutionCoordinator, ExecuteTradeRequest } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { riskEngine, PUMP_USER_VOLUME_ACCUMULATOR_RENT_LAMPORTS } from '../server/risk/riskEngine';
import { workstationDb } from '../server/db/database';
import { executionConfig } from '../server/solana/executionConfig';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { TradeReconciler } from '../server/execution/reconciliation';
import { txBuilder } from '../server/solana/transactionBuilder';
import { userVolumeAccumulatorPda } from '@pump-fun/pump-sdk';
import { MemecoinAggregatorService } from '../server/memecoinAggregator';
import { PumpFeedListener } from '../server/solana/pumpFeedListener';
import { solPriceService } from '../server/market/solPriceService';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState, createPassingEligibilityReport } from './e2e/helpers/simulatedStates';
import { settleLeftoverLiveBuys } from './helpers/leftoverBuys';

/**
 * 3A (P3.1: R1-0, R1-15, R1-7, R1-14, N-20). Every LIVE buy re-checks readiness, not only the arm; the unresolved-buy query fails closed;
 * the same-mint check runs on the fresh position read next to the reservation; the reservation includes the first-buy accumulator rent;
 * DEMO_MODE moves only the demo pools and never runs next to LIVE.
 *
 * Real ExecutionCoordinator, armed through armLiveTrading after a real startup reconciliation, on the in-memory SQLite. The doubles are the
 * Connection (MockSolanaRpc), the signer, and the curve, quote, builder, snapshot and reconciler edges the other LIVE suites stub. The
 * builder is the observation point: a buy that reaches txBuilder.buildBuyTransaction got past every gate this task adds.
 * (R1-10, routes passing the gate's mode, is the C1 default G already landed in executeSnipe; not repeated here.)
 */

async function signedTx(conn: any, payer = Keypair.generate()): Promise<VersionedTransaction> {
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 })] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  return tx;
}

describe('3A: per-buy readiness and fail-closed buy checks (real coordinator, LIVE armed)', () => {
  let coordinator: ExecutionCoordinator;
  let rpc: MockSolanaRpc;
  let conn: any;
  let wallet: Keypair;
  let build: ReturnType<typeof vi.spyOn>;
  let send: ReturnType<typeof vi.spyOn>;

  const buyReq = (mint = Keypair.generate().publicKey.toBase58()): ExecuteTradeRequest => ({
    signalTimestamp: Date.now(), mint, symbol: 'S3A', name: 'S3A', amountSol: 0.02,
    source: 'AUTO_SNIPER', provenance: 'REAL_ONCHAIN', eligibilityReport: createPassingEligibilityReport(mint),
  });

  const seedLive = () => {
    const id = `s3a_${Math.random().toString(36).slice(2)}`;
    const mint = Keypair.generate().publicKey.toBase58();
    workstationDb.savePosition({
      id, mint, symbol: 'S3A', name: 'S3A', tokenDecimals: 6, tokenQuantityRaw: '1000000000',
      entryPriceSol: 0.0001, currentPriceSol: 0.00005, currentValueSol: 0.05, costBasisLamports: 100_000_000, realizedPnLSol: 0,
      status: 'OPEN', venue: 'PUMP_BONDING_CURVE', executionMode: 'LIVE', entryTxSignature: `sig_${id}`, entryTimestamp: Date.now(),
      lastMarkTimestamp: Date.now(), recordUpdatedAt: Date.now(), updatedAt: Date.now(),
    } as any);
    return { id, mint };
  };

  beforeEach(async () => {
    vi.spyOn(ExecutionCoordinator.prototype as any, 'liveBuyReadinessProblems').mockRestore(); // the suite setup stubs it green (tests/setup/devnetGuard.ts)
    settleLeftoverLiveBuys();
    for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0 } as any);
    wallet = Keypair.generate();
    vi.stubEnv('ALLOW_LIVE_REAL_MONEY_TRADING', 'true');
    vi.stubEnv('DEMO_MODE', '');
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(wallet.publicKey);
    vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => tx);
    const realConfig = executionConfig.getConfig.bind(executionConfig);
    vi.spyOn(executionConfig, 'getConfig').mockImplementation(() => ({ ...realConfig(), jitoBlockEngineUrl: '' })); // devnet: no block engine
    vi.spyOn(workstationDb, 'getDailyTotalPnLSol').mockReturnValue(0);
    PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() } as any;
    PumpCurveService.cachedFeeConfig = { feeBps: 100 } as any;
    riskEngine.setKillSwitch(false);
    riskEngine.setCircuitBreaker('CLOSED');
    riskEngine.recordRpcSuccess();
    // the builder stub ends each buy in a failure; the shared risk engine's 15 s failure cooldown would then answer the next test first
    vi.spyOn(riskEngine, 'recordTradeFailure').mockImplementation(() => undefined);
    rpc = new MockSolanaRpc();
    // the constructor's connect runs the cluster check and the startup reconciliation; wait for it like s245 does
    const realInit = (ExecutionCoordinator.prototype as any).initializeConnection;
    let initDone: Promise<unknown> = Promise.resolve();
    vi.spyOn(ExecutionCoordinator.prototype as any, 'initializeConnection').mockImplementation(function (this: any) {
      initDone = Promise.resolve(realInit.call(this));
      return initDone;
    });
    const c: any = rpc.createConnection();
    c.getBalance = vi.fn(async () => 1_000_000_000);
    c.getParsedTokenAccountsByOwner = vi.fn(async () => ({ context: { slot: 1 }, value: [] })); // an empty wallet: nothing to adopt
    coordinator = new ExecutionCoordinator(c);
    await initDone;
    conn = coordinator.getConnection();
    expect(coordinator.getReconciliationStatus()?.status, coordinator.getReconciliationStatus()?.details).toBe('EXECUTION_READY');
    expect(await coordinator.syncRealWalletBalance()).toBeGreaterThan(0.015);
    const armed = coordinator.armLiveTrading(true, 'CONFIRM_LIVE_TRADING_RISK');
    expect(armed.success, armed.message).toBe(true);

    vi.spyOn(coordinator.getJitoTransport(), 'getTipFloorLamports').mockResolvedValue(null as any);
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE' } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '0', tokenDecimals: 6, timestamp: Date.now() });
    build = vi.spyOn(txBuilder, 'buildBuyTransaction').mockRejectedValue(new Error('TEST_BUILD_REACHED'));
    send = vi.spyOn(conn, 'sendRawTransaction');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    riskEngine.setCircuitBreaker('CLOSED');
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    coordinator.cleanup();
    rpc.clear();
  });

  /** The sell edges of the other LIVE stop-loss suites (halt_protective_exits_send, s245). */
  const sellEdges = () => {
    vi.spyOn(PumpCurveService, 'calculateSellQuote').mockReturnValue({ expectedJitoTipLamports: 0, minOutputLamports: 1 } as any);
    vi.spyOn(txBuilder, 'buildSellTransaction').mockImplementation(async () => signedTx(conn) as any);
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '1000000000', tokenDecimals: 6, timestamp: Date.now() });
    vi.spyOn(TradeReconciler, 'reconcileSellTransaction').mockResolvedValue({
      success: true, reconciliationState: 'RECONCILED', actualTokensSoldRaw: '1000000000', tokensSoldHuman: 1000, tokenDecimals: 6,
      actualGrossSolProceedsLamports: 50_000_000, actualNetSolProceedsLamports: 49_000_000, actualNetworkFeeLamports: 5000,
      actualJitoTipLamports: 0, actualRealizedPnLSol: -0.05, remainingTokensRaw: '0', isFullyClosed: true, slot: 6,
    } as any);
    vi.spyOn(conn, 'getTokenAccountBalance').mockResolvedValue({ context: { slot: 1 }, value: { amount: '1000000000', decimals: 6, uiAmount: 1000, uiAmountString: '1000' } } as any);
  };

  it('control: armed and green, a LIVE buy gets past every 3A gate to the builder', async () => {
    const res = await coordinator.executeTrade(buyReq());
    expect(build).toHaveBeenCalledTimes(1);
    expect(res.error ?? '').not.toMatch(/LIVE_NOT_READY|POSITION_ALREADY_OPEN|UNRESOLVED_BUY/);
  });

  it('R1-0: the database turns read-only after the arm: the buy is refused LIVE_NOT_READY with nothing built or sent, and a STOP_LOSS still sends', async () => {
    const { id } = seedLive();
    vi.spyOn(workstationDb, 'isWritable').mockReturnValue(false);
    const res = await coordinator.executeTrade(buyReq());
    expect(res.success).toBe(false);
    expect(res.lifecycleState).toBe('RISK_REJECTED');
    expect(res.error).toMatch(/^LIVE_NOT_READY: .*database is not writable/);
    expect(build).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    sellEdges();
    const sold = await coordinator.closePosition(id, 100, 'STOP_LOSS');
    expect(sold.error ?? '').not.toMatch(/LIVE_NOT_READY/);
    expect(send).toHaveBeenCalledTimes(1);
    expect(sold.success, sold.error).toBe(true);
  });

  it('R1-0: a reconciliation that ends in MISMATCH after the arm: the buy is refused, a STOP_LOSS still sends', async () => {
    const { id } = seedLive();
    // a confirmed buy whose details cannot be read keeps the reconciliation at MISMATCH (N9 in n5_startup_reconcile)
    const sig = `s3a_${Math.random().toString(36).slice(2)}`;
    workstationDb.saveTransaction({ signature: sig, orderId: `o_${sig}`, correlationId: 'c', mint: Keypair.generate().publicKey.toBase58(), direction: 'BUY', submissionTransport: 'SOLANA_RPC', submissionTime: Date.now() - 5000, reconciliationState: 'PENDING', networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE' } as any);
    vi.spyOn(conn, 'getSignatureStatuses').mockResolvedValue({ context: { slot: 1 }, value: [{ slot: 5, confirmations: null, err: null, confirmationStatus: 'finalized' }] } as any);
    vi.spyOn(conn, 'getTransaction').mockResolvedValue(null);
    vi.spyOn(conn, 'getTokenAccountBalance').mockResolvedValue({ context: { slot: 1 }, value: { amount: '1000000000', decimals: 6, uiAmount: 1000, uiAmountString: '1000' } } as any);
    const recon = await coordinator.startupReconciliation();
    expect(recon.status).toBe('RECONCILIATION_MISMATCH');
    expect(coordinator.isLiveArmed()).toBe(true); // the arm is not taken back; only the buy gate notices

    const res = await coordinator.executeTrade(buyReq());
    expect(res.lifecycleState).toBe('RISK_REJECTED');
    expect(res.error).toMatch(/^LIVE_NOT_READY: .*startup reconciliation is RECONCILIATION_MISMATCH/);
    expect(build).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    sellEdges();
    const sold = await coordinator.closePosition(id, 100, 'STOP_LOSS');
    expect(send).toHaveBeenCalledTimes(1);
    expect(sold.success, sold.error).toBe(true);
    workstationDb.saveTransaction({ ...workstationDb.loadTransactions().find((t) => t.signature === sig)!, reconciliationState: 'REVERTED' });
  });

  it('R1-0: a HALF_OPEN breaker after the arm: the buy is refused, a STOP_LOSS still sends', async () => {
    const { id } = seedLive();
    riskEngine.setCircuitBreaker('HALF_OPEN');
    const res = await coordinator.executeTrade(buyReq());
    expect(res.lifecycleState).toBe('RISK_REJECTED');
    expect(res.error).toMatch(/^LIVE_NOT_READY: .*circuit breaker is HALF_OPEN/);
    expect(build).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    sellEdges();
    const sold = await coordinator.closePosition(id, 100, 'STOP_LOSS');
    expect(send).toHaveBeenCalledTimes(1);
    expect(sold.success, sold.error).toBe(true);
  });

  it('R1-0 (Q17 block): readiness that fails while the buy is being signed stops the send (ENTRY_REVOKED)', async () => {
    build.mockImplementation(async () => signedTx(conn) as any);
    vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => {
      vi.spyOn(workstationDb, 'isWritable').mockReturnValue(false); // the disk fills during the sign
      return tx;
    });
    const before = coordinator.getSpendableBankrollSol();
    const res = await coordinator.executeTrade(buyReq());
    expect(res.lifecycleState).toBe('RISK_REJECTED');
    expect(res.error).toMatch(/^ENTRY_REVOKED: live readiness failed \(.*database is not writable/);
    expect(build).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(coordinator.getSpendableBankrollSol()).toBe(before); // the reservation was given back
  });

  it('R1-15: the unresolved-buy query throws: hasUnresolvedLiveBuy answers true and the buy is refused before anything is built', async () => {
    const db = (workstationDb as any).db;
    const realPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: any) => {
      if (/reconciliation_state IN \('PENDING', 'RECONCILIATION_REQUIRED'\)/.test(sql) && /direction = 'BUY'/.test(sql)) throw new Error('SQLITE_IOERR: disk I/O error');
      return realPrepare(sql);
    });
    const req = buyReq();
    expect(workstationDb.hasUnresolvedLiveBuy(req.mint)).toBe(true);
    const res = await coordinator.executeTrade(req);
    expect(res.lifecycleState).toBe('RISK_REJECTED');
    expect(res.error).toMatch(/^UNRESOLVED_BUY/);
    expect(build).not.toHaveBeenCalled();
  });

  it('R1-7: a row for the same mint saved during the awaits (orphan recovery adopting it) is caught next to the reservation: POSITION_ALREADY_OPEN', async () => {
    const req = buyReq();
    // the tip-floor read is one of the awaits between the first same-mint check and the reservation
    vi.spyOn(coordinator.getJitoTransport(), 'getTipFloorLamports').mockImplementation(async () => {
      workstationDb.savePosition({
        id: `adopted_${req.mint.slice(0, 6)}`, mint: req.mint, symbol: 'S3A', name: 'S3A', tokenDecimals: 6, tokenQuantityRaw: '5000',
        entryPriceSol: 0.0001, currentPriceSol: 0.0001, currentValueSol: 0.0005, costBasisLamports: 500_000, realizedPnLSol: 0,
        status: 'OPEN', venue: 'PUMP_BONDING_CURVE', executionMode: 'LIVE', entryTxSignature: `RECOVERED:${req.mint}`, entryTimestamp: Date.now(),
        lastMarkTimestamp: Date.now(), recordUpdatedAt: Date.now(), updatedAt: Date.now(),
      } as any);
      return null as any;
    });
    const before = coordinator.getSpendableBankrollSol();
    const res = await coordinator.executeTrade(req);
    expect(res.lifecycleState).toBe('RISK_REJECTED');
    expect(res.error).toMatch(/^POSITION_ALREADY_OPEN/);
    expect(build).not.toHaveBeenCalled();
    expect(coordinator.getSpendableBankrollSol()).toBe(before);
  });

});
