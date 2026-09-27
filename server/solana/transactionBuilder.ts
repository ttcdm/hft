import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
  Connection,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import BN from 'bn.js';
import { PumpSdk } from '@pump-fun/pump-sdk';
import { createCloseAccountInstruction } from '@solana/spl-token';
import {
  PUMP_FUN_PROGRAM_ID,
  PUMP_FUN_FEE_RECIPIENT,
  PUMP_FUN_GLOBAL_ACCOUNT,
  PUMP_FUN_EVENT_AUTHORITY,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
} from './programs';

export interface PumpBuyParams {
  buyer: PublicKey;
  mint: PublicKey;
  bondingCurve: PublicKey;
  associatedBondingCurve: PublicKey;
  associatedUser: PublicKey;
  creator: PublicKey;
  feeRecipient?: PublicKey;
  buybackFeeRecipient?: PublicKey;
  quoteMint?: PublicKey;
  tokenProgram?: PublicKey;
  quoteTokenProgram?: PublicKey;
  amountTokens: bigint;
  maxSolCostLamports: bigint;
  computeUnits?: number;
  priorityFeeMicroLamports?: number;
  jitoTipLamports?: bigint;
  jitoTipAccount?: PublicKey;
}

export interface PumpSellParams {
  seller: PublicKey;
  mint: PublicKey;
  bondingCurve: PublicKey;
  associatedBondingCurve: PublicKey;
  associatedUser: PublicKey;
  creator: PublicKey;
  feeRecipient?: PublicKey;
  buybackFeeRecipient?: PublicKey;
  quoteMint?: PublicKey;
  tokenProgram?: PublicKey;
  quoteTokenProgram?: PublicKey;
  amountTokens: bigint;
  minSolOutputLamports: bigint;
  computeUnits?: number;
  priorityFeeMicroLamports?: number;
  jitoTipLamports?: bigint;
  jitoTipAccount?: PublicKey;
  closeAta?: boolean;
}

export class SolanaTransactionBuilder {
  private cachedBlockhash: { blockhash: string; lastValidBlockHeight: number; timestamp: number } | null = null;
  private readonly BLOCKHASH_MAX_AGE_MS = 25000; // 25s for fast Solana slot time

  public static getAssociatedTokenAddress(
    mint: PublicKey,
    owner: PublicKey,
    tokenProgramId: PublicKey = TOKEN_PROGRAM_ID
  ): PublicKey {
    const [address] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    return address;
  }

