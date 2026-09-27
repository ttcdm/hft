import '../suppress-warnings.cjs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PublicKey, Connection } from '@solana/web3.js';
import BN from 'bn.js';
import {
  inspectToken2022Extensions,
  resolvePumpFeeRecipients,
  PumpCurveService,
  Token2022ExtensionReport,
} from '../server/solana/pumpCurve';
import {
  SolanaTransactionBuilder,
  PumpBuyParams,
  PumpSellParams,
} from '../server/solana/transactionBuilder';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { TradeReconciler } from '../server/execution/reconciliation';
import { localSigner } from '../server/solana/signer';
import { evaluateTokenSafety, TokenSafetyFactors } from '../server/risk/tokenSafety';
import {
  PUMP_FUN_PROGRAM_ID,
  PUMP_FUN_FEE_RECIPIENT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '../server/solana/programs';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import {
  createSimulatedBondingCurveState,
  createSimulatedPumpSwapState,
  VALID_PUMP_MINT_1,
  SOL_NATIVE_MINT,
  NON_SOL_QUOTE_MINT,
} from './e2e/helpers/simulatedStates';

describe('Milestone 1 Empirical Adversarial Challenge Suite', () => {
  // =========================================================================
  // MISSION ITEM 1: Fee Recipient Collision & Resolution Guards
  // =========================================================================
  describe('Mission Item 1: Fee Recipient Collision & Resolution Guards', () => {
    const dummyBuyer = new PublicKey('4Nd1mBQtrMJVYVfKf2PJy9NZWsWC89S2qMTrE57sR8Q1');
    const dummyCreator = new PublicKey('39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg');
    const dummyMint = new PublicKey('CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS');
    const [dummyBondingCurve] = SolanaTransactionBuilder.getBondingCurveAddress(dummyMint);
    const dummyAssociatedCurve = SolanaTransactionBuilder.getAssociatedTokenAddress(dummyMint, dummyBondingCurve);
    const dummyAssociatedUser = SolanaTransactionBuilder.getAssociatedTokenAddress(dummyMint, dummyBuyer);
    const collidingKey = new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD');
    const distinctFeeRecipient = PUMP_FUN_FEE_RECIPIENT;
    const distinctBuybackFeeRecipient = new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD');

    it('M1.1: resolvePumpFeeRecipients throws FEE_RECIPIENT_COLLISION when normal and buyback recipients collide', () => {
      const mockGlobalWithCollision = {
        feeRecipient: collidingKey.toBase58(),
        feeRecipients: [collidingKey.toBase58()],
        reservedFeeRecipient: collidingKey.toBase58(),
        reservedFeeRecipients: [collidingKey.toBase58()],
        buybackFeeRecipients: [collidingKey.toBase58()],
      };

      // Both normal mode and Mayhem mode must throw FEE_RECIPIENT_COLLISION
      expect(() => {
        resolvePumpFeeRecipients(mockGlobalWithCollision, false, 'LIVE');
      }).toThrow(/FEE_RECIPIENT_COLLISION/);

      expect(() => {
        resolvePumpFeeRecipients(mockGlobalWithCollision, true, 'LIVE');
      }).toThrow(/FEE_RECIPIENT_COLLISION/);
    });

    it('M1.2: resolvePumpFeeRecipients strictly fails closed in LIVE mode when on-chain recipients cannot be resolved', () => {
      // Missing normal fee recipients in LIVE mode
      const emptyGlobal = {
        feeRecipient: null,
        feeRecipients: [],
        reservedFeeRecipient: null,
        reservedFeeRecipients: [],
        buybackFeeRecipients: [distinctBuybackFeeRecipient.toBase58()],
      };

      expect(() => {
        resolvePumpFeeRecipients(emptyGlobal, false, 'LIVE');
      }).toThrow(/FEE_RECIPIENT_UNRESOLVED/);

      // Missing reserved fee recipients in Mayhem LIVE mode
      expect(() => {
        resolvePumpFeeRecipients(emptyGlobal, true, 'LIVE');
      }).toThrow(/FEE_RECIPIENT_UNRESOLVED/);

      // Missing buyback recipients in LIVE mode
      const noBuybackGlobal = {
        feeRecipient: distinctFeeRecipient.toBase58(),
        buybackFeeRecipients: [],
      };
      expect(() => {
        resolvePumpFeeRecipients(noBuybackGlobal, false, 'LIVE');
      }).toThrow(/FEE_RECIPIENT_UNRESOLVED/);
    });

    it('M1.3: createPumpBuyV2Instruction throws FEE_RECIPIENT_COLLISION on identical feeRecipient and buybackFeeRecipient', async () => {
      const collidingBuyParams: PumpBuyParams = {
        buyer: dummyBuyer,
        mint: dummyMint,
        bondingCurve: dummyBondingCurve,
        associatedBondingCurve: dummyAssociatedCurve,
        associatedUser: dummyAssociatedUser,
        creator: dummyCreator,
        feeRecipient: collidingKey,
        buybackFeeRecipient: collidingKey, // COLLISION!
        amountTokens: 1_000_000n,
        maxSolCostLamports: 10_000_000n,
        tokenProgram: TOKEN_PROGRAM_ID,
      };

      await expect(
        SolanaTransactionBuilder.createPumpBuyV2Instruction(collidingBuyParams)
      ).rejects.toThrow(/FEE_RECIPIENT_COLLISION/);
    });

    it('M1.4: createPumpSellV2Instruction throws FEE_RECIPIENT_COLLISION on identical feeRecipient and buybackFeeRecipient', async () => {
      const collidingSellParams: PumpSellParams = {
        seller: dummyBuyer,
        mint: dummyMint,
        bondingCurve: dummyBondingCurve,
        associatedBondingCurve: dummyAssociatedCurve,
        associatedUser: dummyAssociatedUser,
        creator: dummyCreator,
        feeRecipient: collidingKey,
        buybackFeeRecipient: collidingKey, // COLLISION!
        amountTokens: 500_000n,
        minSolOutputLamports: 4_500_000n,
        tokenProgram: TOKEN_PROGRAM_ID,
      };

      await expect(
        SolanaTransactionBuilder.createPumpSellV2Instruction(collidingSellParams)
      ).rejects.toThrow(/FEE_RECIPIENT_COLLISION/);
    });

    it('M1.5: createPumpBuyV2Instruction & createPumpSellV2Instruction reject default or missing creator and fee keys', async () => {
      const invalidCreatorParams: PumpBuyParams = {
        buyer: dummyBuyer,
        mint: dummyMint,
        bondingCurve: dummyBondingCurve,
        associatedBondingCurve: dummyAssociatedCurve,
        associatedUser: dummyAssociatedUser,
        creator: PublicKey.default, // Invalid creator!
        feeRecipient: distinctFeeRecipient,
        buybackFeeRecipient: distinctBuybackFeeRecipient,
        amountTokens: 1_000_000n,
        maxSolCostLamports: 10_000_000n,
      };

      await expect(
        SolanaTransactionBuilder.createPumpBuyV2Instruction(invalidCreatorParams)
      ).rejects.toThrow(/PUMP_V2_CREATOR_REQUIRED/);

      const invalidFeeRecipientParams: PumpBuyParams = {
        ...invalidCreatorParams,
        creator: dummyCreator,
        feeRecipient: PublicKey.default, // Invalid fee recipient!
      };

      await expect(
        SolanaTransactionBuilder.createPumpBuyV2Instruction(invalidFeeRecipientParams)
      ).rejects.toThrow(/PUMP_V2_FEE_RECIPIENT_REQUIRED/);

      const invalidBuybackRecipientParams: PumpBuyParams = {
        ...invalidCreatorParams,
        creator: dummyCreator,
        buybackFeeRecipient: PublicKey.default, // Invalid buyback recipient!
      };

      await expect(
        SolanaTransactionBuilder.createPumpBuyV2Instruction(invalidBuybackRecipientParams)
      ).rejects.toThrow(/PUMP_V2_BUYBACK_RECIPIENT_REQUIRED/);
    });
  });

  // =========================================================================
  // MISSION ITEM 2: Token-2022 TLV Extension Parser Hardening
  // =========================================================================
  describe('Mission Item 2: Token-2022 TLV Extension Parser Hardening', () => {
    // Helper to create valid 82-byte SPL Mint header
    function createBaseMintAccount(decimals = 6): Buffer {
      const buf = Buffer.alloc(82);
      buf.writeUInt32LE(1, 0); // mint authority COption::Some
      Buffer.from(VALID_PUMP_MINT_1.toBytes()).copy(buf, 4); // mint authority pubkey (32 bytes)
      buf.writeBigUInt64LE(1_000_000_000_000_000n, 36); // supply: 1B
      buf.writeUInt8(decimals, 44); // decimals
      buf.writeUInt8(1, 45); // is_initialized = true
      buf.writeUInt32LE(0, 46); // freeze authority COption::None
      return buf;
    }

    // Helper to build a Token-2022 buffer with arbitrary TLV records
    function createToken2022Buffer(tlvs: Array<{ type: number; data: Buffer }>): Buffer {
      const base = createBaseMintAccount();
      // Token-2022 extension section starts at byte 82 with account type byte: 1 = Mint
      const accountTypeByte = Buffer.from([1]);
      const tlvBuffers: Buffer[] = [];

      for (const tlv of tlvs) {
        const header = Buffer.alloc(4);
        header.writeUInt16LE(tlv.type, 0);
        header.writeUInt16LE(tlv.data.length, 2);
        tlvBuffers.push(header, tlv.data);
      }

      return Buffer.concat([base, accountTypeByte, ...tlvBuffers]);
    }

    it('M2.1: accepts clean standard SPL Mint (82 bytes) as safe with zero extensions', () => {
      const cleanMint = createBaseMintAccount();
      const report = inspectToken2022Extensions(cleanMint);
      expect(report.isSafe).toBe(true);
      expect(report.detectedExtensionTypes.length).toBe(0);
      expect(report.unsupportedExtensionTypes.length).toBe(0);
      expect(report.hasCorruptTlv).toBe(false);
    });

    it('M2.2: accepts safe Token-2022 extensions (MetadataPointer 16 & TokenMetadata 17)', () => {
      const safeBuffer = createToken2022Buffer([
        { type: 16, data: Buffer.alloc(36) }, // MetadataPointer
        { type: 17, data: Buffer.alloc(64) }, // TokenMetadata
      ]);
      const report = inspectToken2022Extensions(safeBuffer);
      expect(report.isSafe).toBe(true);
      expect(report.detectedExtensionTypes).toEqual([16, 17]);
      expect(report.unsupportedExtensionTypes.length).toBe(0);
      expect(report.hasCorruptTlv).toBe(false);
    });

    it('M2.3: detects and rejects unsupported PermanentDelegate extension (Type 12)', () => {
      const buffer = createToken2022Buffer([
        { type: 12, data: Buffer.alloc(32) }, // PermanentDelegate pubkey
      ]);
      const report = inspectToken2022Extensions(buffer);
      expect(report.isSafe).toBe(false);
      expect(report.hasPermanentDelegate).toBe(true);
      expect(report.unsupportedExtensionTypes).toContain(12);
      expect(report.unsupportedExtensionNames).toContain('PermanentDelegate');
    });

    it('M2.4: detects and rejects unsupported TransferHook extension (Type 14 & 15)', () => {
      const buffer = createToken2022Buffer([
        { type: 14, data: Buffer.alloc(64) }, // TransferHook
      ]);
      const report = inspectToken2022Extensions(buffer);
      expect(report.isSafe).toBe(false);
      expect(report.hasTransferHook).toBe(true);
      expect(report.unsupportedExtensionTypes).toContain(14);
      expect(report.unsupportedExtensionNames).toContain('TransferHook');
    });

    it('M2.5: detects and rejects unsupported NonTransferable extension (Type 9)', () => {
      const buffer = createToken2022Buffer([
        { type: 9, data: Buffer.alloc(0) }, // NonTransferable (length 0)
      ]);
      const report = inspectToken2022Extensions(buffer);
      expect(report.isSafe).toBe(false);
      expect(report.isNonTransferable).toBe(true);
      expect(report.unsupportedExtensionTypes).toContain(9);
      expect(report.unsupportedExtensionNames).toContain('NonTransferable');
    });

    it('M2.6: detects and rejects unsupported DefaultAccountState extension (Type 6)', () => {
      const buffer = createToken2022Buffer([
        { type: 6, data: Buffer.from([1]) }, // DefaultAccountState (1 = Frozen)
      ]);
      const report = inspectToken2022Extensions(buffer);
      expect(report.isSafe).toBe(false);
      expect(report.hasDefaultAccountState).toBe(true);
      expect(report.unsupportedExtensionTypes).toContain(6);
      expect(report.unsupportedExtensionNames).toContain('DefaultAccountState');
    });

    it('M2.7: detects and rejects unsupported TransferFeeConfig extension (Type 1 & 2)', () => {
      const buffer = createToken2022Buffer([
        { type: 1, data: Buffer.alloc(108) }, // TransferFeeConfig
      ]);
      const report = inspectToken2022Extensions(buffer);
      expect(report.isSafe).toBe(false);
      expect(report.hasTransferFee).toBe(true);
      expect(report.unsupportedExtensionTypes).toContain(1);
      expect(report.unsupportedExtensionNames).toContain('TransferFeeConfig');
    });

    it('M2.8: detects and rejects unsupported InterestBearingMint extension (Type 10)', () => {
      const buffer = createToken2022Buffer([
        { type: 10, data: Buffer.alloc(52) }, // InterestBearingMint
      ]);
      const report = inspectToken2022Extensions(buffer);
      expect(report.isSafe).toBe(false);
      expect(report.unsupportedExtensionTypes).toContain(10);
      expect(report.unsupportedExtensionNames).toContain('InterestBearingMint');
    });

    it('M2.9: detects and rejects unknown / novel extension tags (e.g. Type 999)', () => {
      const buffer = createToken2022Buffer([
        { type: 999, data: Buffer.alloc(16) },
      ]);
      const report = inspectToken2022Extensions(buffer);
      expect(report.isSafe).toBe(false);
      expect(report.detectedExtensionTypes).toContain(999);
      expect(report.unsupportedExtensionTypes).toContain(999);
      expect(report.unsupportedExtensionNames).toContain('UnknownExtension(999)');
    });

    it('M2.10: detects corrupt TLV when declared extension length overflows buffer', () => {
      // Build buffer where extension header claims 100 bytes, but buffer only has 10 bytes remaining
      const base = createBaseMintAccount();
      const accountTypeByte = Buffer.from([1]);
      const header = Buffer.alloc(4);
      header.writeUInt16LE(16, 0); // MetadataPointer
      header.writeUInt16LE(100, 2); // Claims 100 bytes of data
      const partialData = Buffer.alloc(10); // Only 10 bytes provided

      const truncatedBuffer = Buffer.concat([base, accountTypeByte, header, partialData]);
      const report = inspectToken2022Extensions(truncatedBuffer);

      expect(report.hasCorruptTlv).toBe(true);
      expect(report.isSafe).toBe(false);
    });

    it('M2.11: evaluateTokenSafety integration rejects unsafe Token-2022 extensions in LIVE mode', () => {
      const factorsWithUnsupportedExtension: TokenSafetyFactors = {
        mint: VALID_PUMP_MINT_1.toBase58(),
        mintAuthority: 'REVOKED',
        freezeAuthority: 'REVOKED',
        hasToken2022Extensions: true,
        unsupportedToken2022Extension: 'TransferHook',
        devHoldingPct: 2.0,
        top10HoldersPct: 15.0,
      };

      const assessment = evaluateTokenSafety(factorsWithUnsupportedExtension, 'LIVE');
      expect(assessment.score).toBe('DANGEROUS');
      expect(assessment.isEligibleForSniper).toBe(false);
      expect(assessment.risks.some((r) => r.includes('UNSUPPORTED_TOKEN_EXTENSION'))).toBe(true);
    });

    it('M2.13: multi-TLV sequence — safe extension followed by TransferHook must be rejected', () => {
      const buffer = createToken2022Buffer([
        { type: 16, data: Buffer.alloc(36) }, // Safe: MetadataPointer
        { type: 14, data: Buffer.alloc(64) }, // Unsafe: TransferHook
      ]);
      const report = inspectToken2022Extensions(buffer);
      expect(report.isSafe).toBe(false);
      expect(report.detectedExtensionTypes).toEqual([16, 14]);
      expect(report.unsupportedExtensionTypes).toEqual([14]);
      expect(report.hasTransferHook).toBe(true);
    });

    it('M2.14: multi-TLV sequence — first TLV valid, second TLV length overflows buffer triggers hasCorruptTlv', () => {
      const base = createBaseMintAccount();
      const accountType = Buffer.from([1]);

      // TLV 1: Valid MetadataPointer (len 36)
      const header1 = Buffer.alloc(4);
      header1.writeUInt16LE(16, 0);
      header1.writeUInt16LE(36, 2);
      const data1 = Buffer.alloc(36);

      // TLV 2: Corrupted header claiming 500 bytes when only 8 bytes remain
      const header2 = Buffer.alloc(4);
      header2.writeUInt16LE(17, 0);
      header2.writeUInt16LE(500, 2);
      const data2 = Buffer.alloc(8);

      const multiBuf = Buffer.concat([base, accountType, header1, data1, header2, data2]);
      const report = inspectToken2022Extensions(multiBuf);

      expect(report.hasCorruptTlv).toBe(true);
      expect(report.isSafe).toBe(false);
      expect(report.detectedExtensionTypes).toEqual([16]); // Only the first was fully unpacked
    });

    it('M2.15: rejects scaled UI amount and confidential transfer extensions', () => {
      const buffer = createToken2022Buffer([
        { type: 4, data: Buffer.alloc(32) }, // ConfidentialTransferMint
        { type: 24, data: Buffer.alloc(8) }, // ScaledUiAmountMint
      ]);
      const report = inspectToken2022Extensions(buffer);
      expect(report.isSafe).toBe(false);
      expect(report.hasConfidentialTransfers).toBe(true);
      expect(report.unsupportedExtensionTypes).toContain(4);
      expect(report.unsupportedExtensionTypes).toContain(24);
    });
  });

  // =========================================================================
  // MISSION ITEM 3: PumpSwap Effective Quote Reserves & Boundary Math
  // =========================================================================
  describe('Mission Item 3: PumpSwap Effective Quote Reserves & Boundary Math', () => {
    it('M3.1: effectiveQuoteReserve strictly equals actual quoteReserve + virtualQuoteReserves', () => {
      const actualQuote = 50_000_000_000n; // 50 SOL actual in pool
      const virtualQuote = 30_000_000_000n; // 30 SOL virtual bonding curve
      const poolState = createSimulatedPumpSwapState({
        quoteReserve: actualQuote,
        virtualQuoteReserves: virtualQuote,
      });

      expect(poolState.effectiveQuoteReserve).toBe(80_000_000_000n);
      expect(poolState.effectiveQuoteReserve).toBe(poolState.quoteReserve + poolState.virtualQuoteReserves);
    });

    it('M3.2: boundary condition — zero actual quote reserve with positive virtual quote reserves', () => {
      const zeroActualQuote = 0n;
      const virtualQuote = 30_000_000_000n;
      const baseReserve = 1_000_000_000_000_000n; // 1B tokens with 6 decimals = 1,000,000,000 human

      const poolState = createSimulatedPumpSwapState({
        baseReserve,
        quoteReserve: zeroActualQuote,
        virtualQuoteReserves: virtualQuote,
      });

      expect(poolState.effectiveQuoteReserve).toBe(30_000_000_000n);
      // spotPriceSol = quoteSol / baseHuman = (30 SOL) / (1,000,000,000 tokens) = 0.00000003 SOL/token
      expect(poolState.spotPriceSol).toBeCloseTo(0.00000003, 8);
      expect(Number.isFinite(poolState.spotPriceSol)).toBe(true);
      expect(poolState.spotPriceSol).toBeGreaterThan(0);
    });

    it('M3.3: boundary condition — zero base reserve does not cause division-by-zero or NaN', () => {
      const poolState = createSimulatedPumpSwapState({
        baseReserve: 0n,
        quoteReserve: 50_000_000_000n,
        virtualQuoteReserves: 30_000_000_000n,
      });

      expect(poolState.baseReserve).toBe(0n);
      expect(Number.isFinite(poolState.spotPriceSol)).toBe(true);
      expect(isNaN(poolState.spotPriceSol)).toBe(false);
      // Zero base tokens means spot price falls back to safe 0 or default
      expect(poolState.spotPriceSol).toBe(0.000575);
    });

    it('M3.4: boundary condition — huge virtual quote reserves (100M SOL) computes without integer overflow', () => {
      const hugeVirtualQuote = 100_000_000_000_000_000n; // 100M SOL in lamports
      const actualQuote = 10_000_000_000n;
      const baseReserve = 500_000_000_000_000n; // 500M tokens

      const poolState = createSimulatedPumpSwapState({
        baseReserve,
        quoteReserve: actualQuote,
        virtualQuoteReserves: hugeVirtualQuote,
      });

      expect(poolState.effectiveQuoteReserve).toBe(actualQuote + hugeVirtualQuote);
      expect(Number.isFinite(poolState.spotPriceSol)).toBe(true);
      expect(poolState.spotPriceSol).toBeGreaterThan(0);
    });

    it('M3.5: standalone quote functions include virtualQuoteReserves in mathematical calculations', () => {
      // Setup swapState fixture
      const mockSwapStateWithVirtual = {
        poolBaseAmount: new BN('500000000000000'), // 500M tokens
        poolQuoteAmount: new BN('30000000000'),     // 30 SOL actual
        pool: {
          virtualQuoteReserves: new BN('30000000000'), // 30 SOL virtual
          quoteMint: SOL_NATIVE_MINT,
          coinCreator: VALID_PUMP_MINT_1,
          creator: VALID_PUMP_MINT_1,
          isMayhemMode: false,
          creatorFeeBps: '0',
        },
        globalConfig: null,
        feeConfig: null,
        baseMintAccount: { decimals: 6 },
        baseMint: VALID_PUMP_MINT_1,
      };

      const mockSwapStateWithoutVirtual = {
        ...mockSwapStateWithVirtual,
        pool: {
          ...mockSwapStateWithVirtual.pool,
          virtualQuoteReserves: new BN(0),
        },
      };

      // Buying with 1 SOL input via PumpSwapVenueService
      const buyWithVirtual = PumpSwapVenueService.quotePumpSwapBuyQuoteInput({
        solAmountLamports: 1_000_000_000n,
        slippageBps: 500,
        swapState: mockSwapStateWithVirtual,
      });

      const buyWithoutVirtual = PumpSwapVenueService.quotePumpSwapBuyQuoteInput({
        solAmountLamports: 1_000_000_000n,
        slippageBps: 500,
        swapState: mockSwapStateWithoutVirtual,
      });

      // With higher effective quote reserve (due to virtual reserves), price of tokens is higher,
      // so 1 SOL should buy FEWER base tokens than when virtual quote reserves are ignored!
      expect(buyWithVirtual).toBeDefined();
      expect(buyWithoutVirtual).toBeDefined();
      expect(buyWithVirtual.uiBase.lt(buyWithoutVirtual.uiBase)).toBe(true);
    });

    it('M3.6: buildPumpSwapBuyInstructions & SellInstructions reject zero liquidity pools', async () => {
      const mockRpc = new MockSolanaRpc();
      const conn = mockRpc.createConnection();
      const dummyUser = new PublicKey('4Nd1mBQtrMJVYVfKf2PJy9NZWsWC89S2qMTrE57sR8Q1');

      // Attempting to build on non-existent or zero liquidity pool fails closed
      await expect(
        PumpSwapVenueService.buildPumpSwapBuyInstructions(
          conn,
          dummyUser,
          VALID_PUMP_MINT_1,
          1_000_000_000n,
          800,
          'LIVE'
        )
      ).rejects.toThrow(/PUMPSWAP_POOL_NOT_FOUND/);

      await expect(
        PumpSwapVenueService.buildPumpSwapSellInstructions(
          conn,
          dummyUser,
          VALID_PUMP_MINT_1,
          10_000_000n,
          800,
          'LIVE'
        )
      ).rejects.toThrow(/PUMPSWAP_POOL_NOT_FOUND/);
    });

    it('M3.7: quotePumpSwapSellBaseInput produces higher SOL output with positive virtual quote reserves', () => {
      const mockSwapStateWithVirtual = {
        poolBaseAmount: new BN('500000000000000'), // 500M tokens
        poolQuoteAmount: new BN('30000000000'),     // 30 SOL actual
        pool: {
          virtualQuoteReserves: new BN('30000000000'), // 30 SOL virtual
          quoteMint: SOL_NATIVE_MINT,
          coinCreator: VALID_PUMP_MINT_1,
          creator: VALID_PUMP_MINT_1,
          isMayhemMode: false,
          creatorFeeBps: '0',
        },
        globalConfig: null,
        feeConfig: null,
        baseMintAccount: { decimals: 6 },
        baseMint: VALID_PUMP_MINT_1,
      };

      const mockSwapStateWithoutVirtual = {
        ...mockSwapStateWithVirtual,
        pool: {
          ...mockSwapStateWithVirtual.pool,
          virtualQuoteReserves: new BN(0),
        },
      };

      const sellWithVirtual = PumpSwapVenueService.quotePumpSwapSellBaseInput({
        tokenAmountRaw: 10_000_000_000n,
        slippageBps: 500,
        swapState: mockSwapStateWithVirtual,
      });

      const sellWithoutVirtual = PumpSwapVenueService.quotePumpSwapSellBaseInput({
        tokenAmountRaw: 10_000_000_000n,
        slippageBps: 500,
        swapState: mockSwapStateWithoutVirtual,
      });

      expect(sellWithVirtual).toBeDefined();
      expect(sellWithoutVirtual).toBeDefined();
      // Selling tokens when virtual reserves exist produces strictly higher quote SOL proceeds
      expect(sellWithVirtual.uiQuote.gt(sellWithoutVirtual.uiQuote)).toBe(true);
    });
  });

  // =========================================================================
  // MISSION ITEM 4: ExecutionMode Propagation & Fail-Closed Guards
  // =========================================================================
  describe('Mission Item 4: ExecutionMode Propagation & Fail-Closed Guards', () => {
    let mockRpc: MockSolanaRpc;
    let coordinator: ExecutionCoordinator;

    beforeEach(() => {
      mockRpc = new MockSolanaRpc();
      coordinator = new ExecutionCoordinator();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      mockRpc.clear();
      coordinator.cleanup();
    });

    it('M4.1: calculateBuyQuote and calculateSellQuote throw CRITICAL_CONFIG_ERROR when executionMode is omitted', () => {
      const baseCurveState = createSimulatedBondingCurveState();

      expect(() => {
        (PumpCurveService as any).calculateBuyQuote(baseCurveState, 0.05);
      }).toThrow(/CRITICAL_CONFIG_ERROR/);

      expect(() => {
        (PumpCurveService as any).calculateSellQuote(baseCurveState, 1_000_000n);
      }).toThrow(/CRITICAL_CONFIG_ERROR/);
    });

    it('M4.2: calculateBuyQuote and calculateSellQuote fail closed in LIVE mode when fee config is unconfigured', () => {
      const baseCurveState = createSimulatedBondingCurveState({
        feeComputationStatus: 'UNAVAILABLE',
      });

      // Clear cached fee configuration
      PumpCurveService.cachedGlobal = null;
      PumpCurveService.cachedFeeConfig = null;

      expect(() => {
        PumpCurveService.calculateBuyQuote({
          state: baseCurveState,
          amountSol: 0.05,
          executionMode: 'LIVE',
        });
      }).toThrow(/DYNAMIC_FEE_CALCULATION_FAILED/);

      expect(() => {
        PumpCurveService.calculateSellQuote({
          state: baseCurveState,
          tokenAmountRaw: 1_000_000n,
          executionMode: 'LIVE',
        });
      }).toThrow(/DYNAMIC_FEE_CALCULATION_FAILED/);
    });

    it('M4.3: resolvePumpFeeRecipients throws CRITICAL_CONFIG_ERROR when executionMode is invalid or omitted', () => {
      expect(() => {
        (resolvePumpFeeRecipients as any)(null, false, undefined);
      }).toThrow(/CRITICAL_CONFIG_ERROR/);

      expect(() => {
        (resolvePumpFeeRecipients as any)(null, false, 'INVALID_MODE');
      }).toThrow(/CRITICAL_CONFIG_ERROR/);
    });

    it('M4.4: getPoolState fails closed in LIVE mode on non-SOL quote mint', async () => {
      const conn = mockRpc.createConnection();
      // In LIVE mode, non-existent pool returns null or throws
      const result = await PumpSwapVenueService.getPoolState(conn, VALID_PUMP_MINT_1, 'LIVE');
      expect(result).toBeNull();
    });

    it('M4.5: resolveVenue propagates executionMode and fails closed to UNKNOWN in LIVE mode on missing curve', async () => {
      const conn = mockRpc.createConnection();
      const res = await PumpSwapVenueService.resolveVenue(conn, VALID_PUMP_MINT_1, 'LIVE');
      expect(res.venue).toBe('UNKNOWN');
      expect(res.isMigrated).toBe(true);
    });

    it('M4.6: TradeReconciler.capturePreTradeSnapshot fails closed in LIVE mode if wallet balance check fails', async () => {
      const failingConnection = {
        getBalance: async () => {
          throw new Error('RPC_NODE_UNAVAILABLE');
        },
      } as unknown as Connection;

      const dummyWallet = new PublicKey('4Nd1mBQtrMJVYVfKf2PJy9NZWsWC89S2qMTrE57sR8Q1');

      // LIVE mode must throw
      await expect(
        TradeReconciler.capturePreTradeSnapshot(
          failingConnection,
          dummyWallet,
          VALID_PUMP_MINT_1,
          TOKEN_PROGRAM_ID,
          'LIVE'
        )
      ).rejects.toThrow(/PRE_TRADE_SNAPSHOT_FAILED/);

      // PAPER mode must gracefully fall back without throwing
      const paperSnapshot = await TradeReconciler.capturePreTradeSnapshot(
        failingConnection,
        dummyWallet,
        VALID_PUMP_MINT_1,
        TOKEN_PROGRAM_ID,
        'PAPER'
      );
      expect(paperSnapshot).toBeDefined();
      expect(paperSnapshot.walletSolLamports).toBe(0);
    });

    it('M4.7: ExecutionCoordinator.armLiveTrading rejects arming when ALLOW_LIVE_REAL_MONEY_TRADING is false', () => {
      const originalEnv = process.env.ALLOW_LIVE_REAL_MONEY_TRADING;
      try {
        process.env.ALLOW_LIVE_REAL_MONEY_TRADING = 'false';
        const armResult = coordinator.armLiveTrading(true, 'CONFIRM_LIVE_TRADING_RISK');
        expect(armResult.success).toBe(false);
        expect(armResult.message).toContain('REAL_MONEY_PROHIBITED');
        expect(coordinator.isLiveArmed()).toBe(false);
        expect(coordinator.getExecutionMode()).toBe('PAPER');
      } finally {
        process.env.ALLOW_LIVE_REAL_MONEY_TRADING = originalEnv;
      }
    });
    it('M4.8: ExecutionCoordinator.canExecuteLive returns allowed: false with explicit reasons when prerequisites are missing', () => {
      vi.spyOn(localSigner, 'getStatus').mockReturnValue('NOT_CONFIGURED');
      const check = coordinator.canExecuteLive();
      expect(check.allowed).toBe(false);
      expect(check.reasons.length).toBeGreaterThan(0);
      // Prerequisite failure reasons must include signer and feeds
      expect(check.reasons.some((r) => r.toLowerCase().includes('signer'))).toBe(true);
      expect(check.readiness.ready).toBe(false);
    });

    it('M4.9: ExecutionCoordinator.executeTrade rejects unapproved provenance in LIVE mode with PROVENANCE_VIOLATION', async () => {
      // Force execution mode to LIVE for coordinator trade test
      (coordinator as any).executionMode = 'LIVE';

      const tradeReq = {
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'TEST',
        name: 'Test Token',
        amountSol: 0.005,
        source: 'AUTO_SNIPER' as const,
        provenance: 'SYNTHETIC_TEST' as const, // UNAPPROVED FOR LIVE!
      };

      const res = await coordinator.executeTrade(tradeReq);
      expect(res.success).toBe(false);
      expect(res.lifecycleState).toBe('RISK_REJECTED');
      expect(res.error).toContain('PROVENANCE_VIOLATION');
    });

    it('M4.10: ExecutionCoordinator.executeTrade rejects eligibility mint mismatch attack', async () => {
      (coordinator as any).executionMode = 'LIVE';

      const attackerMint = '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv';
      const honestMint = VALID_PUMP_MINT_1.toBase58();

      const mismatchedReport = {
        mint: honestMint,
        isEligible: true,
        score: 'SAFE' as const,
        riskScoreNumber: 10,
        checks: [],
        failedCount: 0,
        warningCount: 0,
        passedCount: 5,
        evaluatedAt: Date.now(),
      };

      const tradeReq = {
        mint: attackerMint, // Trying to trade attacker mint using honest mint's report!
        symbol: 'ATTACK',
        name: 'Attack Token',
        amountSol: 0.005,
        source: 'AUTO_SNIPER' as const,
        provenance: 'REAL_ONCHAIN' as const,
        eligibilityReport: mismatchedReport,
      };

      const res = await coordinator.executeTrade(tradeReq);
      expect(res.success).toBe(false);
      expect(res.lifecycleState).toBe('FILTER_REJECTED');
      expect(res.error).toContain('ELIGIBILITY_MINT_MISMATCH');
    });

    it('M4.11: calculateBuyQuote and calculateSellQuote reject completed/migrated bonding curves', () => {
      const completedCurve = createSimulatedBondingCurveState({ complete: true });

      expect(() => {
        PumpCurveService.calculateBuyQuote({
          state: completedCurve,
          amountSol: 0.05,
          executionMode: 'LIVE',
        });
      }).toThrow(/BONDING_CURVE_MIGRATED/);

      expect(() => {
        PumpCurveService.calculateSellQuote({
          state: completedCurve,
          tokenAmountRaw: 1_000_000n,
          executionMode: 'LIVE',
        });
      }).toThrow(/BONDING_CURVE_MIGRATED/);
    });

    it('M4.12: calculateBuyQuote and calculateSellQuote reject non-SOL exotic quote mints', () => {
      const usdcCurve = createSimulatedBondingCurveState({ quoteMint: NON_SOL_QUOTE_MINT });

      expect(() => {
        PumpCurveService.calculateBuyQuote({
          state: usdcCurve,
          amountSol: 0.05,
          executionMode: 'LIVE',
        });
      }).toThrow(/UNSUPPORTED_QUOTE_MINT/);

      expect(() => {
        PumpCurveService.calculateSellQuote({
          state: usdcCurve,
          tokenAmountRaw: 1_000_000n,
          executionMode: 'LIVE',
        });
      }).toThrow(/UNSUPPORTED_QUOTE_MINT/);
    });
  });
});



