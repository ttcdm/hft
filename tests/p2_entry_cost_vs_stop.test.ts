import { describe, it, expect } from 'vitest';
import { Keypair, MessageAccountKeys, PublicKey } from '@solana/web3.js';
import { TradeReconciler } from '../server/execution/reconciliation';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { TOKEN_PROGRAM_ID } from '../server/solana/programs';
import { ExitEngine } from '../server/exits/exitEngine';

/**
 * P2 (critique #2): the entry price must be what the curve charged, not the whole wallet delta.
 * Wallet, mint and keys are freshly generated throwaway values; the Connection is a minimal stand-in for getTransaction.
 */
const SOL = 1e9;
const RENT = 2_039_280;

function setup(opts: { curveLamports: number; fee: number; tip: number; rent: number; tokensRaw: string }) {
  const wallet = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const ata = PumpCurveService.getAssociatedTokenAddress(mint, wallet, TOKEN_PROGRAM_ID);
  const curve = Keypair.generate().publicKey;
  const tipAcct = Keypair.generate().publicKey;
  const keys = [wallet, ata, curve, tipAcct];
  const delta = opts.curveLamports + opts.fee + opts.tip + opts.rent;
  const pre = [5 * SOL, 0, 10 * SOL, 1 * SOL]; // a tip account already exists on chain
  const post = [5 * SOL - delta, opts.rent, 10 * SOL + opts.curveLamports, 1 * SOL + opts.tip];
  const connection = {
    getTransaction: async () => ({
      slot: 123,
      transaction: { message: { getAccountKeys: () => new MessageAccountKeys(keys) } },
      meta: {
        err: null,
        fee: opts.fee,
        preBalances: pre,
        postBalances: post,
        preTokenBalances: [],
        postTokenBalances: [{ accountIndex: 1, mint: mint.toBase58(), owner: wallet.toBase58(), uiTokenAmount: { amount: opts.tokensRaw, decimals: 6 } }],
      },
    }),
    getTokenAccountBalance: async () => { throw new Error('no ata'); },
  } as any;
  const snap = { walletSolLamports: 5 * SOL, tokenBalanceRaw: '0', tokenDecimals: 6, timestamp: Date.now() };
  return { wallet, mint, connection, snap, delta };
}

describe('P2: entry cost vs stop-loss', () => {
  // 0.02 SOL order: 0.0185 SOL to the curve, a 0.0035 SOL tip and 0.0001 SOL of fees on top, plus new-ATA rent.
  const spec = { curveLamports: 18_500_000, fee: 100_000, tip: 3_500_000, rent: RENT, tokensRaw: '600000000000' };

  it('splits the wallet delta into curve spend, rent, tip and fees', async () => {
    const { wallet, mint, connection, snap, delta } = setup(spec);
    const r = await TradeReconciler.reconcileBuyTransaction(connection, 'sig', wallet, mint, TOKEN_PROGRAM_ID, snap, spec.tip);
    expect(r.success).toBe(true);
    expect(r.actualSolSpentLamports).toBe(delta);
    expect(r.tokenAccountRentLamports).toBe(RENT);
    expect(r.curveSpendLamports).toBe(spec.curveLamports);
    const tokens = 600_000;
    expect(r.effectiveFillPriceSol).toBeCloseTo(spec.curveLamports / SOL / tokens, 12);
    expect(r.allInFillPriceSol).toBeCloseTo(delta / SOL / tokens, 12);
    expect(r.allInFillPriceSol!).toBeGreaterThan(r.effectiveFillPriceSol * 1.2);
  });

  it('a flat market does not trip the hard stop on the first mark, and the old all-in price would have', async () => {
    const { wallet, mint, connection, snap } = setup(spec);
    const r = await TradeReconciler.reconcileBuyTransaction(connection, 'sig', wallet, mint, TOKEN_PROGRAM_ID, snap, spec.tip);
    const flatMark = spec.curveLamports / SOL / 600_000; // the curve price the buy just paid
    const entryTs = Date.now() - 1000;
    const fixed = ExitEngine.evaluate({ entryPriceSol: r.effectiveFillPriceSol, currentPriceSol: flatMark, entryTimestamp: entryTs });
    expect(fixed.shouldExit).toBe(false);
    expect(fixed.profitPct).toBeCloseTo(0, 3);
    const old = ExitEngine.evaluate({ entryPriceSol: r.allInFillPriceSol!, currentPriceSol: flatMark, entryTimestamp: entryTs });
    expect(old.reason).toBe('STOP_LOSS');
  });

  it('a real -20% move still stops out against the curve price', async () => {
    const { wallet, mint, connection, snap } = setup(spec);
    const r = await TradeReconciler.reconcileBuyTransaction(connection, 'sig', wallet, mint, TOKEN_PROGRAM_ID, snap, spec.tip);
    const d = ExitEngine.evaluate({ entryPriceSol: r.effectiveFillPriceSol, currentPriceSol: r.effectiveFillPriceSol * 0.79, entryTimestamp: Date.now() - 1000 });
    expect(d.reason).toBe('STOP_LOSS');
  });

  it('with an existing token account (no new rent) nothing is subtracted for rent', async () => {
    const { wallet, mint, connection, snap } = setup({ ...spec, rent: 0 });
    const r = await TradeReconciler.reconcileBuyTransaction(connection, 'sig', wallet, mint, TOKEN_PROGRAM_ID, snap, spec.tip);
    expect(r.tokenAccountRentLamports).toBe(0);
    expect(r.curveSpendLamports).toBe(spec.curveLamports);
  });

  it('cost basis stays the true all-in wallet delta so PnL is honest', async () => {
    const { wallet, mint, connection, snap, delta } = setup(spec);
    const r = await TradeReconciler.reconcileBuyTransaction(connection, 'sig', wallet, mint, TOKEN_PROGRAM_ID, snap, spec.tip);
    expect(r.actualSolSpentLamports).toBe(delta);
  });

  it('falls back to the whole delta when the split would leave nothing for the curve', async () => {
    const { wallet, mint, connection, snap, delta } = setup({ curveLamports: 1_000, fee: 5_000, tip: 0, rent: 0, tokensRaw: '1000000' });
    const r = await TradeReconciler.reconcileBuyTransaction(connection, 'sig', wallet, mint, TOKEN_PROGRAM_ID, snap, 50_000_000);
    expect(r.curveSpendLamports).toBe(delta);
  });
});
