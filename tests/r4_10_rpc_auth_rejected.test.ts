import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { executionConfig } from '../server/solana/executionConfig';
import { SolanaRpcTransport, isDefiniteSendRejection, isRateLimitedSendError } from '../server/solana/transports';
import { createTradingConnection } from '../server/solana/rpcConnection';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { TradeReconciler } from '../server/execution/reconciliation';
import { txBuilder } from '../server/solana/transactionBuilder';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';
import { settleLeftoverLiveBuys } from './helpers/leftoverBuys';

/**
 * R4-10: an RPC plan that expired (HTTP 401, 402 or 403) used to turn every send into "outcome unknown", holding each position's stop-loss
 * for the pending window, with nothing naming the cause. Now a 401/402/403 is a definite rejection with the code RPC_AUTH_REJECTED, and the
 * coordinator raises one RPC_AUTH_REJECTED operator alert, for sends and for reads through the trading Connection.
 *
 * Real ExecutionCoordinator, SolanaRpcTransport, trading Connection (web3.js) and SQLite. The network doubles are globalThis.fetch (to get the
 * error web3.js really throws) and the MockSolanaRpc Connection; the builder, quote and reconciler edges are stubbed as in the other LIVE sell suites.
 */
const AUTH_BODY = JSON.stringify({ error: 'Your plan has expired' });

function stubFetch(status: number, body = AUTH_BODY, statusText = '') {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(body, { status, statusText, headers: { 'content-type': 'application/json' } }));
}

/** The error web3.js throws for sendRawTransaction when the RPC answers with `status`, through the app's own trading Connection. */
async function web3SendError(status: number, statusText = ''): Promise<Error> {
  const fetchSpy = stubFetch(status, AUTH_BODY, statusText);
  try {
    const conn = createTradingConnection('http://127.0.0.1:8899');
    const err = await conn.sendRawTransaction(Buffer.alloc(8), { skipPreflight: true }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    return err as Error;
  } finally {
    fetchSpy.mockRestore();
  }
}

async function signedTx(conn: any, payer = Keypair.generate()): Promise<VersionedTransaction> {
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 })] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  return tx;
}

describe('R4-10: 401/402/403 from the RPC is a definite, named rejection', () => {
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

  it('the errors web3.js throws for 401, 402 and 403 (with or without a status text) are definite and not rate limits; 500 stays unknown', async () => {
    for (const [status, text] of [[401, 'Unauthorized'], [402, 'Payment Required'], [403, 'Forbidden'], [401, ''], [403, '']] as const) {
      const err = await web3SendError(status, text);
      expect(isDefiniteSendRejection(err)).toBe(true);
      expect(isRateLimitedSendError(err)).toBe(false);
    }
    // a 403 whose body talks about a limit is still an auth refusal, not a rate limit to resend through
    expect(isRateLimitedSendError(new Error('403 Forbidden: {"error":"request limit reached for this key"}'))).toBe(false);
    expect(isDefiniteSendRejection(await web3SendError(500, 'Internal Server Error'))).toBe(false);
  });

  it('the transport marks a 401 send authRejected with the RPC_AUTH_REJECTED code, not ambiguous', async () => {
    const t = new SolanaRpcTransport(conn);
    const tx = await signedTx(conn);
    const err = await web3SendError(401, 'Unauthorized');
    vi.spyOn(conn, 'sendRawTransaction').mockRejectedValueOnce(err);
    const r = await t.submit(tx);
    expect(r.success).toBe(false);
    expect(r.ambiguous).toBe(false);
    expect(r.rateLimited).toBe(false);
    expect(r.authRejected).toBe(401);
    expect(r.error).toMatch(/^RPC_AUTH_REJECTED: RPC plan expired or key refused \(HTTP 401\)/);
  });

  it('a sell refused with 402 is not held as a pending sell, does not walk the slippage ladder, and raises RPC_AUTH_REJECTED once', async () => {
    const id = `r410_sell_${Math.random().toString(36).slice(2)}`;
    workstationDb.savePosition({
      id, mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'R410', name: 'R410', tokenDecimals: 6, tokenQuantityRaw: '1000000000',
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
    const err = await web3SendError(402, 'Payment Required');
    const send = vi.spyOn(conn, 'sendRawTransaction').mockRejectedValue(err);
    const first = await coordinator.closePosition(id, 33, 'TAKE_PROFIT_1');
    expect(first.success).toBe(false);
    expect(first.error).toMatch(/^RPC_AUTH_REJECTED/);
    expect(first.error).not.toMatch(/SEND_OUTCOME_UNKNOWN/);
    expect((coordinator as any).pendingSells.has(id)).toBe(false);
    expect(coordinator.getExitFailureCount(id)).toBe(0); // no slippage step for a refusal that is not about price
    const second = await coordinator.closePosition(id, 33, 'TAKE_PROFIT_1');
    expect(second.error ?? '').not.toMatch(/SELL_PENDING_VERIFICATION/); // not held for the pending window
    expect(send).toHaveBeenCalledTimes(2);
    const alerts = coordinator.getOperatorAlerts().filter((a) => a.code === 'RPC_AUTH_REJECTED');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toMatch(/RPC plan expired or key refused: the RPC answered HTTP 402/);
    workstationDb.savePosition({ ...workstationDb.loadPositions().find((p) => p.id === id)!, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0 } as any);
  });

  it('a read (getBalance) refused with 403 through the trading Connection raises the same alert', async () => {
    const fetchSpy = stubFetch(403, AUTH_BODY, 'Forbidden');
    try {
      const trading = createTradingConnection('http://127.0.0.1:8899');
      await expect(trading.getBalance(Keypair.generate().publicKey)).rejects.toThrow(/403/);
      await expect(trading.getAccountInfo(Keypair.generate().publicKey)).rejects.toThrow(/403/);
    } finally {
      fetchSpy.mockRestore();
    }
    const alerts = coordinator.getOperatorAlerts().filter((a) => a.code === 'RPC_AUTH_REJECTED');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toMatch(/HTTP 403 to (getBalance|getAccountInfo)/);
  });
});
