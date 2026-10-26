import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import bs58 from 'bs58';
import { Keypair, PublicKey, SendTransactionError, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { riskEngine } from '../server/risk/riskEngine';
import { workstationDb } from '../server/db/database';
import { executionConfig } from '../server/solana/executionConfig';
import { CLUSTER_GENESIS_HASH } from '../server/solana/clusterGuard';
import { JitoTransport, SolanaRpcTransport, isDefiniteSendRejection } from '../server/solana/transports';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { TradeReconciler } from '../server/execution/reconciliation';
import { txBuilder } from '../server/solana/transactionBuilder';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { MockJitoEngine } from './e2e/helpers/mockJito';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState, createPassingEligibilityReport } from './e2e/helpers/simulatedStates';
import { settleLeftoverLiveBuys } from './helpers/leftoverBuys';

/**
 * P1.5 (R1-2, R1-70, R1-82, R1-113, R1-6, R1-80, N-35): a send whose outcome is unknown is never recorded as REVERTED.
 * Real ExecutionCoordinator, SolanaRpcTransport and JitoTransport; the Connection (MockSolanaRpc) is the only network double, plus the
 * builder/reconciler edges the existing LIVE tests stub. No block engine, as on devnet, except in the Jito case.
 */
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const MAINNET = CLUSTER_GENESIS_HASH['mainnet-beta'];

/** A real signed v0 transaction (a 1-lamport self transfer), so its signature is known before the send. */
async function signedTx(conn: any, payer = Keypair.generate()): Promise<VersionedTransaction> {
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 })] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  return tx;
}
const sigOf = (raw: Buffer | Uint8Array) => bs58.encode(VersionedTransaction.deserialize(Uint8Array.from(raw)).signatures[0]);

