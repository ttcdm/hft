import { describe, it, expect, beforeEach } from 'vitest';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import {
  fetchTokenHolderDistribution,
  PumpCurveService,
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

describe('Phase 3 Challenger Empirical Stress & Boundary Test Suite', () => {
  const CANONICAL_FEE_RECIPIENT = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');
  const CANONICAL_BUYBACK_RECIPIENT = new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD');

  // =========================================================================
  // 1. Adversarial & Boundary Tests for B01 (fetchTokenHolderDistribution)
  // =========================================================================
  describe('B01 Stress: Boundary and Adversarial Holder Distributions', () => {
    it('handles empty RPC holder response gracefully without NaN or throwing', async () => {
      const mint = Keypair.generate().publicKey;
      const creator = Keypair.generate().publicKey;
      const bondingCurve = Keypair.generate().publicKey;

      const mockConn = {
        getTokenLargestAccounts: async () => ({ value: [] as any[], context: { slot: 100 } }),
        getTokenSupply: async () => ({ value: { amount: '0', decimals: 6, uiAmount: 0 }, context: { slot: 100 } }),
      } as unknown as Connection;

      const dist = await fetchTokenHolderDistribution(mockConn, mint, creator, bondingCurve);

      expect(dist.mint).toBe(mint.toBase58());
      expect(dist.totalCirculatingSupply).toBe(0n);
      expect(dist.nonBondingCirculatingSupply).toBe(0n);
      expect(dist.bondingCurveBalance).toBe(0n);
      expect(dist.creatorBalance).toBe(0n);
      expect(dist.top10HoldersPct).toBe(0);
      expect(dist.devHoldingPct).toBe(0);
      expect(dist.topHolders).toEqual([]);
      expect(Number.isNaN(dist.top10HoldersPct)).toBe(false);
      expect(Number.isNaN(dist.devHoldingPct)).toBe(false);
    });

    it('handles 100% supply locked in bonding curve (0 non-bonding circulating supply)', async () => {
      const mint = Keypair.generate().publicKey;
      const creator = Keypair.generate().publicKey;
      const bondingCurve = Keypair.generate().publicKey;
      const bondingCurveAta = PumpCurveService.getAssociatedTokenAddress(mint, bondingCurve, TOKEN_PROGRAM_ID);

      const mockConn = {
        getTokenLargestAccounts: async () => ({
          value: [{ address: bondingCurveAta, amount: '1000000000000000', decimals: 6, uiAmount: 1000000000 }],
          context: { slot: 200 },
        }),
        getTokenSupply: async () => ({
          value: { amount: '1000000000000000', decimals: 6, uiAmount: 1000000000 },
          context: { slot: 200 },
        }),
      } as unknown as Connection;

      const dist = await fetchTokenHolderDistribution(mockConn, mint, creator, bondingCurve);

      expect(dist.bondingCurveBalance).toBe(1000000000000000n);
      expect(dist.nonBondingCirculatingSupply).toBe(0n);
      expect(dist.top10HoldersPct).toBe(0);
      expect(dist.devHoldingPct).toBe(0);
      expect(Number.isFinite(dist.top10HoldersPct)).toBe(true);
      expect(Number.isFinite(dist.devHoldingPct)).toBe(true);
    });

    it('handles bonding curve balance exceeding total supply (adversarial/corrupt RPC data)', async () => {
      const mint = Keypair.generate().publicKey;
      const creator = Keypair.generate().publicKey;
      const bondingCurve = Keypair.generate().publicKey;
      const bondingCurveAta = PumpCurveService.getAssociatedTokenAddress(mint, bondingCurve, TOKEN_PROGRAM_ID);

      // Curve reported with 1.2B tokens while supply is 1.0B
      const mockConn = {
        getTokenLargestAccounts: async () => ({
          value: [{ address: bondingCurveAta, amount: '1200000000000000', decimals: 6, uiAmount: 1200000000 }],
          context: { slot: 300 },
        }),
        getTokenSupply: async () => ({
          value: { amount: '1000000000000000', decimals: 6, uiAmount: 1000000000 },
          context: { slot: 300 },
        }),
      } as unknown as Connection;

      const dist = await fetchTokenHolderDistribution(mockConn, mint, creator, bondingCurve);
      expect(dist.nonBondingCirculatingSupply).toBeGreaterThanOrEqual(0n);
      expect(dist.top10HoldersPct).toBe(0);
      expect(dist.devHoldingPct).toBe(0);
    });

    it('correctly calculates extreme creator cartel exposure (>10% dev holding) and triggers filter rejection', async () => {
      const mint = Keypair.generate().publicKey;
      const creator = Keypair.generate().publicKey;
      const bondingCurve = Keypair.generate().publicKey;

      const bondingCurveAta = PumpCurveService.getAssociatedTokenAddress(mint, bondingCurve, TOKEN_PROGRAM_ID);
      const creatorAta = PumpCurveService.getAssociatedTokenAddress(mint, creator, TOKEN_PROGRAM_ID);

      // C1: total supply 300M. Bonding curve: 210M. Creator holds 45M = 15.00% of TOTAL supply.
      const mockHolders = [
        { address: bondingCurveAta, amount: '210000000000000', decimals: 6, uiAmount: 210000000 },
        { address: creatorAta, amount: '45000000000000', decimals: 6, uiAmount: 45000000 },
        ...Array.from({ length: 9 }, () => ({
          address: Keypair.generate().publicKey,
          amount: '5000000000000', // 5M each = 45M total
          decimals: 6,
          uiAmount: 5000000,
        })),
      ];

      const mockConn = {
        getTokenLargestAccounts: async () => ({ value: mockHolders, context: { slot: 400 } }),
        getTokenSupply: async () => ({
          value: { amount: '300000000000000', decimals: 6, uiAmount: 300000000 },
          context: { slot: 400 },
        }),
      } as unknown as Connection;

      const dist = await fetchTokenHolderDistribution(mockConn, mint, creator, bondingCurve);
      expect(dist.devHoldingPct).toBe(15.0);
      // C1: creator excluded; 9 * 5M = 45M / 300M = 15.0%
      expect(dist.top10HoldersPct).toBe(15.0);

      // Feed into EligibilityFilter in LIVE mode
      const report = EligibilityFilter.evaluate(
        {
          mint: mint.toBase58(),
          symbol: 'CARTEL',
          name: 'Cartel Dev Token',
          liquidityUsd: 20000,
          devHoldingPct: dist.devHoldingPct,
          top10HoldersPct: dist.top10HoldersPct,
          isMintAuthorityRevoked: true,
          isFreezeAuthorityRevoked: true,
        },
        true // LIVE mode
      );

      expect(report.isEligible).toBe(false);
      const devCheck = report.checks.find((c) => c.ruleId === 'MAX_CREATOR_EXPOSURE');
      expect(devCheck?.status).toBe('FAIL');
      expect(devCheck?.observedValue).toBe('15.0%');
    });

    it('correctly calculates top-10 concentration failure (>40% top 10) and triggers filter rejection', async () => {
      const mint = Keypair.generate().publicKey;
      const creator = Keypair.generate().publicKey;
      const bondingCurve = Keypair.generate().publicKey;

      const bondingCurveAta = PumpCurveService.getAssociatedTokenAddress(mint, bondingCurve, TOKEN_PROGRAM_ID);
      const creatorAta = PumpCurveService.getAssociatedTokenAddress(mint, creator, TOKEN_PROGRAM_ID);

      // C1: total supply 200M. Creator holds 4M (2%). Whale 80M (40%) + 8 * 2M (8%) = 48% of TOTAL, creator excluded.
      const mockHolders = [
        { address: bondingCurveAta, amount: '100000000000000', decimals: 6, uiAmount: 100000000 },
        { address: Keypair.generate().publicKey, amount: '80000000000000', decimals: 6, uiAmount: 80000000 }, // 40%
        { address: creatorAta, amount: '4000000000000', decimals: 6, uiAmount: 4000000 }, // 2%
        ...Array.from({ length: 8 }, () => ({
          address: Keypair.generate().publicKey,
          amount: '2000000000000', // 2M each = 16M total
          decimals: 6,
          uiAmount: 2000000,
        })),
      ];

      const mockConn = {
        getTokenLargestAccounts: async () => ({ value: mockHolders, context: { slot: 500 } }),
        getTokenSupply: async () => ({
          value: { amount: '200000000000000', decimals: 6, uiAmount: 200000000 },
          context: { slot: 500 },
        }),
      } as unknown as Connection;

      const dist = await fetchTokenHolderDistribution(mockConn, mint, creator, bondingCurve);
      expect(dist.devHoldingPct).toBe(2.0);
      expect(dist.top10HoldersPct).toBe(48.0);

      const report = EligibilityFilter.evaluate(
        {
          mint: mint.toBase58(),
          symbol: 'WHALE',
          name: 'Whale Concentrated Token',
          liquidityUsd: 20000,
          devHoldingPct: dist.devHoldingPct,
          top10HoldersPct: dist.top10HoldersPct,
          isMintAuthorityRevoked: true,
          isFreezeAuthorityRevoked: true,
        },
        true
      );

      expect(report.isEligible).toBe(false);
      const top10Check = report.checks.find((c) => c.ruleId === 'TOP_10_CONCENTRATION');
      expect(top10Check?.status).toBe('FAIL');
      expect(top10Check?.observedValue).toBe('48.0%');
    });

    it('queries creator ATA via getTokenAccountBalance fallback if creator is not in top 20 accounts', async () => {
      const mint = Keypair.generate().publicKey;
      const creator = Keypair.generate().publicKey;
      const bondingCurve = Keypair.generate().publicKey;

      const bondingCurveAta = PumpCurveService.getAssociatedTokenAddress(mint, bondingCurve, TOKEN_PROGRAM_ID);
      const creatorAta = PumpCurveService.getAssociatedTokenAddress(mint, creator, TOKEN_PROGRAM_ID);

      // 20 largest accounts do not include creator
      const largestAccounts = [
        { address: bondingCurveAta, amount: '700000000000000', decimals: 6, uiAmount: 700000000 },
        ...Array.from({ length: 19 }, () => ({
          address: Keypair.generate().publicKey,
          amount: '10000000000000', // 10M each
          decimals: 6,
          uiAmount: 10000000,
        })),
      ];

      const mockConn = {
        getTokenLargestAccounts: async () => ({ value: largestAccounts, context: { slot: 600 } }),
        getTokenSupply: async () => ({
          value: { amount: '1000000000000000', decimals: 6, uiAmount: 1000000000 },
          context: { slot: 600 },
        }),
        getTokenAccountBalance: async (ata: PublicKey) => {
          if (ata.equals(creatorAta)) {
            // Creator has 15M tokens (1.5% of 1B total supply)
            return { value: { amount: '15000000000000', decimals: 6, uiAmount: 15000000 }, context: { slot: 600 } };
          }
          throw new Error('Account not found');
        },
      } as unknown as Connection;

      const dist = await fetchTokenHolderDistribution(mockConn, mint, creator, bondingCurve);
      expect(dist.creatorBalance).toBe(15000000000000n);
      expect(dist.devHoldingPct).toBe(1.5);
    });
  });

  // =========================================================================
  // 2. Stress Tests for B06 & B19 (Position Lifecycles & Rent Recovery)
  // =========================================================================
  describe('B06 & B19 Stress: Position Lifecycles, Rent Recovery, and Dust Gating', () => {
    it('B06: supports Token-2022 close account instruction with correct program id', async () => {
      const seller = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;
      const bondingCurve = Keypair.generate().publicKey;
      const associatedBondingCurve = Keypair.generate().publicKey;
      const associatedUser = Keypair.generate().publicKey;
      const creator = Keypair.generate().publicKey;

      const mockConn = {
        getLatestBlockhash: async () => ({
          blockhash: Keypair.generate().publicKey.toBase58(),
          lastValidBlockHeight: 12345,
        }),
      } as unknown as Connection;

      const sellParams: PumpSellParams = {
        seller,
        mint,
        bondingCurve,
        associatedBondingCurve,
        associatedUser,
        creator,
        feeRecipient: CANONICAL_FEE_RECIPIENT,
        buybackFeeRecipient: CANONICAL_BUYBACK_RECIPIENT,
        amountTokens: 1000000n,
        minSolOutputLamports: 500000n,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        closeAta: true,
      };

      const tx = await txBuilder.buildSellTransaction(mockConn, sellParams, true);
      const compiledInstructions = tx.message.compiledInstructions;
      const closeIx = compiledInstructions[3];

      expect(Array.from(closeIx.data)).toEqual([9]); // CloseAccount opcode = 9
      const closeProgramId = (closeIx as any).programId || 
        (tx.message as any).staticAccountKeys?.[(closeIx as any).programIdIndex] || 
        (tx.message as any).accountKeys?.[(closeIx as any).programIdIndex];
      expect(closeProgramId.toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    });

    it('B19: Dust gate boundary - exact behavior at netProceeds = 0, netProceeds < 0, and netProceeds > 0', async () => {
      const coordinator = new ExecutionCoordinator();
      const testMint = Keypair.generate().publicKey.toBase58();

      // Case A: 100% exit of completely dead token (residual = 0 SOL)
      // Net proceeds = 0 + 0.00203928 (rent) - ~0.00019 (fees) = +0.00184 SOL > 0
      // Economic viability permits this exit because closing the ATA reclaims rent!
      const deadPosId = `dead-pos-${Date.now()}`;
      workstationDb.savePosition({
        id: deadPosId,
        mint: testMint,
        symbol: 'DEAD',
        name: 'Dead Token',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000',
        costBasisLamports: 1000000,
        entryPriceSol: 0.001,
        currentPriceSol: 0,
        currentValueSol: 0,
        realizedPnLSol: 0,
        entryTimestamp: Date.now(),
        entryTxSignature: `sig-dead-${Date.now()}`,
        executionMode: 'LIVE',
        status: 'OPEN',
      });

      // Under LIVE mode, if signer is not ready, it checks economic viability first:
      // Since net proceeds > 0, it does NOT reject with DUST_POSITION_EXIT_UNECONOMICAL
      // Instead it proceeds past the dust gate to signer check.
      const resDead100 = await coordinator.closePosition(deadPosId, 100, 'Dead Token Exit');
      expect(resDead100.error !== 'DUST_POSITION_EXIT_UNECONOMICAL').toBe(true);

      // Case B: Partial 50% exit of dead token
      // Net proceeds = 0 + 0 (no rent) - fees = -fees <= 0
      // Must abort with DUST_POSITION_EXIT_UNECONOMICAL
      const resDead50 = await coordinator.closePosition(deadPosId, 50, 'Partial Dead Exit');
      expect(resDead50.success).toBe(false);
      expect(resDead50.error).toBe('DUST_POSITION_EXIT_UNECONOMICAL');
    });

    it('B19 & B06: Full position lifecycle (Open -> Partial Sell -> PARTIALLY_CLOSED -> Full Sell -> CLOSED)', async () => {
      const coordinator = new ExecutionCoordinator();
      const mint = Keypair.generate().publicKey.toBase58();
      const positionId = `lifecycle-pos-${Date.now()}`;

      // 1. Initial Position (Cost: 0.010 SOL, 1,000,000 tokens @ 0.010 SOL)
      // Current price = 0.025 SOL (2.5x gain)
      workstationDb.savePosition({
        id: positionId,
        mint,
        symbol: 'CYCLE',
        name: 'Lifecycle Token',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000',
        costBasisLamports: 10_000_000,
        entryPriceSol: 0.010,
        currentPriceSol: 0.025,
        currentValueSol: 0.025,
        realizedPnLSol: 0,
        entryTimestamp: Date.now(),
        entryTxSignature: `sig-cycle-${Date.now()}`,
        executionMode: 'PAPER',
        status: 'OPEN',
      });

      // 2. Partial Sell: 50% (take profit)
      const partialRes = await coordinator.closePosition(positionId, 50, 'TP Stage 1');
      expect(partialRes.success).toBe(true);
      expect(partialRes.status).toBe('PARTIALLY_CLOSED');

      // Verify DB state after partial sell
      const posAfterPartial = workstationDb.loadPositions().find((p) => p.id === positionId);
      expect(posAfterPartial).toBeDefined();
      expect(posAfterPartial?.status).toBe('PARTIALLY_CLOSED');
      // Half tokens sold: 500,000 remaining
      expect(posAfterPartial?.tokenQuantityRaw).toBe('500000');
      // Half cost basis remaining: 0.005 SOL (5,000,000 lamports)
      expect(posAfterPartial?.costBasisLamports).toBe(5_000_000);
      // Realized profit on 50%: gross proceeds (0.0124) - cost (0.005) - paper fees > 0
      expect(posAfterPartial?.realizedPnLSol).toBeGreaterThan(0);

      // 3. Final Sell: 100% of remaining position
      const finalRes = await coordinator.closePosition(positionId, 100, 'TP Stage 2 Final');
      expect(finalRes.success).toBe(true);
      expect(finalRes.status).toBe('CLOSED');

      const posAfterFinal = workstationDb.loadPositions().find((p) => p.id === positionId);
      expect(posAfterFinal?.status).toBe('CLOSED');
      expect(posAfterFinal?.tokenQuantityRaw).toBe('0');
      expect(posAfterFinal?.costBasisLamports).toBe(0);

      // 4. Attempting to sell an already closed position must fail
      const closedRes = await coordinator.closePosition(positionId, 100, 'Duplicate Sell');
      expect(closedRes.success).toBe(false);
      expect(closedRes.error).toBe('Position not found or already closed');
    });
  });

  // =========================================================================
  // 3. Stress Tests for B07 & B24 (Dynamic Jito Tip Sizing & Urgency Multipliers)
  // =========================================================================
  describe('B07 & B24 Stress: Dynamic Jito Tip Sizing & Urgency Multipliers', () => {
    it('calculateDynamicJitoTip handles adversarial notional inputs without crashing', () => {
      // Negative amounts fallback to default 180,000 lamports
      expect(calculateDynamicJitoTip(-1)).toBe(180_000);
      expect(calculateDynamicJitoTip(0)).toBe(180_000);
      expect(calculateDynamicJitoTip(NaN)).toBe(180_000);
      expect(calculateDynamicJitoTip(Infinity)).toBe(180_000);
      expect(calculateDynamicJitoTip(-Infinity)).toBe(180_000);

      // Sub-lamport trade amounts clamp to 150,000 floor
      expect(calculateDynamicJitoTip(0.000000001)).toBe(150_000);

      // Massive amounts clamp to 1,000,000 ceiling
      expect(calculateDynamicJitoTip(100.0)).toBe(1_000_000);
      expect(calculateDynamicJitoTip(10_000.0)).toBe(1_000_000);
    });

    it('resolveDynamicJitoTip evaluates various urgency multipliers under live floor and notional scaling', () => {
      // Scenario A: Urgency multipliers on 0.006 SOL trade without live floor (base = 180,000 lamports)
      // 1.0x urgency -> 180,000
      const tip1x = executionConfig.resolveDynamicJitoTip({
        tradeAmountSol: 0.006,
        urgencyMultiplier: 1.0,
      });
      expect(tip1x.tipLamports).toBe(180_000);

      // 1.25x urgency -> 180,000 * 1.25 = 225,000 lamports
      const tip125x = executionConfig.resolveDynamicJitoTip({
        tradeAmountSol: 0.006,
        urgencyMultiplier: 1.25,
      });
      expect(tip125x.tipLamports).toBe(225_000);
      expect(tip125x.tipSol).toBe(0.000225);

      // 2.0x urgency -> 180,000 * 2 = 360,000 lamports
      const tip2x = executionConfig.resolveDynamicJitoTip({
        tradeAmountSol: 0.006,
        urgencyMultiplier: 2.0,
      });
      expect(tip2x.tipLamports).toBe(360_000);

      // Scenario B: Extreme urgency multiplier bounded by economic sanity (15% of trade value, planning decision #1)
      // Trade: 0.010 SOL (10,000,000 lamports). 15% sanity ceiling = 1,500,000 lamports.
      // Base dynamic tip = 300,000 lamports. Urgency = 20x -> 6,000,000 lamports.
      // Must be capped by operator ceiling (0.05 SOL = 50M) and economic sanity rule (15% = 1.5M).
      const extremeTip = executionConfig.resolveDynamicJitoTip({
        tradeAmountSol: 0.010,
        urgencyMultiplier: 20.0,
      });
      expect(extremeTip.tipLamports).toBe(1_500_000);
      expect(extremeTip.policyReason).toContain('CAPPED by economic sanity rule');

      // Scenario C: Live Jito floor with urgency multiplier
      const liveFloorTip = executionConfig.resolveDynamicJitoTip({
        tipFloorLamports: 200_000,
        urgencyMultiplier: 1.5,
        tradeAmountSol: 0.05,
      });
      // 200,000 * 1.5 = 300,000 lamports
      expect(liveFloorTip.tipLamports).toBe(300_000);
      expect(liveFloorTip.policyReason).toContain('JITO_LIVE_FLOOR');
    });

    it('B24: UI PumpFunHotCalloutsView is clean of old 0.005 SOL tips across all references', () => {
      const componentPath = path.join(process.cwd(), 'src/components/PumpFunHotCalloutsView.tsx');
      const fileContent = fs.readFileSync(componentPath, 'utf8');

      // Verifies 0.00018 SOL is present
      expect(fileContent).toContain('0.00018');
      // Verifies old 0.005 default tip is not present
      expect(fileContent.includes('0.005')).toBe(false);
    });
  });

  // =========================================================================
  // 4. Stress Tests for B20 (Daily Total Loss Limit & Concurrency)
  // =========================================================================
  describe('B20 Stress: Daily Total PnL Calculation & Concurrency', () => {
    let db: WorkstationDatabase;
    let risk: HardenedRiskEngine;

    beforeEach(() => {
      db = new WorkstationDatabase(':memory:');
      risk = new HardenedRiskEngine();
      risk.updateLimits({
        maxDailyLossSol: 0.025, // 0.025 SOL daily stop limit
      });
    });

    it('accurately computes complex multi-leg portfolio daily PnL (realized + unrealized - fees)', () => {
      const now = Date.now();

      // Closed winning trade (+0.010 SOL)
      db.savePosition({
        id: 'win-1',
        mint: Keypair.generate().publicKey.toBase58(),
        symbol: 'WIN1',
        name: 'Winning Trade',
        tokenDecimals: 6,
        tokenQuantityRaw: '0',
        costBasisLamports: 0,
        entryPriceSol: 0.005,
        currentPriceSol: 0.010,
        realizedPnLSol: 0.010,
        entryTxSignature: 'sig-win-1',
        entryTimestamp: now - 3600000,
        executionMode: 'LIVE',
        status: 'CLOSED',
      });

      // Closed losing trade (-0.015 SOL)
      db.savePosition({
        id: 'loss-1',
        mint: Keypair.generate().publicKey.toBase58(),
        symbol: 'LOSS1',
        name: 'Losing Trade',
        tokenDecimals: 6,
        tokenQuantityRaw: '0',
        costBasisLamports: 0,
        entryPriceSol: 0.020,
        currentPriceSol: 0.005,
        realizedPnLSol: -0.015,
        entryTxSignature: 'sig-loss-1',
        entryTimestamp: now - 2000000,
        executionMode: 'LIVE',
        status: 'CLOSED',
      });

      // Open winning position (+0.004 SOL unrealized)
      // Cost: 0.008 SOL (8M lamports), Value: 0.012 SOL
      db.savePosition({
        id: 'open-win',
        mint: Keypair.generate().publicKey.toBase58(),
        symbol: 'OPENWIN',
        name: 'Open Winner',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000',
        costBasisLamports: 8_000_000,
        entryPriceSol: 0.008,
        currentPriceSol: 0.012,
        realizedPnLSol: 0,
        entryTxSignature: 'sig-open-win',
        entryTimestamp: now - 1000000,
        executionMode: 'LIVE',
        status: 'OPEN',
      });

      // Open losing position (-0.022 SOL unrealized drawdown)
      // Cost: 0.025 SOL (25M lamports), Value: 0.003 SOL
      db.savePosition({
        id: 'open-loss',
        mint: Keypair.generate().publicKey.toBase58(),
        symbol: 'OPENLOSS',
        name: 'Open Loser',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000',
        costBasisLamports: 25_000_000,
        entryPriceSol: 0.025,
        currentPriceSol: 0.003,
        realizedPnLSol: 0,
        entryTxSignature: 'sig-open-loss',
        entryTimestamp: now - 500000,
        executionMode: 'LIVE',
        status: 'OPEN',
      });

      // Transactions fees paid: 2,000,000 lamports = 0.002 SOL
      db.saveTransaction({
        signature: 'tx-fee-1',
        orderId: 'ord-1',
        correlationId: 'c-1',
        mint: Keypair.generate().publicKey.toBase58(),
        direction: 'BUY',
        submissionTransport: 'JITO',
        submissionTime: now - 100000,
        reconciliationState: 'RECONCILED',
        networkFeeLamports: 500000,
        jitoTipLamports: 1500000,
        executionMode: 'LIVE',
      });

      // Expected Daily Total PnL:
      // Closed: +0.010 - 0.015 = -0.005 SOL
      // Unrealized: (0.012 - 0.008) + (0.003 - 0.025) = +0.004 - 0.022 = -0.018 SOL
      // Fees: -0.002 SOL
      // Total = -0.005 + (-0.018) - 0.002 = -0.025000 SOL
      const dailyTotalPnL = db.getDailyTotalPnLSol('LIVE');
      expect(dailyTotalPnL).toBeCloseTo(-0.025, 4);
    });

    it('strictly isolates PAPER and LIVE modes in daily total PnL', () => {
      const now = Date.now();

      // Large PAPER loss: -0.100 SOL
      db.savePosition({
        id: 'paper-loss',
        mint: Keypair.generate().publicKey.toBase58(),
        symbol: 'PAPERLOSS',
        name: 'Paper Loss',
        tokenDecimals: 6,
        tokenQuantityRaw: '0',
        costBasisLamports: 0,
        entryPriceSol: 0.100,
        currentPriceSol: 0,
        realizedPnLSol: -0.100,
        entryTxSignature: 'sig-paper-loss',
        entryTimestamp: now - 1000,
        executionMode: 'PAPER',
        status: 'CLOSED',
      });

      // Clean LIVE state (no trades)
      const livePnL = db.getDailyTotalPnLSol('LIVE');
      expect(livePnL).toBe(0);

      // Paper PnL reflects paper loss
      const paperPnL = db.getDailyTotalPnLSol('PAPER');
      expect(paperPnL).toBeCloseTo(-0.100, 4);
    });

    it('concurrency stress: handles 50 concurrent transaction writes and 20 position writes safely', async () => {
      const txPromises = Array.from({ length: 50 }, (_, i) => {
        return Promise.resolve().then(() => {
          db.saveTransaction({
            signature: `concurrent-tx-${i}-${Date.now()}`,
            orderId: `ord-${i}`,
            correlationId: `corr-${i}`,
            mint: Keypair.generate().publicKey.toBase58(),
            direction: i % 2 === 0 ? 'BUY' : 'SELL',
            submissionTransport: 'JITO',
            submissionTime: Date.now(),
            reconciliationState: 'RECONCILED',
            networkFeeLamports: 25000,
            jitoTipLamports: 180000,
            executionMode: 'LIVE',
          });
        });
      });

      const posPromises = Array.from({ length: 20 }, (_, i) => {
        return Promise.resolve().then(() => {
          db.savePosition({
            id: `concurrent-pos-${i}-${Date.now()}`,
            mint: Keypair.generate().publicKey.toBase58(),
            symbol: `CONC${i}`,
            name: `Concurrent Token ${i}`,
            tokenDecimals: 6,
            tokenQuantityRaw: '1000000',
            costBasisLamports: 6_000_000,
            entryPriceSol: 0.006,
            currentPriceSol: 0.007,
            currentValueSol: 0.007,
            realizedPnLSol: 0,
            entryTimestamp: Date.now(),
            entryTxSignature: `sig-conc-${i}`,
            executionMode: 'LIVE',
            status: 'OPEN',
          });
        });
      });

      await Promise.all([...txPromises, ...posPromises]);

      // Verify all 50 transactions and 20 positions are persisted and queryable
      const txs = db.loadTransactions();
      const openPositions = db.loadPositions('LIVE', 'ACTIVE');

      expect(txs.length).toBeGreaterThanOrEqual(50);
      expect(openPositions.length).toBeGreaterThanOrEqual(20);

      // Verify getDailyTotalPnLSol executes without error under concurrent load
      const totalPnL = db.getDailyTotalPnLSol('LIVE');
      expect(Number.isFinite(totalPnL)).toBe(true);
    });

    it('concurrency stress: prevents double-sell race conditions on closePosition via pendingExits locking', async () => {
      const coordinator = new ExecutionCoordinator();
      const mint = Keypair.generate().publicKey.toBase58();
      const racePosId = `race-pos-${Date.now()}`;

      workstationDb.savePosition({
        id: racePosId,
        mint,
        symbol: 'RACE',
        name: 'Race Token',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000',
        costBasisLamports: 6_000_000,
        entryPriceSol: 0.006,
        currentPriceSol: 0.008,
        currentValueSol: 0.008,
        realizedPnLSol: 0,
        entryTimestamp: Date.now(),
        entryTxSignature: `sig-race-${Date.now()}`,
        executionMode: 'PAPER',
        status: 'OPEN',
      });

      // Fire 2 close calls simultaneously
      const [res1, res2] = await Promise.all([
        coordinator.closePosition(racePosId, 100, 'Concurrent Close 1'),
        coordinator.closePosition(racePosId, 100, 'Concurrent Close 2'),
      ]);

      // Exactly one must succeed, and the racing call must fail safely
      const successCount = (res1.success ? 1 : 0) + (res2.success ? 1 : 0);
      expect(successCount).toBe(1);

      const failedRes = res1.success ? res2 : res1;
      expect(failedRes.success).toBe(false);
      // The coordinator's active concurrency lock returns EXIT_IN_PROGRESS or Position not found
      expect(
        failedRes.error?.includes('EXIT_IN_PROGRESS') ||
        failedRes.error === 'Position not found or already closed'
      ).toBe(true);
    });
  });
});
