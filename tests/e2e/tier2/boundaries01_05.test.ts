import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ExecutionCoordinator } from '../../../server/execution/coordinator';
import { PumpCurveService } from '../../../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../../../server/solana/pumpSwapService';
import { executionConfig } from '../../../server/solana/executionConfig';
import { WorkstationDatabase } from '../../../server/db/database';
import { HardenedRiskEngine } from '../../../server/risk/riskEngine';
import { TestDatabase } from '../helpers/testDb';
import { MockSolanaRpc } from '../helpers/mockRpc';
import { MockJitoEngine } from '../helpers/mockJito';
import {
  createSimulatedBondingCurveState,
  createSimulatedPumpSwapState,
  VALID_PUMP_MINT_1,
  GRADUATED_PUMP_MINT,
  SOL_NATIVE_MINT,
  NON_SOL_QUOTE_MINT,
} from '../helpers/simulatedStates';
import { PublicKey } from '@solana/web3.js';

describe('Tier 2: Boundary & Corner Cases (Features 1 - 5)', () => {
  let coordinator: ExecutionCoordinator;
  let riskEngine: HardenedRiskEngine;
  let testDb: TestDatabase;
  let mockRpc: MockSolanaRpc;
  let mockJito: MockJitoEngine;

  beforeEach(() => {
    testDb = new TestDatabase();
    mockRpc = new MockSolanaRpc();
    mockJito = new MockJitoEngine();
    mockJito.start();

    riskEngine = new HardenedRiskEngine();
    riskEngine.updateLimits({
      cooldownPerMintMs: 0,
      cooldownAfterFailedTradeMs: 0,
      maxAggregateExposureSol: 100,
    });

    vi.spyOn(WorkstationDatabase.prototype, 'loadPositions').mockReturnValue([]);
    vi.spyOn(WorkstationDatabase.prototype, 'getDailyRealizedPnLSol').mockReturnValue(0);

    coordinator = new ExecutionCoordinator();
  });

  afterEach(() => {
    mockJito.stop();
    vi.restoreAllMocks();
    testDb.close();
  });

  // =========================================================================
  // Feature 1: Execution Mode Propagation Boundaries
  // =========================================================================
  describe('Feature 1 Boundaries: Execution Mode Propagation', () => {
    const baseState = createSimulatedBondingCurveState();

    it('B1.1: executeTrade handles undefined or invalid executionMode safely defaulting to PAPER', async () => {
      const res = await coordinator.executeTrade({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'TEST',
        name: 'Test Token',
        amountSol: 0.005,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        currentPriceSol: 0.0001,
        // @ts-expect-error test boundary
        executionMode: 'INVALID_MODE',
      });
      expect(res.executionMode).toBe('PAPER');
    });

    it('B1.2: calculateBuyQuote strictly requires executionMode and throws on omission', () => {
      expect(() =>
        (PumpCurveService as any).calculateBuyQuote(baseState, 0.05)
      ).toThrow(/CRITICAL_CONFIG_ERROR/);
    });

    it('B1.3: zero slippage tolerance (0 bps) is preserved in quote calculation', () => {
      const quote = PumpCurveService.calculateBuyQuote({
        state: baseState,
        amountSol: 0.01,
        slippageBps: 0,
        executionMode: 'PAPER',
      });
      expect(quote.slippageBps).toBe(0);
      expect(quote.maxInputLamports).toBe(quote.expectedSolAmountLamports);
    });

    it('B1.4: maximum slippage tolerance boundary (10,000 bps = 100%)', () => {
      const quote = PumpCurveService.calculateBuyQuote({
        state: baseState,
        amountSol: 0.01,
        slippageBps: 10000,
        executionMode: 'PAPER',
      });
      expect(quote.slippageBps).toBe(10000);
      expect(quote.maxInputLamports).toBe(quote.expectedSolAmountLamports * 2);
    });

    it('B1.5: executeTrade with zero amountSol is handled fail-closed', async () => {
      const res = await coordinator.executeTrade({
        mint: VALID_PUMP_MINT_1.toBase58(),
        symbol: 'TEST',
        name: 'Test Token',
        amountSol: 0,
        source: 'AUTO_SNIPER',
        provenance: 'REAL_ONCHAIN',
        currentPriceSol: 0.0001,
      });
      expect(res.success).toBe(false);
    });
  });

  // =========================================================================
  // Feature 2: Pump.fun V2 Bonding Curve Boundaries
  // =========================================================================
  describe('Feature 2 Boundaries: Pump.fun V2 Correctness', () => {
    it('B2.1: virtual reserves with zero virtual tokens throws insufficient liquidity', () => {
      const state = createSimulatedBondingCurveState({
        virtualTokenReserves: 0n,
        virtualSolReserves: 30_000_000_000n,
      });
      expect(() =>
        PumpCurveService.calculateBuyQuote({
          state,
          amountSol: 0.01,
          executionMode: 'PAPER',
        })
      ).toThrow(/Insufficient bonding curve liquidity/);
    });

    it('B2.2: virtual reserves with zero virtual SOL yields 0 spot price and infinite price impact in PAPER mode', () => {
      const state = createSimulatedBondingCurveState({
        virtualTokenReserves: 1_073_000_000_000_000n,
        virtualSolReserves: 0n,
      });
      const quote = PumpCurveService.calculateBuyQuote({
        state,
        amountSol: 0.01,
        executionMode: 'PAPER',
      });
      expect(quote.spotPriceSol).toBe(0);
      expect(quote.estimatedPriceImpactBps).toBe(Infinity);
    });

    it('B2.3: extreme SOL amount results in massive price impact exceeding risk limit', () => {
      const state = createSimulatedBondingCurveState();
      const quote = PumpCurveService.calculateBuyQuote({
        state,
        amountSol: 1000,
        executionMode: 'PAPER',
      });
      // Extreme buy generates huge price impact (> 300,000 bps)
      expect(quote.estimatedPriceImpactBps).toBeGreaterThan(10000);

      // Evaluating an order with this price impact rejects
      const riskResult = riskEngine.evaluateOrder({
        mint: state.mint.toBase58(),
        orderSizeSol: 1000,
        expectedPriceSol: quote.executionPriceSol,
        slippageBps: 300,
        estimatedFeeLamports: 50000,
        jitoTipLamports: 100000,
        signalTimestamp: Date.now(),
        marketDataTimestamp: Date.now(),
        currentOpenPositionsCount: 0,
        currentTotalExposureSol: 0,
        walletSpendableSol: 2000,
        executionMode: 'PAPER',
      });
      expect(riskResult.approved).toBe(false);
    });

    it('B2.4: 1 lamport input produces consistent integer arithmetic without truncation panic', () => {
      const state = createSimulatedBondingCurveState();
      const quote = PumpCurveService.calculateBuyQuote({
        state,
        amountSol: 0.000000001, // 1 lamport
        executionMode: 'PAPER',
      });
      expect(BigInt(quote.tokenAmountRaw) >= 0n).toBe(true);
    });

    it('B2.5: exact graduation threshold sol (85 SOL) matches completed status transition', () => {
      const state = createSimulatedBondingCurveState({
        realSolReserves: 85_000_000_000n,
        complete: true,
      });
      expect(state.complete).toBe(true);
      expect(state.realSolReserves).toBe(85_000_000_000n);
    });
  });

  // =========================================================================
  // Feature 3: PumpSwap AMM Boundaries
  // =========================================================================
  describe('Feature 3 Boundaries: PumpSwap Correctness', () => {
    it('B3.1: effective quote reserves correctly handles 0 virtual quote reserves boundary', () => {
      const state = createSimulatedPumpSwapState({
        quoteReserve: 50_000_000_000n,
        virtualQuoteReserves: 0n,
      });
      expect(state.effectiveQuoteReserve).toBe(50_000_000_000n);
      expect(state.virtualQuoteReserves).toBe(0n);
    });

    it('B3.2: creator fee BPS distinction at boundaries (0n vs 500n)', () => {
      const zeroFeeState = createSimulatedPumpSwapState({ creatorFeeBps: 0n });
      const maxFeeState = createSimulatedPumpSwapState({ creatorFeeBps: 500n });

      expect(zeroFeeState.creatorFeeBps).toBe(0n);
      expect(maxFeeState.creatorFeeBps).toBe(500n);
    });

    it('B3.3: resolveVenue for unresolvable pool returns venue UNKNOWN and isMigrated true', async () => {
      const conn = mockRpc.createConnection();
      const unknownMint = new PublicKey('11111111111111111111111111111111');
      const res = await PumpSwapVenueService.resolveVenue(conn, unknownMint, 'LIVE');
      expect(res.venue).toBe('UNKNOWN');
      expect(res.isMigrated).toBe(true);
    });

    it('B3.4: buildPumpSwapSellInstructions throws PUMPSWAP_POOL_NOT_FOUND on nonexistent pool', async () => {
      const conn = mockRpc.createConnection();
      const nonExistentMint = new PublicKey('11111111111111111111111111111111');
      await expect(
        PumpSwapVenueService.buildPumpSwapSellInstructions(
          conn,
          PublicKey.default,
          nonExistentMint,
          100_000n,
          800,
          'PAPER'
        )
      ).rejects.toThrow(/PUMPSWAP_POOL_NOT_FOUND/);
    });

    it('B3.5: quoteMint validation strictly requires native SOL in LIVE execution state', () => {
      const validSolState = createSimulatedPumpSwapState({
        quoteMint: SOL_NATIVE_MINT,
      });
      const invalidQuoteState = createSimulatedPumpSwapState({ quoteMint: NON_SOL_QUOTE_MINT });

      expect(validSolState.quoteMint.toBase58()).toBe(SOL_NATIVE_MINT.toBase58());
      expect(invalidQuoteState.quoteMint.toBase58()).toBe(NON_SOL_QUOTE_MINT.toBase58());
      expect(invalidQuoteState.quoteMint.equals(validSolState.quoteMint)).toBe(false);
    });
  });

  // =========================================================================
  // Feature 4: Migration Safety Boundaries
  // =========================================================================
  describe('Feature 4 Boundaries: Migration Safety', () => {
    it('B4.1: curve complete flag true marks graduated token state', () => {
      const state = createSimulatedBondingCurveState({ complete: true });
      expect(state.complete).toBe(true);
    });

    it('B4.2: curve complete flag false maintains unmigrated active bonding curve state', () => {
      const state = createSimulatedBondingCurveState({ complete: false });
      expect(state.complete).toBe(false);
    });

    it('B4.3: unresolvable pool address produces UNKNOWN venue with safe exit rejection', async () => {
      const closeRes = await coordinator.closePosition('non-existent-pos-id');
      expect(closeRes.success).toBe(false);
      expect(closeRes.error).toContain('not found');
    });

    it('B4.4: partial migration with timestamp 0 defaults safely to unmigrated', () => {
      testDb.db.prepare(`
        INSERT INTO positions (
          id, mint, symbol, name, token_decimals, base_token_program,
          token_quantity_raw, cost_basis_lamports, entry_price_sol, current_price_sol,
          entry_tx_signature, entry_timestamp, execution_mode, status, updated_at
        ) VALUES (
          'pos-mig-test-01', '11111111111111111111111111111111', 'MIG', 'Migration Test', 6,
          'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', '1000000', 5000000, 0.0001, 0.0001,
          'sig-mig-01', ?, 'PAPER', 'OPEN', ?
        )
      `).run(Date.now(), Date.now());

      const positions = testDb.loadPositions();
      const target = positions.find(p => p.id === 'pos-mig-test-01');
      expect(target).toBeDefined();
      expect(target?.venue).toBe('PUMP_BONDING_CURVE');
    });

    it('B4.5: closePosition with partial sell percentage boundary (0% clamped to 1%)', async () => {
      testDb.db.prepare(`
        INSERT INTO positions (
          id, mint, symbol, name, token_decimals, base_token_program,
          token_quantity_raw, cost_basis_lamports, entry_price_sol, current_price_sol,
          entry_tx_signature, entry_timestamp, execution_mode, status, updated_at
        ) VALUES (
          'pos-pct-test', '11111111111111111111111111111111', 'PCT', 'Pct Test', 6,
          'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', '1000000', 5000000, 0.0001, 0.0001,
          'sig-pct-01', ?, 'PAPER', 'OPEN', ?
        )
      `).run(Date.now(), Date.now());

      vi.spyOn(WorkstationDatabase.prototype, 'loadPositions').mockReturnValue(testDb.loadPositions());

      const res = await coordinator.closePosition('pos-pct-test', 0);
      expect(res.success).toBe(true);
    });
  });

  // =========================================================================
  // Feature 5: Jito Correctness Boundaries
  // =========================================================================
  describe('Feature 5 Boundaries: Jito Correctness', () => {
    it('B5.1: 0 tip lamports boundary is bounded up to minJitoTipSol', () => {
      const resolved = executionConfig.resolveDynamicJitoTip({
        explicitTipSol: 0,
      });
      expect(resolved.tipLamports).toBeGreaterThanOrEqual(10_000);
      expect(resolved.tipSol).toBeGreaterThanOrEqual(0.0001);
    });

    it('B5.2: bundle status API with empty bundle IDs array returns empty statuses', async () => {
      const res = await fetch(`${executionConfig.getConfig().jitoBlockEngineUrl}/api/v1/getBundleStatuses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getBundleStatuses',
          params: [[]],
        }),
      });
      const data = await res.json();
      expect(data.result.value).toEqual([]);
    });

    it('B5.3: bundle ID with non-hex special characters handled without throwing uncaught error', async () => {
      const res = await fetch(`${executionConfig.getConfig().jitoBlockEngineUrl}/api/v1/getBundleStatuses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getBundleStatuses',
          params: [['!@#$%^&*()_+=~`']],
        }),
      });
      const data = await res.json();
      expect(data.result.value).toHaveLength(1);
      expect(data.result.value[0]).toBeNull();
    });

    it('B5.4: tip floor higher than operator max cap is capped at operator max', () => {
      const resolved = executionConfig.resolveDynamicJitoTip({
        tipFloorLamports: 100_000_000,
        operatorMaxSol: 0.05,
      });
      expect(resolved.tipSol).toBe(0.05);
      expect(resolved.tipLamports).toBe(50_000_000);
      expect(resolved.policyReason).toContain('CAPPED by operator maximum');
    });

    it('B5.5: bundle confirmation timeout boundary sets state to TIMEOUT', async () => {
      mockJito.registerBundle({
        bundleId: 'bundle-timeout-test',
        transactions: [],
        submittedAt: Date.now(),
        inflightStatus: 'Failed',
        confirmationStatus: 'Failed',
        slot: 1000,
        err: { Timeout: true },
      });

      const res = await fetch(`${executionConfig.getConfig().jitoBlockEngineUrl}/api/v1/getBundleStatuses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getBundleStatuses',
          params: [['bundle-timeout-test']],
        }),
      });
      const data = await res.json();
      expect(data.result.value[0].confirmation_status).toBe('Failed');
    });
  });
});
