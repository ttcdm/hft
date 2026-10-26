import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { Keypair, PublicKey } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { workstationDb, WorkstationDatabase, type PersistedTransaction } from '../server/db/database';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { TradeReconciler } from '../server/execution/reconciliation';
import { txBuilder } from '../server/solana/transactionBuilder';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../server/solana/programs';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';
import { settleLeftoverLiveBuys } from './helpers/leftoverBuys';

/**
 * Review group E (2026-10-24 review of S249-S266): trade bookkeeping. Real coordinator, TradeReconciler boundaries and SQLite; RPC answers,
 * the sell builder and the submit step are scripted. Wallet keys are freshly generated throwaway values; nothing reaches a cluster.
 */
const uid = () => Math.random().toString(36).slice(2);
const MINT = VALID_PUMP_MINT_1.toBase58();
const sellFill = (sold: string, remaining: string, pnl: number, net: number) => ({
  success: true, reconciliationState: 'RECONCILED', actualTokensSoldRaw: sold, tokensSoldHuman: Number(sold) / 1e6, tokenDecimals: 6,
  actualGrossSolProceedsLamports: net + 5000, actualNetSolProceedsLamports: net, actualNetworkFeeLamports: 5000,
  actualJitoTipLamports: 0, actualRealizedPnLSol: pnl, remainingTokensRaw: remaining, isFullyClosed: remaining === '0', slot: 6,
}) as any;

const clearLedger = () => {
  for (const p of workstationDb.loadPositions()) if (p.status !== 'CLOSED') workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0 } as any);
  for (const t of workstationDb.loadTransactions()) if (['PENDING', 'RECONCILIATION_REQUIRED'].includes(t.reconciliationState)) workstationDb.saveTransaction({ ...t, reconciliationState: 'REVERTED' });
};

