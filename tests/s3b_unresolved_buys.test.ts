import '../suppress-warnings.cjs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair, MessageAccountKeys, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { ExecutionCoordinator, ExecuteTradeRequest, executionCoordinator, LIVE_BUY_FILLED } from '../server/execution/coordinator';
import { autoSnipeController, DEVNET_CONFIRMATION_CODE, AUTO_DEVNET_ORDER_SOL } from '../server/auto/controller';
import { auditWalletChange, WALLET_AUDIT_RENT_ALLOWANCE_SOL } from '../server/auto/killSwitch';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { localSigner } from '../server/solana/signer';
import { riskEngine } from '../server/risk/riskEngine';
import { workstationDb } from '../server/db/database';
import { executionConfig } from '../server/solana/executionConfig';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { TradeReconciler } from '../server/execution/reconciliation';
import { txBuilder } from '../server/solana/transactionBuilder';
import { solPriceService } from '../server/market/solPriceService';
import { TOKEN_PROGRAM_ID } from '../server/solana/programs';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState, createPassingEligibilityReport } from './e2e/helpers/simulatedStates';
import { settleLeftoverLiveBuys } from './helpers/leftoverBuys';
import { resetAuto, newPumpPool } from './fixtures/auto';

/**
 * 3B (P3.2: R1-4, R1-35, R1-47, R1-62, R1-127, R1-3, R1-38). A LIVE buy that was sent and is unresolved (PENDING or RECONCILIATION_REQUIRED)
 * holds a position slot and its worst-case SOL in the coordinator's reserve and risk checks and in the controller's DEVNET_LIVE cap, which
 * counts LIVE positions only. Every landed LIVE buy (confirmed, manual, orphan recovery) journals its whole wallet delta exactly once, and
 * the wallet audit holds a drop an unresolved buy can explain. The session spend counts the real wallet delta, rent included.
 *
 * Real ExecutionCoordinator (armed after a real startup reconciliation), AutoSnipeController, TradeReconciler and in-memory SQLite. Doubles:
 * the Connection (MockSolanaRpc), the signer, the curve/venue/builder/snapshot edges the other LIVE suites stub, and, for the controller,
 * the process-wide coordinator's mode and balance reads (as q8 and g1 do).
 */

const SOL = 1e9;
const RENT = 2_039_280;

async function signedTx(conn: any, payer = Keypair.generate()): Promise<VersionedTransaction> {
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 })] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  return tx;
}
const sigOf = (raw: Buffer | Uint8Array) => bs58.encode(VersionedTransaction.deserialize(Uint8Array.from(raw)).signatures[0]);

/** A landed buy as getTransaction returns it: the wallet pays `delta` lamports (curve, fee, tip, the new token account's rent). */
function landedBuy(wallet: PublicKey, mint: PublicKey, delta: number) {
  const ata = PumpCurveService.getAssociatedTokenAddress(mint, wallet, TOKEN_PROGRAM_ID);
  const keys = [wallet, ata, Keypair.generate().publicKey];
  return {
    slot: 4242,
    blockTime: Math.floor(Date.now() / 1000),
    transaction: { message: { getAccountKeys: () => new MessageAccountKeys(keys) } },
    meta: {
      err: null,
      fee: 10_000,
      preBalances: [5 * SOL, 0, 10 * SOL],
      postBalances: [5 * SOL - delta, RENT, 10 * SOL + (delta - RENT - 10_000)],
      preTokenBalances: [],
      postTokenBalances: [{ accountIndex: 1, mint: mint.toBase58(), owner: wallet.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), uiTokenAmount: { amount: '600000000000', decimals: 6 } }],
    },
  };
}

const quoteJson = (maxInputLamports: number) => JSON.stringify({ maxInputLamports, expectedJitoTipLamports: 0, expectedPriorityFeeLamports: 10_000 });

