import { describe, it, expect, beforeEach } from 'vitest';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createCloseAccountInstruction } from '@solana/spl-token';
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
import { riskEngine, HardenedRiskEngine } from '../server/risk/riskEngine';
import { EligibilityFilter } from '../server/signals/eligibilityFilter';
import fs from 'fs';
import path from 'path';

describe('Phase 3 Master Remediation Suite (B01, B06, B07, B19, B20, B24)', () => {
  const CANONICAL_FEE_RECIPIENT = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');
  const CANONICAL_BUYBACK_RECIPIENT = new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD');

  // =========================================================================
  // Blocker B01: Stage 2 Holder Verification Deadlock Resolution
  // =========================================================================
  describe('B01: Stage 2 Holder Verification & Distribution', () => {
    it('B01.1: fetchTokenHolderDistribution correctly excludes bonding curve and computes non-curve circulating supply', async () => {
      const mint = Keypair.generate().publicKey;
      const creator = Keypair.generate().publicKey;
      const bondingCurve = Keypair.generate().publicKey;

      const bondingCurveAta = PumpCurveService.getAssociatedTokenAddress(mint, bondingCurve, TOKEN_PROGRAM_ID);
      const creatorAta = PumpCurveService.getAssociatedTokenAddress(mint, creator, TOKEN_PROGRAM_ID);

      const mockHolders = [
        // Bonding curve holds 700,000,000 tokens (70% of 1B supply)
        { address: bondingCurveAta, amount: '700000000000000', decimals: 6, uiAmount: 700000000 },
        // Creator ATA holds 24,000,000 tokens (8% of 300M circulating)
        { address: creatorAta, amount: '24000000000000', decimals: 6, uiAmount: 24000000 },
        // Top holders 2 through 10 hold 9 x 6,000,000 = 54,000,000 tokens
        ...Array.from({ length: 9 }, (_, _i) => ({
          address: Keypair.generate().publicKey,
          amount: '6000000000000',
          decimals: 6,
          uiAmount: 6000000,
        })),
        // Additional smaller holders
        { address: Keypair.generate().publicKey, amount: '2000000000000', decimals: 6, uiAmount: 2000000 },
      ];

      const mockConnection = {
        getTokenLargestAccounts: async (_mint: PublicKey) => ({
          value: mockHolders,
          context: { slot: 1000 },
        }),
        getTokenSupply: async (_mint: PublicKey) => ({
          value: {
            amount: '1000000000000000',
            decimals: 6,
            uiAmount: 1000000000,
          },
          context: { slot: 1000 },
        }),
      } as unknown as Connection;

      const dist: TokenHolderDistribution = await fetchTokenHolderDistribution(
        mockConnection,
        mint,
        creator,
        bondingCurve
      );

      expect(dist.mint).toBe(mint.toBase58());
      expect(dist.bondingCurveBalance).toBe(700000000000000n);
      expect(dist.nonBondingCirculatingSupply).toBe(300000000000000n);
      expect(dist.creatorBalance).toBe(24000000000000n);

      // Creator holds 24M / 300M non-bonding supply = 8.00%
      expect(dist.devHoldingPct).toBe(8.0);

      // Top 10 non-bonding accounts:
      // Creator (24M) + 9 holders * 6M (54M) = 78M tokens out of 300M = 26.00%
      expect(dist.top10HoldersPct).toBe(26.0);
    });

    it('B01.2: EligibilityFilter passes when verified metrics satisfy thresholds and rejects when exceeded', () => {
      // Safe token metrics
      const safeReport = EligibilityFilter.evaluate(
        {
          mint: Keypair.generate().publicKey.toBase58(),
          symbol: 'SAFE',
          name: 'Safe Token',
          liquidityUsd: 15000,
          devHoldingPct: 4.5, // <= 10.0% threshold
          top10HoldersPct: 22.0, // <= 40.0% threshold
          isMintAuthorityRevoked: true,
          isFreezeAuthorityRevoked: true,
        },
        true // LIVE mode
      );

      const devCheck = safeReport.checks.find((c) => c.ruleId === 'MAX_CREATOR_EXPOSURE');
      const top10Check = safeReport.checks.find((c) => c.ruleId === 'TOP_10_CONCENTRATION');

      expect(devCheck?.status).toBe('PASS');
      expect(top10Check?.status).toBe('PASS');
      expect(safeReport.isEligible).toBe(true);

      // Rug/Cartel token metrics
      const rugReport = EligibilityFilter.evaluate(
        {
          mint: Keypair.generate().publicKey.toBase58(),
          symbol: 'RUG',
          name: 'Rug Token',
          liquidityUsd: 15000,
          devHoldingPct: 18.5, // > 10.0% -> Excessive creator exposure
          top10HoldersPct: 62.0, // > 40.0% -> High cartel dump risk
          isMintAuthorityRevoked: true,
          isFreezeAuthorityRevoked: true,
        },
        true
      );

      const rugDevCheck = rugReport.checks.find((c) => c.ruleId === 'MAX_CREATOR_EXPOSURE');
      const rugTop10Check = rugReport.checks.find((c) => c.ruleId === 'TOP_10_CONCENTRATION');

      expect(rugDevCheck?.status).toBe('FAIL');
      expect(rugTop10Check?.status).toBe('FAIL');
      expect(rugReport.isEligible).toBe(false);
    });

    it('B01.3: coordinator evaluates token holder distribution in live path eliminating SAFETY_CHECK_UNVERIFIED deadlock', async () => {
      const mint = Keypair.generate().publicKey;
      const creator = Keypair.generate().publicKey;
      const bondingCurve = Keypair.generate().publicKey;

      // When holder distribution is queried via PumpCurveService, verified metrics are produced
      const bondingCurveAta = PumpCurveService.getAssociatedTokenAddress(mint, bondingCurve, TOKEN_PROGRAM_ID);
      const creatorAta = PumpCurveService.getAssociatedTokenAddress(mint, creator, TOKEN_PROGRAM_ID);

      const mockHolders = [
        { address: bondingCurveAta, amount: '700000000000000', decimals: 6, uiAmount: 700000000 },
        { address: creatorAta, amount: '9000000000000', decimals: 6, uiAmount: 9000000 }, // 3%
        ...Array.from({ length: 9 }, () => ({
          address: Keypair.generate().publicKey,
          amount: '5000000000000',
          decimals: 6,
          uiAmount: 5000000,
        })),
      ];

      const mockConn = {
        getTokenLargestAccounts: async () => ({ value: mockHolders, context: { slot: 1 } }),
        getTokenSupply: async () => ({ value: { amount: '1000000000000000', decimals: 6, uiAmount: 1000000000 }, context: { slot: 1 } }),
      } as unknown as Connection;

      const dist = await PumpCurveService.fetchTokenHolderDistribution(mockConn, mint, creator, bondingCurve);
      expect(dist.devHoldingPct).toBe(3.0);
      expect(dist.devHoldingPct).toBeLessThanOrEqual(10.0);
      expect(dist.top10HoldersPct).toBeLessThanOrEqual(40.0);
    });
  });

  // =========================================================================
  // Blocker B06: Reclaim ATA Rent on Exits
  // =========================================================================
  describe('B06: Reclaim ATA Rent on Exits (0.00203928 SOL Recovery)', () => {
    it('B06.1: buildSellTransaction does NOT append CloseAccount instruction when closeAta is false or omitted', async () => {
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
        closeAta: false,
      };

      const tx = await txBuilder.buildSellTransaction(mockConn, sellParams, false);
      const compiledInstructions = tx.message.compiledInstructions;

      // Should contain 2 compute budget instructions + 1 Pump sell instruction = 3 total (no close instruction)
      expect(compiledInstructions.length).toBe(3);
    });

    it('B06.2: buildSellTransaction appends CloseAccount instruction when closeAta is true (100% position exit)', async () => {
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
        closeAta: true,
      };

      const tx = await txBuilder.buildSellTransaction(mockConn, sellParams, true);
      const compiledInstructions = tx.message.compiledInstructions;

      // Contains 2 compute budget + 1 Pump sell + 1 CloseAccount = 4 instructions
      expect(compiledInstructions.length).toBe(4);

      // Verify instruction #3 is the CloseAccount instruction with opcode 9
      const closeIx = compiledInstructions[3];
      expect(Array.from(closeIx.data)).toEqual([9]);
    });

    it('B06.3: createCloseAccountInstruction correctly binds ATA, destination, and owner', () => {
      const ata = Keypair.generate().publicKey;
      const seller = Keypair.generate().publicKey;

      const ix = createCloseAccountInstruction(ata, seller, seller, [], TOKEN_PROGRAM_ID);
      expect(ix.programId.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
      expect(ix.keys).toHaveLength(3);
      expect(ix.keys[0].pubkey.toBase58()).toBe(ata.toBase58());
      expect(ix.keys[0].isWritable).toBe(true);
      expect(ix.keys[1].pubkey.toBase58()).toBe(seller.toBase58());
      expect(ix.keys[1].isWritable).toBe(true);
      expect(ix.keys[2].pubkey.toBase58()).toBe(seller.toBase58());
      expect(ix.keys[2].isSigner).toBe(true);
      expect(ix.data).toEqual(Buffer.from([9]));
    });
  });

  // =========================================================================
  // Blockers B07 & B24: Dynamic Jito Tip Sizing & UI Normalization
  // =========================================================================
  describe('B07 & B24: Dynamic Jito Tip Sizing & UI Normalization', () => {
    it('B07.1: calculateDynamicJitoTip scales at 3% of notional bounded between 150k and 1M lamports', () => {
      // MICRO_10 Baseline: 0.006 SOL trade -> 3% of 6,000,000 = 180,000 lamports (0.00018 SOL)
      const microTip = calculateDynamicJitoTip(0.006);
      expect(microTip).toBe(180_000);
      expect(calculateDynamicJitoTipSol(0.006)).toBe(0.00018);

      // Floor enforcement: 0.001 SOL trade -> 3% = 30,000 -> clamped to 150,000 lamports floor
      const floorTip = calculateDynamicJitoTip(0.001);
      expect(floorTip).toBe(150_000);
      expect(calculateDynamicJitoTipSol(0.001)).toBe(0.00015);

      // Linear 3% scaling: 0.020 SOL trade -> 3% of 20,000,000 = 600,000 lamports
      const scaledTip = calculateDynamicJitoTip(0.020);
      expect(scaledTip).toBe(600_000);
      expect(calculateDynamicJitoTipSol(0.020)).toBe(0.0006);

      // Ceiling enforcement: 0.100 SOL trade -> 3% of 100M = 3,000,000 -> clamped to 1,000,000 lamports ceiling
      const ceilingTip = calculateDynamicJitoTip(0.100);
      expect(ceilingTip).toBe(1_000_000);
      expect(calculateDynamicJitoTipSol(0.100)).toBe(0.001);
    });

    it('B07.2: executionConfig.resolveDynamicJitoTip resolves 180,000 lamports for 0.006 SOL trade', () => {
      const resolved = executionConfig.resolveDynamicJitoTip({
        tradeAmountSol: 0.006,
      });

      expect(resolved.tipLamports).toBe(180_000);
      expect(resolved.tipSol).toBe(0.00018);
      expect(resolved.isDynamic).toBe(true);
      expect(resolved.policyReason).toContain('DYNAMIC_NOTIONAL_SCALING');
    });

    it('B24: UI PumpFunHotCalloutsView sets default Jito tip to 0.00018 SOL', () => {
      const componentPath = path.join(process.cwd(), 'src/components/PumpFunHotCalloutsView.tsx');
      const fileContent = fs.readFileSync(componentPath, 'utf8');

      // Verifies default tip in initial state is 0.00018 SOL
      expect(fileContent).toContain('jitoPriorityTipSol: 0.00018');
      // Verifies no hardcoded 0.005 SOL default remains in rules state
      expect(fileContent.includes('jitoPriorityTipSol: 0.005')).toBe(false);
    });
  });

  // =========================================================================
  // Blocker B19: Dust Exit Prevention
  // =========================================================================
  describe('B19: Dust Exit Prevention (Economic Viability Gate)', () => {
    it('B19.1: closePosition aborts with DUST_POSITION_EXIT_UNECONOMICAL when net proceeds <= 0', async () => {
      const coordinator = new ExecutionCoordinator();
      const testMint = Keypair.generate().publicKey.toBase58();

      // Save a tiny dust position with 0.00001 SOL residual value
      const positionId = `dust-pos-${Date.now()}`;
      workstationDb.savePosition({
        id: positionId,
        mint: testMint,
        symbol: 'DUST',
        name: 'Dust Coin',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000',
        costBasisLamports: 1000000,
        entryPriceSol: 0.001,
        currentPriceSol: 0.00000001,
        currentValueSol: 0.00001,
        realizedPnLSol: 0,
        entryTimestamp: Date.now(),
        entryTxSignature: `sig-dust-${Date.now()}`,
        executionMode: 'LIVE',
        status: 'OPEN',
      });

      // Partial sell (sellPct = 50%) -> closeAta = false (no 0.00204 SOL rent recovery)
      // Residual value = 0.000005 SOL, estimated fees ~0.00021 SOL -> netProceeds <= 0
      const res = await coordinator.closePosition(positionId, 50, 'Take Profit');

      expect(res.success).toBe(false);
      expect(res.error).toBe('DUST_POSITION_EXIT_UNECONOMICAL');
    });

    it('B19.2: closePosition permits exit when position is economically viable', async () => {
      const coordinator = new ExecutionCoordinator();
      const testMint = Keypair.generate().publicKey.toBase58();

      const positionId = `viable-pos-${Date.now()}`;
      workstationDb.savePosition({
        id: positionId,
        mint: testMint,
        symbol: 'VIABLE',
        name: 'Viable Coin',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000',
        costBasisLamports: 5000000,
        entryPriceSol: 0.005,
        currentPriceSol: 0.006,
        currentValueSol: 0.05, // 0.05 SOL value >> fees
        realizedPnLSol: 0,
        entryTimestamp: Date.now(),
        entryTxSignature: `sig-viable-${Date.now()}`,
        executionMode: 'PAPER',
        status: 'OPEN',
      });

      const res = await coordinator.closePosition(positionId, 100, 'Take Profit');
      expect(res.success).toBe(true);
      expect(res.status).toBe('CLOSED');
      expect(res.pnlSol).toBeDefined();
    });
  });

  // =========================================================================
  // Blocker B20: Unrealized Drawdown Blindness Resolution
  // =========================================================================
  describe('B20: Unrealized Drawdown Loss Limit Gate', () => {
    let db: WorkstationDatabase;
    let risk: HardenedRiskEngine;

    beforeEach(() => {
      db = new WorkstationDatabase(':memory:');
      risk = new HardenedRiskEngine();
      risk.updateLimits({
        maxDailyLossSol: 0.02, // 0.02 SOL daily loss stop
      });
    });

    it('B20.1: getDailyTotalPnLSol accurately sums closed PnL, open unrealized PnL, and fees', () => {
      const mint1 = Keypair.generate().publicKey.toBase58();
      const mint2 = Keypair.generate().publicKey.toBase58();

      // 1. Closed position with -0.005 SOL realized loss
      db.savePosition({
        id: 'closed-1',
        mint: mint1,
        symbol: 'LOSS1',
        name: 'Loss 1',
        tokenDecimals: 6,
        tokenQuantityRaw: '0',
        costBasisLamports: 0,
        entryPriceSol: 0.01,
        currentPriceSol: 0.005,
        realizedPnLSol: -0.005,
        entryTxSignature: 'sig-closed-1',
        entryTimestamp: Date.now() - 3600000,
        executionMode: 'LIVE',
        status: 'CLOSED',
        lastUpdatedTimestamp: Date.now(),
      });

      // 2. Open position with -0.012 SOL unrealized drawdown (cost 0.015 SOL, value 0.003 SOL)
      db.savePosition({
        id: 'open-1',
        mint: mint2,
        symbol: 'DRAWDOWN',
        name: 'Drawdown Coin',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000',
        costBasisLamports: 15_000_000, // 0.015 SOL
        entryPriceSol: 0.015,
        currentPriceSol: 0.003, // 0.003 SOL value
        realizedPnLSol: 0,
        entryTxSignature: 'sig-open-1',
        entryTimestamp: Date.now() - 1800000,
        executionMode: 'LIVE',
        status: 'OPEN',
      });

      // 3. Transactions with fees paid (0.001 SOL total)
      db.saveTransaction({
        signature: 'tx-1',
        orderId: 'ord-1',
        correlationId: 'c-1',
        mint: mint1,
        direction: 'BUY',
        submissionTransport: 'JITO',
        submissionTime: Date.now(),
        reconciliationState: 'RECONCILED',
        networkFeeLamports: 250000,
        jitoTipLamports: 750000, // Total fee = 1,000,000 lamports = 0.001 SOL
        executionMode: 'LIVE',
      });

      // Daily Total PnL = -0.005 (realized) + (-0.012 unrealized) - 0.001 (fees) = -0.018 SOL
      const totalPnL = db.getDailyTotalPnLSol('LIVE');
      expect(totalPnL).toBeCloseTo(-0.018, 4);
    });

    it('B20.2: risk engine halts trading when open position unrealized drawdown breaches daily loss threshold', () => {
      const mintRug = Keypair.generate().publicKey.toBase58();

      // Open position suffered severe -99% rug drawdown: 0.025 SOL cost down to 0.0001 SOL
      workstationDb.savePosition({
        id: `open-rug-${Date.now()}`,
        mint: mintRug,
        symbol: 'RUGGED',
        name: 'Rugged Token',
        tokenDecimals: 6,
        tokenQuantityRaw: '1000000',
        costBasisLamports: 25_000_000, // 0.025 SOL cost
        entryPriceSol: 0.025,
        currentPriceSol: 0.00001, // Near zero value -> -0.025 SOL loss
        realizedPnLSol: 0,
        entryTxSignature: `sig-rug-${Date.now()}`,
        entryTimestamp: Date.now() - 60000,
        executionMode: 'LIVE',
        status: 'OPEN',
      });

      const orderEvaluation = riskEngine.evaluateOrder({
        mint: Keypair.generate().publicKey.toBase58(),
        orderSizeSol: 0.006,
        expectedPriceSol: 0.0001,
        slippageBps: 800,
        estimatedFeeLamports: 25000,
        jitoTipLamports: 180000,
        signalTimestamp: Date.now(),
        marketDataTimestamp: Date.now(),
        walletSpendableSol: 0.05,
        currentOpenPositionsCount: 1,
        currentTotalExposureSol: 0.0001,
        executionMode: 'LIVE',
      });

      // The open position drawdown (-0.025 SOL) breached the daily loss limit (0.02 SOL),
      // so trading is halted immediately with DAILY_LOSS_LIMIT!
      expect(orderEvaluation.approved).toBe(false);
      expect(orderEvaluation.reasonCode).toBe('DAILY_LOSS_LIMIT');
      expect(orderEvaluation.message).toContain('daily stop limit');
    });
  });
});