describe('Review E: LIVE sell bookkeeping in closePosition', () => {
  let coordinator: ExecutionCoordinator;
  let mockRpc: MockSolanaRpc;
  let conn: any;
  let submit: ReturnType<typeof vi.spyOn>;
  let recon: ReturnType<typeof vi.spyOn>;
  let posId: string;
  let sent: string[];

  beforeEach(async () => {
    settleLeftoverLiveBuys();
    clearLedger();
    mockRpc = new MockSolanaRpc();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(Keypair.generate().publicKey);
    vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => tx);
    PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() };
    PumpCurveService.cachedFeeConfig = { feeBps: 100 };
    const realInit = (ExecutionCoordinator.prototype as any).initializeConnection;
    let initDone: Promise<unknown> = Promise.resolve();
    vi.spyOn(ExecutionCoordinator.prototype as any, 'initializeConnection').mockImplementation(function (this: any) {
      initDone = Promise.resolve(realInit.call(this));
      return initDone;
    });
    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
    await initDone;
    conn = (coordinator as any).connection;
    conn.simulateTransaction = vi.fn(async () => ({ context: { slot: 1 }, value: { err: null, logs: [] } }));
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE' } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
    vi.spyOn(PumpCurveService, 'calculateSellQuote').mockReturnValue({ expectedJitoTipLamports: 1000, minOutputLamports: 1 } as any);
    vi.spyOn(txBuilder, 'buildSellTransaction').mockResolvedValue({} as any);
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '1000000000', tokenDecimals: 6, timestamp: Date.now() } as any);
    // each send writes its PENDING SELL row (as submitAndConfirmWithRetry does before sending) and confirms
    sent = [];
    submit = vi.spyOn(coordinator as any, 'submitAndConfirmWithRetry').mockImplementation(async (p: any) => {
      const signature = `e_sell_${sent.length + 1}_${uid()}`;
      sent.push(signature);
      workstationDb.saveTransaction({
        signature, orderId: p.orderId, correlationId: p.correlationId, mint: p.mint, direction: 'SELL', submissionTransport: 'SOLANA_RPC',
        submissionTime: Date.now(), reconciliationState: 'PENDING', networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE',
      });
      return { success: true, signature, transport: 'SOLANA_RPC', slot: 5, lifecycleState: 'CONFIRMED' };
    });
    recon = vi.spyOn(TradeReconciler, 'reconcileSellTransaction').mockResolvedValue(sellFill('500000000', '500000000', -0.025, 24_995_000));
    vi.spyOn(coordinator, 'canExecuteLive').mockReturnValue({ allowed: true, reasons: [], readiness: { ready: true } as any } as any);
    posId = `e_${uid()}`;
    workstationDb.savePosition({
      id: posId, mint: MINT, symbol: 'E', name: 'E Coin', tokenDecimals: 6, tokenQuantityRaw: '1000000000', entryPriceSol: 0.0001,
      currentPriceSol: 0.00005, currentValueSol: 0.05, costBasisLamports: 100_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE',
      executionMode: 'LIVE', entryTxSignature: `sig_${posId}`, entryTimestamp: Date.now(), lastMarkTimestamp: Date.now(),
      recordUpdatedAt: Date.now(), updatedAt: Date.now(),
    } as any);
  });

  afterEach(() => {
    try { (workstationDb as any).db.exec('DROP TRIGGER IF EXISTS e_fail_reconcile'); } catch { /* not created */ }
    vi.restoreAllMocks();
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    coordinator.cleanup();
    mockRpc.clear();
    clearLedger();
  });

  const row = () => workstationDb.loadPositions().find((p) => p.id === posId)!;
  const txState = (sig: string) => workstationDb.loadTransactions().find((t) => t.signature === sig)?.reconciliationState;

  it('L2: the adoption path books on the row as it is after its awaits, so a write made meanwhile is not undone', async () => {
    recon.mockResolvedValueOnce({ success: false, reconciliationState: 'RECONCILIATION_REQUIRED', error: 'fill unreadable' } as any);
    const first = await coordinator.closePosition(posId, 50, 'TAKE_PROFIT_1');
    expect(first.success).toBe(false); // the sell was sent; its fill could not be read, so it is pending
    conn.getTokenAccountBalance = vi.fn(async () => ({ context: { slot: 50 }, value: { amount: '500000000' } }));
    recon.mockImplementationOnce(async () => {
      // while the adopted sell's transaction is read, the exit engine records a take-profit stage on the row
      workstationDb.savePosition({ ...row(), exitStage: 2 } as any);
      return sellFill('500000000', '500000000', -0.025, 24_995_000);
    });
    const adopted = await coordinator.closePosition(posId, 50, 'TAKE_PROFIT_2');
    expect(adopted).toMatchObject({ success: true, pnlSol: -0.025 });
    expect(submit).toHaveBeenCalledTimes(1);
    const after = row();
    expect(after.exitStage).toBe(2);
    expect(after.status).toBe('PARTIALLY_CLOSED');
    expect(after.tokenQuantityRaw).toBe('500000000');
    expect(after.realizedPnLSol).toBeCloseTo(-0.025, 9);
    expect(txState(sent[0])).toBe('RECONCILED');
  });

  it('S258: a stop between booking a sell and marking its row RECONCILED cannot make startup reconciliation book it twice', async () => {
    // the write that marks the first sell RECONCILED fails (as if the process stopped right after booking it)
    const db = (workstationDb as any).db;
    const armTrigger = (sig: string) => db.exec(`CREATE TRIGGER e_fail_reconcile BEFORE UPDATE ON transactions WHEN OLD.signature = '${sig}' AND NEW.reconciliation_state = 'RECONCILED' BEGIN SELECT RAISE(ABORT, 'injected stop'); END`);
    submit.mockImplementationOnce(async (p: any) => {
      const signature = `e_sell_1_${uid()}`;
      sent.push(signature);
      workstationDb.saveTransaction({
        signature, orderId: p.orderId, correlationId: p.correlationId, mint: p.mint, direction: 'SELL', submissionTransport: 'SOLANA_RPC',
        submissionTime: Date.now(), reconciliationState: 'PENDING', networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE',
      });
      armTrigger(signature);
      return { success: true, signature, transport: 'SOLANA_RPC', slot: 5, lifecycleState: 'CONFIRMED' };
    });
    await coordinator.closePosition(posId, 50, 'TAKE_PROFIT_1');
    db.exec('DROP TRIGGER IF EXISTS e_fail_reconcile');
    // invariant: a sell is on the position only together with its RECONCILED row
    const afterFirst = row();
    if (txState(sent[0]) !== 'RECONCILED') {
      expect(afterFirst.realizedPnLSol ?? 0).toBe(0);
      expect(afterFirst.tokenQuantityRaw).toBe('1000000000');
    }

    // the wallet shows the first sell landed; the next take-profit runs
    conn.getTokenAccountBalance = vi.fn(async () => ({ context: { slot: 50 }, value: { amount: '500000000' } }));
    await coordinator.closePosition(posId, 50, 'TAKE_PROFIT_2');
    const booked = row().realizedPnLSol ?? 0;

    // a restart: startup reconciliation re-reads every PENDING sell from the chain
    conn.getSignatureStatuses = vi.fn(async (sigs: string[]) => ({ context: { slot: 60 }, value: sigs.map(() => ({ slot: 6, confirmations: null, err: null, confirmationStatus: 'finalized' })) }));
    conn.getTransaction = vi.fn(async () => ({ slot: 6, blockTime: Math.floor(Date.now() / 1000), meta: { err: null, fee: 5000 } }));
    conn.getParsedTokenAccountsByOwner = vi.fn(async () => ({ context: { slot: 60 }, value: [] }));
    vi.spyOn(TradeReconciler, 'recoverInterruptedTransaction').mockResolvedValue({
      recovered: true, type: 'SELL', mint: MINT, tokenDecimals: 6, tokensSoldRaw: '500000000', tokenBeforeRaw: '1000000000',
      remainingTokensRaw: '500000000', solReceivedLamports: 24_995_000, slot: 6,
    } as any);
    await coordinator.startupReconciliation();
    expect(row().realizedPnLSol ?? 0).toBeCloseTo(booked, 9);
    for (const s of sent) expect(txState(s)).toBe('RECONCILED');
  });

  it('S258: when the booking write fails nothing is booked, and the next pass adopts the landed sell from the wallet once', async () => {
    const db = (workstationDb as any).db;
    submit.mockImplementationOnce(async (p: any) => {
      const signature = `e_sell_1_${uid()}`;
      sent.push(signature);
      workstationDb.saveTransaction({
        signature, orderId: p.orderId, correlationId: p.correlationId, mint: p.mint, direction: 'SELL', submissionTransport: 'SOLANA_RPC',
        submissionTime: Date.now(), reconciliationState: 'PENDING', networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE',
      });
      db.exec(`CREATE TRIGGER e_fail_reconcile BEFORE UPDATE ON transactions WHEN OLD.signature = '${signature}' BEGIN SELECT RAISE(ABORT, 'injected'); END`);
      return { success: true, signature, transport: 'SOLANA_RPC', slot: 5, lifecycleState: 'CONFIRMED' };
    });
    const first = await coordinator.closePosition(posId, 50, 'TAKE_PROFIT_1');
    db.exec('DROP TRIGGER IF EXISTS e_fail_reconcile');
    expect(first.success).toBe(false);
    expect(first.error).toMatch(/SELL_BOOKING_FAILED/);
    expect(row().tokenQuantityRaw).toBe('1000000000');
    expect(row().realizedPnLSol ?? 0).toBe(0);

    conn.getTokenAccountBalance = vi.fn(async () => ({ context: { slot: 50 }, value: { amount: '500000000' } }));
    const second = await coordinator.closePosition(posId, 50, 'TAKE_PROFIT_2');
    expect(second).toMatchObject({ success: true, pnlSol: -0.025 });
    expect(submit).toHaveBeenCalledTimes(1); // adopted, not sold again
    expect(row().realizedPnLSol).toBeCloseTo(-0.025, 9);
    expect(row().tokenQuantityRaw).toBe('500000000');
    expect(txState(sent[0])).toBe('RECONCILED');
  });
});

