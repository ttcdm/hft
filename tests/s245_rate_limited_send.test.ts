import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import bs58 from 'bs58';
import { Keypair, PublicKey, SendTransactionError, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ExecutionCoordinator, SELL_RATE_LIMIT_BACKOFF_MS, SELL_SLIPPAGE_LADDER_BPS, executionCoordinator } from '../server/execution/coordinator';
import { emergencyStop, PANIC_CLOSE_REASON } from '../server/execution/emergencyStop';
import { autoSnipeController } from '../server/auto/controller';
import { localSigner } from '../server/solana/signer';
import { riskEngine } from '../server/risk/riskEngine';
import { workstationDb } from '../server/db/database';
import { executionConfig } from '../server/solana/executionConfig';
import { SolanaRpcTransport, isDefiniteSendRejection, isRateLimitedSendError, sendBackoff } from '../server/solana/transports';
import { createTradingConnection } from '../server/solana/rpcConnection';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { TradeReconciler } from '../server/execution/reconciliation';
import { txBuilder } from '../server/solana/transactionBuilder';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState, createPassingEligibilityReport } from './e2e/helpers/simulatedStates';
import { settleLeftoverLiveBuys } from './helpers/leftoverBuys';

/**
 * S245: a send the RPC refused with a rate limit (the public devnet RPC: HTTP 429 with a JSON-RPC -32007 body, "15/second request limit
 * reached") was not accepted. It used to be read as an unknown outcome, so a sell left a pending sell that refused every later sell of the
 * position (the stop-loss and /panic_sell included). Now it is a definite rejection; a SELL is resent after SELL_RATE_LIMIT_BACKOFF_MS
 * without moving the slippage ladder, and a BUY fails closed.
 *
 * Real ExecutionCoordinator, SolanaRpcTransport, emergencyStop and SQLite. The network doubles are the Connection (MockSolanaRpc) with its
 * sendRawTransaction spied to throw the errors web3.js 1.x really throws, captured below from a real trading Connection whose fetch
 * answers like the public devnet RPC; the builder, quote and reconciler edges are stubbed as in the other LIVE sell suites; the resend
 * wait (sendBackoff.sleep) is a spy, so nothing sleeps for real.
 */
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const LIMIT_BODY = JSON.stringify({ jsonrpc: '2.0', id: '1', error: { code: -32007, message: '15/second request limit reached - reduce your rate or get a dedicated node' } });

/** The error web3.js throws for sendRawTransaction when the RPC answers with `status` and `body`, through the app's own trading Connection. */
async function web3SendError(status: number, body: string, statusText = ''): Promise<Error> {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(body, { status, statusText, headers: { 'content-type': 'application/json' } }));
  try {
    const conn = createTradingConnection('http://127.0.0.1:8899');
    const err = await conn.sendRawTransaction(Buffer.alloc(8), { skipPreflight: true }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    return err as Error;
  } finally {
    fetchSpy.mockRestore();
  }
}
const http429 = () => web3SendError(429, LIMIT_BODY, 'Too Many Requests');
const rpc32007 = () => web3SendError(200, LIMIT_BODY);

async function signedTx(conn: any, payer = Keypair.generate()): Promise<VersionedTransaction> {
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 })] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  return tx;
}
const sigOf = (raw: Buffer | Uint8Array) => bs58.encode(VersionedTransaction.deserialize(Uint8Array.from(raw)).signatures[0]);

