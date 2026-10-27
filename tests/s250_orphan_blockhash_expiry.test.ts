import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import bs58 from 'bs58';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { TradeReconciler } from '../server/execution/reconciliation';
import { executionConfig } from '../server/solana/executionConfig';
import { txBuilder } from '../server/solana/transactionBuilder';
import { localSigner } from '../server/solana/signer';
import { workstationDb, type PersistedTransaction } from '../server/db/database';
import { TOKEN_PROGRAM_ID } from '../server/solana/programs';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';

/**
 * S250 (P2.1, R1-5/R1-81): a LIVE buy that was sent and never landed used to hold its mint (UNRESOLVED_BUY) until a restart: orphan recovery
 * runs at about 5 s to 485 s and only called a row TIMED_OUT after 15 minutes of wall-clock age. Devnet run 4 (2026-10-24) hit it: one buy that
 * did not land in 15 s blocked every later buy of that mint for the rest of the run. Now the PENDING row stores the blockhash's
 * lastValidBlockHeight, and recovery resolves the row as soon as the chain's confirmed block height is past it.
 * Real coordinator, TradeReconciler (spied at its static boundary), transaction builder and SQLite; only RPC answers are scripted.
 */
const uid = () => Math.random().toString(36).slice(2);

describe('S250: an unlanded buy is resolved on blockhash expiry, not after 15 minutes', () => {
  let coordinator: ExecutionCoordinator;
  let conn: any;
  const mint = Keypair.generate().publicKey.toBase58();
  const row = (lastValidBlockHeight?: number): PersistedTransaction => ({
    signature: `s250_${uid()}`, orderId: `o_${uid()}`, correlationId: 'c', mint, direction: 'BUY', submissionTransport: 'SOLANA_RPC',
    submissionTime: Date.now() - 90_000, reconciliationState: 'RECONCILIATION_REQUIRED', networkFeeLamports: 5000, jitoTipLamports: 0,
    executionMode: 'LIVE', error: 'UNCONFIRMED', lastValidBlockHeight,
  });
  const stateOf = (sig: string) => workstationDb.loadTransactionsInStates(['RECONCILIATION_REQUIRED', 'TIMED_OUT'])!.find((t) => t.signature === sig)?.reconciliationState;

  beforeEach(() => {
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(Keypair.generate().publicKey);
    vi.spyOn(TradeReconciler, 'recoverInterruptedTransaction').mockResolvedValue({ recovered: false, type: 'BUY', error: 'Transaction not found on-chain' });
    coordinator = new ExecutionCoordinator(new MockSolanaRpc().createConnection());
    conn = (coordinator as any).connection;
  });
  afterEach(() => {
    for (const t of workstationDb.loadTransactionsInStates(['RECONCILIATION_REQUIRED', 'PENDING'])!) if (t.mint === mint) workstationDb.saveTransaction({ ...t, reconciliationState: 'REVERTED' });
    coordinator.cleanup();
    vi.restoreAllMocks();
  });

  it('past lastValidBlockHeight with no transaction on chain: TIMED_OUT at once, and the mint is no longer held', async () => {
    const t = row(1_000);
    workstationDb.saveTransaction(t);
    conn.getBlockHeight = vi.fn(async () => 1_001);
    expect(workstationDb.hasUnresolvedLiveBuy(mint)).toBe(true);
    const res = await coordinator.recoverOrphanedBuys();
    expect(res.stillOrphaned).not.toContain(t.signature);
    expect(stateOf(t.signature)).toBe('TIMED_OUT');
    expect(workstationDb.hasUnresolvedLiveBuy(mint)).toBe(false);
    expect(conn.getBlockHeight).toHaveBeenCalledWith('confirmed');
  });

  it('at or below lastValidBlockHeight the transaction can still land: the row stays and the mint stays held', async () => {
    const t = row(1_000);
    workstationDb.saveTransaction(t);
    conn.getBlockHeight = vi.fn(async () => 1_000);
    const res = await coordinator.recoverOrphanedBuys();
    expect(res.stillOrphaned).toContain(t.signature);
    expect(stateOf(t.signature)).toBe('RECONCILIATION_REQUIRED');
    expect(workstationDb.hasUnresolvedLiveBuy(mint)).toBe(true);
  });

  it('an unreadable block height is not expiry: a young row stays', async () => {
    const t = row(1_000);
    workstationDb.saveTransaction(t);
    conn.getBlockHeight = vi.fn(async () => { throw new Error('503 service unavailable'); });
    await coordinator.recoverOrphanedBuys();
    expect(stateOf(t.signature)).toBe('RECONCILIATION_REQUIRED');
  });

  it('a row with no stored height keeps the old 15-minute rule and never reads the block height', async () => {
    const t = row(undefined);
    workstationDb.saveTransaction(t);
    conn.getBlockHeight = vi.fn(async () => 9_999_999);
    await coordinator.recoverOrphanedBuys();
    expect(stateOf(t.signature)).toBe('RECONCILIATION_REQUIRED');
    expect(conn.getBlockHeight).not.toHaveBeenCalled();
  });

  it('a later save without the height keeps the stored one', () => {
    const t = row(4_242);
    workstationDb.saveTransaction(t);
    workstationDb.saveTransaction({ ...t, lastValidBlockHeight: undefined, error: 'updated' });
    expect(workstationDb.loadTransactionsInStates(['RECONCILIATION_REQUIRED'])!.find((x) => x.signature === t.signature)?.lastValidBlockHeight).toBe(4_242);
  });
});

