import { describe, it, expect, afterEach, vi } from 'vitest';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { TradeReconciler } from '../server/execution/reconciliation';

/**
 * The live sell-booking function, unmocked (round 1 #7). Only Connection.getTransaction is faked: the proceeds, token delta, realized PnL
 * and fully-closed flag all come from the real TradeReconciler.reconcileSellTransaction.
 */
const wallet = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const walletStr = wallet.toBase58();
const mintStr = mint.toBase58();
const FEE = 5_000;
const COST = 100_000_000; // lamports paid for the whole position

function txFixture(opts: { pre: number; post: number; tokensBefore: string; tokensAfter: string; err?: unknown }) {
  const msg = new TransactionMessage({
    payerKey: wallet,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: wallet, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
  }).compileToV0Message();
  const tb = (amount: string) => [{ accountIndex: 1, mint: mintStr, owner: walletStr, uiTokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: amount } }];
  return {
    slot: 777,
    transaction: { message: msg, signatures: [] },
    meta: {
      err: opts.err ?? null,
      fee: FEE,
      preBalances: [opts.pre, 1, 1],
      postBalances: [opts.post, 1, 1],
      preTokenBalances: tb(opts.tokensBefore),
      postTokenBalances: tb(opts.tokensAfter),
    },
  };
}

function conn(tx: unknown) {
  return { getTransaction: vi.fn().mockResolvedValue(tx) } as any;
}

const snap = (tokenBalanceRaw: string) => ({ walletSolLamports: 1_000_000_000, tokenBalanceRaw, tokenDecimals: 6, timestamp: Date.now() });

async function reconcile(tx: unknown, sellFraction: number, tokenRaw = '1000000000') {
  return TradeReconciler.reconcileSellTransaction(conn(tx), 'sig', wallet, mint, TOKEN_PROGRAM_ID, snap(tokenRaw), COST, sellFraction, 0);
}

describe('TradeReconciler.reconcileSellTransaction (real, getTransaction fixture)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('profit: full sell, wallet gains 150M lamports against a 100M cost basis', async () => {
    const r = await reconcile(txFixture({ pre: 1_000_000_000, post: 1_150_000_000, tokensBefore: '1000000000', tokensAfter: '0' }), 1);
    expect(r.success).toBe(true);
    expect(r.reconciliationState).toBe('RECONCILED');
    expect(r.actualNetSolProceedsLamports).toBe(150_000_000);
    expect(r.actualGrossSolProceedsLamports).toBe(150_000_000 + FEE);
    expect(r.actualNetworkFeeLamports).toBe(FEE);
    expect(r.actualTokensSoldRaw).toBe('1000000000');
    expect(r.tokensSoldHuman).toBe(1000);
    expect(r.actualRealizedPnLSol).toBeCloseTo(0.05, 9);
    expect(r.remainingTokensRaw).toBe('0');
    expect(r.isFullyClosed).toBe(true);
    expect(r.slot).toBe(777);
  });

  it('loss: full sell returns 60M lamports against 100M cost, PnL is -0.04 SOL', async () => {
    const r = await reconcile(txFixture({ pre: 1_000_000_000, post: 1_060_000_000, tokensBefore: '1000000000', tokensAfter: '0' }), 1);
    expect(r.success).toBe(true);
    expect(r.actualNetSolProceedsLamports).toBe(60_000_000);
    expect(r.actualRealizedPnLSol).toBeCloseTo(-0.04, 9);
    expect(r.isFullyClosed).toBe(true);
  });

  it('partial sell: only the sold fraction of the cost basis is charged and the remainder stays open', async () => {
    const r = await reconcile(txFixture({ pre: 1_000_000_000, post: 1_030_000_000, tokensBefore: '1000000000', tokensAfter: '600000000' }), 0.4);
    expect(r.actualTokensSoldRaw).toBe('400000000');
    expect(r.remainingTokensRaw).toBe('600000000');
    expect(r.isFullyClosed).toBe(false);
    expect(r.actualRealizedPnLSol).toBeCloseTo((30_000_000 - 40_000_000) / 1e9, 9);
  });

  it('a reverted sell books nothing and is not RECONCILED', async () => {
    const r = await reconcile(txFixture({ pre: 1_000_000_000, post: 999_995_000, tokensBefore: '1000000000', tokensAfter: '1000000000', err: { InstructionError: [0, 'Custom'] } }), 1);
    expect(r.success).toBe(false);
    expect(r.reconciliationState).toBe('REVERTED');
    expect(r.actualNetSolProceedsLamports).toBe(0);
    expect(r.isFullyClosed).toBe(false);
  });

  it('a transaction that cannot be fetched asks for reconciliation instead of booking a fill', async () => {
    vi.spyOn(TradeReconciler as any, 'fetchConfirmedTx').mockResolvedValue(null);
    const r = await reconcile(null, 1);
    expect(r.success).toBe(false);
    expect(r.reconciliationState).toBe('RECONCILIATION_REQUIRED');
  });

  // A146: the wallet's SOL delta is negative when the sell returned less than the fee and tip it paid. reconciliation.ts clamps the
  // proceeds at 0 (Math.max(0, post - pre)), so the realized loss is booked as exactly the cost portion, too small by the shortfall.
  // The correct booking keeps the negative proceeds: here pre-post = 20_000 lamports, so PnL = (-20_000 - 100_000_000) / 1e9.
  it.todo('A146: negative wallet SOL delta (-20_000 lamports) is booked as proceeds -20_000 and PnL -0.10002 SOL, not clamped to 0 (fix pending in worker C1/C2 batch)');
});