describe('P1.5: an ambiguous send is unknown, never REVERTED', () => {
  let coordinator: ExecutionCoordinator;
  let rpc: MockSolanaRpc;
  let conn: any;
  let wallet: Keypair;

  beforeEach(async () => {
    settleLeftoverLiveBuys();
    wallet = Keypair.generate();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(wallet.publicKey);
    vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => tx);
    const realConfig = executionConfig.getConfig.bind(executionConfig);
    vi.spyOn(executionConfig, 'getConfig').mockImplementation(() => ({ ...realConfig(), jitoBlockEngineUrl: '', rpcFallbackTimeoutMs: 1200 }));
    PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() };
    PumpCurveService.cachedFeeConfig = { feeBps: 100 };
    rpc = new MockSolanaRpc();
    const realInit = (ExecutionCoordinator.prototype as any).initializeConnection;
    let initDone: Promise<unknown> = Promise.resolve();
    vi.spyOn(ExecutionCoordinator.prototype as any, 'initializeConnection').mockImplementation(function (this: any) {
      initDone = Promise.resolve(realInit.call(this));
      return initDone;
    });
    coordinator = new ExecutionCoordinator(rpc.createConnection());
    await initDone;
    conn = coordinator.getConnection();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    coordinator.cleanup();
    rpc.clear();
  });

  const params = async (orderId: string, side: 'BUY' | 'SELL' = 'BUY', mint = Keypair.generate().publicKey) => ({
    tx: await signedTx(conn), orderId, correlationId: orderId, side, mint: mint.toBase58(), mintPubkey: mint, owner: wallet.publicKey,
    tokenProgram: TOKEN_PROGRAM, preSnapshot: { walletSolLamports: 1e9, tokenBalanceRaw: '0', tokenDecimals: 6, timestamp: Date.now() }, jitoTipLamports: 0,
  });

  it('the transport keeps the signature and marks a network failure ambiguous; a sanitize rejection is definite', async () => {
    const t = new SolanaRpcTransport(conn);
    const tx = await signedTx(conn);
    vi.spyOn(conn, 'sendRawTransaction').mockRejectedValueOnce(new Error('fetch failed'));
    const r = await t.submit(tx);
    expect(r.success).toBe(false);
    expect(r.ambiguous).toBe(true);
    expect(r.signature).toBe(bs58.encode(tx.signatures[0]));
    vi.spyOn(conn, 'sendRawTransaction').mockRejectedValueOnce(new Error('failed to send transaction: invalid transaction: Transaction failed to sanitize accounts offsets correctly'));
    const d = await t.submit(tx);
    expect(d.ambiguous).toBe(false);
    expect(isDefiniteSendRejection(new Error('502 Bad Gateway: <html>'))).toBe(false);
    expect(isDefiniteSendRejection(new Error('failed to send transaction: Blockhash not found'))).toBe(true);
    // a JSON-RPC error object from the node (here a -32002 preflight failure) is a refusal; "already processed" never is
    const preflight = new SendTransactionError({ action: 'send', signature: '', transactionMessage: 'Transaction simulation failed: Error processing Instruction 2: custom program error: 0x1772' });
    expect(isDefiniteSendRejection(preflight)).toBe(true);
    expect(isDefiniteSendRejection(new SendTransactionError({ action: 'send', signature: '', transactionMessage: 'This transaction has already been processed' }))).toBe(false);
  });

  it("(a') the send throws but the transaction confirmed: success with the real signature", async () => {
    const p = await params(`p15-a2-${Date.now()}`);
    const sig = bs58.encode(p.tx.signatures[0]);
    vi.spyOn(conn, 'sendRawTransaction').mockImplementation(async (raw: any) => {
      rpc.setSignatureStatus(sigOf(raw), { confirmationStatus: 'confirmed', slot: 9 }); // it was forwarded and landed
      throw new Error('fetch failed');
    });
    const res = await coordinator.submitAndConfirmWithRetry(p);
    expect(res.success).toBe(true);
    expect(res.signature).toBe(sig);
  });

  it('(a) executeTrade: fetch failed and nothing seen yet is RECONCILIATION_REQUIRED with the real signature, and a second buy is refused', async () => {
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE' } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '0', tokenDecimals: 6, timestamp: Date.now() });
    vi.spyOn(txBuilder, 'buildBuyTransaction').mockImplementation(async () => signedTx(conn));
    vi.spyOn(coordinator, 'canExecuteLive').mockReturnValue({ allowed: true, reasons: [], readiness: { ready: true } as any } as any);
    vi.spyOn(workstationDb, 'getDailyTotalPnLSol').mockReturnValue(0);
    const recovery = vi.spyOn(coordinator as any, 'scheduleOrphanRecovery').mockImplementation(() => undefined);
    for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0 } as any);
    (coordinator as any).realWalletBalanceSol = 1;
    (coordinator as any).executionMode = 'LIVE';
    (coordinator as any).isLiveTradingArmed = true;
    let sent = '';
    const send = vi.spyOn(conn, 'sendRawTransaction').mockImplementation(async (raw: any) => { sent = sigOf(raw); throw new Error('fetch failed'); });
    const req = {
      signalTimestamp: Date.now(), mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'P15', name: 'P15', amountSol: 0.005,
      source: 'AUTO_SNIPER', provenance: 'REAL_ONCHAIN', eligibilityReport: createPassingEligibilityReport(VALID_PUMP_MINT_1.toBase58()),
    } as any;
    const res = await coordinator.executeTrade(req);
    expect(send).toHaveBeenCalledTimes(1);
    expect(res.lifecycleState).toBe('RECONCILIATION_REQUIRED');
    expect(res.txSignature).toBe(sent);
    expect(sent).not.toBe('');
    expect(workstationDb.hasUnresolvedLiveBuy(VALID_PUMP_MINT_1.toBase58())).toBe(true);
    expect(workstationDb.loadTransactions().filter((t) => t.signature === sent).map((t) => t.reconciliationState)).not.toContain('REVERTED');
    expect(workstationDb.loadTransactions().some((t) => t.signature.startsWith('failed_') && t.mint === VALID_PUMP_MINT_1.toBase58() && Date.now() - t.submissionTime < 60_000)).toBe(false);
    expect(recovery).toHaveBeenCalled();
    (riskEngine as any).lastTradeFailureTimestamp = 0; // the failure cooldown would otherwise answer first
    const again = await coordinator.executeTrade({ ...req, signalTimestamp: Date.now() });
    expect(again.success).toBe(false);
    expect(again.error).toMatch(/UNRESOLVED_BUY/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('(b) the same failure on a 33% sell leaves a pending sell, and the next exit does not sell again', async () => {
    const id = `p15_sell_${Math.random().toString(36).slice(2)}`;
    workstationDb.savePosition({
      id, mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'P15', name: 'P15', tokenDecimals: 6, tokenQuantityRaw: '1000000000',
      entryPriceSol: 0.0001, currentPriceSol: 0.0002, currentValueSol: 0.2, costBasisLamports: 100_000_000, realizedPnLSol: 0,
      status: 'OPEN', venue: 'PUMP_BONDING_CURVE', executionMode: 'LIVE', entryTxSignature: `sig_${id}`, entryTimestamp: Date.now(),
      lastMarkTimestamp: Date.now(), recordUpdatedAt: Date.now(), updatedAt: Date.now(),
    } as any);
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE' } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
    vi.spyOn(PumpCurveService, 'calculateSellQuote').mockReturnValue({ expectedJitoTipLamports: 0, minOutputLamports: 1 } as any);
    vi.spyOn(txBuilder, 'buildSellTransaction').mockImplementation(async () => signedTx(conn));
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '1000000000', tokenDecimals: 6, timestamp: Date.now() });
    const send = vi.spyOn(conn, 'sendRawTransaction').mockRejectedValue(new Error('socket hang up'));
    const first = await coordinator.closePosition(id, 33, 'TAKE_PROFIT_1');
    expect(first.success).toBe(false);
    expect(first.error).toMatch(/SEND_OUTCOME_UNKNOWN/);
    expect(send).toHaveBeenCalledTimes(1);
    vi.spyOn(conn, 'getTokenAccountBalance').mockResolvedValue({ context: { slot: 1 }, value: { amount: '1000000000', decimals: 6, uiAmount: 1000, uiAmountString: '1000' } } as any);
    const second = await coordinator.closePosition(id, 33, 'TAKE_PROFIT_1');
    expect(second.error).toMatch(/SELL_PENDING_VERIFICATION/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('(b2) S271 review: a pending sell stamped under a clock later set back 18 h holds the exit one window from now, not 18 h', async () => {
    const id = `p15_clock_${Math.random().toString(36).slice(2)}`;
    workstationDb.savePosition({
      id, mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'P15', name: 'P15', tokenDecimals: 6, tokenQuantityRaw: '1000000000',
      entryPriceSol: 0.0001, currentPriceSol: 0.0002, currentValueSol: 0.2, costBasisLamports: 100_000_000, realizedPnLSol: 0,
      status: 'OPEN', venue: 'PUMP_BONDING_CURVE', executionMode: 'LIVE', entryTxSignature: `sig_${id}`, entryTimestamp: Date.now(),
      lastMarkTimestamp: Date.now(), recordUpdatedAt: Date.now(), updatedAt: Date.now(),
    } as any);
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE' } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
    vi.spyOn(PumpCurveService, 'calculateSellQuote').mockReturnValue({ expectedJitoTipLamports: 0, minOutputLamports: 1 } as any);
    vi.spyOn(txBuilder, 'buildSellTransaction').mockImplementation(async () => signedTx(conn));
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '1000000000', tokenDecimals: 6, timestamp: Date.now() });
    vi.spyOn(conn, 'getTokenAccountBalance').mockResolvedValue({ context: { slot: 1 }, value: { amount: '1000000000', decimals: 6, uiAmount: 1000, uiAmountString: '1000' } } as any);
    const send = vi.spyOn(conn, 'sendRawTransaction').mockRejectedValue(new Error('socket hang up'));
    expect((await coordinator.closePosition(id, 33, 'TAKE_PROFIT_1')).error).toMatch(/SEND_OUTCOME_UNKNOWN/);
    // as if the sell had been sent while the clock ran 18 h ahead, with no lastValidBlockHeight to prove it expired
    const pending = (coordinator as any).pendingSells.get(id);
    pending.ts = Date.now() + 18 * 3_600_000;
    delete pending.lastValidBlockHeight;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      expect((await coordinator.closePosition(id, 33, 'TAKE_PROFIT_1')).error).toMatch(/SELL_PENDING_VERIFICATION/); // the window restarts now
      vi.setSystemTime(Date.now() + 101_000); // past PENDING_SELL_WINDOW_MS (100 s)
      const later = await coordinator.closePosition(id, 33, 'TAKE_PROFIT_1');
      expect(later.error ?? '').not.toMatch(/SELL_PENDING_VERIFICATION/); // was held until the clock caught up, 18 h
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('(c) Jito: a status read that throws inside confirm keeps polling instead of escaping as CHAIN_ERROR', async () => {
    const jito = new MockJitoEngine();
    const url = await jito.start();
    try {
      const t = new JitoTransport(conn, url);
      const sig = 'p15_jito_sig';
      rpc.setSignatureStatus(sig, { confirmationStatus: 'confirmed', slot: 4 });
      const real = conn.getSignatureStatuses.bind(conn);
      vi.spyOn(conn, 'getSignatureStatuses').mockRejectedValueOnce(new Error('ECONNRESET')).mockImplementation(real);
      const r = await t.confirm(sig, 3000);
      expect(r.confirmed).toBe(true);
      const t2 = new JitoTransport(conn, url);
      vi.spyOn(conn, 'getSignatureStatuses').mockRejectedValue(new Error('ECONNRESET'));
      const r2 = await t2.confirm('p15_never_seen', 900);
      expect(r2.lifecycleState).toBe('TIMED_OUT');
      expect(r2.error).toMatch(/ECONNRESET/);
    } finally {
      await jito.stop();
    }
  });

  it('(c) executeTrade: an exception after the PENDING row was written leaves it RECONCILIATION_REQUIRED with recovery scheduled', async () => {
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE' } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '0', tokenDecimals: 6, timestamp: Date.now() });
    vi.spyOn(txBuilder, 'buildBuyTransaction').mockImplementation(async () => signedTx(conn));
    vi.spyOn(coordinator, 'canExecuteLive').mockReturnValue({ allowed: true, reasons: [], readiness: { ready: true } as any } as any);
    vi.spyOn(workstationDb, 'getDailyTotalPnLSol').mockReturnValue(0);
    const recovery = vi.spyOn(coordinator as any, 'scheduleOrphanRecovery').mockImplementation(() => undefined);
    for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0 } as any);
    (coordinator as any).realWalletBalanceSol = 1;
    (coordinator as any).executionMode = 'LIVE';
    (coordinator as any).isLiveTradingArmed = true;
    (riskEngine as any).lastTradeFailureTimestamp = 0;
    const mint = Keypair.generate().publicKey.toBase58();
    // the RPC transport's confirm blows up past its own guard (a programming error, a broken dependency): the generic catch handles it
    vi.spyOn(SolanaRpcTransport.prototype, 'confirm').mockRejectedValue(new Error('unexpected confirm failure'));
    const res = await coordinator.executeTrade({
      signalTimestamp: Date.now(), mint, symbol: 'P15C', name: 'P15C', amountSol: 0.005,
      source: 'AUTO_SNIPER', provenance: 'REAL_ONCHAIN', eligibilityReport: createPassingEligibilityReport(mint),
    } as any);
    expect(res.lifecycleState).toBe('RECONCILIATION_REQUIRED');
    expect(res.lifecycleState).not.toBe('CHAIN_ERROR');
    const rows = workstationDb.loadTransactions().filter((t) => t.mint === mint);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((t) => t.reconciliationState === 'RECONCILIATION_REQUIRED')).toBe(true);
    expect(recovery).toHaveBeenCalled();
  });

  it('(d) a sanitize rejection is still SUBMIT_FAILED and its row REVERTED', async () => {
    const p = await params(`p15-d-${Date.now()}`);
    vi.spyOn(conn, 'sendRawTransaction').mockRejectedValue(new Error('failed to send transaction: invalid transaction: Transaction failed to sanitize accounts offsets correctly'));
    const res = await coordinator.submitAndConfirmWithRetry(p);
    expect(res.success).toBe(false);
    expect(res.lifecycleState).toBe('SUBMIT_FAILED');
    expect(res.unconfirmed).toBeFalsy();
    expect(workstationDb.loadTransactions(p.orderId).map((t) => t.reconciliationState)).toEqual(['REVERTED']);
  });

  it('(e) a mismatched genesis (no cached pass) writes no transaction row at all', async () => {
    const fresh = new MockSolanaRpc();
    fresh.genesisHash = MAINNET;
    const c2 = new ExecutionCoordinator(fresh.createConnection());
    try {
      const p = { ...(await params(`p15-e-${Date.now()}`)), tx: await signedTx(c2.getConnection()) };
      const send = vi.spyOn(c2.getConnection() as any, 'sendRawTransaction');
      const res = await c2.submitAndConfirmWithRetry(p);
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/genesis|cluster/i);
      expect(send).not.toHaveBeenCalled();
      expect(workstationDb.loadTransactions(p.orderId)).toEqual([]);
    } finally {
      c2.cleanup();
    }
  });
});
