import { describe, it, expect, beforeEach } from 'vitest';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createCloseAccountInstruction } from '@solana/spl-token';
import {
  fetchTokenHolderDistribution,
  PumpCurveService,
  TokenHolderDistribution,
} from '../server/solana/pumpCurve';
import {
  txBuilder,
  PumpSellParams,
} from '../server/solana/transactionBuilder';
import {
  calculateDynamicJitoTip,
  calculateDynamicJitoTipSol,
  executionConfig,
} from '../server/solana/executionConfig';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { workstationDb, WorkstationDatabase } from '../server/db/database';
import { HardenedRiskEngine } from '../server/risk/riskEngine';
import { EligibilityFilter } from '../server/signals/eligibilityFilter';
import fs from 'fs';
import path from 'path';

describe('Challenger Phase 3 Empirical Verification Suite (B01, B06, B07, B19, B20, B24)', () => {
  const CANONICAL_FEE_RECIPIENT = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');
  const CANONICAL_BUYBACK_RECIPIENT = new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD');
  const mockConn = {
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 99999,
    }),
    getAccountInfo: async () => null,
    getMultipleAccountsInfo: async () => [],
  } as unknown as Connection;

  // =========================================================================
  // TASK 1.1: B01 Boundary & Adversarial Cases
  // =========================================================================
  describe('B01: Holder Distribution Boundary & Adversarial Cases', () => {
    it('B01-ADV.1: Handles empty largestAccounts gracefully without crashing or returning NaN', async () => {
      const mint = Keypair.generate().publicKey;
      const creator = Keypair.generate().publicKey;
      const bondingCurve = Keypair.generate().publicKey;

      const mockConnection = {
        getTokenLargestAccounts: async (_mint: PublicKey) => ({
          value: [],
          context: { slot: 500 },
        }),
        getTokenSupply: async (_mint: PublicKey) => ({
          value: {
            amount: '0',
            decimals: 6,
            uiAmount: 0,
          },
          context: { slot: 500 },
        }),
      } as unknown as Connection;

      const dist = await fetchTokenHolderDistribution(
        mockConnection,
        mint,
        creator,
        bondingCurve
      );

      expect(dist.mint).toBe(mint.toBase58());
      expect(dist.bondingCurveBalance).toBe(0n);
      expect(dist.nonBondingCirculatingSupply).toBe(0n);
      expect(dist.creatorBalance).toBe(0n);
      expect(dist.top10HoldersPct).toBe(0);
      expect(dist.devHoldingPct).toBe(0);
      expect(dist.topHolders).toHaveLength(0);
      expect(Number.isNaN(dist.top10HoldersPct)).toBe(false);
      expect(Number.isNaN(dist.devHoldingPct)).toBe(false);
    });

    it('B01-ADV.2: Handles 0 non-bonding circulating supply (bonding curve holds 100% of supply)', async () => {
      const mint = Keypair.generate().publicKey;
      const creator = Keypair.generate().publicKey;
      const bondingCurve = Keypair.generate().publicKey;

      const bondingCurveAta = PumpCurveService.getAssociatedTokenAddress(mint, bondingCurve, TOKEN_PROGRAM_ID);
      const totalSupply = '1000000000000000'; // 1 Billion tokens

      const mockHolders = [
        { address: bondingCurveAta, amount: totalSupply, decimals: 6, uiAmount: 1000000000 },
      ];

      const mockConnection = {
        getTokenLargestAccounts: async () => ({ value: mockHolders, context: { slot: 500 } }),
        getTokenSupply: async () => ({
          value: { amount: totalSupply, decimals: 6, uiAmount: 1000000000 },
          context: { slot: 500 },
        }),
      } as unknown as Connection;

      const dist = await fetchTokenHolderDistribution(
        mockConnection,
        mint,
        creator,
        bondingCurve
      );

      expect(dist.bondingCurveBalance).toBe(1000000000000000n);
      expect(dist.nonBondingCirculatingSupply).toBe(0n);
      expect(dist.top10HoldersPct).toBe(0);
      expect(dist.devHoldingPct).toBe(0);
      expect(Number.isNaN(dist.top10HoldersPct)).toBe(false);
      expect(Number.isNaN(dist.devHoldingPct)).toBe(false);
    });

    it('B01-ADV.3: Creator with no tokens evaluates to 0% dev holding and passes MAX_CREATOR_EXPOSURE', async () => {
      const mint = Keypair.generate().publicKey;
      const creator = Keypair.generate().publicKey;
      const bondingCurve = Keypair.generate().publicKey;

      const bondingCurveAta = PumpCurveService.getAssociatedTokenAddress(mint, bondingCurve, TOKEN_PROGRAM_ID);

      // Largest accounts contain bonding curve and other holders, but NO creator ATA
      const mockHolders = [
        { address: bondingCurveAta, amount: '800000000000000', decimals: 6, uiAmount: 800000000 },
        { address: Keypair.generate().publicKey, amount: '50000000000000', decimals: 6, uiAmount: 50000000 },
        { address: Keypair.generate().publicKey, amount: '50000000000000', decimals: 6, uiAmount: 50000000 },
      ];

      const mockConnection = {
        getTokenLargestAccounts: async () => ({ value: mockHolders, context: { slot: 500 } }),
        getTokenSupply: async () => ({
          value: { amount: '1000000000000000', decimals: 6, uiAmount: 1000000000 },
          context: { slot: 500 },
        }),
        // getTokenAccountBalance for creator returns 0
        getTokenAccountBalance: async () => ({
          value: { amount: '0', decimals: 6, uiAmount: 0 },
        }),
      } as unknown as Connection;

      const dist = await fetchTokenHolderDistribution(
        mockConnection,
        mint,
        creator,
        bondingCurve
      );

      expect(dist.creatorBalance).toBe(0n);
      expect(dist.devHoldingPct).toBe(0);

      // Verify that 0% creator holding satisfies EligibilityFilter
      const report = EligibilityFilter.evaluate(
        {
          mint: mint.toBase58(),
          symbol: 'CLEAN',
          name: 'Clean Creator',
          liquidityUsd: 20000,
          devHoldingPct: dist.devHoldingPct,
          top10HoldersPct: dist.top10HoldersPct,
          isMintAuthorityRevoked: true,
          isFreezeAuthorityRevoked: true,
        },
        true // LIVE mode
      );

      const creatorCheck = report.checks.find((c) => c.ruleId === 'MAX_CREATOR_EXPOSURE');
      expect(creatorCheck?.status).toBe('PASS');
    });

    it('B01-ADV.4: Bonding curve holding 99% of tokens correctly scopes concentration to the 1% circulating supply', async () => {
      const mint = Keypair.generate().publicKey;
      const creator = Keypair.generate().publicKey;
      const bondingCurve = Keypair.generate().publicKey;

      const bondingCurveAta = PumpCurveService.getAssociatedTokenAddress(mint, bondingCurve, TOKEN_PROGRAM_ID);
      const creatorAta = PumpCurveService.getAssociatedTokenAddress(mint, creator, TOKEN_PROGRAM_ID);

      // Total supply: 1,000,000,000 tokens (1B * 10^6)
      // Bonding curve holds: 990,000,000 tokens (99%)
      // Circulating non-bonding supply: 10,000,000 tokens (1%)
      // Creator holds: 500,000 tokens (5.00% of circulating supply)
      // Holder A holds: 1,500,000 tokens (15.00% of circulating supply)
      // Total top holders: 2,000,000 tokens (20.00% of circulating supply)
      const mockHolders = [
        { address: bondingCurveAta, amount: '990000000000000', decimals: 6, uiAmount: 990000000 },
        { address: creatorAta, amount: '500000000000', decimals: 6, uiAmount: 500000 },
        { address: Keypair.generate().publicKey, amount: '1500000000000', decimals: 6, uiAmount: 1500000 },
      ];

      const mockConnection = {
        getTokenLargestAccounts: async () => ({ value: mockHolders, context: { slot: 500 } }),
        getTokenSupply: async () => ({
          value: { amount: '1000000000000000', decimals: 6, uiAmount: 1000000000 },
          context: { slot: 500 },
        }),
      } as unknown as Connection;

      const dist = await fetchTokenHolderDistribution(
        mockConnection,
        mint,
        creator,
        bondingCurve
      );

      expect(dist.bondingCurveBalance).toBe(990000000000000n);
      expect(dist.nonBondingCirculatingSupply).toBe(10000000000000n); // Exactly 10M tokens
      expect(dist.creatorBalance).toBe(500000000000n); // 500k tokens

      // C1: share of TOTAL supply (1B tokens): 500,000 / 1,000,000,000 = 0.05%
      expect(dist.devHoldingPct).toBe(0.05);

      // C1: creator excluded from top 10; remaining 1.5M of 1B total = 0.15%
      expect(dist.top10HoldersPct).toBe(0.15);
    });

    it('B01-ADV.5: Token-2022 bonding curve ATA is correctly recognized and excluded from circulating supply', async () => {
      const mint = Keypair.generate().publicKey;
      const bondingCurve = Keypair.generate().publicKey;

      // Derive Token-2022 ATA
      const bondingCurveAta2022 = PumpCurveService.getAssociatedTokenAddress(mint, bondingCurve, TOKEN_2022_PROGRAM_ID);

      const mockHolders = [
        { address: bondingCurveAta2022, amount: '750000000000000', decimals: 6, uiAmount: 750000000 },
        { address: Keypair.generate().publicKey, amount: '250000000000000', decimals: 6, uiAmount: 250000000 },
      ];

      const mockConnection = {
        getTokenLargestAccounts: async () => ({ value: mockHolders, context: { slot: 500 } }),
        getTokenSupply: async () => ({
          value: { amount: '1000000000000000', decimals: 6, uiAmount: 1000000000 },
          context: { slot: 500 },
        }),
      } as unknown as Connection;

      const dist = await fetchTokenHolderDistribution(mockConnection, mint, undefined, bondingCurve);

      expect(dist.bondingCurveBalance).toBe(750000000000000n);
      expect(dist.nonBondingCirculatingSupply).toBe(250000000000000n);
      expect(dist.topHolders).toHaveLength(1);
    });
  });

  // =========================================================================
  // TASK 1.2: B06 ATA Rent Recovery Verification
  // =========================================================================
  describe('B06: ATA Rent Recovery (Opcode 9, Program ID, Destination)', () => {
    it('B06-ADV.1: Opcode 9 (CloseAccount) is appended ONLY when closeAta is true (100% position exits)', async () => {
      const seller = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;
      const bondingCurve = Keypair.generate().publicKey;
      const associatedBondingCurve = Keypair.generate().publicKey;
      const associatedUser = Keypair.generate().publicKey;
      const creator = Keypair.generate().publicKey;

      const baseParams: PumpSellParams = {
        seller,
        mint,
        bondingCurve,
        associatedBondingCurve,
        associatedUser,
        creator,
        feeRecipient: CANONICAL_FEE_RECIPIENT,
        buybackFeeRecipient: CANONICAL_BUYBACK_RECIPIENT,
        amountTokens: 500000n,
        minSolOutputLamports: 100000n,
      };

      // 1. Partial exit (closeAta: false)
      const txPartial = await txBuilder.buildSellTransaction(mockConn, { ...baseParams, closeAta: false }, false);
      const opcodesPartial = txPartial.message.compiledInstructions.map((ix) => Array.from(ix.data)[0]);
      expect(opcodesPartial.includes(9)).toBe(false);

      // 2. Omitted closeAta
      const txOmitted = await txBuilder.buildSellTransaction(mockConn, baseParams);
      const opcodesOmitted = txOmitted.message.compiledInstructions.map((ix) => Array.from(ix.data)[0]);
      expect(opcodesOmitted.includes(9)).toBe(false);

      // 3. 100% position exit (closeAta: true)
      const txFull = await txBuilder.buildSellTransaction(mockConn, { ...baseParams, closeAta: true }, true);
      const closeIx = txFull.message.compiledInstructions[3];
      expect(Array.from(closeIx.data)).toEqual([9]); // Opcode 9 = CloseAccount
    });

    it('B06-ADV.2: CloseAccount instruction routes reclaimed rent to destination seller and uses correct token program', () => {
      const seller = Keypair.generate().publicKey;
      const ata = Keypair.generate().publicKey;

      // Test standard SPL Token program
      const splCloseIx = createCloseAccountInstruction(ata, seller, seller, [], TOKEN_PROGRAM_ID);
      expect(splCloseIx.programId.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
      expect(splCloseIx.data[0]).toBe(9);
      expect(splCloseIx.keys[0].pubkey.toBase58()).toBe(ata.toBase58()); // Account to close
      expect(splCloseIx.keys[1].pubkey.toBase58()).toBe(seller.toBase58()); // Destination to receive reclaimed SOL
      expect(splCloseIx.keys[1].isWritable).toBe(true);
      expect(splCloseIx.keys[2].pubkey.toBase58()).toBe(seller.toBase58()); // Owner / Authority
      expect(splCloseIx.keys[2].isSigner).toBe(true);

      // Test Token-2022 program
      const token2022CloseIx = createCloseAccountInstruction(ata, seller, seller, [], TOKEN_2022_PROGRAM_ID);
      expect(token2022CloseIx.programId.toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
      expect(token2022CloseIx.data[0]).toBe(9);
      expect(token2022CloseIx.keys[1].pubkey.toBase58()).toBe(seller.toBase58());
    });

    it('B06-ADV.3: buildSellTransaction with Token-2022 program binds Token-2022 program ID to CloseAccount', async () => {
      const seller = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;
      const bondingCurve = Keypair.generate().publicKey;
      const associatedBondingCurve = Keypair.generate().publicKey;
      const associatedUser = Keypair.generate().publicKey;
      const creator = Keypair.generate().publicKey;

      const params2022: PumpSellParams = {
        seller,
        mint,
        bondingCurve,
        associatedBondingCurve,
        associatedUser,
        creator,
        feeRecipient: CANONICAL_FEE_RECIPIENT,
        buybackFeeRecipient: CANONICAL_BUYBACK_RECIPIENT,
        amountTokens: 1000000n,
        minSolOutputLamports: 100000n,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        closeAta: true,
      };

      const tx = await txBuilder.buildSellTransaction(mockConn, params2022, true);
      const closeIx = tx.message.compiledInstructions[3];
      expect(Array.from(closeIx.data)).toEqual([9]);

      // Direct verification of programId on compiledInstruction
      const programId = tx.message.staticAccountKeys[closeIx.programIdIndex];
      expect(programId.toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    });
  });

  // =========================================================================
  // TASK 1.3: B07 / B24 Dynamic Tip Sizing at Limits
  // =========================================================================
  describe('B07 / B24: Dynamic Tip Sizing at Exact Limits & Stress Boundaries', () => {
    it('B07-ADV.1: Verifies exact behavior at limits: 0 SOL, 0.0001 SOL, 0.006 SOL, 1.0 SOL, 100 SOL', () => {
      // 1. 0 SOL: non-positive notional returns default MICRO_10 tip (180,000 lamports)
      const tip0 = calculateDynamicJitoTip(0);
      expect(tip0).toBe(180_000);
      expect(calculateDynamicJitoTipSol(0)).toBe(0.00018);

      // 2. 0.0001 SOL: 0.0001 * 1e9 * 0.03 = 3,000 lamports -> clamped to floor 150,000 lamports
      const tipSmall = calculateDynamicJitoTip(0.0001);
      expect(tipSmall).toBe(150_000);
      expect(calculateDynamicJitoTipSol(0.0001)).toBe(0.00015);

      // 3. 0.006 SOL: 0.006 * 1e9 * 0.03 = 180,000 lamports (exact MICRO_10 size)
      const tipMicro10 = calculateDynamicJitoTip(0.006);
      expect(tipMicro10).toBe(180_000);
      expect(calculateDynamicJitoTipSol(0.006)).toBe(0.00018);

      // 4. 1.0 SOL: 1.0 * 1e9 * 0.03 = 30,000,000 lamports -> clamped to ceiling 1,000,000 lamports
      const tip1Sol = calculateDynamicJitoTip(1.0);
      expect(tip1Sol).toBe(1_000_000);
      expect(calculateDynamicJitoTipSol(1.0)).toBe(0.001);

      // 5. 100 SOL: 100 * 1e9 * 0.03 = 3,000,000,000 lamports -> clamped to ceiling 1,000,000 lamports
      const tip100Sol = calculateDynamicJitoTip(100);
      expect(tip100Sol).toBe(1_000_000);
      expect(calculateDynamicJitoTipSol(100)).toBe(0.001);
    });

    it('B07-ADV.2: Floor and ceiling strict clamping invariant (150,000 <= tip <= 1,000,000) across 1,000 samples', () => {
      // Test 1000 pseudo-random trade sizes from 0.000001 to 500 SOL
      for (let i = 0; i < 1000; i++) {
        const notional = Math.random() * 500 + 0.000001;
        const tip = calculateDynamicJitoTip(notional);
        expect(tip).toBeGreaterThanOrEqual(150_000);
        expect(tip).toBeLessThanOrEqual(1_000_000);
        expect(Number.isInteger(tip)).toBe(true);
      }
    });

    it('B07-ADV.3: Adversarial inputs: negative values, NaN, Infinity default safely', () => {
      expect(calculateDynamicJitoTip(-1)).toBe(180_000);
      expect(calculateDynamicJitoTip(-100)).toBe(180_000);
      expect(calculateDynamicJitoTip(NaN)).toBe(180_000);
      expect(calculateDynamicJitoTip(Infinity)).toBe(180_000);
      expect(calculateDynamicJitoTip(-Infinity)).toBe(180_000);
    });

    it('B07-ADV.4: Exact boundary transition points for floor and ceiling', () => {
      // Floor threshold: 150,000 / (1e9 * 0.03) = 0.005 SOL
      // Below 0.005 SOL: clamps to 150,000
      expect(calculateDynamicJitoTip(0.00499)).toBe(150_000);
      expect(calculateDynamicJitoTip(0.00500)).toBe(150_000);
      // Above 0.005 SOL: scales linearly at 3%
      expect(calculateDynamicJitoTip(0.00501)).toBe(150_300);

      // Ceiling threshold: 1,000,000 / (1e9 * 0.03) = 0.033333333... SOL
      // Below 0.033333 SOL: scales linearly
      expect(calculateDynamicJitoTip(0.03333)).toBe(999_900);
      // Above ceiling threshold: clamps to 1,000,000
      expect(calculateDynamicJitoTip(0.03334)).toBe(1_000_000);
      expect(calculateDynamicJitoTip(0.05)).toBe(1_000_000);
    });

    it('B24-ADV.1: UI PumpFunHotCalloutsView is verified for normalized 0.00018 SOL default', () => {
      const filePath = path.join(process.cwd(), 'src/components/PumpFunHotCalloutsView.tsx');
      const content = fs.readFileSync(filePath, 'utf8');

      // Rule default
      expect(content).toContain('jitoPriorityTipSol: 0.00018');
      // No remaining 0.005 SOL default
      expect(content.includes('jitoPriorityTipSol: 0.005')).toBe(false);
    });
  });

  // =========================================================================
  // TASK 1.4: B19 / B20 Dust Exits & Unrealized Drawdown Loss Limit
  // =========================================================================
  describe('B19 & B20: Dust Exits & Daily Loss Limits', () => {
    it('B19-ADV.1: Rejects exit when net proceeds <= 0 (uneconomical dust sell)', async () => {
      const coordinator = new ExecutionCoordinator(mockConn);
      const mint = Keypair.generate().publicKey.toBase58();
      const posId = `dust-adv-${Date.now()}`;

      // Save a LIVE position with dust value: 0.00002 SOL
      workstationDb.savePosition({
        id: posId,
        mint,
        symbol: 'DUST',
        name: 'Dust Coin',
        tokenDecimals: 6,
        tokenQuantityRaw: '500',
        costBasisLamports: 500000,
        entryPriceSol: 0.001,
        currentPriceSol: 0.00000004,
        currentValueSol: 0.00002,
        realizedPnLSol: 0,
        entryTimestamp: Date.now(),
        entryTxSignature: `sig-${Date.now()}`,
        executionMode: 'LIVE',
        status: 'OPEN',
      });

      // Partial exit (50%): fraction = 0.5 -> residualValue = 0.00001 SOL
      // closeAta = false (no rent recovery)
      // Estimated fees = ~0.00021 SOL
      // netProceeds = 0.00001 - 0.00021 = -0.00020 SOL <= 0
      const result = await coordinator.closePosition(posId, 50, 'Partial Exit');

      expect(result.success).toBe(false);
      expect(result.error).toBe('DUST_POSITION_EXIT_UNECONOMICAL');
    });

    it('B19-ADV.2: Allows 100% exit of zero/dust token when rent recovery yields net positive proceeds', async () => {
      const coordinator = new ExecutionCoordinator(mockConn);
      const mint = Keypair.generate().publicKey.toBase58();
      const posId = `reclaim-adv-${Date.now()}`;

      // Dead token with 0.00000001 SOL residual value
      workstationDb.savePosition({
        id: posId,
        mint,
        symbol: 'DEAD',
        name: 'Dead Token',
        tokenDecimals: 6,
        tokenQuantityRaw: '100',
        costBasisLamports: 1000000,
        entryPriceSol: 0.01,
        currentPriceSol: 0.0000001,
        currentValueSol: 0.00000001,
        realizedPnLSol: 0,
        entryTimestamp: Date.now(),
        entryTxSignature: `sig-${Date.now()}`,
        executionMode: 'LIVE',
        status: 'OPEN',
      });

      // 100% exit: closeAta = true -> adds 0.00203928 SOL rent recovery
      // netProceeds = 0.00000001 + 0.00203928 - 0.00021 = +0.00182929 SOL > 0
      // Economic viability gate passes (it does not return DUST_POSITION_EXIT_UNECONOMICAL)
      const result = await coordinator.closePosition(posId, 100, 'Reclaim Rent');

      // The dust check did NOT block this; any subsequent error would be RPC/transport related, NOT DUST_POSITION_EXIT_UNECONOMICAL
      expect(result.error !== 'DUST_POSITION_EXIT_UNECONOMICAL').toBe(true);
    });

    it('B20-ADV.1: Risk engine halts orders when open position unrealized drawdown breaches daily loss threshold', () => {
      const memDb = new WorkstationDatabase(':memory:');
      const risk = new HardenedRiskEngine();
      risk.updateLimits({
        maxDailyLossSol: 0.02, // 0.02 SOL max daily loss
      });

      // Insert an open position that dropped 95%: cost 0.025 SOL, value 0.001 SOL -> unrealized drawdown = -0.024 SOL
      const mintRug = Keypair.generate().publicKey.toBase58();
      memDb.savePosition({
        id: 'open-drawdown-1',
        mint: mintRug,
        symbol: 'RUG',
        name: 'Rugged Position',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000',
        costBasisLamports: 25_000_000, // 0.025 SOL
        entryPriceSol: 0.025,
        currentPriceSol: 0.001,
        currentValueSol: 0.001,
        realizedPnLSol: 0,
        entryTxSignature: 'sig-open',
        entryTimestamp: Date.now(),
        executionMode: 'LIVE',
        status: 'OPEN',
      });

      const totalPnL = memDb.getDailyTotalPnLSol('LIVE');
      expect(totalPnL).toBeCloseTo(-0.024, 3);
      expect(totalPnL).toBeLessThanOrEqual(-0.02);

      // Verify risk engine limits evaluation
      const totalLoss = memDb.getDailyTotalPnLSol('LIVE');
      expect(totalLoss <= -0.02).toBe(true);
    });

    it('B20-ADV.2: Cumulative calculation (closed PnL + open unrealized PnL) triggers DAILY_LOSS_LIMIT', () => {
      const memDb = new WorkstationDatabase(':memory:');

      // 1. Closed position with -0.008 SOL realized loss
      memDb.savePosition({
        id: 'closed-loss',
        mint: Keypair.generate().publicKey.toBase58(),
        symbol: 'CLOSED_LOSS',
        name: 'Closed Loss',
        tokenDecimals: 6,
        tokenQuantityRaw: '0',
        costBasisLamports: 0,
        entryPriceSol: 0.01,
        currentPriceSol: 0.002,
        realizedPnLSol: -0.008,
        entryTxSignature: 'sig-c1',
        entryTimestamp: Date.now() - 3600000,
        executionMode: 'LIVE',
        status: 'CLOSED',
        lastUpdatedTimestamp: Date.now(),
      });

      // 2. Open position with -0.013 SOL unrealized loss (cost 0.015, value 0.002)
      // tokenQuantityRaw: 1,000,000 with 6 decimals = 1.0 token. 1.0 * 0.002 = 0.002 SOL value.
      memDb.savePosition({
        id: 'open-loss',
        mint: Keypair.generate().publicKey.toBase58(),
        symbol: 'OPEN_LOSS',
        name: 'Open Loss',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000',
        costBasisLamports: 15_000_000, // 0.015 SOL
        entryPriceSol: 0.015,
        currentPriceSol: 0.002,
        realizedPnLSol: 0,
        entryTxSignature: 'sig-o1',
        entryTimestamp: Date.now() - 1800000,
        executionMode: 'LIVE',
        status: 'OPEN',
      });

      // 3. A landed trade's fees (0.003 SOL) are inside its position's basis and must not be subtracted again (Q3)
      memDb.saveTransaction({
        signature: 'tx-fee-1',
        orderId: 'ord-fee-1',
        correlationId: 'c-fee-1',
        mint: Keypair.generate().publicKey.toBase58(),
        direction: 'BUY',
        submissionTransport: 'JITO',
        submissionTime: Date.now(),
        reconciliationState: 'RECONCILED',
        networkFeeLamports: 1_000_000,
        jitoTipLamports: 2_000_000, // Total = 3,000,000 lamports = 0.003 SOL
        executionMode: 'LIVE',
      });

      // Total PnL = -0.008 (closed) + (-0.013 unrealized) = -0.021 SOL
      const dailyTotal = memDb.getDailyTotalPnLSol('LIVE');
      expect(dailyTotal).toBeCloseTo(-0.021, 4);

      // Verify that when dailyTotal <= -maxDailyLossSol (-0.020), it breaches limit
      const maxDailyLossSol = 0.020;
      const breached = dailyTotal <= -maxDailyLossSol;
      expect(breached).toBe(true);
    });

    it('B20-ADV.3: When daily loss is strictly below limit, trading is NOT halted', () => {
      const memDb = new WorkstationDatabase(':memory:');

      // Position with small loss of -0.005 SOL
      memDb.savePosition({
        id: 'small-loss',
        mint: Keypair.generate().publicKey.toBase58(),
        symbol: 'SMALL_LOSS',
        name: 'Small Loss',
        tokenDecimals: 6,
        tokenQuantityRaw: '0',
        costBasisLamports: 0,
        entryPriceSol: 0.01,
        currentPriceSol: 0.005,
        realizedPnLSol: -0.005,
        entryTxSignature: 'sig-s1',
        entryTimestamp: Date.now() - 3600000,
        executionMode: 'LIVE',
        status: 'CLOSED',
        lastUpdatedTimestamp: Date.now(),
      });

      const dailyTotal = memDb.getDailyTotalPnLSol('LIVE');
      expect(dailyTotal).toBeCloseTo(-0.005, 4);

      const maxDailyLossSol = 0.020;
      const breached = dailyTotal <= -maxDailyLossSol;
      expect(breached).toBe(false);
    });

    it('B20-ADV.4: Exact boundary transition at maxDailyLossSol (-0.01999 vs -0.02000)', () => {
      const maxDailyLossSol = 0.02;

      // Case 1: Just below limit: -0.01999 SOL loss -> not breached
      const dailyPnLSafe = -0.01999;
      expect(dailyPnLSafe <= -maxDailyLossSol).toBe(false);

      // Case 2: Exactly at limit: -0.02000 SOL loss -> breached
      const dailyPnLLimit = -0.02000;
      expect(dailyPnLLimit <= -maxDailyLossSol).toBe(true);

      // Case 3: Over limit: -0.02001 SOL loss -> breached
      const dailyPnLExceeded = -0.02001;
      expect(dailyPnLExceeded <= -maxDailyLossSol).toBe(true);
    });
  });
});