describe('Review E: wallet balance reads that close a position (S259, S260)', () => {
  let coordinator: ExecutionCoordinator;
  let mockRpc: MockSolanaRpc;
  let conn: any;
  let wallet: PublicKey;

  beforeEach(() => {
    clearLedger();
    mockRpc = new MockSolanaRpc();
    wallet = Keypair.generate().publicKey;
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(wallet);
    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
    conn = (coordinator as any).connection;
    conn.getBalance = vi.fn(async () => 1_000_000_000);
    conn.getParsedTokenAccountsByOwner = vi.fn(async () => ({ context: { slot: 1 }, value: [] }));
    conn.getSignatureStatuses = vi.fn(async () => ({ context: { slot: 1 }, value: [null] }));
    (coordinator as any).rpcHealth = 'HEALTHY';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    coordinator.cleanup();
    mockRpc.clear();
    clearLedger();
  });

  const legacyPosition = () => {
    const id = `e259_${uid()}`;
    // saved without baseTokenProgram, as rows from before the column were: the column default (SPL Token) is stored
    workstationDb.savePosition({
      id, mint: MINT, symbol: 'E', name: 'E', tokenDecimals: 6, tokenQuantityRaw: '1000', entryPriceSol: 1e-4, currentPriceSol: 1e-4,
      currentValueSol: 0.1, costBasisLamports: 100_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE',
      executionMode: 'LIVE', entryTxSignature: `sig_${id}`, entryTimestamp: Date.now(), lastMarkTimestamp: Date.now(),
      recordUpdatedAt: Date.now(), updatedAt: Date.now(),
    } as any);
    return id;
  };

  it('S259: a legacy row of a Token-2022 mint whose tokens are still held is not closed as REALIZED_ASSUMED_LOSS', async () => {
    const id = legacyPosition();
    expect(workstationDb.loadPositions().find((p) => p.id === id)!.baseTokenProgram).toBe(TOKEN_PROGRAM_ID.toBase58());
    const ata2022 = PumpCurveService.getAssociatedTokenAddress(VALID_PUMP_MINT_1, wallet, TOKEN_2022_PROGRAM_ID);
    conn.getAccountInfo = vi.fn(async (pk: PublicKey) => (pk.equals(VALID_PUMP_MINT_1) ? { owner: TOKEN_2022_PROGRAM_ID, lamports: 1, data: Buffer.alloc(82), executable: false } : null));
    conn.getTokenAccountBalance = vi.fn(async (ata: PublicKey) => {
      if (ata.equals(ata2022)) return { context: { slot: 10 }, value: { amount: '1000', decimals: 6 } };
      throw new Error('failed to get token account balance: Invalid param: could not find account');
    });
    await coordinator.startupReconciliation();
    const after = workstationDb.loadPositions().find((p) => p.id === id)!;
    expect(after.status).toBe('OPEN');
    expect(after.realizedPnLSol ?? 0).toBe(0);
    expect(after.exitReason ?? '').not.toMatch(/REALIZED_ASSUMED_LOSS/);
  });

  it('S259: an "Invalid param" that is not "could not find account" is an unreadable balance, not 0', async () => {
    const id = legacyPosition();
    conn.getTokenAccountBalance = vi.fn(async () => { throw new Error('failed to get token account balance: Invalid param: not a Token account'); });
    await coordinator.startupReconciliation();
    const after = workstationDb.loadPositions().find((p) => p.id === id)!;
    expect(after.status).toBe('OPEN');
    expect(after.realizedPnLSol ?? 0).toBe(0);
  });

  it('S259: an unreadable mint account leaves an empty answer undecided', async () => {
    const id = legacyPosition();
    conn.getAccountInfo = vi.fn(async () => { throw new Error('503 service unavailable'); });
    conn.getTokenAccountBalance = vi.fn(async () => { throw new Error('failed to get token account balance: Invalid param: could not find account'); });
    await coordinator.startupReconciliation();
    expect(workstationDb.loadPositions().find((p) => p.id === id)!.status).toBe('OPEN');
  });

  it('S260: the LIVE buy baseline throws on an "Invalid param" other than a missing account', async () => {
    const c = { getBalance: async () => 1e9, getTokenAccountBalance: async () => { throw new Error('failed to get token account balance: Invalid param: not a Token account'); } } as any;
    await expect(TradeReconciler.capturePreTradeSnapshot(c, wallet, VALID_PUMP_MINT_1, TOKEN_PROGRAM_ID, 'LIVE')).rejects.toThrow(/PRE_TRADE_SNAPSHOT_FAILED/);
  });
});

