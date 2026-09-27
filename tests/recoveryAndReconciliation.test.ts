import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { workstationDb } from '../server/db/database';
import { NormalizedPosition } from '../server/core/types';
import { TradeReconciler } from '../server/execution/reconciliation';

describe('Recovery & Reconciliation Subsystem', () => {
  const testId = `test_pos_${Date.now()}`;
  const testPosition: NormalizedPosition = {
    id: testId,
    mint: 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS',
    symbol: 'TESTCOIN',
    name: 'Test Memecoin',
    tokenDecimals: 6,
    tokenQuantityRaw: '1000000000',
    costBasisLamports: 100_000_000,
    entryPriceSol: 0.0001,
    currentPriceSol: 0.00012,
    currentValueSol: 0.12,
    unrealizedPnLSol: 0.02,
    unrealizedPnLPct: 20.0,
    realizedPnLSol: 0,
    entryTxSignature: '4vJ9JU1bJJE96TLNxzbVjyD3bV71jVj1v9',
    entrySlot: 280000000,
    entryTimestamp: Date.now(),
    entryFeeLamports: 5000,
    priorityFeeLamports: 25000,
    jitoTipLamports: 1_000_000,
    executionMode: 'PAPER',
    status: 'OPEN',
    markAgeMs: 0,
    markSource: 'SOLANA_RPC',
    lastUpdatedTimestamp: Date.now(),
  };

  it('persists positions to SQLite database and verifies round-trip fidelity', () => {
    workstationDb.savePosition(testPosition);

    const loaded = workstationDb.loadPositions('PAPER', 'OPEN');
    const matched = loaded.find((p) => p.id === testId);

    expect(matched).toBeDefined();
    expect(matched!.symbol).toBe('TESTCOIN');
    expect(matched!.tokenQuantityRaw).toBe('1000000000');
    expect(matched!.costBasisLamports).toBe(100_000_000);
  });

  it('records structured journal audit logs', () => {
    workstationDb.logJournal('SYSTEM_STARTUP', 'test-corr-1', 'PAPER', { test: true });

    const logs = workstationDb.getEvents(10);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.eventType === 'SYSTEM_STARTUP')).toBe(true);
  });

  it('updates position status on exit without orphaned records', () => {
    testPosition.status = 'CLOSED';
    testPosition.exitReason = 'TEST_EXIT';
    testPosition.exitTxSignature = '5xK9JU1bJJE96TLNxzbVjyD3bV71jVj1v9';
    testPosition.realizedPnLSol = 0.02;

    workstationDb.savePosition(testPosition);

    const openPositions = workstationDb.loadPositions('PAPER', 'OPEN');
    expect(openPositions.some((p) => p.id === testId)).toBe(false);

    const closedPositions = workstationDb.loadPositions('PAPER', 'CLOSED');
    expect(closedPositions.some((p) => p.id === testId)).toBe(true);
  });

  it('reconciles interrupted partial SELL without invisible inventory or stale CLOSED status', async () => {
    const { PublicKey } = await import('@solana/web3.js');
    const { TradeReconciler } = await import('../server/execution/reconciliation');

    const walletKey = new PublicKey('11111111111111111111111111111112');
    const testMint = 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS';
    const posId = `partial_sell_pos_${Date.now()}`;
    const sellTxSig = '6yL9JU1bJJE96TLNxzbVjyD3bV71jVj1v9';

    // 1. Initial position with 1,000,000 tokens (1,000,000 * 10^6 raw units) and 1.0 SOL cost basis
    const initialPos: NormalizedPosition = {
      id: posId,
      mint: testMint,
      symbol: 'PARTSALE',
      name: 'Partial Sale Token',
      tokenDecimals: 6,
      tokenQuantityRaw: '1000000000000', // 1,000,000 tokens
      costBasisLamports: 1_000_000_000, // 1.0 SOL
      entryPriceSol: 0.000001,
      currentPriceSol: 0.0000014,
      currentValueSol: 1.4,
      unrealizedPnLSol: 0.4,
      unrealizedPnLPct: 40.0,
      realizedPnLSol: 0,
      entryTxSignature: '3wK9JU1bJJE96TLNxzbVjyD3bV71jVj1v8',
      entrySlot: 280000000,
      entryTimestamp: Date.now() - 60000,
      entryFeeLamports: 5000,
      priorityFeeLamports: 25000,
      jitoTipLamports: 1_000_000,
      executionMode: 'PAPER',
      status: 'OPEN',
      markAgeMs: 0,
      markSource: 'SOLANA_RPC',
      lastUpdatedTimestamp: Date.now(),
    };
    workstationDb.savePosition(initialPos);

    // 2. Mock connection for on-chain transaction: 25% sold (250,000 tokens), 750,000 tokens remain
    const mockConnection: any = {
      getTransaction: async () => ({
        slot: 280001000,
        blockTime: Math.floor(Date.now() / 1000),
        transaction: {
          message: {
            getAccountKeys: () => ({
              staticAccountKeys: [walletKey, new PublicKey('11111111111111111111111111111111')],
            }),
          },
        },
        meta: {
          err: null,
          fee: 5000,
          preBalances: [2_000_000_000, 100_000_000],
          postBalances: [2_350_000_000, 100_000_000], // +0.35 SOL received net
          preTokenBalances: [
            {
              accountIndex: 0,
              mint: testMint,
              owner: walletKey.toBase58(),
              uiTokenAmount: { amount: '1000000000000', decimals: 6 },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 0,
              mint: testMint,
              owner: walletKey.toBase58(),
              uiTokenAmount: { amount: '750000000000', decimals: 6 }, // 750,000 remaining
            },
          ],
        },
      }),
    };

    // 3. Run authoritative on-chain recovery
    const recovery = await TradeReconciler.recoverInterruptedTransaction(
      mockConnection,
      sellTxSig,
      walletKey
    );

    expect(recovery.recovered).toBe(true);
    expect(recovery.type).toBe('SELL');
    expect(recovery.mint).toBe(testMint);
    expect(recovery.tokensSoldRaw).toBe('250000000000'); // 250,000 tokens sold
    expect(recovery.remainingTokensRaw).toBe('750000000000'); // 750,000 remaining
    expect(recovery.solReceivedLamports).toBe(350_000_000); // 0.35 SOL received

    // 4. Reconcile position state against recovery data
    const existing = workstationDb.loadPositions('PAPER', 'OPEN').find((p) => p.id === posId)!;
    expect(existing).toBeDefined();

    const remainingTokens = BigInt(recovery.remainingTokensRaw!);
    const tokensSold = BigInt(recovery.tokensSoldRaw!);
    const totalTokensBefore = BigInt(recovery.tokenBeforeRaw!);
    const sellFraction = Number(tokensSold) / Number(totalTokensBefore);
    const costPortionLamports = Math.round(existing.costBasisLamports * sellFraction);
    const netProceedsLamports = recovery.solReceivedLamports!;
    const realizedPnLSol = (netProceedsLamports - costPortionLamports) / 1e9;

    expect(sellFraction).toBeCloseTo(0.25, 2);
    expect(costPortionLamports).toBe(250_000_000); // 0.25 SOL cost of goods sold
    expect(realizedPnLSol).toBeCloseTo(0.10, 4); // 0.35 SOL proceeds - 0.25 SOL cost = +0.10 SOL profit

    if (remainingTokens > 0n) {
      existing.status = 'PARTIALLY_CLOSED';
      existing.tokenQuantityRaw = remainingTokens.toString();
      existing.costBasisLamports = Math.max(0, existing.costBasisLamports - costPortionLamports);
      existing.realizedPnLSol = (existing.realizedPnLSol ?? 0) + realizedPnLSol;
    } else {
      existing.status = 'CLOSED';
    }
    workstationDb.savePosition(existing);

    // 5. Verify position in DB: must NOT be CLOSED, must be PARTIALLY_CLOSED with 750,000 tokens
    const updated = workstationDb.loadPositions('PAPER', 'PARTIALLY_CLOSED').find((p) => p.id === posId);
    expect(updated).toBeDefined();
    expect(updated!.status).toBe('PARTIALLY_CLOSED');
    expect(updated!.tokenQuantityRaw).toBe('750000000000');
    expect(updated!.costBasisLamports).toBe(750_000_000); // 0.75 SOL remaining cost basis
    expect(updated!.realizedPnLSol).toBeCloseTo(0.10, 4);
  });

  it('recovers interrupted BUY transaction from on-chain state and reconstructs position', async () => {
    const walletKey = new PublicKey('11111111111111111111111111111112');
    const buyTxSig = '7zM9JU1bJJE96TLNxzbVjyD3bV71jVj1v9';
    const buyMint = 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS';

    const mockBuyConnection: any = {
      getTransaction: async () => ({
        slot: 280002000,
        blockTime: Math.floor(Date.now() / 1000),
        transaction: {
          message: {
            getAccountKeys: () => ({
              staticAccountKeys: [walletKey, new PublicKey('11111111111111111111111111111111')],
            }),
          },
        },
        meta: {
          err: null,
          fee: 5000,
          preBalances: [2_000_000_000, 100_000_000],
          postBalances: [1_900_000_000, 100_000_000], // -0.10 SOL net spent
          preTokenBalances: [
            {
              accountIndex: 0,
              mint: buyMint,
              owner: walletKey.toBase58(),
              uiTokenAmount: { amount: '0', decimals: 6 },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 0,
              mint: buyMint,
              owner: walletKey.toBase58(),
              uiTokenAmount: { amount: '500000000000', decimals: 6 }, // 500,000 tokens received
            },
          ],
        },
      }),
    };

    const recovery = await TradeReconciler.recoverInterruptedTransaction(
      mockBuyConnection,
      buyTxSig,
      walletKey
    );

    expect(recovery.recovered).toBe(true);
    expect(recovery.type).toBe('BUY');
    expect(recovery.mint).toBe(buyMint);
    expect(recovery.tokenQuantityRaw).toBe('500000000000');
    expect(recovery.solSpentLamports).toBe(100_000_000);

    // Persist recovered position to SQLite
    const recoveredPosition: NormalizedPosition = {
      id: buyTxSig,
      mint: recovery.mint!,
      symbol: 'RECBUY',
      name: 'Recovered Buy Token',
      tokenDecimals: recovery.tokenDecimals ?? 6,
      tokenQuantityRaw: recovery.tokenQuantityRaw!,
      costBasisLamports: recovery.solSpentLamports!,
      entryPriceSol: 0.0002,
      currentPriceSol: 0.0002,
      currentValueSol: 0.1,
      unrealizedPnLSol: 0,
      unrealizedPnLPct: 0,
      realizedPnLSol: 0,
      entryTxSignature: buyTxSig,
      entrySlot: 280002000,
      entryTimestamp: Date.now(),
      entryFeeLamports: 5000,
      priorityFeeLamports: 0,
      jitoTipLamports: 0,
      executionMode: 'PAPER',
      status: 'OPEN',
      markAgeMs: 0,
      markSource: 'SOLANA_RPC',
      venue: 'PUMP_BONDING_CURVE',
      lastUpdatedTimestamp: Date.now(),
    };

    workstationDb.savePosition(recoveredPosition);
    const inDb = workstationDb.loadPositions('PAPER', 'OPEN').find((p) => p.id === buyTxSig);
    expect(inDb).toBeDefined();
    expect(inDb!.tokenQuantityRaw).toBe('500000000000');
    expect(inDb!.costBasisLamports).toBe(100_000_000);
  });
});

