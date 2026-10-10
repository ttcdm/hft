import '../suppress-warnings.cjs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Connection, Keypair, MessageAccountKeys, PublicKey } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { TradeReconciler } from '../server/execution/reconciliation';
import { localSigner } from '../server/solana/signer';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { TOKEN_PROGRAM_ID } from '../server/solana/programs';
import { workstationDb, PersistedTransaction } from '../server/db/database';

/**
 * P3 (critique #3): a confirmed LIVE buy whose getTransaction came back null must not leave tokens without a position.
 * Wallet, mint and keys are freshly generated throwaway values. Real TradeReconciler, coordinator and SQLite; only the RPC answers are stubbed.
 */
const SOL = 1e9;
const RENT = 2_039_280;

function fixture(tag: string) {
  const wallet = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const ata = PumpCurveService.getAssociatedTokenAddress(mint, wallet, TOKEN_PROGRAM_ID);
  const keys = [wallet, ata, Keypair.generate().publicKey];
  const curve = 18_500_000, fee = 100_000, tip = 1_000_000;
  const delta = curve + fee + tip + RENT;
  const txResult = (err: any = null) => ({
    slot: 4242,
    blockTime: Math.floor(Date.now() / 1000),
    transaction: { message: { getAccountKeys: () => new MessageAccountKeys(keys) } },
    meta: {
      err,
      fee,
      preBalances: [5 * SOL, 0, 10 * SOL],
      postBalances: [5 * SOL - delta, RENT, 10 * SOL + curve],
      preTokenBalances: [],
      postTokenBalances: [{ accountIndex: 1, mint: mint.toBase58(), owner: wallet.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), uiTokenAmount: { amount: '600000000000', decimals: 6 } }],
    },
  });
  const sig = `p3_${tag}_${Math.random().toString(36).slice(2)}`;
  return { wallet, mint, sig, curve, delta, tip, txResult };
}

function orphanRow(f: ReturnType<typeof fixture>): PersistedTransaction {
  return {
    signature: f.sig,
    orderId: `ord-${f.sig}`,
    correlationId: `corr-${f.sig}`,
    mint: f.mint.toBase58(),
    direction: 'BUY',
    submissionTransport: 'SOLANA_RPC',
    submissionTime: Date.now() - 20_000,
    landingSlot: 4242,
    reconciliationState: 'RECONCILIATION_REQUIRED',
    networkFeeLamports: 100_000,
    jitoTipLamports: f.tip,
    executionMode: 'LIVE',
    error: 'Transaction metadata could not be fetched from RPC for verification',
  };
}

