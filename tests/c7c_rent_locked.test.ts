import { describe, it, expect, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { CapitalSizer } from '../server/capital/capitalSizer';
import { executionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';
import { buildBoard } from '../server/board';

const RENT = 2_039_280 / 1e9;
function save(id: string, mode: 'LIVE' | 'PAPER', status: string) {
  workstationDb.savePosition({
    id, mint: Keypair.generate().publicKey.toBase58(), symbol: 'R', name: 'R', tokenDecimals: 6, tokenQuantityRaw: '1000',
    entryPriceSol: 1e-6, currentPriceSol: 1e-6, currentValueSol: 0.001, costBasisLamports: 1_000_000, realizedPnLSol: 0, status,
    venue: 'PUMP_BONDING_CURVE', executionMode: mode, entryTxSignature: id, entryTimestamp: Date.now(), recordUpdatedAt: Date.now(), updatedAt: Date.now(),
  } as any);
}

describe('C7c: token-account rent counts as locked capital', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the sizer subtracts rent; the SPL constant is the real rent-exempt minimum', () => {
    expect(CapitalSizer.SPL_TOKEN_ACCOUNT_RENT_LAMPORTS).toBe(2_039_280);
    expect(CapitalSizer.calculateSpendableBankroll(1, 0.015, 0, 0)).toBeCloseTo(0.985, 9);
    expect(CapitalSizer.calculateSpendableBankroll(1, 0.015, 0.1, 0.004078560)).toBeCloseTo(0.88092144, 9);
    expect(CapitalSizer.calculateSpendableBankroll(0.01, 0.015, 0, 0.002)).toBe(0);
  });

  it('coordinator: rent = open LIVE positions x 2,039,280 lamports; closed and paper positions do not count', () => {
    const before = executionCoordinator.getRentLockedSol();
    save('rent-live-1', 'LIVE', 'OPEN');
    save('rent-live-2', 'LIVE', 'OPEN');
    save('rent-paper', 'PAPER', 'OPEN');
    save('rent-closed', 'LIVE', 'CLOSED');
    expect(executionCoordinator.getRentLockedSol() - before).toBeCloseTo(2 * RENT, 12);
  });

  it('spendable and the board use the same number; with no balance read the board shows a dash', () => {
    vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol').mockReturnValue(null);
    expect(buildBoard().wallet.rentLockedSol).toBeNull();
    vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol').mockReturnValue(0.5);
    const rent = executionCoordinator.getRentLockedSol();
    expect(rent).toBeGreaterThan(0); // the live positions saved above
    expect(buildBoard().wallet.rentLockedSol).toBe(rent);
    expect(executionCoordinator.getSpendableBankrollSol()).toBe(
      CapitalSizer.calculateSpendableBankroll((executionCoordinator as any).realWalletBalanceSol ?? 0, 0.015, 0, rent)
    );
  });
});