describe('Review E: S250 orphan recovery asks the signature status before TIMED_OUT', () => {
  let coordinator: ExecutionCoordinator;
  let conn: any;
  const mint = Keypair.generate().publicKey.toBase58();
  const orphan = (): PersistedTransaction => ({
    signature: `e250_${uid()}`, orderId: `o_${uid()}`, correlationId: 'c', mint, direction: 'BUY', submissionTransport: 'SOLANA_RPC',
    submissionTime: Date.now() - 90_000, reconciliationState: 'RECONCILIATION_REQUIRED', networkFeeLamports: 5000, jitoTipLamports: 0,
    executionMode: 'LIVE', error: 'UNCONFIRMED', lastValidBlockHeight: 1_000,
  });
  const stateOf = (sig: string) => workstationDb.loadTransactionsInStates(['RECONCILIATION_REQUIRED', 'TIMED_OUT']).find((t) => t.signature === sig)?.reconciliationState;

  beforeEach(() => {
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(Keypair.generate().publicKey);
    vi.spyOn(TradeReconciler, 'recoverInterruptedTransaction').mockResolvedValue({ recovered: false, type: 'BUY', error: 'Transaction not found on-chain' });
    coordinator = new ExecutionCoordinator(new MockSolanaRpc().createConnection());
    conn = (coordinator as any).connection;
    conn.getBlockHeight = vi.fn(async () => 1_001); // past the blockhash window
  });
  afterEach(() => {
    for (const t of workstationDb.loadTransactionsInStates(['RECONCILIATION_REQUIRED', 'PENDING'])) if (t.mint === mint) workstationDb.saveTransaction({ ...t, reconciliationState: 'REVERTED' });
    coordinator.cleanup();
    vi.restoreAllMocks();
  });

  it('getTransaction has nothing but the signature has a status (this node lacks the history): the row stays, not TIMED_OUT', async () => {
    const t = orphan();
    workstationDb.saveTransaction(t);
    conn.getSignatureStatuses = vi.fn(async () => ({ context: { slot: 9 }, value: [{ slot: 8, confirmations: null, err: null, confirmationStatus: 'finalized' }] }));
    const res = await coordinator.recoverOrphanedBuys();
    expect(res.stillOrphaned).toContain(t.signature);
    expect(stateOf(t.signature)).toBe('RECONCILIATION_REQUIRED');
    expect(conn.getSignatureStatuses).toHaveBeenCalledWith([t.signature], { searchTransactionHistory: true });
  });

  it('an unreadable signature status keeps the row', async () => {
    const t = orphan();
    workstationDb.saveTransaction(t);
    conn.getSignatureStatuses = vi.fn(async () => { throw new Error('fetch failed'); });
    await coordinator.recoverOrphanedBuys();
    expect(stateOf(t.signature)).toBe('RECONCILIATION_REQUIRED');
  });

  it('no status anywhere and past the window: TIMED_OUT as before', async () => {
    const t = orphan();
    workstationDb.saveTransaction(t);
    conn.getSignatureStatuses = vi.fn(async () => ({ context: { slot: 9 }, value: [null] }));
    await coordinator.recoverOrphanedBuys();
    expect(stateOf(t.signature)).toBe('TIMED_OUT');
  });
});

