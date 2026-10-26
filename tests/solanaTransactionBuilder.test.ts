import '../suppress-warnings.cjs';
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { SolanaTransactionBuilder, PumpBuyParams, PumpSellParams } from '../server/solana/transactionBuilder';
import {
  PUMP_FUN_PROGRAM_ID,
  PUMP_FUN_FEE_RECIPIENT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
} from '../server/solana/programs';

describe('SolanaTransactionBuilder — Protocol Instructions & Discriminators', () => {
  const buyer = new PublicKey('4Nd1mBQtrMJVYVfKf2PJy9NZWsWC89S2qMTrE57sR8Q1');
  const creator = new PublicKey('39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg');
  const mint = new PublicKey('CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS');
  const [bondingCurve] = SolanaTransactionBuilder.getBondingCurveAddress(mint);
  const associatedBondingCurve = SolanaTransactionBuilder.getAssociatedTokenAddress(mint, bondingCurve);
  const associatedUser = SolanaTransactionBuilder.getAssociatedTokenAddress(mint, buyer);

  it('generates correct Anchor discriminator and 27-account structure for official Pump.fun buy_v2', async () => {
    const params: PumpBuyParams = {
      buyer,
      mint,
      bondingCurve,
      associatedBondingCurve,
      associatedUser,
      creator,
      feeRecipient: PUMP_FUN_FEE_RECIPIENT,
      buybackFeeRecipient: new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD'),
      amountTokens: 1_000_000_000n,
      maxSolCostLamports: 100_000_000n,
      tokenProgram: TOKEN_PROGRAM_ID,
    };

    const ix = await SolanaTransactionBuilder.createPumpBuyV2Instruction(params);

    expect(ix.programId.equals(PUMP_FUN_PROGRAM_ID)).toBe(true);
    // Official PumpSdk buy_v2 instruction requires 27 accounts
    expect(ix.keys.length).toBe(27);

    // Official buy_v2 8-byte discriminator: b817ee6167c5d33d
    const discHex = ix.data.subarray(0, 8).toString('hex');
    expect(discHex).toBe('b817ee6167c5d33d');
  });

  it('generates correct Anchor discriminator and 26-account structure for official Pump.fun sell_v2', async () => {
    const params: PumpSellParams = {
      seller: buyer,
      mint,
      bondingCurve,
      associatedBondingCurve,
      associatedUser,
      creator,
      feeRecipient: PUMP_FUN_FEE_RECIPIENT,
      buybackFeeRecipient: new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD'),
      amountTokens: 500_000_000n,
      minSolOutputLamports: 45_000_000n,
      tokenProgram: TOKEN_PROGRAM_ID,
    };

    const ix = await SolanaTransactionBuilder.createPumpSellV2Instruction(params);

    expect(ix.programId.equals(PUMP_FUN_PROGRAM_ID)).toBe(true);
    // Official PumpSdk sell_v2 instruction requires 26 accounts
    expect(ix.keys.length).toBe(26);

    // Official sell_v2 8-byte discriminator: 5df6823ce7e940b2
    const discHex = ix.data.subarray(0, 8).toString('hex');
    expect(discHex).toBe('5df6823ce7e940b2');
  });

  it('constructs valid Compute Budget instructions (Limit & Priority Price)', () => {
    const ixs = SolanaTransactionBuilder.createComputeBudgetInstructions(250000, 75000);
    expect(ixs.length).toBe(2);

    expect(ixs[0].programId.equals(COMPUTE_BUDGET_PROGRAM_ID)).toBe(true);
    expect(ixs[0].data.readUInt8(0)).toBe(2); // SetComputeUnitLimit
    expect(ixs[0].data.readUInt32LE(1)).toBe(250000);

    expect(ixs[1].programId.equals(COMPUTE_BUDGET_PROGRAM_ID)).toBe(true);
    expect(ixs[1].data.readUInt8(0)).toBe(3); // SetComputeUnitPrice
    expect(ixs[1].data.readBigUInt64LE(1)).toBe(75000n);
  });

  it('constructs idempotent ATA instruction with Token-2022 support', () => {
    const ata = SolanaTransactionBuilder.getAssociatedTokenAddress(mint, buyer, TOKEN_2022_PROGRAM_ID);
    const ix = SolanaTransactionBuilder.createAtaIdempotentInstruction(
      buyer,
      ata,
      buyer,
      mint,
      TOKEN_2022_PROGRAM_ID
    );

    expect(ix.keys.some((k) => k.pubkey.equals(TOKEN_2022_PROGRAM_ID))).toBe(true);
  });
});