describe('S245 (a): the real web3.js rate-limit errors are definite rejections', () => {
  afterEach(() => vi.restoreAllMocks());

  it('HTTP 429 (a plain Error starting "429") and a JSON-RPC -32007 body (SendTransactionError) are rate limits and definite', async () => {
    const e429 = await http429();
    expect(e429).not.toBeInstanceOf(SendTransactionError);
    expect(e429.message).toMatch(/^429 Too Many Requests: .*-32007/);
    const e32007 = await rpc32007();
    expect(e32007).toBeInstanceOf(SendTransactionError);
    expect(e32007.message).toMatch(/15\/second request limit reached/);
    // HTTP/2 has no status text: web3.js then writes "429 : <body>"
    const bare = await web3SendError(429, 'Too Many Requests');
    expect(bare.message).toMatch(/^429 /);
    for (const e of [e429, e32007, bare]) {
      expect(isRateLimitedSendError(e)).toBe(true);
      expect(isDefiniteSendRejection(e)).toBe(true);
    }
    expect(isRateLimitedSendError({ code: -32005, message: 'Node is unhealthy' })).toBe(true);
    // unchanged: a network failure, a timeout, a 5xx page and "already processed" stay ambiguous, and are not rate limits
    const ambiguous = [new Error('fetch failed'), new Error('socket hang up'), new Error('RPC_TIMEOUT: sendTransaction got no answer within 1500 ms'),
      await web3SendError(502, '<html>502 Bad Gateway</html>', 'Bad Gateway'), await web3SendError(503, 'unavailable', 'Service Unavailable'),
      new SendTransactionError({ action: 'send', signature: '', transactionMessage: 'This transaction has already been processed' })];
    for (const e of ambiguous) {
      expect(isRateLimitedSendError(e), e.message).toBe(false);
      expect(isDefiniteSendRejection(e), e.message).toBe(false);
    }
  });

  it('SolanaRpcTransport.submit reports a 429 as rateLimited and not ambiguous, keeping the signature', async () => {
    const rpc = new MockSolanaRpc();
    const conn: any = rpc.createConnection();
    const t = new SolanaRpcTransport(conn);
    const tx = await signedTx(conn);
    vi.spyOn(conn, 'sendRawTransaction').mockRejectedValueOnce(await http429()).mockRejectedValueOnce(await rpc32007());
    for (let i = 0; i < 2; i++) {
      const r = await t.submit(tx);
      expect(r.success).toBe(false);
      expect(r.rateLimited).toBe(true);
      expect(r.ambiguous).toBe(false);
      expect(r.signature).toBe(bs58.encode(tx.signatures[0]));
    }
  });
});

