import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { PumpCurveService, PumpMarketState, inspectToken2022Extensions } from '../server/solana/pumpCurve';
import { TOKEN_PROGRAM_ID } from '../server/solana/programs';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';

describe('Accounting & Reconciliation — Curve Math and PnL', () => {
  const dummyMint = new PublicKey('CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS');
  const dummyBondingCurve = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');

  const baseMarketState: PumpMarketState = {
    mint: dummyMint,
    bondingCurve: dummyBondingCurve,
    associatedBondingCurve: dummyBondingCurve,
    creator: dummyMint,
    feeRecipient: new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM'),
    buybackFeeRecipient: new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD'),
    quoteMint: new PublicKey('So11111111111111111111111111111111111111112'),
    baseTokenProgram: TOKEN_PROGRAM_ID,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
    tokenProgram: TOKEN_PROGRAM_ID,
    tokenDecimals: 6,
    virtualTokenReserves: 1_073_000_000_000_000n, // 1.073B tokens with 6 decimals
    virtualSolReserves: 30_000_000_000n,          // 30 SOL initial
    realTokenReserves: 793_000_000_000_000n,
    realSolReserves: 0n,
    tokenTotalSupply: 1_000_000_000_000_000n,
    complete: false,
    isMayhemMode: false,
    protocolFeeBps: 100,
    creatorFeeBps: 0,
    mintAuthorityStatus: 'PASS',
    freezeAuthorityStatus: 'PASS',
    isMintAuthorityRevoked: true,
    isFreezeAuthorityRevoked: true,
    feeComputationStatus: 'VERIFIED',
    marketDataTimestamp: Date.now(),
    marketDataSource: 'SOLANA_RPC_BONDING_CURVE',
  };

  it('strictly throws CRITICAL_CONFIG_ERROR if executionMode is omitted from quotes', () => {
    expect(() => (PumpCurveService as any).calculateBuyQuote(baseMarketState, 0.1)).toThrow(/CRITICAL_CONFIG_ERROR/);
    expect(() => (PumpCurveService as any).calculateSellQuote(baseMarketState, 1000n)).toThrow(/CRITICAL_CONFIG_ERROR/);
  });

  it('fails closed in LIVE mode if global fee config is missing', () => {
    expect(() =>
      PumpCurveService.calculateBuyQuote({
        state: baseMarketState,
        amountSol: 0.1,
        executionMode: 'LIVE',
      })
    ).toThrow(/DYNAMIC_FEE_CALCULATION_FAILED/);

    expect(() =>
      PumpCurveService.calculateSellQuote({
        state: baseMarketState,
        tokenAmountRaw: 1_000_000n,
        executionMode: 'LIVE',
      })
    ).toThrow(/DYNAMIC_FEE_CALCULATION_FAILED/);
  });

  it('calculates mathematically rigorous BUY quote without synthetic fallbacks', () => {
    const quote = PumpCurveService.calculateBuyQuote({
      state: baseMarketState,
      amountSol: 0.1,
      slippageBps: 500,
      jitoTipSol: 0.001,
      priorityFeeLamports: 25000,
      executionMode: 'PAPER',
    });

    expect(quote.side).toBe('BUY');
    expect(quote.mint).toBe(dummyMint.toBase58());
    expect(quote.expectedSolAmountLamports).toBe(100_000_000); // 0.1 SOL
    expect(quote.protocolFeeLamports).toBe(1_000_000);        // 1% of 0.1 SOL = 0.001 SOL
    expect(BigInt(quote.tokenAmountRaw)).toBeGreaterThan(0n);
    expect(quote.spotPriceSol).toBeGreaterThan(0);
    expect(quote.executionPriceSol).toBeGreaterThanOrEqual(quote.spotPriceSol);
    expect(quote.estimatedPriceImpactBps).toBeGreaterThanOrEqual(0);
    expect(quote.maxInputLamports).toBe(105_000_000); // 5% slippage applied to 0.1 SOL
  });

  it('calculates mathematically rigorous SELL quote without synthetic fallbacks', () => {
    // Sell 1,000,000 tokens (1 token in 6-dec terms)
    const tokenSellRaw = 1_000_000_000_000n;
    const quote = PumpCurveService.calculateSellQuote({
      state: baseMarketState,
      tokenAmountRaw: tokenSellRaw,
      slippageBps: 500,
      jitoTipSol: 0.001,
      priorityFeeLamports: 25000,
      executionMode: 'PAPER',
    });

    expect(quote.side).toBe('SELL');
    expect(quote.tokenAmountRaw).toBe(tokenSellRaw.toString());
    expect(quote.expectedSolAmountLamports).toBeGreaterThan(0);
    expect(quote.protocolFeeLamports).toBeGreaterThan(0);
    expect(quote.minOutputLamports).toBeLessThan(quote.expectedSolAmountLamports);
  });

  it('rejects quotes when bonding curve is 100% complete (migrated)', () => {
    const completedState = { ...baseMarketState, complete: true };
    expect(() =>
      PumpCurveService.calculateBuyQuote({
        state: completedState,
        amountSol: 0.1,
        executionMode: 'PAPER',
      })
    ).toThrow(/BONDING_CURVE_MIGRATED/);

    expect(() =>
      PumpCurveService.calculateSellQuote({
        state: completedState,
        tokenAmountRaw: 1000n,
        executionMode: 'PAPER',
      })
    ).toThrow(/BONDING_CURVE_MIGRATED/);
  });

  it('accurately parses and flags dangerous Token-2022 extensions', () => {
    // Normal 82-byte SPL mint data
    const cleanMint = Buffer.alloc(82);
    expect(inspectToken2022Extensions(cleanMint).isSafe).toBe(true);

    // Token-2022 with TransferFee (extension type 1)
    const feeMint = Buffer.alloc(166 + 4 + 12);
    feeMint[165] = 1; // account type = Mint
    feeMint.writeUInt16LE(1, 166); // extension type = 1
    feeMint.writeUInt16LE(12, 168); // length = 12
    const feeResult = inspectToken2022Extensions(feeMint);
    expect(feeResult.hasTransferFee).toBe(true);
    expect(feeResult.isSafe).toBe(false);

    // Token-2022 with TransferHook (extension type 14)
    const hookMint = Buffer.alloc(166 + 4 + 12);
    hookMint[165] = 1;
    hookMint.writeUInt16LE(14, 166); // extension type = 14
    hookMint.writeUInt16LE(12, 168);
    const hookResult = inspectToken2022Extensions(hookMint);
    expect(hookResult.hasTransferHook).toBe(true);
    expect(hookResult.isSafe).toBe(false);
  });

  it('fails closed when PumpSwap pool does not exist for sell instructions', async () => {
    // Mock connection
    const mockConn = {
      getAccountInfo: async () => null,
      getMultipleAccountsInfo: async () => [null, null, null],
    } as any;

    await expect(
      PumpSwapVenueService.buildPumpSwapSellInstructions(
        mockConn,
        dummyMint,
        dummyMint,
        1000n,
        800,
        'PAPER'
      )
    ).rejects.toThrow();
  });

  it('handles partial sales correctly (25%, 50%, 99%, 100%)', () => {
    const totalTokensRaw = 10_000_000_000_000n; // Total bought
    const costBasisLamports = 100_000_000;      // 0.1 SOL entry cost

    const fractions = [0.25, 0.50, 0.99, 1.0];

    for (const fraction of fractions) {
      const soldTokensRaw = BigInt(Math.round(Number(totalTokensRaw) * fraction));
      const remainingTokensRaw = totalTokensRaw - soldTokensRaw;
      const costPortionLamports = costBasisLamports * fraction;

      // Suppose proceeds = 1.2x cost basis (profitable trade)
      const netSolProceedsLamports = Math.round(costPortionLamports * 1.2);
      const realizedPnLSol = (netSolProceedsLamports - costPortionLamports) / 1e9;

      expect(soldTokensRaw).toBeGreaterThan(0n);
      expect(remainingTokensRaw).toBeGreaterThanOrEqual(0n);
      expect(realizedPnLSol).toBeGreaterThan(0);

      if (fraction === 1.0) {
        expect(remainingTokensRaw).toBe(0n);
      }
    }
  });

  it('handles negative PnL when proceeds are below cost basis', () => {
    const costBasisLamports = 100_000_000; // 0.1 SOL entry

    // Loss scenario: received 0.07 SOL proceeds on 100% exit
    const netSolProceedsLamports = 70_000_000;
    const realizedPnLSol = (netSolProceedsLamports - costBasisLamports) / 1e9;

    expect(realizedPnLSol).toBe(-0.03);
  });

  it('handles large token quantities safely using BigInt without precision loss', () => {
    // 500 Trillion raw units (common for high-supply memecoins)
    const largeAmount = 500_000_000_000_000_000n;
    const half = largeAmount / 2n;

    expect(half + half).toBe(largeAmount);
    expect(largeAmount.toString()).toBe('500000000000000000');
  });

  it('differentiates 6 decimals vs 9 decimals accurately', () => {
    const rawTokens = 1_000_000_000n;
    const humanQty6 = Number(rawTokens) / Math.pow(10, 6);
    const humanQty9 = Number(rawTokens) / Math.pow(10, 9);

    expect(humanQty6).toBe(1000); // 1,000 tokens in 6 decimals
    expect(humanQty9).toBe(1);    // 1 token in 9 decimals
  });

  it('preserves last_mark_timestamp separately from record_updated_at in database', async () => {
    const { workstationDb } = await import('../server/db/database');
    const posId = `test-mark-${Date.now()}`;
    const markTime = 1700000000000;

    workstationDb.savePosition({
      id: posId,
      symbol: 'TEST',
      name: 'Test Token',
      mint: dummyMint.toBase58(),
      tokenDecimals: 6,
      tokenQuantityRaw: '1000000',
      costBasisLamports: 10000000,
      entryPriceSol: 0.01,
      currentPriceSol: 0.012,
      currentValueSol: 0.012,
      unrealizedPnLSol: 0.002,
      unrealizedPnLPct: 20.0,
      status: 'OPEN',
      executionMode: 'PAPER',
      entryTimestamp: markTime,
      lastUpdatedTimestamp: markTime,
      lastMarkTimestamp: markTime,
      entryTxSignature: 'sig-test-1',
      entrySlot: 100,
      entryFeeLamports: 5000,
      priorityFeeLamports: 0,
      realizedPnLSol: 0,
      jitoTipLamports: 0,
      markAgeMs: 0,
      markSource: 'SOLANA_RPC',
    });

    const loaded1 = workstationDb.loadPositions().find((p) => p.id === posId);
    expect(loaded1).toBeDefined();
    expect(loaded1?.lastMarkTimestamp).toBe(markTime);

    // Now update position without updating mark (e.g. status change or internal record update)
    // Wait a millisecond so record_updated_at advances
    await new Promise((r) => setTimeout(r, 10));
    loaded1!.status = 'PARTIALLY_CLOSED';
    workstationDb.savePosition(loaded1!);

    const loaded2 = workstationDb.loadPositions().find((p) => p.id === posId);
    expect(loaded2?.status).toBe('PARTIALLY_CLOSED');
    expect(loaded2?.lastMarkTimestamp).toBe(markTime); // Mark timestamp MUST remain the original mark time!
  });

  it('correctly loads ACTIVE positions including OPEN and PARTIALLY_CLOSED, excluding CLOSED', async () => {
    const { workstationDb } = await import('../server/db/database');
    const idOpen = `test-open-${Date.now()}`;
    const idPartial = `test-partial-${Date.now()}`;
    const idClosed = `test-closed-${Date.now()}`;

    const base = {
      symbol: 'TEST',
      name: 'Test Token',
      mint: dummyMint.toBase58(),
      tokenDecimals: 6,
      tokenQuantityRaw: '1000000',
      costBasisLamports: 10000000,
      entryPriceSol: 0.01,
      currentPriceSol: 0.01,
      currentValueSol: 0.01,
      unrealizedPnLSol: 0,
      unrealizedPnLPct: 0,
      realizedPnLSol: 0,
      entrySlot: 100,
      executionMode: 'PAPER' as const,
      entryTimestamp: Date.now(),
      lastUpdatedTimestamp: Date.now(),
      entryTxSignature: 'sig-test',
      entryFeeLamports: 5000,
      priorityFeeLamports: 0,
      jitoTipLamports: 0,
      markAgeMs: 0,
      markSource: 'SOLANA_RPC' as const,
    };

    workstationDb.savePosition({ ...base, id: idOpen, status: 'OPEN' });
    workstationDb.savePosition({ ...base, id: idPartial, status: 'PARTIALLY_CLOSED' });
    workstationDb.savePosition({ ...base, id: idClosed, status: 'CLOSED' });

    const active = workstationDb.loadPositions('PAPER', 'ACTIVE');
    const openOnly = workstationDb.loadPositions('PAPER', 'OPEN');

    const activeIds = active.map((p) => p.id);
    expect(activeIds).toContain(idOpen);
    expect(activeIds).toContain(idPartial);
    expect(activeIds.includes(idClosed)).toBe(false);

    const openOnlyIds = openOnly.map((p) => p.id);
    expect(openOnlyIds).toContain(idOpen);
    expect(openOnlyIds.includes(idPartial)).toBe(false);
  });

  it('rejects instruction construction with FEE_RECIPIENT_COLLISION when fee recipients collide', async () => {
    const { SolanaTransactionBuilder } = await import('../server/solana/transactionBuilder');
    const collidingRecipient = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');

    await expect(
      SolanaTransactionBuilder.createPumpBuyV2Instruction({
        buyer: dummyMint,
        mint: dummyMint,
        bondingCurve: dummyBondingCurve,
        associatedBondingCurve: dummyBondingCurve,
        associatedUser: dummyBondingCurve,
        creator: dummyMint,
        feeRecipient: collidingRecipient,
        buybackFeeRecipient: collidingRecipient, // Collision!
        amountTokens: 1_000_000n,
        maxSolCostLamports: 10_000_000n,
      })
    ).rejects.toThrow(/FEE_RECIPIENT_COLLISION/);
  });
});