  public static getBondingCurveAddress(mint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mint.toBuffer()],
      PUMP_FUN_PROGRAM_ID
    );
  }

  public async getRecentBlockhash(connection: Connection, forceFresh = false): Promise<string> {
    const now = Date.now();
    if (!forceFresh && this.cachedBlockhash && now - this.cachedBlockhash.timestamp < this.BLOCKHASH_MAX_AGE_MS) {
      return this.cachedBlockhash.blockhash;
    }

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    this.cachedBlockhash = { blockhash, lastValidBlockHeight, timestamp: now };
    return blockhash;
  }

  public static createAtaIdempotentInstruction(
    payer: PublicKey,
    associatedToken: PublicKey,
    owner: PublicKey,
    mint: PublicKey,
    tokenProgramId: PublicKey = TOKEN_PROGRAM_ID
  ): TransactionInstruction {
    const keys = [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    ];
    return new TransactionInstruction({
      keys,
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      data: Buffer.from([1]), // CreateIdempotent
    });
  }

  public static createComputeBudgetInstructions(
    units: number = 200000,
    microLamports: number = 50000
  ): TransactionInstruction[] {
    const ixs: TransactionInstruction[] = [];

    // Set Compute Unit Limit (0x02 + u32 units)
    const limitData = Buffer.alloc(5);
    limitData.writeUInt8(2, 0);
    limitData.writeUInt32LE(units, 1);
    ixs.push(new TransactionInstruction({
      programId: COMPUTE_BUDGET_PROGRAM_ID,
      keys: [],
      data: limitData,
    }));

    // Set Compute Unit Price (0x03 + u64 microLamports)
    if (microLamports > 0) {
      const priceData = Buffer.alloc(9);
      priceData.writeUInt8(3, 0);
      priceData.writeBigUInt64LE(BigInt(microLamports), 1);
      ixs.push(new TransactionInstruction({
        programId: COMPUTE_BUDGET_PROGRAM_ID,
        keys: [],
        data: priceData,
      }));
    }

    return ixs;
  }

  private static pumpSdkInstance: any = null;
  public static getPumpSdk(): any {
    if (!SolanaTransactionBuilder.pumpSdkInstance) {
      SolanaTransactionBuilder.pumpSdkInstance = new PumpSdk();
    }
    return SolanaTransactionBuilder.pumpSdkInstance;
  }

  // Official Pump.fun V2 Buy instruction via @pump-fun/pump-sdk (27 accounts, discriminator: b817ee6167c5d33d)
  public static async createPumpBuyV2Instruction(params: PumpBuyParams): Promise<TransactionInstruction> {
    if (!params.creator || params.creator.equals(PublicKey.default)) {
      throw new Error(
        `PUMP_V2_CREATOR_REQUIRED: Cannot construct Pump V2 buy instruction without authoritative bonding curve creator. Rejecting trade.`
      );
    }
    const sdk = SolanaTransactionBuilder.getPumpSdk();
    const tokenProgram = params.tokenProgram || TOKEN_PROGRAM_ID;
    const quoteTokenProgram = params.quoteTokenProgram || TOKEN_PROGRAM_ID;
    const quoteMint = params.quoteMint || new PublicKey('So11111111111111111111111111111111111111112');
    const feeRecipient = params.feeRecipient;
    const buybackFeeRecipient = params.buybackFeeRecipient;
    if (!feeRecipient || feeRecipient.equals(PublicKey.default)) {
      throw new Error('PUMP_V2_FEE_RECIPIENT_REQUIRED: Valid non-default feeRecipient is strictly required for Pump V2');
    }
    if (!buybackFeeRecipient || buybackFeeRecipient.equals(PublicKey.default)) {
      throw new Error('PUMP_V2_BUYBACK_RECIPIENT_REQUIRED: Valid non-default buybackFeeRecipient is strictly required for Pump V2');
    }
    if (feeRecipient.equals(buybackFeeRecipient)) {
      throw new Error(
        `FEE_RECIPIENT_COLLISION: feeRecipient (${feeRecipient.toBase58()}) and buybackFeeRecipient (${buybackFeeRecipient.toBase58()}) must be distinct accounts`
      );
    }

    const ix = await sdk.getBuyV2InstructionRaw({
      user: params.buyer,
      mint: params.mint,
      creator: params.creator,
      amount: new BN(params.amountTokens.toString()),
      quoteAmount: new BN(params.maxSolCostLamports.toString()),
      tokenProgram,
      quoteMint,
      quoteTokenProgram,
      feeRecipient,
      buybackFeeRecipient,
    });
    if (ix.keys.length !== 27) {
      throw new Error(`PUMP_V2_BUY_KEYS_MISMATCH: Expected 27 keys, got ${ix.keys.length}`);
    }
    return ix;
  }

  // Official Pump.fun V2 Sell instruction via @pump-fun/pump-sdk (26 accounts, discriminator: 5df6823ce7e940b2)
  public static async createPumpSellV2Instruction(params: PumpSellParams): Promise<TransactionInstruction> {
    if (!params.creator || params.creator.equals(PublicKey.default)) {
      throw new Error(
        `PUMP_V2_CREATOR_REQUIRED: Cannot construct Pump V2 sell instruction without authoritative bonding curve creator. Rejecting trade.`
      );
    }
    const sdk = SolanaTransactionBuilder.getPumpSdk();
    const tokenProgram = params.tokenProgram || TOKEN_PROGRAM_ID;
    const quoteTokenProgram = params.quoteTokenProgram || TOKEN_PROGRAM_ID;
    const quoteMint = params.quoteMint || new PublicKey('So11111111111111111111111111111111111111112');
    const feeRecipient = params.feeRecipient;
    const buybackFeeRecipient = params.buybackFeeRecipient;

    if (!feeRecipient || feeRecipient.equals(PublicKey.default)) {
      throw new Error('PUMP_V2_FEE_RECIPIENT_REQUIRED: Valid non-default feeRecipient is strictly required for Pump V2');
    }
    if (!buybackFeeRecipient || buybackFeeRecipient.equals(PublicKey.default)) {
      throw new Error('PUMP_V2_BUYBACK_RECIPIENT_REQUIRED: Valid non-default buybackFeeRecipient is strictly required for Pump V2');
    }
    if (feeRecipient.equals(buybackFeeRecipient)) {
      throw new Error(
        `FEE_RECIPIENT_COLLISION: feeRecipient (${feeRecipient.toBase58()}) and buybackFeeRecipient (${buybackFeeRecipient.toBase58()}) must be distinct accounts`
      );
    }

    const ix = await sdk.getSellV2InstructionRaw({
      user: params.seller,
      mint: params.mint,
      creator: params.creator,
      amount: new BN(params.amountTokens.toString()),
      quoteAmount: new BN(params.minSolOutputLamports.toString()),
      tokenProgram,
      quoteMint,
      quoteTokenProgram,
      feeRecipient,
      buybackFeeRecipient,
    });
    if (ix.keys.length !== 26) {
      throw new Error(`PUMP_V2_SELL_KEYS_MISMATCH: Expected 26 keys, got ${ix.keys.length}`);
    }
    return ix;
  }

  // Anchor instruction discriminator for Pump.fun legacy "global:buy" (kept for backward compatibility reference)
  public static createPumpBuyInstruction(params: PumpBuyParams): TransactionInstruction {
    const data = Buffer.alloc(8 + 8 + 8);
    const discriminator = Buffer.from('66063d1201daebea', 'hex');
    discriminator.copy(data, 0);
    data.writeBigUInt64LE(params.amountTokens, 8);
    data.writeBigUInt64LE(params.maxSolCostLamports, 16);

    const tokenProgram = params.tokenProgram || TOKEN_PROGRAM_ID;

    const keys = [
      { pubkey: PUMP_FUN_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: params.bondingCurve, isSigner: false, isWritable: true },
      { pubkey: params.associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: params.associatedUser, isSigner: false, isWritable: true },
      { pubkey: params.buyer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    return new TransactionInstruction({
      programId: PUMP_FUN_PROGRAM_ID,
      keys,
      data,
    });
  }

  // Anchor instruction discriminator for Pump.fun "global:sell" = [0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]
  public static createPumpSellInstruction(params: PumpSellParams): TransactionInstruction {
    const data = Buffer.alloc(8 + 8 + 8);
    const discriminator = Buffer.from('33e685a4017f83ad', 'hex');
    discriminator.copy(data, 0);
    data.writeBigUInt64LE(params.amountTokens, 8);
    data.writeBigUInt64LE(params.minSolOutputLamports, 16);

    const tokenProgram = params.tokenProgram || TOKEN_PROGRAM_ID;

    const keys = [
      { pubkey: PUMP_FUN_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: params.bondingCurve, isSigner: false, isWritable: true },
      { pubkey: params.associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: params.associatedUser, isSigner: false, isWritable: true },
      { pubkey: params.seller, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    return new TransactionInstruction({
      programId: PUMP_FUN_PROGRAM_ID,
      keys,
      data,
    });
  }

  public async buildBuyTransaction(
    connection: Connection,
    params: PumpBuyParams
  ): Promise<VersionedTransaction> {
    const instructions: TransactionInstruction[] = [];
    const tokenProgram = params.tokenProgram || TOKEN_PROGRAM_ID;

    // 1. Compute limits & Priority fees
    instructions.push(
      ...SolanaTransactionBuilder.createComputeBudgetInstructions(
        params.computeUnits || 250000,
        params.priorityFeeMicroLamports || 50000
      )
    );

    // 2. ATA Idempotent Creation with appropriate token program
    instructions.push(
      SolanaTransactionBuilder.createAtaIdempotentInstruction(
        params.buyer,
        params.associatedUser,
        params.buyer,
        params.mint,
        tokenProgram
      )
    );

    // 3. Official Pump V2 Buy (27 accounts, b817ee6167c5d33d)
    const pumpBuyIx = await SolanaTransactionBuilder.createPumpBuyV2Instruction(params);
    instructions.push(pumpBuyIx);

    // 4. Jito Tip Transfer if specified
    if (params.jitoTipLamports && params.jitoTipLamports > 0n && params.jitoTipAccount) {
      instructions.push(
        SystemProgram.transfer({
          fromPubkey: params.buyer,
          toPubkey: params.jitoTipAccount,
          lamports: Number(params.jitoTipLamports),
        })
      );
    }

    const recentBlockhash = await this.getRecentBlockhash(connection);

    const messageV0 = new TransactionMessage({
      payerKey: params.buyer,
      recentBlockhash,
      instructions,
    }).compileToV0Message();

    return new VersionedTransaction(messageV0);
  }

  public async buildSellTransaction(
    connection: Connection,
    params: PumpSellParams,
    closeAta?: boolean
  ): Promise<VersionedTransaction> {
    const instructions: TransactionInstruction[] = [];

    instructions.push(
      ...SolanaTransactionBuilder.createComputeBudgetInstructions(
        params.computeUnits || 200000,
        params.priorityFeeMicroLamports || 50000
      )
    );

    // 2. Official Pump V2 Sell (26 accounts, 5df6823ce7e940b2)
    const pumpSellIx = await SolanaTransactionBuilder.createPumpSellV2Instruction(params);
    instructions.push(pumpSellIx);

    // B06: Reclaim ATA Rent on Exits (100% position exits)
    const shouldCloseAta = closeAta !== undefined ? closeAta : !!params.closeAta;
    if (shouldCloseAta) {
      const tokenProgramId = params.tokenProgram || TOKEN_PROGRAM_ID;
      instructions.push(
        createCloseAccountInstruction(
          params.associatedUser,
          params.seller,
          params.seller,
          [],
          tokenProgramId
        )
      );
    }

    if (params.jitoTipLamports && params.jitoTipLamports > 0n && params.jitoTipAccount) {
      instructions.push(
        SystemProgram.transfer({
          fromPubkey: params.seller,
          toPubkey: params.jitoTipAccount,
          lamports: Number(params.jitoTipLamports),
        })
      );
    }

    const recentBlockhash = await this.getRecentBlockhash(connection);

    const messageV0 = new TransactionMessage({
      payerKey: params.seller,
      recentBlockhash,
      instructions,
    }).compileToV0Message();

    return new VersionedTransaction(messageV0);
  }

  public async buildCustomVersionedTransaction(
    connection: Connection,
    payer: PublicKey,
    instructions: TransactionInstruction[]
  ): Promise<VersionedTransaction> {
    const recentBlockhash = await this.getRecentBlockhash(connection);
    const messageV0 = new TransactionMessage({
      payerKey: payer,
      recentBlockhash,
      instructions,
    }).compileToV0Message();

    return new VersionedTransaction(messageV0);
  }
}

export const txBuilder = new SolanaTransactionBuilder();
