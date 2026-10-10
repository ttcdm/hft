import { describe, it, expect } from 'vitest';
import { MessageAccountKeys, PublicKey } from '@solana/web3.js';
import { TradeReconciler } from '../server/execution/reconciliation';
import { TOKEN_2022_PROGRAM_ID } from '../server/solana/programs';
import { ExitEngine } from '../server/exits/exitEngine';
import fixture from './fixtures/devnet_buy_5tVXiM.json';

/**
 * F1: the real devnet buy 5tVXiM… (0.01 SOL into a Token-2022 pump curve, 2026-10-10) recorded an entry price ~14% above
 * the curve price. The buyer also funded a pump-owned account (1,346,200 lamports) that P2's split did not subtract.
 * Fixture: the transaction's public balance data from getTransaction (no keys or secrets).
 */
const WALLET = new PublicKey(fixture.accountKeys[0]);
const MINT = new PublicKey('GhkRAgqCeuRiE9eBGQ6nQFZkFeg7ZTwk55zNA7zF8YyH');
const TOKENS_RAW = '9540846041122';
const DECIMALS = 6;

function connection() {
  return {
    getTransaction: async () => ({
      slot: fixture.slot,
      transaction: { message: { getAccountKeys: () => new MessageAccountKeys(fixture.accountKeys.map((k) => new PublicKey(k))) } },
      meta: {
        err: null,
        fee: fixture.fee,
        preBalances: fixture.preBalances,
        postBalances: fixture.postBalances,
        preTokenBalances: fixture.preTokenBalances,
        postTokenBalances: fixture.postTokenBalances,
      },
    }),
    getTokenAccountBalance: async () => { throw new Error('not needed'); },
  } as any;
}

const snap = { walletSolLamports: fixture.preBalances[0], tokenBalanceRaw: '0', tokenDecimals: DECIMALS, timestamp: Date.now() };

describe('F1: entry price on the real devnet Token-2022 buy', () => {
  it('splits 12,902,540 lamports into curve 10,000,000, ATA rent, other new-account rent and fee', async () => {
    const r = await TradeReconciler.reconcileBuyTransaction(connection(), fixture.signature, WALLET, MINT, TOKEN_2022_PROGRAM_ID, snap, 0);
    expect(r.success).toBe(true);
    expect(r.actualSolSpentLamports).toBe(12_902_540);
    expect(r.actualTokensReceivedRaw).toBe(TOKENS_RAW);
    expect(r.tokenAccountRentLamports).toBe(1_513_840);
    expect(r.otherNewAccountRentLamports).toBe(1_346_200);
    expect(r.actualNetworkFeeLamports).toBe(42_500);
    expect(r.curveSpendLamports).toBe(10_000_000); // the 0.01 SOL order, pump fees included
  });

  it('the entry price is the curve price paid (about 1.048e-9), not the 1.189e-9 the app recorded on devnet', async () => {
    const r = await TradeReconciler.reconcileBuyTransaction(connection(), fixture.signature, WALLET, MINT, TOKEN_2022_PROGRAM_ID, snap, 0);
    const tokens = Number(TOKENS_RAW) / 10 ** DECIMALS;
    expect(r.effectiveFillPriceSol).toBeCloseTo(0.01 / tokens, 15);
    expect(r.effectiveFillPriceSol).toBeLessThan(1.06e-9);
    expect(r.allInFillPriceSol!).toBeCloseTo(0.01290254 / tokens, 15); // cost basis stays all-in
  });

  it('the mark the dashboard showed right after the buy (1.045e-9) is within 1% of entry, so no stop-loss fires', async () => {
    const r = await TradeReconciler.reconcileBuyTransaction(connection(), fixture.signature, WALLET, MINT, TOKEN_2022_PROGRAM_ID, snap, 0);
    const d = ExitEngine.evaluate({ entryPriceSol: r.effectiveFillPriceSol, currentPriceSol: 1.045e-9, entryTimestamp: Date.now() - 1000 });
    expect(Math.abs(d.profitPct)).toBeLessThan(1);
    expect(d.shouldExit).toBe(false);
  });
});
