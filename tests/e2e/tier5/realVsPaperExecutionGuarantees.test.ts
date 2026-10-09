import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js';
import * as crypto from 'crypto';
import bs58 from 'bs58';
import { ExecutionCoordinator } from '../../../server/execution/coordinator';
import { LocalKeypairSigner, localSigner } from '../../../server/solana/signer';
import { PumpCurveService } from '../../../server/solana/pumpCurve';
import { SolanaTransactionBuilder, txBuilder } from '../../../server/solana/transactionBuilder';
import { PUMP_FUN_PROGRAM_ID } from '../../../server/solana/programs';
import { executionConfig } from '../../../server/solana/executionConfig';
import { workstationDb, WorkstationDatabase } from '../../../server/db/database';
import {
  createSimulatedBondingCurveState,
  VALID_PUMP_MINT_1,
  DUMMY_FEE_RECIPIENT,
  DUMMY_BUYBACK_FEE_RECIPIENT,
} from '../helpers/simulatedStates';
import { MockSolanaRpc } from '../helpers/mockRpc';
import { MockJitoEngine } from '../helpers/mockJito';
import { TestDatabase } from '../helpers/testDb';

// RFC 8410: id-Ed25519 SPKI public key DER prefix (12 bytes)
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function verifyEd25519Signature(message: Buffer | Uint8Array, signature: Buffer | Uint8Array, publicKeyBytes: Buffer | Uint8Array): boolean {
  try {
    const spkiDer = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyBytes)]);
    const keyObj = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(message), keyObj, Buffer.from(signature));
  } catch {
    return false;
  }
}

function mockPassingLiveReadiness(coord: ExecutionCoordinator, liveKeypair: Keypair) {
  vi.spyOn(coord, 'canExecuteLive').mockReturnValue({
    allowed: true,
    reasons: [],
    readiness: {
      ready: true,
      score: 100,
      reasons: [],
      components: {
        signer: { ready: true, status: 'READY', address: liveKeypair.publicKey.toBase58() },
        bankroll: { ready: true, balanceSol: 1.5, spendableSol: 1.485, reserveRequiredSol: 0.015 },
        database: { ready: true, writable: true },
        startupReconciliation: { ready: true, status: 'EXECUTION_READY', details: 'All clear' },
        solanaRpc: { ready: true, health: 'HEALTHY', latencyMs: 1 },
        pumpFeed: { ready: true, status: 'HEALTHY', lastEventSecAgo: 1 },
        positionMarks: { ready: true, status: 'HEALTHY', lastMarkSecAgo: 1 },
        killSwitch: { ready: true, active: false },
        circuitBreaker: { ready: true, state: 'CLOSED' },
        jitoTransport: { ready: true, health: 'HEALTHY' },
        realMarketData: { ready: true, lastEventSecAgo: 1 },
      },
    } as any,
  });
}

