import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { TradeReconciler } from '../server/execution/reconciliation';
import { txBuilder } from '../server/solana/transactionBuilder';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';
import { settleLeftoverLiveBuys } from './helpers/leftoverBuys';

/**
 * Sell-side double-send safety (haiku attack 2026-10-26, combined fix order step 5): R1 #2, R4-8, R5-8, R4-7, R5-7/R6-9, R7-11, A95.
 * Real ExecutionCoordinator.closePosition and SQLite. Stubbed at the edges only: the Connection (MockSolanaRpc plus per-test RPC answers),
 * the builder, the venue lookup, the quote, the send (submitAndConfirmWithRetry) and the fill read (reconcileSellTransaction).
 */
describe('C2: a pending sell is held until it is proven unable to land, and never sent twice', () => {
  let coordinator: ExecutionCoordinator;
  let rpc: MockSolanaRpc;
  let conn: any;
  let submit: ReturnType<typeof vi.spyOn>;
  let quoteSpy: ReturnType<typeof vi.spyOn>;
  let recon: ReturnType<typeof vi.spyOn>;
  let posId: string;
  const TOTAL = 1_000_000_000n;

  const mkPosition = () => {
    const id = `c2_${Math.random().toString(36).slice(2)}`;
    workstationDb.savePosition({
      id, mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'C2', name: 'C2 Coin', tokenDecimals: 6,
      tokenQuantityRaw: TOTAL.toString(), entryPriceSol: 0.0001, currentPriceSol: 0.00015, currentValueSol: 0.15,
      costBasisLamports: 100_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE', exitStage: 0,
      executionMode: 'LIVE', entryTxSignature: `sig_${id}`, entryTimestamp: Date.now(), lastMarkTimestamp: Date.now(),
      recordUpdatedAt: Date.now(), updatedAt: Date.now(),
    } as any);
    return id;
  };
  const row = () => workstationDb.loadPositions().find((p) => p.id === posId)!;
  const balance = (amount: string | Error) => {
    conn.getTokenAccountBalance = vi.fn(async () => { if (amount instanceof Error) throw amount; return { context: { slot: 10 }, value: { amount } }; });
  };
  const sigStatus = (v: any) => { conn.getSignatureStatuses = vi.fn(async () => ({ context: { slot: 10 }, value: [v] })); };
  const sold = (n: bigint) => ({
    success: true, reconciliationState: 'RECONCILED', actualTokensSoldRaw: n.toString(), tokensSoldHuman: Number(n) / 1e6, tokenDecimals: 6,
    actualGrossSolProceedsLamports: 50_000_000, actualNetSolProceedsLamports: 49_000_000, actualNetworkFeeLamports: 5000,
    actualJitoTipLamports: 0, actualRealizedPnLSol: 0.016, remainingTokensRaw: (TOTAL - n).toString(), isFullyClosed: n >= TOTAL, slot: 6,
  });
  /** A 33% take-profit whose send went out and was never confirmed: a pending sell with lastValidBlockHeight 1,000. */
  const pendingTp1 = async () => {
    submit.mockResolvedValueOnce({ success: false, signature: 'tp1_unconfirmed', transport: 'SOLANA_RPC', error: 'UNCONFIRMED', lifecycleState: 'REVERTED', unconfirmed: true });
    const first = await coordinator.closePosition(posId, 33, 'TAKE_PROFIT_1');
    expect(first.success).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
    const p = (coordinator as any).pendingSells.get(posId);
    expect(p?.signature).toBe('tp1_unconfirmed');
    return p;
  };

  beforeEach(async () => {
    settleLeftoverLiveBuys();
    const kp = Keypair.generate();
    rpc = new MockSolanaRpc();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(kp.publicKey);
    vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => tx);
    PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() };
    PumpCurveService.cachedFeeConfig = { feeBps: 100 };
    const realInit = (ExecutionCoordinator.prototype as any).initializeConnection;
    let initDone: Promise<unknown> = Promise.resolve();
    vi.spyOn(ExecutionCoordinator.prototype as any, 'initializeConnection').mockImplementation(function (this: any) {
      initDone = Promise.resolve(realInit.call(this));
      return initDone;
    });
    coordinator = new ExecutionCoordinator(rpc.createConnection());
    await initDone;
    conn = (coordinator as any).connection;
    conn.simulateTransaction = vi.fn(async () => ({ context: { slot: 1 }, value: { err: null, logs: [] } }));
    conn.getBlockHeight = vi.fn(async () => 900);
    sigStatus(null);
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE' } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
    quoteSpy = vi.spyOn(PumpCurveService, 'calculateSellQuote').mockReturnValue({ expectedJitoTipLamports: 0, minOutputLamports: 1 } as any);
    vi.spyOn(txBuilder, 'buildSellTransaction').mockResolvedValue({} as any);
    vi.spyOn(txBuilder, 'lastValidBlockHeightOf').mockReturnValue(1_000);
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: TOTAL.toString(), tokenDecimals: 6, timestamp: Date.now() });
    submit = vi.spyOn(coordinator as any, 'submitAndConfirmWithRetry').mockResolvedValue({ success: true, signature: 'sell_ok', transport: 'SOLANA_RPC', slot: 5, lifecycleState: 'CONFIRMED' });
    recon = vi.spyOn(TradeReconciler, 'reconcileSellTransaction').mockResolvedValue(sold(330_000_000n) as any);
    posId = mkPosition();
    balance(TOTAL.toString());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    coordinator.cleanup();
    rpc.clear();
  });

  it('R1 #2: past the 100 s window, a failed wallet read keeps the hold; the same partial is not sent again', async () => {
    const p = await pendingTp1();
    p.ts = Date.now() - 200_000; // the window has passed
    balance(new Error('429 Too Many Requests'));
    const again = await coordinator.closePosition(posId, 33, 'TAKE_PROFIT_1');
    expect(again.error).toMatch(/^SELL_PENDING_VERIFICATION/);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('R4-8: past the window, an unchanged wallet with a blockhash still valid keeps the hold (no release on the clock alone)', async () => {
    const p = await pendingTp1();
    p.ts = Date.now() - 200_000;
    conn.getBlockHeight = vi.fn(async () => 1_000); // not past lastValidBlockHeight
    const again = await coordinator.closePosition(posId, 33, 'TAKE_PROFIT_1');
    expect(again.error).toMatch(/^SELL_PENDING_VERIFICATION/);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('R4-8: once the confirmed block height is past lastValidBlockHeight and the signature has no status, the next sell goes out', async () => {
    await pendingTp1();
    conn.getBlockHeight = vi.fn(async () => 1_001);
    const next = await coordinator.closePosition(posId, 100, 'STOP_LOSS');
    expect(next.error ?? '').not.toMatch(/SELL_PENDING_VERIFICATION/);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(conn.getBlockHeight).toHaveBeenCalledWith('confirmed');
  });

  it('R5-8: a landed partial is adopted from its own signature even when a transfer topped the wallet back up', async () => {
    const p = await pendingTp1();
    p.ts = Date.now() - 200_000;
    sigStatus({ slot: 9, confirmations: 3, err: null, confirmationStatus: 'confirmed' });
    balance('1200000000'); // 330,000,000 sold, then 530,000,000 sent in from outside
    const again = await coordinator.closePosition(posId, 33, 'TAKE_PROFIT_1');
    expect(again.success, again.error).toBe(true);
    expect(again.adoptedPendingSell).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1); // adopted, not sent a second time
    const r = row();
    expect(r.tokenQuantityRaw).toBe('670000000');
    expect(r.status).toBe('PARTIALLY_CLOSED');
    expect(r.exitStage).toBe(1);
  });

  it('R4-7: a landed sell whose post-fill row read throws is still held as pending, so the next pass adopts it instead of selling again', async () => {
    let sent = false;
    submit.mockImplementationOnce(async () => { sent = true; return { success: true, signature: 'landed_tp1', transport: 'SOLANA_RPC', slot: 5, lifecycleState: 'CONFIRMED' }; });
    const realLoad = workstationDb.loadPositions.bind(workstationDb);
    const load = vi.spyOn(workstationDb, 'loadPositions').mockImplementation(((...a: any[]) => {
      if (sent) { sent = false; throw new Error('SQLITE_IOERR: disk I/O error'); }
      return (realLoad as any)(...a);
    }) as any);
    const first = await coordinator.closePosition(posId, 33, 'TAKE_PROFIT_1');
    expect(first.success).toBe(false);
    load.mockRestore();
    expect((coordinator as any).pendingSells.get(posId)?.signature).toBe('landed_tp1');
    // the DB is back; the wallet shows the sale: adopted, not sold again
    sigStatus({ slot: 9, confirmations: 3, err: null, confirmationStatus: 'confirmed' });
    balance('670000000');
    const again = await coordinator.closePosition(posId, 33, 'TAKE_PROFIT_1');
    expect(again.success, again.error).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(row().exitStage).toBe(1);
  });

  it('R4-7: a sell that is booked leaves no pending marker behind', async () => {
    const res = await coordinator.closePosition(posId, 33, 'TAKE_PROFIT_1');
    expect(res.success, res.error).toBe(true);
    expect((coordinator as any).pendingSells.has(posId)).toBe(false);
  });

  it('R5-7/R6-9: a manual 100% close that adopts a pending TP1 advances the stage and says it only adopted a partial', async () => {
    await pendingTp1();
    balance('670000000');
    const res = await coordinator.closePosition(posId, 100, 'Operator close');
    expect(res.success, res.error).toBe(true);
    expect(res.adoptedPendingSell).toBe(true);
    expect(res.adoptedPartial).toBe(true);
    expect(res.remainingTokensRaw).toBe('670000000');
    expect(submit).toHaveBeenCalledTimes(1);
    const r = row();
    expect(r.status).toBe('PARTIALLY_CLOSED');
    expect(r.exitStage).toBe(1); // TP1 will not fire again on the remainder
    expect(r.exitReason).toBe('TAKE_PROFIT_1');
  });

  it('R7-11: the quantity is computed from the row as it is after the claim, not from the copy read before it', async () => {
    // a sell that finished during the tip-floor await (before the claim) left 670,000,000
    vi.spyOn(coordinator.getJitoTransport(), 'getTipFloorLamports').mockImplementation(async () => {
      workstationDb.savePosition({ ...row(), tokenQuantityRaw: '670000000', status: 'PARTIALLY_CLOSED', exitStage: 1 } as any);
      return 0;
    });
    balance('670000000');
    const res = await coordinator.closePosition(posId, 33, 'TAKE_PROFIT_2');
    expect(res.success, res.error).toBe(true);
    expect(String((quoteSpy.mock.calls.at(-1)![0] as any).tokenAmountRaw)).toBe(((670_000_000n * 3300n) / 10_000n).toString());
  });

  it('A95: a partial sell is clamped to the wallet, and the row is scaled to it first', async () => {
    balance('400000000'); // the row says 1,000,000,000
    const res = await coordinator.closePosition(posId, 50, 'TAKE_PROFIT_1');
    expect(res.success, res.error).toBe(true);
    expect(String((quoteSpy.mock.calls.at(-1)![0] as any).tokenAmountRaw)).toBe('200000000');
    expect(coordinator.getOperatorAlerts().some((a) => a.code === 'POSITION_BALANCE_CLAMPED' && a.positionId === posId)).toBe(true);
  });
});
