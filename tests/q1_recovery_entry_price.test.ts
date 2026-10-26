import { describe, it, expect } from 'vitest';
import { MessageAccountKeys, PublicKey } from '@solana/web3.js';
import { TradeReconciler } from '../server/execution/reconciliation';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { ExitEngine } from '../server/exits/exitEngine';
import fixture from './fixtures/devnet_buy_5tVXiM.json';

/**
 * Q1: an orphan-recovered first buy must be priced like a live-reconciled one. The real devnet buy (fixture) funded a pump per-user
 * account (1,346,200 lamports) besides its token account; recoverInterruptedTransaction used to leave that in the curve spend,
 * so the recovered entry price came out ~14% high and the next honest mark read as a loss that fires the stop.
 */
const WALLET = new PublicKey(fixture.accountKeys[0]);
const connection = {
  getTransaction: async () => ({
    slot: fixture.slot,
    blockTime: 1_760_000_000,
    transaction: { message: { getAccountKeys: () => new MessageAccountKeys(fixture.accountKeys.map((k) => new PublicKey(k))), staticAccountKeys: fixture.accountKeys.map((k) => new PublicKey(k)) } },
    meta: { err: null, fee: fixture.fee, preBalances: fixture.preBalances, postBalances: fixture.postBalances, preTokenBalances: fixture.preTokenBalances, postTokenBalances: fixture.postTokenBalances },
  }),
} as any;

describe('Q1: recovery prices the entry like the live reconcile', () => {
  it('recoverInterruptedTransaction subtracts the other new-account rent', async () => {
    const r = await TradeReconciler.recoverInterruptedTransaction(connection, fixture.signature, WALLET);
    expect(r.recovered).toBe(true);
    expect(r.solSpentLamports).toBe(12_902_540);
    expect(r.tokenAccountRentLamports).toBe(1_513_840);
    expect(r.otherNewAccountRentLamports).toBe(1_346_200);
    expect(r.curveSpendLamports).toBe(10_000_000);
  });

  it('the recovered position enters at the curve price, so a flat mark does not stop it out', async () => {
    const r = await TradeReconciler.recoverInterruptedTransaction(connection, fixture.signature, WALLET);
    const pos = (ExecutionCoordinator.prototype as any).positionFromRecoveredBuy.call({}, { signature: fixture.signature, mint: r.mint, jitoTipLamports: 0, executionMode: 'LIVE' }, r, fixture.slot);
    const tokens = Number(r.tokenQuantityRaw) / 1e6;
    expect(pos.entryPriceSol).toBeCloseTo(0.01 / tokens, 15);
    expect(pos.costBasisLamports).toBe(12_902_540); // cost basis stays all-in
    const d = ExitEngine.evaluate({ entryPriceSol: pos.entryPriceSol, currentPriceSol: 1.045e-9, entryTimestamp: Date.now() - 1000 });
    expect(d.shouldExit).toBe(false);
  });
});