describe('Tier 5: Production Readiness — Real vs Paper Execution Guarantees (Zero-Emulation Invariants)', () => {
  let mockRpc: MockSolanaRpc;
  let mockJito: MockJitoEngine;
  let testDb: TestDatabase;
  let coordinator: ExecutionCoordinator;
  let liveTradingKeypair: Keypair;

  beforeEach(async () => {
    // Generate real Ed25519 keypair for signer
    liveTradingKeypair = Keypair.generate();

    mockRpc = new MockSolanaRpc();
    mockJito = new MockJitoEngine();
    await mockJito.start();
    testDb = new TestDatabase();

    // Configure signer mock hermetically
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(liveTradingKeypair.publicKey);
    vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: VersionedTransaction) => {
      tx.sign([liveTradingKeypair]);
      return tx;
    });

    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
    vi.spyOn(coordinator, 'syncRealWalletBalance').mockResolvedValue(1.5);
    (coordinator as any).realWalletBalanceSol = 1.5;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.ALLOW_LIVE_REAL_MONEY_TRADING;
    await mockJito.stop();
    testDb.close();
    mockRpc.clear();
  });

  // =========================================================================
  // 1. Arming Policy & Fail-Closed Pre-Execution Gates
  // =========================================================================
  describe('Arming Policy & Fail-Closed Pre-Execution Gates', () => {
    it('RPG-1: LIVE mode execution fails closed if live trading is not armed', async () => {
      expect(coordinator.isLiveArmed()).toBe(false);
      expect(coordinator.getExecutionMode()).toBe('PAPER');

      // Attempting to execute in LIVE mode without arming
      (coordinator as any).executionMode = 'LIVE';
      const result = await coordinator.executeTrade({
        signalTimestamp: Date.now(),
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'TEST1',
        name: 'Test Token 1',
        amountSol: 0.005,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
      });

      expect(result.success).toBe(false);
      expect(result.lifecycleState).toBe('SIGN_FAILED');
      expect(result.error).toMatch(/Live trading is not armed or signer is unavailable/);
    });

    it('RPG-2: LIVE mode execution fails closed if signer is not READY', async () => {
      process.env.ALLOW_LIVE_REAL_MONEY_TRADING = 'true';
      vi.spyOn(localSigner, 'getStatus').mockReturnValue('NOT_CONFIGURED');

      const armResult = coordinator.armLiveTrading(true, 'CONFIRM_LIVE_TRADING_RISK');
      expect(armResult.success).toBe(false);
      expect(armResult.message).toMatch(/Prerequisites failed/);
      expect(coordinator.isLiveArmed()).toBe(false);
    });
  });

  // =========================================================================
  // 2. Market Data Truthfulness & Fallback Prohibition in LIVE Mode
  // =========================================================================
  describe('Market Data Truthfulness & Fallback Prohibition in LIVE Mode', () => {
    it('RPG-3: LIVE mode strictly disallows synthetic pricing: fails closed if on-chain bonding curve RPC fails', async () => {
      process.env.ALLOW_LIVE_REAL_MONEY_TRADING = 'true';
      mockPassingLiveReadiness(coordinator, liveTradingKeypair);
      coordinator.armLiveTrading(true, 'CONFIRM_LIVE_TRADING_RISK');
      expect(coordinator.isLiveArmed()).toBe(true);

      // On-chain RPC returns null (cannot fetch curve state)
      vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(null);

      const result = await coordinator.executeTrade({
        signalTimestamp: Date.now(),
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'TEST1',
        name: 'Test Token 1',
        amountSol: 0.005,
        currentPriceSol: 0.0001, // Caller suggests price, but coordinator MUST query on-chain
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
      });

      expect(result.success).toBe(false);
      expect(result.lifecycleState).toBe('RISK_REJECTED');
      expect(result.error).toMatch(/MARKET_DATA_UNAVAILABLE: Could not fetch real Pump\.fun bonding curve/);
    });

    it('RPG-4: PAPER mode permits documented fallback pricing when dynamic market state is unavailable', async () => {
      expect(coordinator.getExecutionMode()).toBe('PAPER');

      // In PAPER mode, an explicit currentPriceSol can be used for simulation
      const result = await coordinator.executeTrade({
        signalTimestamp: Date.now(),
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'TEST1',
        name: 'Test Token 1',
        amountSol: 0.005,
        currentPriceSol: 0.0001,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
      });

      expect(result.success).toBe(true);
      expect(result.executionMode).toBe('PAPER');
      expect(result.fillPriceSol).toBeGreaterThan(0);
    });

    it('RPG-5: LIVE quotes strictly require feeComputationStatus === VERIFIED', () => {
      const baseState = createSimulatedBondingCurveState({ feeComputationStatus: 'UNAVAILABLE' });

      // In LIVE mode, unverified fee computation throws immediately
      expect(() => {
        PumpCurveService.calculateBuyQuote({
          state: baseState,
          amountSol: 0.01,
          executionMode: 'LIVE',
        });
      }).toThrow(/DYNAMIC_FEE_CALCULATION_FAILED/);

      // In PAPER mode, fallback fee is permitted
      const paperQuote = PumpCurveService.calculateBuyQuote({
        state: baseState,
        amountSol: 0.01,
        executionMode: 'PAPER',
      });
      expect(paperQuote).toBeDefined();
      expect(paperQuote.protocolFeeLamports).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 3. Signal Provenance Enforcement (No Synthetic Leaks to LIVE)
  // =========================================================================
  describe('Signal Provenance Enforcement (No Synthetic Leaks to LIVE)', () => {
    beforeEach(() => {
      process.env.ALLOW_LIVE_REAL_MONEY_TRADING = 'true';
      mockPassingLiveReadiness(coordinator, liveTradingKeypair);
      coordinator.armLiveTrading(true, 'CONFIRM_LIVE_TRADING_RISK');
    });

    it('RPG-6: rejects SYNTHETIC provenance signals in LIVE mode with PROVENANCE_VIOLATION', async () => {
      const result = await coordinator.executeTrade({
        signalTimestamp: Date.now(),
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'TEST1',
        name: 'Test Token 1',
        amountSol: 0.005,
        source: 'AUTO_SNIPER',
        provenance: 'SYNTHETIC' as any,
      });

      expect(result.success).toBe(false);
      expect(result.lifecycleState).toBe('RISK_REJECTED');
      expect(result.error).toMatch(/PROVENANCE_VIOLATION/);
    });

    it('RPG-7: rejects BACKTEST provenance signals in LIVE mode with PROVENANCE_VIOLATION', async () => {
      const result = await coordinator.executeTrade({
        signalTimestamp: Date.now(),
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'TEST1',
        name: 'Test Token 1',
        amountSol: 0.005,
        source: 'AUTO_SNIPER',
        provenance: 'BACKTEST' as any,
      });

      expect(result.success).toBe(false);
      expect(result.lifecycleState).toBe('RISK_REJECTED');
      expect(result.error).toMatch(/PROVENANCE_VIOLATION/);
    });

    it('RPG-8: accepts approved real provenances in LIVE mode', async () => {
      const mockState = createSimulatedBondingCurveState();
      vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(mockState);

      const approvedProvenances = ['LIVE_PUMP_STREAM', 'REAL_ONCHAIN', 'REAL_SOCIAL', 'COPY_TRADE', 'MANUAL_OPERATOR'] as const;

      for (const prov of approvedProvenances) {
        // Will pass provenance check (may fail later on mock rpc/reconciliation, but NOT on provenance)
        const result = await coordinator.executeTrade({
          signalTimestamp: Date.now(),
          mint: VALID_PUMP_MINT_1.toBase58(),
          symbol: 'TEST1',
          name: 'Test Token 1',
          amountSol: 0.005,
          source: 'AUTO_SNIPER',
          provenance: prov,
        });

        expect(result.error).not.toMatch(/PROVENANCE_VIOLATION/);
      }
    });
  });

  // =========================================================================
  // 4. Real Instruction Structure & Cryptographic Signing (Zero Mock Lambdas)
  // =========================================================================
  describe('Real Instruction Structure & Cryptographic Signing (Zero Mock Lambdas)', () => {
    const buyer = Keypair.generate().publicKey;
    const creator = Keypair.generate().publicKey;
    const mint = VALID_PUMP_MINT_1;
    const [bondingCurve] = SolanaTransactionBuilder.getBondingCurveAddress(mint);
    const associatedBondingCurve = SolanaTransactionBuilder.getAssociatedTokenAddress(mint, bondingCurve);
    const associatedUser = SolanaTransactionBuilder.getAssociatedTokenAddress(mint, buyer);

    it('RPG-9: LIVE buy transaction constructs official Pump V2 27-account instruction and Anchor discriminator', async () => {
      const buyIx = await SolanaTransactionBuilder.createPumpBuyV2Instruction({
        buyer,
        mint,
        bondingCurve,
        associatedBondingCurve,
        associatedUser,
        creator,
        feeRecipient: DUMMY_FEE_RECIPIENT,
        buybackFeeRecipient: DUMMY_BUYBACK_FEE_RECIPIENT,
        amountTokens: 1_000_000_000n,
        maxSolCostLamports: 10_000_000n,
      });

      expect(buyIx.programId.equals(PUMP_FUN_PROGRAM_ID)).toBe(true);
      expect(buyIx.keys.length).toBe(27);

      // Official PumpSdk buy_v2 8-byte discriminator: b817ee6167c5d33d
      const discriminatorHex = buyIx.data.subarray(0, 8).toString('hex');
      expect(discriminatorHex).toBe('b817ee6167c5d33d');
    });

    it('RPG-10: LIVE sell transaction constructs official Pump V2 26-account instruction and Anchor discriminator', async () => {
      const sellIx = await SolanaTransactionBuilder.createPumpSellV2Instruction({
        seller: buyer,
        mint,
        bondingCurve,
        associatedBondingCurve,
        associatedUser,
        creator,
        feeRecipient: DUMMY_FEE_RECIPIENT,
        buybackFeeRecipient: DUMMY_BUYBACK_FEE_RECIPIENT,
        amountTokens: 500_000_000n,
        minSolOutputLamports: 4_500_000n,
      });

      expect(sellIx.programId.equals(PUMP_FUN_PROGRAM_ID)).toBe(true);
      expect(sellIx.keys.length).toBe(26);

      // Official PumpSdk sell_v2 8-byte discriminator: 5df6823ce7e940b2
      const discriminatorHex = sellIx.data.subarray(0, 8).toString('hex');
      expect(discriminatorHex).toBe('5df6823ce7e940b2');
    });

    it('RPG-11: txBuilder compiles full VersionedTransaction with Ed25519 signature', async () => {
      const v0Tx = await txBuilder.buildBuyTransaction(mockRpc.createConnection(), {
        buyer: liveTradingKeypair.publicKey,
        mint,
        bondingCurve,
        associatedBondingCurve,
        associatedUser,
        creator,
        feeRecipient: DUMMY_FEE_RECIPIENT,
        buybackFeeRecipient: DUMMY_BUYBACK_FEE_RECIPIENT,
        amountTokens: 1_000_000_000n,
        maxSolCostLamports: 10_000_000n,
        jitoTipLamports: 150_000n,
        jitoTipAccount: executionConfig.getJitoTipAccountPublicKey(),
      });

      expect(v0Tx).toBeInstanceOf(VersionedTransaction);

      // Sign transaction with real keypair
      v0Tx.sign([liveTradingKeypair]);
      expect(v0Tx.signatures[0].length).toBe(64);

      // Cryptographically verify signature against serialized message
      const msgBytes = v0Tx.message.serialize();
      const isValid = verifyEd25519Signature(
        msgBytes,
        v0Tx.signatures[0],
        liveTradingKeypair.publicKey.toBytes()
      );
      expect(isValid).toBe(true);
    });
  });

  // =========================================================================
  // 5. Position Mark Price Isolation (Zero Synthetic Price Pollution)
  // =========================================================================
  describe('Position Mark Price Isolation (Zero Synthetic Price Pollution)', () => {
    it('RPG-12: updatePositionMarkPrices strictly ignores synthetic price map for LIVE positions', async () => {
      const livePosId = `live_pos_${Date.now()}`;
      const paperPosId = `paper_pos_${Date.now()}`;

      // Insert both a LIVE and PAPER position
      workstationDb.savePosition({
        id: livePosId,
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'LIVECOIN',
        name: 'Live Token',
        tokenDecimals: 6,
        baseTokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        entryPriceSol: 0.0001,
        currentPriceSol: 0.0001,
        tokenQuantityRaw: '1000000000',
        costBasisLamports: 100_000_000,
        realizedPnLSol: 0,
        status: 'OPEN',
        venue: 'PUMP_BONDING_CURVE',
        executionMode: 'LIVE',
        entryTxSignature: 'sig_live_1',
        entryTimestamp: Date.now(),
        recordUpdatedAt: Date.now(),
        updatedAt: Date.now(),
      });

      workstationDb.savePosition({
        id: paperPosId,
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'PAPERCOIN',
        name: 'Paper Token',
        tokenDecimals: 6,
        baseTokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        entryPriceSol: 0.0001,
        currentPriceSol: 0.0001,
        tokenQuantityRaw: '1000000000',
        costBasisLamports: 100_000_000,
        realizedPnLSol: 0,
        status: 'OPEN',
        venue: 'PUMP_BONDING_CURVE',
        executionMode: 'PAPER',
        entryTxSignature: 'sig_paper_1',
        entryTimestamp: Date.now(),
        recordUpdatedAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Provide synthetic price map with a 10x pumped price
      const syntheticMap = {
        [VALID_PUMP_MINT_1.toBase58()]: {
          priceSol: 0.0010,
          source: 'SYNTHETIC_MARKET_FEED',
        },
      };

      await coordinator.updatePositionMarkPrices(syntheticMap);

      const positions = workstationDb.loadPositions();
      const livePos = positions.find((p) => p.id === livePosId)!;
      const paperPos = positions.find((p) => p.id === paperPosId)!;

      // Invariant: PAPER position receives the synthetic mark
      expect(paperPos.currentPriceSol).toBe(0.0010);
      expect(paperPos.markSource).toBe('SYNTHETIC_MARKET_FEED');

      // Invariant: LIVE position NEVER accepts synthetic mark
      expect(livePos.currentPriceSol).toBe(0.0001);
      expect(livePos.markSource).not.toBe('SYNTHETIC_MARKET_FEED');
    });

    it('RPG-13: database maintains strict isolation between LIVE and PAPER records', () => {
      const livePositions = workstationDb.loadPositions('LIVE');
      const paperPositions = workstationDb.loadPositions('PAPER');

      for (const lp of livePositions) {
        expect(lp.executionMode).toBe('LIVE');
      }
      for (const pp of paperPositions) {
        expect(pp.executionMode).toBe('PAPER');
      }
    });
  });
});