describe('Review E: L3 a boot whose cluster check failed still reconciles once the RPC verifies', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the heartbeat runs startup reconciliation even when its own check never saw the boot failure', async () => {
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(Keypair.generate().publicKey);
    // the boot check fails without leaving a cluster problem behind: the heartbeat's own check, run at the same time, passed after it
    vi.spyOn(ExecutionCoordinator.prototype as any, 'verifyCluster').mockResolvedValueOnce(false).mockResolvedValue(true);
    const realInit = (ExecutionCoordinator.prototype as any).initializeConnection;
    let initDone: Promise<unknown> = Promise.resolve();
    vi.spyOn(ExecutionCoordinator.prototype as any, 'initializeConnection').mockImplementation(function (this: any) {
      initDone = Promise.resolve(realInit.call(this));
      return initDone;
    });
    const c = new ExecutionCoordinator(new MockSolanaRpc().createConnection());
    await initDone;
    expect((c as any).clusterProblem).toBeNull();
    expect((c as any).firstReconciliationDone).toBe(false);
    const reconcile = vi.spyOn(c, 'startupReconciliation').mockResolvedValue({ status: 'EXECUTION_READY', mismatchesCount: 0, details: '' });
    (c as any).startMarketFeedHeartbeat();
    try {
      await vi.waitFor(() => expect(reconcile).toHaveBeenCalled(), { timeout: 2000 });
    } finally {
      c.cleanup();
    }
  });
});

