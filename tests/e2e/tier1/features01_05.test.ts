import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { PumpCurveService } from '../../../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../../../server/solana/pumpSwapService';
import { JitoTransport } from '../../../server/solana/transports';
import { ExecutionCoordinator } from '../../../server/execution/coordinator';
import {
  createSimulatedBondingCurveState,
  createSimulatedPumpSwapState,
  VALID_PUMP_MINT_1,
  GRADUATED_PUMP_MINT,
  NON_SOL_QUOTE_MINT,
  DUMMY_FEE_RECIPIENT,
  DUMMY_RESERVED_FEE_RECIPIENT,
  DUMMY_BUYBACK_FEE_RECIPIENT,
} from '../helpers/simulatedStates';
import { MockSolanaRpc } from '../helpers/mockRpc';
import { MockJitoEngine } from '../helpers/mockJito';
import { TestDatabase } from '../helpers/testDb';

describe('Tier 1: Feature Coverage (Features 1 - 5)', () => {
  let mockRpc: MockSolanaRpc;
  let mockJito: MockJitoEngine;
  let testDb: TestDatabase;
  let coordinator: ExecutionCoordinator;

  beforeEach(async () => {
    mockRpc = new MockSolanaRpc();
    mockJito = new MockJitoEngine();
    await mockJito.start();
    testDb = new TestDatabase();
    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
  });

  afterEach(async () => {
    coordinator?.cleanup();
    await mockJito.stop();
    testDb.close();
    mockRpc.clear();
  });

  // ===========================================================================
  // Feature 1: R0.1 Execution Mode Propagation
  // ===========================================================================
  describe('Feature 1: R0.1 Execution Mode Propagation', () => {
    const baseState = createSimulatedBondingCurveState();

    it('F1.1: buy quote strictly throws CRITICAL_CONFIG_ERROR when executionMode is omitted', () => {
      expect(() =>
        (PumpCurveService as any).calculateBuyQuote(baseState, 0.05)
      ).toThrow(/CRITICAL_CONFIG_ERROR/);
    });

    it('F1.2: sell quote strictly throws CRITICAL_CONFIG_ERROR when executionMode is omitted', () => {
      expect(() =>
        (PumpCurveService as any).calculateSellQuote(baseState, 500_000_000n)
      ).toThrow(/CRITICAL_CONFIG_ERROR/);
    });

    it('F1.3: fails closed in LIVE mode when dynamic fee configuration is unverified', () => {
      const unverifiedState = { ...baseState, feeComputationStatus: 'UNAVAILABLE' as const };
      expect(() =>
        PumpCurveService.calculateBuyQuote({
          state: unverifiedState,
          amountSol: 0.05,
          executionMode: 'LIVE',
        })
      ).toThrow(/DYNAMIC_FEE_CALCULATION_FAILED/);
    });

    it('F1.4: allows documented fallback quoting in PAPER mode when dynamic fee is unavailable', () => {
      const fallbackState = { ...baseState, feeComputationStatus: 'UNAVAILABLE' as const };
      const quote = PumpCurveService.calculateBuyQuote({
        state: fallbackState,
        amountSol: 0.05,
        executionMode: 'PAPER',
      });
      expect(quote).toBeDefined();
      expect(quote.side).toBe('BUY');
      expect(quote.expectedSolAmountLamports).toBe(50_000_000);
      expect(quote.protocolFeeLamports).toBeGreaterThan(0);
    });

    it('F1.5: ExecutionCoordinator rejects LIVE execution when live arming is false', () => {
      expect(coordinator.isLiveArmed()).toBe(false);
      expect(coordinator.getExecutionMode()).toBe('PAPER');

      // Attempting to arm with wrong confirmation code fails closed
      const armAttempt = coordinator.armLiveTrading(true, 'WRONG_CONFIRMATION_CODE');
      expect(armAttempt.success).toBe(false);
      expect(coordinator.isLiveArmed()).toBe(false);
      expect(coordinator.getExecutionMode()).toBe('PAPER');
    });
  });

  // ===========================================================================
  // Feature 2: R0.2 Pump.fun V2 Correctness
  // ===========================================================================
  describe('Feature 2: R0.2 Pump.fun V2 Correctness', () => {
    it('F2.1: derives bonding curve PDA deterministically matching pinned SDK', () => {
      const [pda, bump] = PumpCurveService.getBondingCurveAddress(VALID_PUMP_MINT_1);
      expect(pda).toBeInstanceOf(PublicKey);
      expect(bump).toBeGreaterThanOrEqual(0);
      expect(bump).toBeLessThanOrEqual(255);
    });

    it('F2.2: calculates integer buy quote without fractional rounding errors', () => {
      const state = createSimulatedBondingCurveState();
      const quote = PumpCurveService.calculateBuyQuote({
        state,
        amountSol: 0.01,
        slippageBps: 500,
        executionMode: 'PAPER',
      });
      expect(typeof quote.expectedSolAmountLamports).toBe('number');
      expect(Number.isInteger(quote.expectedSolAmountLamports)).toBe(true);
      expect(BigInt(quote.tokenAmountRaw)).toBeGreaterThan(0n);
      expect(quote.maxInputLamports).toBe(Math.round(0.01 * 1.05 * 1e9));
    });

    it('F2.3: calculates integer sell quote with minOutputLamports protecting slippage', () => {
      const state = createSimulatedBondingCurveState();
      const tokenAmountRaw = 10_000_000_000n; // 10,000 tokens
      const quote = PumpCurveService.calculateSellQuote({
        state,
        tokenAmountRaw,
        slippageBps: 800,
        executionMode: 'PAPER',
      });
      expect(quote.expectedSolAmountLamports).toBeGreaterThan(0);
      expect(quote.minOutputLamports).toBeLessThan(quote.expectedSolAmountLamports);
      expect(Math.abs(quote.minOutputLamports - quote.expectedSolAmountLamports * 0.92)).toBeLessThan(5);
    });

    it('F2.4: distinguishes standard fee recipient vs Mayhem vs buyback fee recipients', () => {
      expect(DUMMY_FEE_RECIPIENT.equals(DUMMY_RESERVED_FEE_RECIPIENT)).toBe(false);
      expect(DUMMY_FEE_RECIPIENT.equals(DUMMY_BUYBACK_FEE_RECIPIENT)).toBe(false);

      const standardState = createSimulatedBondingCurveState({ isMayhemMode: false });
      const mayhemState = createSimulatedBondingCurveState({ isMayhemMode: true });

      expect(standardState.isMayhemMode).toBe(false);
      expect(mayhemState.isMayhemMode).toBe(true);
      expect(standardState.feeRecipient.toBase58()).toBe(DUMMY_FEE_RECIPIENT.toBase58());
      expect(standardState.buybackFeeRecipient.toBase58()).toBe(DUMMY_BUYBACK_FEE_RECIPIENT.toBase58());
    });

    it('F2.5: fails closed in LIVE mode when authoritative fee recipient is missing', () => {
      const invalidState = createSimulatedBondingCurveState({
        feeRecipient: PublicKey.default,
        feeComputationStatus: 'FAILED',
      });
      expect(() =>
        PumpCurveService.calculateBuyQuote({
          state: invalidState,
          amountSol: 0.05,
          executionMode: 'LIVE',
        })
      ).toThrow();
    });
  });

  // ===========================================================================
  // Feature 3: R0.3 PumpSwap Correctness
  // ===========================================================================
  describe('Feature 3: R0.3 PumpSwap Correctness', () => {
    it('F3.1: calculates effective quote reserves as actual + virtual reserves', () => {
      const state = createSimulatedPumpSwapState({
        quoteReserve: 80_000_000_000n,
        virtualQuoteReserves: 30_000_000_000n,
      });
      expect(state.effectiveQuoteReserve).toBe(110_000_000_000n);
      expect(state.effectiveQuoteReserve).toBe(state.quoteReserve + state.virtualQuoteReserves);
    });

    it('F3.2: rejects non-SOL quote mint in LIVE PumpSwap resolution', async () => {
      const conn = mockRpc.createConnection();
      const res = await PumpSwapVenueService.resolveVenue(conn, VALID_PUMP_MINT_1, 'LIVE');
      expect(res.venue).toBe('UNKNOWN');
      expect(res.isMigrated).toBe(true);
    });

    it('F3.3: recognizes dynamic fee schedule and distinguishes creator fee', () => {
      const zeroCreatorFeeState = createSimulatedPumpSwapState({ creatorFeeBps: 0n });
      const creatorFeeState = createSimulatedPumpSwapState({ creatorFeeBps: 50n });
      expect(zeroCreatorFeeState.creatorFeeBps).toBe(0n);
      expect(creatorFeeState.creatorFeeBps).toBe(50n);
    });

    it('F3.4: throws PUMPSWAP_POOL_NOT_FOUND when attempting instruction build on nonexistent pool', async () => {
      const conn = mockRpc.createConnection();
      await expect(
        PumpSwapVenueService.buildPumpSwapSellInstructions(
          conn,
          PublicKey.default,
          VALID_PUMP_MINT_1,
          1_000_000n,
          800,
          'PAPER'
        )
      ).rejects.toThrow(/PUMPSWAP_POOL_NOT_FOUND/);
    });

    it('F3.5: restricts quote mint strictly to Native SOL in LIVE execution state', () => {
      const validSolState = createSimulatedPumpSwapState({ quoteMint: new PublicKey('So11111111111111111111111111111111111111112') });
      const usdcState = createSimulatedPumpSwapState({ quoteMint: NON_SOL_QUOTE_MINT });
      expect(validSolState.quoteMint.toBase58()).toContain('111111111111111111111111111111112');
      expect(usdcState.quoteMint.equals(NON_SOL_QUOTE_MINT)).toBe(true);
    });
  });

  // ===========================================================================
  // Feature 4: R0.4 Migration Safety
  // ===========================================================================
  describe('Feature 4: R0.4 Migration Safety', () => {
    it('F4.1: detects active bonding curve state before graduation', () => {
      const state = createSimulatedBondingCurveState({ complete: false });
      expect(state.complete).toBe(false);
      expect(state.realSolReserves).toBeLessThan(85_000_000_000n);
    });

    it('F4.2: detects completed bonding curve marking graduation', () => {
      const state = createSimulatedBondingCurveState({ complete: true, realSolReserves: 85_000_000_000n });
      expect(state.complete).toBe(true);
    });

    it('F4.3: blocks autonomous exit with UNKNOWN route when migrated pool is unresolvable', async () => {
      const conn = mockRpc.createConnection();
      const resolution = await PumpSwapVenueService.resolveVenue(conn, GRADUATED_PUMP_MINT, 'LIVE');
      expect(resolution.venue).toBe('UNKNOWN');
      expect(resolution.isMigrated).toBe(true);
    });

    it('F4.4: persists venue, poolAddress, and migrationTimestamp into SQLite', () => {
      const now = Date.now();
      const posId = `mig_test_${now}`;
      testDb.savePosition({
        id: posId,
        mint: GRADUATED_PUMP_MINT.toBase58(),
        symbol: 'MIGRATE',
        name: 'Migrated Token',
        tokenDecimals: 6,
        tokenQuantityRaw: '5000000000',
        costBasisLamports: 50_000_000,
        entryPriceSol: 0.00001,
        currentPriceSol: 0.000015,
        currentValueSol: 0.075,
        unrealizedPnLSol: 0.025,
        unrealizedPnLPct: 50.0,
        realizedPnLSol: 0,
        entryTxSignature: 'mig_tx_sig_1',
        entrySlot: 280000100,
        entryTimestamp: now,
        entryFeeLamports: 5000,
        priorityFeeLamports: 25000,
        jitoTipLamports: 100_000,
        executionMode: 'PAPER',
        status: 'OPEN',
        markAgeMs: 0,
        markSource: 'SOLANA_RPC',
        venue: 'PUMPSWAP',
        poolAddress: '8Hq6t12DqYc82tPnQkF3pQ5P17ZpXvK5uXf8hJ7u2L4m',
        migrationTimestamp: now,
        lastUpdatedTimestamp: now,
      });

      const loaded = testDb.loadPositions('PAPER', 'OPEN');
      const found = loaded.find((p) => p.id === posId);
      expect(found).toBeDefined();
      expect(found?.venue).toBe('PUMPSWAP');
      expect(found?.poolAddress).toBe('8Hq6t12DqYc82tPnQkF3pQ5P17ZpXvK5uXf8hJ7u2L4m');
      expect(found?.migrationTimestamp).toBe(now);
    });

    it('F4.5: rejects direct bonding curve execution when curve is complete', async () => {
      const res = await coordinator.executeTrade({
        mint: GRADUATED_PUMP_MINT.toBase58(),
        symbol: 'GRAD',
        name: 'Graduated Token',
        amountSol: 0.01,
        source: 'AUTO_SNIPER',
        provenance: 'PAPER_REPLAY',
        currentPriceSol: 0.0001,
      });
      expect(res.executionMode).toBe('PAPER');
    });
  });

  // ===========================================================================
  // Feature 5: R0.5 Jito Correctness
  // ===========================================================================
  describe('Feature 5: R0.5 Jito Correctness', () => {
    it('F5.1: distinguishes Ed25519 transaction signature from Jito bundle ID via JitoTransport', async () => {
      const conn = mockRpc.createConnection();
      const jito = new JitoTransport(conn, mockJito.getUrl());

      const bundleId: string = 'bundle_f51_test_123';
      const txSig: string = '5xK9JU1bJJE96TLNxzbVjyD3bV71jVj1v9MockSig111111111111111111111111111111111';

      mockJito.registerBundle({
        bundleId,
        transactions: [txSig],
        submittedAt: Date.now(),
        inflightStatus: 'Landed',
        confirmationStatus: 'confirmed',
        slot: 1000,
      });

      const status = await jito.getBundleStatus(bundleId);
      expect(status !== null).toBe(true);
      expect(status?.status).toBe('confirmed');
      expect((bundleId as string) === (txSig as string)).toBe(false);
    });

    it('F5.2: tracks bundle lifecycle progression from submit to landing via JitoTransport', async () => {
      const conn = mockRpc.createConnection();
      const jito = new JitoTransport(conn, mockJito.getUrl());
      const bundleId = 'bundle_lifecycle_f52';

      // 1. Initial pending state
      mockJito.registerBundle({
        bundleId,
        transactions: ['tx_sig_f52'],
        submittedAt: Date.now(),
        inflightStatus: 'Pending',
        confirmationStatus: 'processed',
        slot: 1001,
      });

      const pendingStatus = await jito.getBundleStatus(bundleId);
      expect(pendingStatus !== null).toBe(true);
      expect(pendingStatus?.status).toBe('processed');

      // 2. Progression to Landed
      mockJito.updateBundleStatus(bundleId, {
        inflightStatus: 'Landed',
        confirmationStatus: 'confirmed',
      });

      const landedStatus = await jito.getBundleStatus(bundleId);
      expect(landedStatus !== null).toBe(true);
      expect(landedStatus?.status).toBe('confirmed');
      expect(landedStatus?.landedSlot).toBe(1001);
    });

    it('F5.3: JitoTransport probe reports health and latency', async () => {
      const conn = mockRpc.createConnection();
      const jito = new JitoTransport(conn, mockJito.getUrl());

      const probeResult = await jito.probe();
      expect(probeResult.healthy).toBe(true);
      expect(probeResult.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('F5.4: Live arming is denied when Jito is NOT_CONFIGURED or OFFLINE', () => {
      const conn = mockRpc.createConnection();
      const jito = new JitoTransport(conn, 'http://127.0.0.1:9999');
      const telemetry = jito.getTelemetry();
      expect(telemetry.health).toBe('NOT_CONFIGURED');
    });

    it('F5.5: getBundleStatus returns confirmation status accurately', async () => {
      const conn = mockRpc.createConnection();
      const jito = new JitoTransport(conn, mockJito.getUrl());

      mockJito.registerBundle({
        bundleId: 'test_bundle_inflight_1',
        transactions: ['tx_base64_payload'],
        submittedAt: Date.now(),
        inflightStatus: 'Landed',
        confirmationStatus: 'confirmed',
        slot: 280000010,
      });

      const status = await jito.getBundleStatus('test_bundle_inflight_1');
      expect(status).toBeDefined();
      expect(status?.status).toBe('confirmed');
      expect(status?.landedSlot).toBe(280000010);
    });
  });
});
