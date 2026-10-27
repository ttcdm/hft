import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { workstationDb, WorkstationDatabase } from '../server/db/database';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1 } from './e2e/helpers/simulatedStates';

/**
 * R5-4: a transactions table that cannot be read is unknown, never "nothing unresolved". Real coordinator and SQLite; the RPC answers are
 * scripted, and the one DB read under test is made to fail at the database boundary.
 */
describe('R5-4: an unreadable ledger never reads as "no unresolved transactions"', () => {
  let coordinator: ExecutionCoordinator;
  let mockRpc: MockSolanaRpc;
  let conn: any;
  let wallet: Keypair;
  const mint = VALID_PUMP_MINT_1.toBase58();
  const uid = () => Math.random().toString(36).slice(2);

  const livePosition = (id: string) => {
    workstationDb.savePosition({
      id, mint, symbol: 'R54', name: 'R54', tokenDecimals: 6, tokenQuantityRaw: '1000', entryPriceSol: 1e-4, currentPriceSol: 1e-4,
      currentValueSol: 0.1, costBasisLamports: 100_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE',
      executionMode: 'LIVE', entryTxSignature: `sig_${id}`, entryTimestamp: Date.now(), lastMarkTimestamp: Date.now(),
      walletPubkey: wallet.publicKey.toBase58(),
    } as any);
  };
  const clearLedger = () => {
    for (const p of workstationDb.loadPositions()) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0 } as any);
    for (const t of workstationDb.loadTransactions()) if (['PENDING', 'RECONCILIATION_REQUIRED'].includes(t.reconciliationState)) workstationDb.saveTransaction({ ...t, reconciliationState: 'REVERTED' });
  };

  beforeEach(() => {
    mockRpc = new MockSolanaRpc();
    wallet = Keypair.generate();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(wallet.publicKey);
    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
    coordinator.orphanRecoveryDelaysMs = [];
    conn = (coordinator as any).connection;
    conn.getBalance = vi.fn(async () => 1_000_000_000);
    conn.getParsedTokenAccountsByOwner = vi.fn(async () => ({ context: { slot: 1 }, value: [] }));
    conn.getSignatureStatuses = vi.fn(async () => ({ context: { slot: 1 }, value: [null] }));
    (coordinator as any).rpcHealth = 'HEALTHY';
    vi.spyOn(coordinator as any, 'scheduleReconcileRetry').mockImplementation(() => undefined);
    clearLedger();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    coordinator.cleanup();
    mockRpc.clear();
    clearLedger();
  });

  it('the two ledger reads answer null, not [], when the transactions table cannot be read', () => {
    const db = new WorkstationDatabase(':memory:');
    (db as any).db.exec('DROP TABLE transactions');
    expect(db.loadTransactionsInStates(['PENDING'])).toBeNull();
    expect(db.getPendingTransactions()).toBeNull();
  });

  it('startup reconciliation leaves a zero-balance position open and books nothing when the ledger read fails', async () => {
    const id = `r54_${uid()}`;
    livePosition(id);
    conn.getTokenAccountBalance = vi.fn(async () => { throw new Error('failed to get token account balance: Invalid param: could not find account'); });
    vi.spyOn(workstationDb, 'getPendingTransactions').mockReturnValue(null);
    const journal = vi.spyOn(workstationDb, 'logJournal');
    const res = await coordinator.startupReconciliation();
    const row = workstationDb.loadPositions().find((p) => p.id === id)!;
    expect(row.status).toBe('OPEN');
    expect(row.costBasisLamports).toBe(100_000_000);
    expect(res.status).toBe('RECONCILIATION_MISMATCH');
    expect(res.details).toMatch(/transactions table could not be read/);
    expect(journal.mock.calls.some((c) => c[0] === 'REALIZED_ASSUMED_LOSS')).toBe(false);
  });

  it('orphan recovery and the untracked scan report the unreadable ledger instead of "nothing unresolved"', async () => {
    vi.spyOn(workstationDb, 'loadTransactionsInStates').mockReturnValue(null);
    const r = await coordinator.recoverOrphanedBuys();
    expect(r.ledgerUnreadable).toBe(true);
    await expect(coordinator.scanUntrackedWalletTokens()).rejects.toThrow(/transactions table could not be read/);
  });

  it('the exit pass holds every LIVE position while the ledger of unresolved sells cannot be read', async () => {
    const id = `r54x_${uid()}`;
    livePosition(id);
    await (coordinator as any).reconcileInFlight?.catch(() => undefined); // the boot pass of a directly built coordinator
    (coordinator as any).firstReconciliationDone = false;
    vi.spyOn(workstationDb, 'loadTransactionsInStates').mockReturnValue(null);
    vi.spyOn(coordinator as any, 'updatePositionMarkPrices').mockResolvedValue(undefined);
    const evaluated: string[] = [];
    const exitEngine = await import('../server/exits/exitEngine');
    vi.spyOn(exitEngine.ExitEngine, 'evaluate').mockImplementation(((input: any) => { evaluated.push(input.positionId); return { shouldExit: false } as any; }) as any);
    await coordinator.evaluateAndProcessExits();
    expect(evaluated).not.toContain(id);
    expect(coordinator.getOperatorAlerts().some((a) => a.code === 'LEDGER_UNREADABLE' && !a.cleared)).toBe(true);
  });
});