describe('Review E: the cluster stamp is never overwritten on a failed read', () => {
  const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
  const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
  const fileDb = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-e-'));
    return { db: new WorkstationDatabase(path.join(dir, 'ledger.db')), dir };
  };

  it('a stamp that cannot be parsed refuses the RPC and is left as it is', () => {
    const { db, dir } = fileDb();
    expect(db.checkClusterStamp(DEVNET)).toEqual({ ok: true, stamped: true });
    const other = new DatabaseSync(db.getDbPath());
    other.prepare(`UPDATE app_settings SET value_json = '{not json' WHERE key = 'cluster_genesis_hash'`).run();
    const res = db.checkClusterStamp(MAINNET);
    expect(res.ok).toBe(false);
    expect((res as any).unreadable).toBeTruthy();
    expect((other.prepare(`SELECT value_json FROM app_settings WHERE key = 'cluster_genesis_hash'`).get() as any).value_json).toBe('{not json');
    other.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a failed SELECT refuses the RPC instead of reading as unstamped', () => {
    const { db, dir } = fileDb();
    db.checkClusterStamp(DEVNET);
    const other = new DatabaseSync(db.getDbPath());
    other.exec('ALTER TABLE app_settings RENAME TO app_settings_moved');
    const res = db.checkClusterStamp(MAINNET);
    expect(res.ok).toBe(false);
    expect((res as any).unreadable).toMatch(/app_settings/);
    other.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the coordinator reports an unreadable stamp as DB_CLUSTER_STAMP_UNREADABLE', async () => {
    vi.spyOn(workstationDb, 'checkClusterStamp').mockReturnValue({ ok: false, stored: '', unreadable: 'disk I/O error' });
    const c = new ExecutionCoordinator(new MockSolanaRpc().createConnection());
    expect(await (c as any).verifyCluster()).toBe(false);
    expect((c as any).clusterProblem).toMatch(/DB_CLUSTER_STAMP_UNREADABLE/);
    c.cleanup();
    vi.restoreAllMocks();
  });
});

describe('Review E: saveSellBooking is one write', () => {
  it('a failed ledger update leaves the position and its realized events untouched', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-e-'));
    const db = new WorkstationDatabase(path.join(dir, 'ledger.db'));
    const id = `e_book_${uid()}`;
    const pos = {
      id, mint: MINT, symbol: 'E', name: 'E', tokenDecimals: 6, tokenQuantityRaw: '1000', entryPriceSol: 1e-4, currentPriceSol: 1e-4,
      costBasisLamports: 100_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE', executionMode: 'LIVE',
      entryTxSignature: `sig_${id}`, entryTimestamp: Date.now(), lastMarkTimestamp: Date.now(),
    } as any;
    db.savePosition(pos);
    db.saveTransaction({ signature: 'e_book_sig', orderId: 'o', correlationId: 'c', mint: MINT, direction: 'SELL', submissionTransport: 'SOLANA_RPC',
      submissionTime: Date.now(), reconciliationState: 'PENDING', networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE' });
    const other = new DatabaseSync(db.getDbPath());
    other.exec(`CREATE TRIGGER fail_upd BEFORE UPDATE ON transactions BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    expect(() => db.saveSellBooking({ ...pos, status: 'CLOSED', tokenQuantityRaw: '0', realizedPnLSol: -0.05, exitTxSignature: 'e_book_sig' }, 'e_book_sig', { slot: 6 })).toThrow(/injected/);
    const after = db.loadPositions().find((p) => p.id === id)!;
    expect(after.status).toBe('OPEN');
    expect(after.realizedPnLSol ?? 0).toBe(0);
    expect((other.prepare('SELECT COUNT(*) AS n FROM realized_events WHERE position_id = ?').get(id) as any).n).toBe(0);
    other.exec('DROP TRIGGER fail_upd');
    db.saveSellBooking({ ...pos, status: 'CLOSED', tokenQuantityRaw: '0', realizedPnLSol: -0.05, exitTxSignature: 'e_book_sig' }, 'e_book_sig', { slot: 6 });
    expect(db.loadPositions().find((p) => p.id === id)!.realizedPnLSol).toBeCloseTo(-0.05, 9);
    expect(db.loadTransactions().find((t) => t.signature === 'e_book_sig')?.reconciliationState).toBe('RECONCILED');
    other.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