/** An unresolved LIVE buy as an earlier send leaves it: its order row (with the quote) and its RECONCILIATION_REQUIRED ledger row. */
function plantUnresolved(mint: string, maxInputLamports = 6_000_000, state: 'PENDING' | 'RECONCILIATION_REQUIRED' = 'RECONCILIATION_REQUIRED') {
  const sig = `s3b_${Math.random().toString(36).slice(2)}`;
  const orderId = `ord-${sig}`;
  workstationDb.saveOrder({
    id: orderId, clientOrderId: orderId, correlationId: sig, mint, symbol: 'S3B', side: 'BUY', amountLamports: 5_000_000, expectedTokensRaw: '1',
    slippageBps: 800, status: 'SUBMITTED', quoteJson: quoteJson(maxInputLamports), executionMode: 'LIVE', createdAt: Date.now(), updatedAt: Date.now(),
  } as any);
  workstationDb.saveTransaction({
    signature: sig, orderId, correlationId: sig, mint, direction: 'BUY', submissionTransport: 'SOLANA_RPC', submissionTime: Date.now(),
    reconciliationState: state, networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE', error: 'UNCONFIRMED: test',
  });
  return sig;
}

const closeAllActive = () => {
  for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0 } as any);
};

describe('3B: unresolved LIVE buys count everywhere; the wallet audit knows them', () => {
  let coordinator: ExecutionCoordinator;
  let rpc: MockSolanaRpc;
  let conn: any;
  let wallet: Keypair;
  let build: ReturnType<typeof vi.spyOn>;
  let savedDelays: number[];
  const savedLimits = { ...riskEngine.getLimits() };

  const buyReq = (mint = Keypair.generate().publicKey.toBase58(), source = 'AUTO_SNIPER'): ExecuteTradeRequest => ({
    signalTimestamp: Date.now(), mint, symbol: 'S3B', name: 'S3B', amountSol: 0.005,
    source, provenance: 'REAL_ONCHAIN', eligibilityReport: createPassingEligibilityReport(mint),
  } as any);

  /** A confirmed LIVE buy through the real coordinator: built, sent on the mock RPC, its fill read as `delta` lamports out of the wallet. */
  const confirmEdges = (delta: number) => {
    build.mockImplementation(async () => signedTx(conn) as any);
    vi.spyOn(TradeReconciler, 'reconcileBuyTransaction').mockImplementation(async () => ({
      success: true, reconciliationState: 'RECONCILED', actualSolSpentLamports: delta, actualTokensReceivedRaw: '600000000000', tokensReceivedHuman: 600000,
      tokenDecimals: 6, effectiveFillPriceSol: 1e-8, allInFillPriceSol: 1e-8, actualNetworkFeeLamports: 10_000, curveSpendLamports: delta - RENT - 10_000,
      tokenAccountRentLamports: RENT, otherNewAccountRentLamports: 0, slot: 7,
    } as any));
  };

  /** The process-wide controller in DEVNET_LIVE, as q8 and g1 set it up; the balance it audits is `bal`. */
  const armAuto = async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    vi.stubEnv('ALLOWED_CLUSTER', 'devnet');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    vi.spyOn(executionCoordinator, 'isLiveArmed').mockReturnValue(true);
    vi.spyOn(executionCoordinator, 'syncRealWalletBalance').mockResolvedValue(null);
    const bal = vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol').mockReturnValue(1);
    const ok = await autoSnipeController.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE });
    expect(ok.ok, ok.error).toBe(true);
    return bal;
  };

  beforeEach(async () => {
    vi.spyOn(ExecutionCoordinator.prototype as any, 'liveBuyReadinessProblems').mockRestore(); // the suite setup stubs it green (tests/setup/devnetGuard.ts)
    settleLeftoverLiveBuys();
    closeAllActive();
    savedDelays = TradeReconciler.txFetchRetryDelaysMs;
    TradeReconciler.txFetchRetryDelaysMs = [0, 0, 0];
    memecoinAggregator.setConfluenceGating(false);
    solPriceService.setPrice(150, 'TEST_FIXTURE');
    wallet = Keypair.generate();
    vi.stubEnv('ALLOW_LIVE_REAL_MONEY_TRADING', 'true');
    vi.stubEnv('DEMO_MODE', '');
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(wallet.publicKey);
    vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => tx);
    const realConfig = executionConfig.getConfig.bind(executionConfig);
    vi.spyOn(executionConfig, 'getConfig').mockImplementation(() => ({ ...realConfig(), jitoBlockEngineUrl: '', rpcFallbackTimeoutMs: 1200 }));
    vi.spyOn(workstationDb, 'getDailyTotalPnLSol').mockReturnValue(0);
    PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() } as any;
    PumpCurveService.cachedFeeConfig = { feeBps: 100 } as any;
    riskEngine.setKillSwitch(false);
    riskEngine.setCircuitBreaker('CLOSED');
    riskEngine.recordRpcSuccess();
    (riskEngine as any).lastTradeFailureTimestamp = 0;
    rpc = new MockSolanaRpc();
    const realInit = (ExecutionCoordinator.prototype as any).initializeConnection;
    let initDone: Promise<unknown> = Promise.resolve();
    vi.spyOn(ExecutionCoordinator.prototype as any, 'initializeConnection').mockImplementation(function (this: any) {
      initDone = Promise.resolve(realInit.call(this));
      return initDone;
    });
    const c: any = rpc.createConnection();
    c.getBalance = vi.fn(async () => 1_000_000_000);
    c.getParsedTokenAccountsByOwner = vi.fn(async () => ({ context: { slot: 1 }, value: [] }));
    coordinator = new ExecutionCoordinator(c);
    await initDone;
    conn = coordinator.getConnection();
    expect(coordinator.getReconciliationStatus()?.status, coordinator.getReconciliationStatus()?.details).toBe('EXECUTION_READY');
    expect(await coordinator.syncRealWalletBalance()).toBeGreaterThan(0.015);
    expect(coordinator.armLiveTrading(true, 'CONFIRM_LIVE_TRADING_RISK').success).toBe(true);
    vi.spyOn(coordinator as any, 'scheduleOrphanRecovery').mockImplementation(() => undefined); // the tests run recovery themselves
    vi.spyOn(coordinator.getJitoTransport(), 'getTipFloorLamports').mockResolvedValue(null as any);
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE' } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockImplementation(async () => createSimulatedBondingCurveState());
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '0', tokenDecimals: 6, timestamp: Date.now() });
    build = vi.spyOn(txBuilder, 'buildBuyTransaction').mockRejectedValue(new Error('TEST_BUILD_REACHED'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    riskEngine.updateLimits({ maxSimultaneousPositions: savedLimits.maxSimultaneousPositions });
    (riskEngine as any).lastTradeFailureTimestamp = 0;
    TradeReconciler.txFetchRetryDelaysMs = savedDelays;
    await resetAuto();
    executionCoordinator.clearHalt();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    coordinator.cleanup();
    rpc.clear();
    settleLeftoverLiveBuys();
    closeAllActive();
  });

  it('R1-4: a buy of A left RECONCILIATION_REQUIRED, then B after the failure cooldown: MAX_EXPOSURE, nothing built or sent', async () => {
    riskEngine.updateLimits({ maxSimultaneousPositions: 1 });
    build.mockImplementation(async () => signedTx(conn) as any);
    let sentA = '';
    const send = vi.spyOn(conn, 'sendRawTransaction').mockImplementation(async (raw: any) => { sentA = sigOf(raw); throw new Error('fetch failed'); });
    const a = await coordinator.executeTrade(buyReq());
    expect(a.lifecycleState, a.error).toBe('RECONCILIATION_REQUIRED');
    expect(a.txSignature).toBe(sentA);
    expect(build).toHaveBeenCalledTimes(1);

    // the unconfirmed send started the 15 s failure cooldown; B comes after it
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + riskEngine.getLimits().cooldownAfterFailedTradeMs + 1_000);
    build.mockRejectedValue(new Error('TEST_BUILD_REACHED'));
    const b = await coordinator.executeTrade(buyReq());
    expect(b.lifecycleState).toBe('RISK_REJECTED');
    expect(b.error).toMatch(/^MAX_EXPOSURE: .*max simultaneous positions \(1\/1\)/);
    expect(build).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('R1-4, R1-47: an unresolved LIVE buy takes the DEVNET_LIVE slot: the controller drops the next candidate with DEVNET_MAX_OPEN_POSITIONS', async () => {
    plantUnresolved(Keypair.generate().publicKey.toBase58(), 6_000_000, 'PENDING'); // another process's buy, still waiting for its confirmation
    await armAuto();
    const snipe = vi.spyOn(memecoinAggregator, 'executeSnipe');
    const { mint } = newPumpPool('HOT');
    const d = await autoSnipeController.submitCandidate({ mint, symbol: 'B', source: 'TEST' as any, amountUsd: 0.7, provenance: 'REAL_ONCHAIN' });
    expect(d.outcome).toBe('DROPPED');
    expect(d.reason).toMatch(/^DEVNET_MAX_OPEN_POSITIONS \(1\) reached: 0 open LIVE position\(s\), 1 unresolved LIVE buy\(s\)/);
    expect(snipe).not.toHaveBeenCalled();
  });

  it('R1-4: unresolved buys hold their worst-case SOL in the reserve check (INSUFFICIENT_FUNDS_CONCURRENCY)', async () => {
    // the wallet holds 1 SOL; an unresolved buy that may still take up to 0.98 SOL leaves too little for a 0.005 order plus the reserve
    plantUnresolved(Keypair.generate().publicKey.toBase58(), 980_000_000);
    const res = await coordinator.executeTrade(buyReq());
    expect(res.lifecycleState).toBe('RISK_REJECTED');
    expect(res.error).toMatch(/^INSUFFICIENT_FUNDS_CONCURRENCY: .*unresolved buys \(0\.98\d+ SOL\)/);
    expect(build).not.toHaveBeenCalled();
  });

  it('fail closed: the unresolved-buy ledger cannot be read, the buy is refused', async () => {
    const db = (workstationDb as any).db;
    const realPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: any) => {
      if (String(sql).includes('LEFT JOIN orders')) throw new Error('SQLITE_IOERR');
      return realPrepare(sql);
    });
    const res = await coordinator.executeTrade(buyReq());
    expect(res.lifecycleState).toBe('RISK_REJECTED');
    expect(res.error).toMatch(/^UNRESOLVED_BUY: the ledger of unresolved LIVE buys could not be read/);
    expect(build).not.toHaveBeenCalled();
  });

  it('R1-35: one ACTIVE PAPER position does not take the DEVNET_LIVE slot', async () => {
    await armAuto();
    const id = `s3b_paper_${Math.random().toString(36).slice(2)}`;
    workstationDb.savePosition({
      id, mint: Keypair.generate().publicKey.toBase58(), symbol: 'P', name: 'P', tokenDecimals: 6, tokenQuantityRaw: '1', entryPriceSol: 1, currentPriceSol: 1,
      currentValueSol: 0.03, costBasisLamports: 30_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE', executionMode: 'PAPER',
      entryTxSignature: `PAPER:${id}`, entryTimestamp: Date.now(), recordUpdatedAt: Date.now(), updatedAt: Date.now(),
    } as any);
    const snipe = vi.spyOn(memecoinAggregator, 'executeSnipe').mockResolvedValue({ success: true, message: 'ok', txHash: 't', amountSol: AUTO_DEVNET_ORDER_SOL, positionId: 'dv-s3b', feesPaidLamports: 0 });
    const { mint } = newPumpPool('HOT');
    const d = await autoSnipeController.submitCandidate({ mint, symbol: 'L', source: 'TEST' as any, amountUsd: 0.7, provenance: 'REAL_ONCHAIN' });
    expect(d.reason).not.toMatch(/DEVNET_MAX_OPEN_POSITIONS/);
    expect(d.outcome, d.reason).toBe('BOUGHT');
    expect(snipe).toHaveBeenCalledTimes(1);
  });

  it('R1-62, R1-38: an auto buy whose getTransaction is null, balance down 0.0075: held, not halted; recovery journals it once and the audit explains it', async () => {
    const bal = await armAuto();
    const t0 = Date.now();
    expect(await autoSnipeController.auditWallet(t0)).toBeNull(); // the first look sets the mark

    // the auto buy landed; its fill could not be read (getTransaction null), so its row is RECONCILIATION_REQUIRED and nothing is journaled
    const mint = Keypair.generate().publicKey;
    build.mockImplementation(async () => signedTx(conn) as any);
    vi.spyOn(conn, 'getTransaction').mockResolvedValue(null);
    const a = await coordinator.executeTrade(buyReq(mint.toBase58()));
    expect(a.lifecycleState, a.error).toBe('RECONCILIATION_REQUIRED');
    expect(workstationDb.hasUnresolvedLiveBuy(mint.toBase58())).toBe(true);

    const halt = vi.spyOn(executionCoordinator, 'haltAll');
    const delta = 7_500_000;
    bal.mockReturnValue(1 - delta / SOL);
    const held = await autoSnipeController.auditWallet(t0 + 1);
    expect(held?.explained).toBe(true);
    expect(halt).not.toHaveBeenCalled();
    expect(autoSnipeController.getMode()).toBe('DEVNET_LIVE');

    // orphan recovery reads the landed buy and adopts it: one LIVE_BUY_FILLED row with the whole wallet delta
    vi.spyOn(conn, 'getTransaction').mockResolvedValue(landedBuy(wallet.publicKey, mint, delta) as any);
    const rec = await coordinator.recoverOrphanedBuys();
    expect(rec.recovered).toEqual([a.txSignature]);
    await coordinator.recoverOrphanedBuys(); // idempotent: already RECONCILED, journals nothing more
    const rows = workstationDb.loadDecisions({ mint: mint.toBase58(), outcome: LIVE_BUY_FILLED });
    expect(rows).toHaveLength(1);
    expect(rows[0].solDelta).toBeCloseTo(-delta / SOL, 12);
    expect(workstationDb.sumDecisionSolDelta(t0, Date.now() + 1).delta).toBeCloseTo(-delta / SOL, 12);

    const after = await autoSnipeController.auditWallet(Date.now() + 2);
    expect(after?.explained).toBe(true);
    expect(after?.unexplainedSol).toBeCloseTo(0, 9);
    expect(halt).not.toHaveBeenCalled();
    expect(executionCoordinator.getHaltReason()).toBeNull();
  });

  it('R1-62: a drop larger than the unresolved buys can take still halts', () => {
    const journal = { delta: 0, gross: 0, count: 0 };
    const unresolved = { worstCaseSol: 0.0075, count: 1 };
    expect(auditWalletChange(1, 1 - 0.0075, journal, unresolved)).toMatchObject({ explained: true, heldByUnresolved: true });
    expect(auditWalletChange(1, 1 - 0.0075, journal).explained).toBe(false); // the same drop with nothing unresolved
    expect(auditWalletChange(1, 1 - 0.0075 - WALLET_AUDIT_RENT_ALLOWANCE_SOL - 0.01, journal, unresolved).explained).toBe(false);
    expect(auditWalletChange(1, 1.01, journal, unresolved).explained).toBe(false); // a rise is never an unresolved buy
  });

  it('R1-38: a manual LIVE buy during DEVNET_LIVE journals its wallet delta once and does not halt', async () => {
    const bal = await armAuto();
    const t0 = Date.now();
    expect(await autoSnipeController.auditWallet(t0)).toBeNull();
    const delta = 7_500_000;
    confirmEdges(delta);
    const mint = Keypair.generate().publicKey.toBase58();
    const res = await coordinator.executeTrade(buyReq(mint, 'MANUAL'));
    expect(res.lifecycleState, res.error).toBe('CONFIRMED');
    const rows = workstationDb.loadDecisions({ mint, outcome: LIVE_BUY_FILLED });
    expect(rows).toHaveLength(1);
    expect(rows[0].solDelta).toBeCloseTo(-delta / SOL, 12);
    expect(rows[0].positionId).toBe(res.positionId);

    const halt = vi.spyOn(executionCoordinator, 'haltAll');
    bal.mockReturnValue(1 - delta / SOL);
    const audit = await autoSnipeController.auditWallet(Date.now() + 1);
    expect(audit?.explained).toBe(true);
    expect(halt).not.toHaveBeenCalled();
    expect(executionCoordinator.getHaltReason()).toBeNull();
  });

  it('R1-127, R1-38: an auto DEVNET_LIVE buy counts its whole wallet delta (rent included) in spentSol, and journals it once', async () => {
    await armAuto();
    const delta = 5_000_000 + RENT + 1_346_200 + 15_000; // order, token-account rent, first-buy accumulator rent, fee and tip
    confirmEdges(delta);
    vi.spyOn(memecoinAggregator, 'executeSnipe').mockImplementation(async (p: any) => {
      const r = await coordinator.executeTrade(buyReq(p.contractAddress));
      return { success: r.success, message: r.error ?? 'ok', txHash: r.txSignature ?? '', amountSol: p.amountSolOverride, positionId: r.positionId, feesPaidLamports: r.feesPaidLamports };
    });
    const t0 = Date.now();
    const { mint } = newPumpPool('HOT');
    const d = await autoSnipeController.submitCandidate({ mint, symbol: 'S', source: 'TEST' as any, amountUsd: 0.7, provenance: 'REAL_ONCHAIN' });
    expect(d.outcome, d.reason).toBe('BOUGHT');
    expect(autoSnipeController.getStatus().session!.spentSol).toBeCloseTo(delta / SOL, 12);
    // counted once: the coordinator's LIVE_BUY_FILLED row carries the delta, the controller's BOUGHT row none
    const rows = workstationDb.loadDecisions({ mint, sinceTs: t0 });
    expect(rows.filter((r) => r.solDelta !== null).map((r) => r.outcome)).toEqual([LIVE_BUY_FILLED]);
    expect(rows.find((r) => r.outcome === 'BOUGHT')!.solDelta).toBeNull();
    expect(workstationDb.sumDecisionSolDelta(t0 - 1, Date.now() + 1).delta).toBeCloseTo(-delta / SOL, 12);
  });

  it('R1-127: an auto buy that returns UNCONFIRMED counts its worst case, then the real delta once orphan recovery adopts it', async () => {
    await armAuto();
    const delta = 6_100_000;
    build.mockImplementation(async () => signedTx(conn) as any);
    vi.spyOn(conn, 'sendRawTransaction').mockRejectedValue(new Error('fetch failed'));
    let sig = '';
    vi.spyOn(memecoinAggregator, 'executeSnipe').mockImplementation(async (p: any) => {
      const r = await coordinator.executeTrade(buyReq(p.contractAddress));
      sig = r.txSignature ?? '';
      return { success: false, message: r.error ?? '', txHash: '' };
    });
    const { mint } = newPumpPool('HOT');
    const d = await autoSnipeController.submitCandidate({ mint, symbol: 'U', source: 'TEST' as any, amountUsd: 0.7, provenance: 'REAL_ONCHAIN' });
    expect(d.outcome).toBe('REJECTED');
    expect(d.reason).toMatch(/^UNCONFIRMED/);
    const worst = autoSnipeController.getStatus().session!.spentSol;
    expect(worst).toBeGreaterThan(AUTO_DEVNET_ORDER_SOL + (RENT + 1_346_200) / SOL); // order, slippage headroom and both rents

    vi.spyOn(conn, 'getTransaction').mockResolvedValue(landedBuy(wallet.publicKey, new PublicKey(mint), delta) as any);
    expect((await coordinator.recoverOrphanedBuys()).recovered).toEqual([sig]);
    expect(autoSnipeController.getStatus().session!.spentSol).toBeCloseTo(delta / SOL, 12);
  });
});
