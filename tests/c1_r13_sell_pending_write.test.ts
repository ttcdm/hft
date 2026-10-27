import '../suppress-warnings.cjs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PublicKey, TransactionMessage, VersionedTransaction, SystemProgram, Keypair } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';
import { TOKEN_PROGRAM_ID } from '../server/solana/programs';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1 } from './e2e/helpers/simulatedStates';

/**
 * R1 #3: the SELL branch ignored a failed PENDING write and sent anyway, so a crash after the send left nothing durable naming the
 * signature. It must refuse before sending, like the BUY branch. Real coordinator; the DB write fails at the database boundary.
 */
describe('R1 #3: a SELL whose PENDING row cannot be written is not sent', () => {
  let coordinator: ExecutionCoordinator;
  let mockRpc: MockSolanaRpc;

  const signedTx = (payer: PublicKey): VersionedTransaction => {
    const msg = new TransactionMessage({
      payerKey: payer, recentBlockhash: PublicKey.default.toBase58(),
      instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 5000 })],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.signatures = [new Uint8Array(64).fill(9)];
    return tx;
  };

  beforeEach(() => {
    mockRpc = new MockSolanaRpc();
    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
  });
  afterEach(() => {
    coordinator.cleanup();
    vi.restoreAllMocks();
    mockRpc.clear();
  });

  it('returns SUBMIT_FAILED (PENDING_WRITE_FAILED) and never reaches the send', async () => {
    const owner = Keypair.generate().publicKey;
    vi.spyOn(workstationDb, 'saveTransaction').mockReturnValue(false);
    const inner = vi.spyOn(coordinator as any, 'submitAndConfirmInner');
    const res = await coordinator.submitAndConfirmWithRetry({
      tx: signedTx(owner), orderId: `ord-exit-r13-${Date.now()}`, correlationId: 'exit-r13', side: 'SELL',
      mint: VALID_PUMP_MINT_1.toBase58(), mintPubkey: VALID_PUMP_MINT_1, owner, tokenProgram: TOKEN_PROGRAM_ID,
      preSnapshot: { timestamp: Date.now(), walletSolLamports: 1e9, tokenBalanceRaw: '1000', tokenDecimals: 6 },
      jitoTipLamports: 0, exitReason: 'STOP_LOSS',
    } as any);
    expect(res.success).toBe(false);
    expect(res.lifecycleState).toBe('SUBMIT_FAILED');
    expect(res.error).toMatch(/^PENDING_WRITE_FAILED/);
    expect(inner).not.toHaveBeenCalled();
    expect((mockRpc as any).submittedTransactions ?? []).toHaveLength(0);
  });
});