describe('P3: orphaned landed buy', () => {
  let savedDelays: number[];
  beforeEach(() => {
    savedDelays = TradeReconciler.txFetchRetryDelaysMs;
    TradeReconciler.txFetchRetryDelaysMs = [0, 0, 0];
  });
  afterEach(() => {
    TradeReconciler.txFetchRetryDelaysMs = savedDelays;
    vi.restoreAllMocks();
  });

  describe('getTransaction retries', () => {
    it('a null answer that turns into the transaction on the 3rd try reconciles', async () => {
      const f = fixture('retry');
      let calls = 0;
      const connection = {
        getTransaction: async () => (++calls < 3 ? null : f.txResult()),
        getTokenAccountBalance: async () => { throw new Error('none'); },
      } as any;
      const snap = { walletSolLamports: 5 * SOL, tokenBalanceRaw: '0', tokenDecimals: 6, timestamp: Date.now() };
      const r = await TradeReconciler.reconcileBuyTransaction(connection, f.sig, f.wallet, f.mint, TOKEN_PROGRAM_ID, snap, f.tip);
      expect(calls).toBe(3);
      expect(r.reconciliationState).toBe('RECONCILED');
      expect(r.curveSpendLamports).toBe(f.curve);
    });

    it('a thrown RPC error is retried too', async () => {
      const f = fixture('throw');
      let calls = 0;
      const connection = {
        getTransaction: async () => { if (++calls === 1) throw new Error('503'); return f.txResult(); },
        getTokenAccountBalance: async () => { throw new Error('none'); },
      } as any;
      const snap = { walletSolLamports: 5 * SOL, tokenBalanceRaw: '0', tokenDecimals: 6, timestamp: Date.now() };
      const r = await TradeReconciler.reconcileBuyTransaction(connection, f.sig, f.wallet, f.mint, TOKEN_PROGRAM_ID, snap, f.tip);
      expect(r.reconciliationState).toBe('RECONCILED');
    });

    it('stays RECONCILIATION_REQUIRED after every attempt is null, and tried delays+1 times', async () => {
      const f = fixture('null');
      let calls = 0;
      const connection = { getTransaction: async () => { calls++; return null; } } as any;
      const snap = { walletSolLamports: 5 * SOL, tokenBalanceRaw: '0', tokenDecimals: 6, timestamp: Date.now() };
      const r = await TradeReconciler.reconcileBuyTransaction(connection, f.sig, f.wallet, f.mint, TOKEN_PROGRAM_ID, snap, f.tip);
      expect(r.reconciliationState).toBe('RECONCILIATION_REQUIRED');
      expect(calls).toBe(4);
    });

    it('a reverted transaction is not retried', async () => {
      const f = fixture('rev');
      let calls = 0;
      const connection = { getTransaction: async () => { calls++; return f.txResult({ InstructionError: [0, 'Custom'] }); } } as any;
      const snap = { walletSolLamports: 5 * SOL, tokenBalanceRaw: '0', tokenDecimals: 6, timestamp: Date.now() };
      const r = await TradeReconciler.reconcileBuyTransaction(connection, f.sig, f.wallet, f.mint, TOKEN_PROGRAM_ID, snap, f.tip);
      expect(r.reconciliationState).toBe('REVERTED');
      expect(calls).toBe(1);
    });
  });

  describe('coordinator recovery of orphaned rows', () => {
    let coordinator: ExecutionCoordinator;
    let f: ReturnType<typeof fixture>;
    let getTx: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      f = fixture('co');
      vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(f.wallet);
      vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
      vi.spyOn(Connection.prototype, 'getSlot').mockResolvedValue(4242);
      vi.spyOn(Connection.prototype, 'getBalance').mockResolvedValue(5 * SOL);
      getTx = vi.fn(async () => f.txResult());
      vi.spyOn(Connection.prototype, 'getTransaction').mockImplementation(getTx as any);
      coordinator = new ExecutionCoordinator();
      coordinator.orphanRecoveryDelaysMs = [];
      await vi.waitFor(() => expect((coordinator as any).lastStartupReconciliation).toBeTruthy());
    });
    afterEach(() => coordinator.cleanup());

    const positionFor = (sig: string) => workstationDb.loadPositions().find((p) => p.entryTxSignature === sig);

    it('opens an OPEN position with the curve entry price and the all-in cost basis, and marks the row RECONCILED', async () => {
      workstationDb.saveTransaction(orphanRow(f));
      expect(positionFor(f.sig)).toBeUndefined();
      const r = await coordinator.recoverOrphanedBuys();
      expect(r.recovered).toContain(f.sig);
      const pos = positionFor(f.sig)!;
      expect(pos.status).toBe('OPEN');
      expect(pos.mint).toBe(f.mint.toBase58());
      expect(pos.tokenQuantityRaw).toBe('600000000000');
      expect(pos.costBasisLamports).toBe(f.delta);
      expect(pos.entryPriceSol).toBeCloseTo(f.curve / SOL / 600_000, 12);
      expect(workstationDb.loadTransactions().find((t) => t.signature === f.sig)!.reconciliationState).toBe('RECONCILED');
    });

    it('is idempotent: a second pass creates no second position', async () => {
      workstationDb.saveTransaction(orphanRow(f));
      await coordinator.recoverOrphanedBuys();
      const again = await coordinator.recoverOrphanedBuys();
      expect(again.recovered).not.toContain(f.sig);
      expect(workstationDb.loadPositions().filter((p) => p.entryTxSignature === f.sig)).toHaveLength(1);
    });

    it('leaves the row orphaned (and reports it) while the RPC still has no transaction', async () => {
      getTx.mockImplementation(async () => null);
      workstationDb.saveTransaction(orphanRow(f));
      const r = await coordinator.recoverOrphanedBuys();
      expect(r.stillOrphaned).toContain(f.sig);
      expect(positionFor(f.sig)).toBeUndefined();
      expect(workstationDb.loadTransactions().find((t) => t.signature === f.sig)!.reconciliationState).toBe('RECONCILIATION_REQUIRED');
    });

    it('marks the row REVERTED when the chain says it reverted', async () => {
      getTx.mockImplementation(async () => f.txResult({ InstructionError: [0, 'Custom'] }));
      workstationDb.saveTransaction(orphanRow(f));
      await coordinator.recoverOrphanedBuys();
      expect(positionFor(f.sig)).toBeUndefined();
      expect(workstationDb.loadTransactions().find((t) => t.signature === f.sig)!.reconciliationState).toBe('REVERTED');
    });

    it('startup reconciliation re-reads RECONCILIATION_REQUIRED rows, not only PENDING ones', async () => {
      workstationDb.saveTransaction(orphanRow(f));
      await coordinator.startupReconciliation();
      expect(positionFor(f.sig)?.status).toBe('OPEN');
    });

    it('startup reports a still-unreadable orphan as a mismatch', async () => {
      getTx.mockImplementation(async () => null);
      workstationDb.saveTransaction(orphanRow(f));
      const res = await coordinator.startupReconciliation();
      expect(res.status).toBe('RECONCILIATION_MISMATCH');
      expect(res.details).toContain(f.sig.slice(0, 8));
    });

    it('does not touch SELL rows or paper rows', async () => {
      const sell = { ...orphanRow(f), direction: 'SELL' as const };
      workstationDb.saveTransaction(sell);
      const r = await coordinator.recoverOrphanedBuys();
      expect(r.recovered).toHaveLength(0);
      expect(positionFor(f.sig)).toBeUndefined();
    });

    it('the background retry (what a failed live buy schedules) recovers the position', async () => {
      getTx.mockImplementation(async () => null); // RPC has not indexed it yet
      workstationDb.saveTransaction(orphanRow(f));
      (coordinator as any).scheduleOrphanRecovery([0, 0, 0, 0]);
      await new Promise((r) => setTimeout(r, 5));
      expect(positionFor(f.sig)).toBeUndefined();
      getTx.mockImplementation(async () => f.txResult()); // indexed now
      (coordinator as any).scheduleOrphanRecovery([0]);
      await vi.waitFor(() => expect(positionFor(f.sig)?.status).toBe('OPEN'));
    });
  });
});