describe('S245: rate-limited sends through the real coordinator', () => {
  let coordinator: ExecutionCoordinator;
  let rpc: MockSolanaRpc;
  let conn: any;
  let wallet: Keypair;
  let sleep: ReturnType<typeof vi.spyOn>;
  let quote: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    settleLeftoverLiveBuys();
    for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0 } as any);
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
    sleep = vi.spyOn(sendBackoff, 'sleep').mockResolvedValue(undefined);
    // sell edges, as in p15/p4: venue, curve, quote, builder, snapshot and reconciler
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE' } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
    quote = vi.spyOn(PumpCurveService, 'calculateSellQuote').mockReturnValue({ expectedJitoTipLamports: 0, minOutputLamports: 1 } as any);
    vi.spyOn(txBuilder, 'buildSellTransaction').mockImplementation(async () => signedTx(conn));
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '1000000000', tokenDecimals: 6, timestamp: Date.now() });
    vi.spyOn(TradeReconciler, 'reconcileSellTransaction').mockResolvedValue({
      success: true, reconciliationState: 'RECONCILED', actualTokensSoldRaw: '1000000000', tokensSoldHuman: 1000, tokenDecimals: 6,
      actualGrossSolProceedsLamports: 50_000_000, actualNetSolProceedsLamports: 49_000_000, actualNetworkFeeLamports: 5000,
      actualJitoTipLamports: 0, actualRealizedPnLSol: -0.05, remainingTokensRaw: '0', isFullyClosed: true, slot: 6,
    } as any);
    vi.spyOn(conn, 'getTokenAccountBalance').mockResolvedValue({ context: { slot: 1 }, value: { amount: '1000000000', decimals: 6, uiAmount: 1000, uiAmountString: '1000' } } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    coordinator.cleanup();
    rpc.clear();
  });

  const seedLive = () => {
    const id = `s245_${Math.random().toString(36).slice(2)}`;
    workstationDb.savePosition({
      id, mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'S245', name: 'S245', tokenDecimals: 6, tokenQuantityRaw: '1000000000',
      entryPriceSol: 0.0001, currentPriceSol: 0.00005, currentValueSol: 0.05, costBasisLamports: 100_000_000, realizedPnLSol: 0,
      status: 'OPEN', venue: 'PUMP_BONDING_CURVE', executionMode: 'LIVE', entryTxSignature: `sig_${id}`, entryTimestamp: Date.now(),
      lastMarkTimestamp: Date.now(), recordUpdatedAt: Date.now(), updatedAt: Date.now(),
    } as any);
    return id;
  };
  /** sendRawTransaction answers `errors` in turn, then accepts (the transaction lands and confirms). Records the signature of each send. */
  const sendAnswering = (errors: Error[]) => {
    const sent: string[] = [];
    let n = 0;
    const spy = vi.spyOn(conn, 'sendRawTransaction').mockImplementation(async (raw: any) => {
      const sig = sigOf(raw);
      sent.push(sig);
      if (n < errors.length) throw errors[n++];
      rpc.setSignatureStatus(sig, { confirmationStatus: 'confirmed', slot: 9 });
      return sig;
    });
    return { spy, sent };
  };
  const journal = () => vi.spyOn(workstationDb, 'logJournal');
  const kinds = (j: ReturnType<typeof journal>) => j.mock.calls.map((c) => c[0]);

  it('(b) a STOP_LOSS sell rate-limited twice, then accepted: the same transaction is resent, confirms, and the ladder stays at the first rung', async () => {
    const id = seedLive();
    const j = journal();
    const { spy, sent } = sendAnswering([await http429(), await rpc32007()]);
    const res = await coordinator.closePosition(id, 100, 'STOP_LOSS');
    expect(res.success, res.error).toBe(true);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(new Set(sent).size).toBe(1); // one signed transaction, resent: it can land at most once
    expect(sleep.mock.calls.map((c) => c[0])).toEqual(SELL_RATE_LIMIT_BACKOFF_MS.slice(0, 2));
    expect(kinds(j)).not.toContain('SEND_OUTCOME_UNKNOWN'); // never treated as possibly forwarded, so no pending sell was recorded
    expect(workstationDb.loadPositions().find((p) => p.id === id)!.status).toBe('CLOSED');
    expect((quote.mock.calls[0][0] as any).slippageBps).toBe(SELL_SLIPPAGE_LADDER_BPS[0]);
    expect(coordinator.exitSlippageBps(id)).toBe(SELL_SLIPPAGE_LADDER_BPS[0]);
    expect(coordinator.getExitFailureCount(id)).toBe(0);
  });

  it('(c) rate-limited past every resend: RPC_RATE_LIMITED, no pending sell, the ladder does not move, and the next close sends and lands', async () => {
    const id = seedLive();
    const e = await http429();
    const j = journal();
    const { spy } = sendAnswering(Array(SELL_RATE_LIMIT_BACKOFF_MS.length + 1).fill(e));
    const first = await coordinator.closePosition(id, 100, 'STOP_LOSS');
    expect(first.success).toBe(false);
    expect(first.error).toMatch(/^RPC_RATE_LIMITED/);
    expect(first.error).not.toMatch(/SEND_OUTCOME_UNKNOWN/);
    expect(first.notSent).toBe(true);
    expect(spy).toHaveBeenCalledTimes(SELL_RATE_LIMIT_BACKOFF_MS.length + 1);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([...SELL_RATE_LIMIT_BACKOFF_MS]);
    expect(kinds(j)).toContain('SEND_RATE_LIMITED');
    expect(kinds(j)).not.toContain('SEND_OUTCOME_UNKNOWN');
    expect(coordinator.exitSlippageBps(id)).toBe(SELL_SLIPPAGE_LADDER_BPS[0]);
    expect(coordinator.getExitFailureCount(id)).toBe(0);
    expect(coordinator.exitRetryWaitMs(id)).toBe(0);
    expect(coordinator.getOperatorAlerts().some((a) => a.code === 'EXIT_RATE_LIMITED' && a.positionId === id && !a.cleared)).toBe(true);
    // the row of the refused sell is REVERTED, not PENDING
    expect(workstationDb.getPendingTransactions().some((t) => t.mint === VALID_PUMP_MINT_1.toBase58() && t.direction === 'SELL')).toBe(false);

    // the RPC recovers: the next close is not refused with SELL_PENDING_VERIFICATION; it sends and lands
    const second = await coordinator.closePosition(id, 100, 'STOP_LOSS');
    expect(second.error).toBeUndefined();
    expect(second.success).toBe(true);
    expect(spy).toHaveBeenCalledTimes(SELL_RATE_LIMIT_BACKOFF_MS.length + 2);
    expect((quote.mock.calls.at(-1)![0] as any).slippageBps).toBe(SELL_SLIPPAGE_LADDER_BPS[0]);
    expect(coordinator.getOperatorAlerts().some((a) => a.code === 'EXIT_RATE_LIMITED' && a.positionId === id && !a.cleared)).toBe(false);
  });

  describe('(d) emergencyStop (/panic_sell) with a rate-limited first send', () => {
    beforeEach(() => {
      // the panic's closes go to this suite's coordinator (on the mock Connection); emergencyStop itself and closePosition are real
      vi.spyOn(executionCoordinator, 'closePosition').mockImplementation((id, pct, reason) => coordinator.closePosition(id, pct, reason));
    });
    afterEach(async () => {
      riskEngine.setKillSwitch(false);
      await autoSnipeController.setMode('OFF');
    });

    it('a 429 on the first send: the panic still closes the position', async () => {
      const id = seedLive();
      const { spy } = sendAnswering([await http429()]);
      const report = await emergencyStop({ exitAll: true, reason: 's245 panic' });
      expect(report.failed).toEqual([]);
      expect(report.succeeded.map((s) => s.id)).toEqual([id]);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(workstationDb.loadPositions().find((p) => p.id === id)!.status).toBe('CLOSED');
      expect(executionCoordinator.closePosition).toHaveBeenCalledWith(id, 100, PANIC_CLOSE_REASON);
    });

    it('every resend rate-limited: reported in failed[] as RPC_RATE_LIMITED (no pending-sell block), and a second panic sells it', async () => {
      const id = seedLive();
      const { spy } = sendAnswering(Array(SELL_RATE_LIMIT_BACKOFF_MS.length + 1).fill(await http429()));
      const first = await emergencyStop({ exitAll: true, reason: 's245 panic' });
      expect(first.succeeded).toEqual([]);
      expect(first.failed.map((f) => f.id)).toEqual([id]);
      expect(first.failed[0].error).toMatch(/^RPC_RATE_LIMITED/);
      expect(first.failed[0].error).not.toMatch(/SELL_PENDING_VERIFICATION|SEND_OUTCOME_UNKNOWN/);
      const second = await emergencyStop({ exitAll: true, reason: 's245 panic again' });
      expect(second.failed).toEqual([]);
      expect(second.succeeded.map((s) => s.id)).toEqual([id]);
      expect(spy).toHaveBeenCalledTimes(SELL_RATE_LIMIT_BACKOFF_MS.length + 2);
    });
  });

  it('(e) a BUY rate-limited: SUBMIT_FAILED with no resend, its row REVERTED, and the mint is not blocked as unresolved', async () => {
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '0', tokenDecimals: 6, timestamp: Date.now() });
    vi.spyOn(txBuilder, 'buildBuyTransaction').mockImplementation(async () => signedTx(conn));
    vi.spyOn(coordinator, 'canExecuteLive').mockReturnValue({ allowed: true, reasons: [], readiness: { ready: true, components: { pumpFeed: { status: 'READY' } } } as any } as any);
    vi.spyOn(workstationDb, 'getDailyTotalPnLSol').mockReturnValue(0);
    // armed through the public routes: the wallet balance from the (mock) RPC, then armLiveTrading with the real-money flag on
    vi.stubEnv('ALLOW_LIVE_REAL_MONEY_TRADING', 'true');
    expect(await coordinator.syncRealWalletBalance()).toBeGreaterThan(0.015);
    expect(coordinator.armLiveTrading(true, 'CONFIRM_LIVE_TRADING_RISK').success).toBe(true);
    expect(coordinator.getExecutionMode()).toBe('LIVE');
    const mint = Keypair.generate().publicKey.toBase58();
    const { spy, sent } = sendAnswering([await http429()]);
    const res = await coordinator.executeTrade({
      signalTimestamp: Date.now(), mint, symbol: 'S241B', name: 'S241B', amountSol: 0.005,
      source: 'AUTO_SNIPER', provenance: 'REAL_ONCHAIN', eligibilityReport: createPassingEligibilityReport(mint),
    } as any);
    expect(res.success).toBe(false);
    expect(res.lifecycleState).toBe('SUBMIT_FAILED');
    expect(res.error).toMatch(/RPC_RATE_LIMITED/);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(workstationDb.loadTransactions().filter((t) => t.signature === sent[0]).map((t) => t.reconciliationState)).toEqual(['REVERTED']);
    expect(workstationDb.hasUnresolvedLiveBuy(mint)).toBe(false);
    expect(workstationDb.loadPositions(undefined, 'ACTIVE').some((p) => p.mint === mint)).toBe(false);
  });

  it('submitAndConfirmWithRetry: a SELL resends through the 32007 shape too; a BUY never resends', async () => {
    const mintPk = Keypair.generate().publicKey;
    const mk = async (side: 'BUY' | 'SELL') => ({
      tx: await signedTx(conn), orderId: `s245-${side}-${Date.now()}-${Math.random()}`, correlationId: 's245', side, mint: mintPk.toBase58(), mintPubkey: mintPk,
      owner: wallet.publicKey, tokenProgram: TOKEN_PROGRAM, preSnapshot: { walletSolLamports: 1e9, tokenBalanceRaw: '0', tokenDecimals: 6, timestamp: Date.now() }, jitoTipLamports: 0,
    });
    const e = await rpc32007();
    const { spy } = sendAnswering([e, e, e]);
    const sell = await coordinator.submitAndConfirmWithRetry(await mk('SELL'));
    expect(sell.success, sell.error).toBe(true);
    expect(spy).toHaveBeenCalledTimes(4);
    spy.mockRejectedValue(e);
    const buy = await coordinator.submitAndConfirmWithRetry(await mk('BUY'));
    expect(buy.success).toBe(false);
    expect(buy.lifecycleState).toBe('SUBMIT_FAILED');
    expect(buy.unconfirmed).toBeFalsy();
    expect(spy).toHaveBeenCalledTimes(5);
  });
});