describe('S250: the PENDING row carries the lastValidBlockHeight of the blockhash the transaction was built with', () => {
  afterEach(() => vi.restoreAllMocks());

  it('txBuilder remembers each fetched blockhash, and submitAndConfirmWithRetry stores its height on the row', async () => {
    const blockhash = Keypair.generate().publicKey.toBase58();
    const fetched = await txBuilder.getRecentBlockhash({ getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 777_777 }) } as any, true);
    expect(fetched).toBe(blockhash);
    expect(txBuilder.lastValidBlockHeightOf(blockhash)).toBe(777_777);
    expect(txBuilder.lastValidBlockHeightOf(PublicKey.default.toBase58() + 'x')).toBeUndefined();

    const real = executionConfig.getConfig();
    vi.spyOn(executionConfig, 'getConfig').mockReturnValue({ ...real, jitoBlockEngineUrl: '' });
    const c = new ExecutionCoordinator(new MockSolanaRpc().createConnection());
    const payer = Keypair.generate().publicKey;
    const tx = new VersionedTransaction(new TransactionMessage({
      payerKey: payer, recentBlockhash: blockhash,
      instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 5000 })],
    }).compileToV0Message());
    tx.signatures = [new Uint8Array(64).fill(50)];
    const sig = bs58.encode(tx.signatures[0]);
    vi.spyOn((c as any).rpcTransport, 'submit').mockResolvedValue({ signature: sig, transport: 'SOLANA_RPC', success: true, submitDurationMs: 1, lifecycleState: 'BUNDLE_PENDING' } as any);
    vi.spyOn((c as any).rpcTransport, 'confirm').mockResolvedValue({ confirmed: true, slot: 5 } as any);
    const m = Keypair.generate().publicKey;
    const orderId = `s250-${uid()}`;
    await c.submitAndConfirmWithRetry({
      tx, orderId, correlationId: 'corr-s250', side: 'BUY', mint: m.toBase58(), mintPubkey: m, owner: payer, tokenProgram: TOKEN_PROGRAM_ID,
      preSnapshot: { timestamp: Date.now(), walletSolLamports: 1e9, tokenBalanceRaw: '0', tokenDecimals: 6, slot: 1 } as any, jitoTipLamports: 0,
    } as any);
    const rows = workstationDb.loadTransactions(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].lastValidBlockHeight).toBe(777_777);
    c.cleanup();
  });
});
