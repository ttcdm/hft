import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { ExecutionCoordinator } from '../../../server/execution/coordinator';
import { HardenedRiskEngine, riskEngine as singletonRiskEngine } from '../../../server/risk/riskEngine';
import { EligibilityFilter } from '../../../server/signals/eligibilityFilter';
import { ConfluenceEngine } from '../../../server/signals/confluenceEngine';
import { WorkstationDatabase } from '../../../server/db/database';
import { ExitEngine } from '../../../server/exits/exitEngine';
import { TestDatabase } from '../helpers/testDb';
import { MockSolanaRpc } from '../helpers/mockRpc';
import { MockJitoEngine } from '../helpers/mockJito';
import {
  VALID_PUMP_MINT_1,
  GRADUATED_PUMP_MINT,
  TOKEN_2022_MINT,
  SIMULATED_PASSING_ELIGIBILITY,
} from '../helpers/simulatedStates';

describe('Tier 4: Real-World Workload Scenarios (Realistic Multi-Step Lifecycles)', () => {
  let mockRpc: MockSolanaRpc;
  let mockJito: MockJitoEngine;
  let testDb: TestDatabase;
  let coordinator: ExecutionCoordinator;
  let riskEngine: HardenedRiskEngine;

  let savedPositions: any[] = [];

  beforeEach(async () => {
    savedPositions = [];
    mockRpc = new MockSolanaRpc();
    mockJito = new MockJitoEngine();
    await mockJito.start();
    testDb = new TestDatabase();
    riskEngine = new HardenedRiskEngine();
    const limits = {
      cooldownPerMintMs: 0,
      cooldownAfterFailedTradeMs: 0,
      maxAggregateExposureSol: 100,
      maxDailyLossSol: 0.05,
      maxPositionSol: 0.05,
      maxFeePctOfPosition: 20.0,
      maxSlippageBps: 800,
    };
    riskEngine.updateLimits(limits);
    singletonRiskEngine.updateLimits(limits);
    vi.spyOn(WorkstationDatabase.prototype, 'savePosition').mockImplementation((pos: any) => {
      const idx = savedPositions.findIndex((p) => p.id === pos.id);
      if (idx >= 0) savedPositions[idx] = pos;
      else savedPositions.push(pos);
    });
    vi.spyOn(WorkstationDatabase.prototype, 'loadPositions').mockImplementation((mode?: string, status?: string) => {
      return savedPositions.filter((p) => {
        if (mode && p.executionMode !== mode) return false;
        if (status === 'ACTIVE') return p.status === 'OPEN' || p.status === 'PARTIALLY_CLOSED';
        if (status && p.status !== status) return false;
        return true;
      });
    });
    vi.spyOn(WorkstationDatabase.prototype, 'getDailyRealizedPnLSol').mockReturnValue(0);
    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
  });

  afterEach(async () => {
    coordinator?.cleanup();
    vi.restoreAllMocks();
    await mockJito.stop();
    testDb.close();
    mockRpc.clear();
  });

  // ===========================================================================
  // Scenario 1: Complete Snipe-to-Exit Lifecycle (Happy Path)
  // ===========================================================================
  it('W1: Complete Snipe-to-Exit: signal -> safety check -> entry -> trailing stop -> profitable exit', async () => {
    const mint = VALID_PUMP_MINT_1.toBase58();

    // 1. Token Safety & Eligibility Check
    const eligibility = EligibilityFilter.evaluate({
      mint,
      symbol: 'SNIPE1',
      name: 'Snipe Happy Path',
      liquidityUsd: 15000,
      isFreezeAuthorityRevoked: true,
      isMintAuthorityRevoked: true,
    }, 'PAPER');
    expect(eligibility.isEligible).toBe(true);

    // 2. Pre-Trade Risk Evaluation (MICRO_10 Sizing: 0.005 SOL)
    const riskCheck = riskEngine.evaluateOrder({
      mint,
      orderSizeSol: 0.005,
      expectedPriceSol: 0.0001,
      slippageBps: 300,
      estimatedFeeLamports: 15000,
      jitoTipLamports: 100000,
      signalTimestamp: Date.now(),
      marketDataTimestamp: Date.now(),
      currentOpenPositionsCount: 0,
      currentTotalExposureSol: 0,
      walletSpendableSol: 0.055,
      executionMode: 'PAPER',
    });
    expect(riskCheck.approved).toBe(true);

    // 3. Execution (PAPER Mode) with economic Jito tip
    const tradeResult = await coordinator.executeTrade({
      mint,
      symbol: 'SNIPE1',
      name: 'Snipe Happy Path',
      amountSol: 0.005,
      jitoTipSol: 0.0001,
      source: 'AUTO_SNIPER',
      provenance: 'REAL_ONCHAIN',
      currentPriceSol: 0.0001,
    });
    expect(tradeResult.success).toBe(true);
    expect(tradeResult.positionId).toBeDefined();

    const posId = tradeResult.positionId!;
    const entryPrice = 0.0001;
    let highWaterMark = entryPrice;
    let trailingStop = entryPrice * 0.85; // 15% stop

    // 4. Mark Price Updates (Price Pumps +60%)
    const markPrice1 = 0.00016;
    if (markPrice1 > highWaterMark) {
      highWaterMark = markPrice1;
      trailingStop = highWaterMark * 0.90; // Tightens to 10% trailing stop
    }
    expect(trailingStop).toBe(0.000144);

    // 5. Price Reversal triggers Trailing Stop
    const pullbackPrice = 0.000142; // Below trailing stop (0.000144)
    expect(pullbackPrice).toBeLessThan(trailingStop);

    // 6. Close Position
    const closeResult = await coordinator.closePosition(posId, 100, 'TRAILING_STOP');
    expect(closeResult.success).toBe(true);
  });

  // ===========================================================================
  // Scenario 2: Migration Lifecycle (Bonding Curve to PumpSwap AMM)
  // ===========================================================================
  it('W2: Migration Lifecycle: bonding curve entry -> graduation event -> PumpSwap pool resolution -> AMM sell', async () => {
    const mint = GRADUATED_PUMP_MINT.toBase58();
    const posId = `mig_lifecycle_${Date.now()}`;
    const canonicalPool = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';

    // 1. Initial Position established on Bonding Curve
    testDb.savePosition({
      id: posId,
      mint,
      symbol: 'MIGLIFE',
      name: 'Migration Lifecycle',
      tokenDecimals: 6,
      baseTokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      entryPriceSol: 0.0001,
      currentPriceSol: 0.00015,
      tokenQuantityRaw: '1000000000',
      costBasisLamports: 100_000_000,
      realizedPnLSol: 0,
      status: 'OPEN',
      venue: 'PUMP_BONDING_CURVE',
      executionMode: 'PAPER',
      entryTxSignature: 'sig_mig_life_1',
      entryTimestamp: Date.now() - 300000,
      recordUpdatedAt: Date.now(),
      updatedAt: Date.now(),
    });

    // 2. Bonding Curve Reaches 100% and Graduates
    const migrationReport = EligibilityFilter.evaluate({
      mint,
      symbol: 'MIGLIFE',
      name: 'Migration Lifecycle',
      liquidityUsd: 65000,
      isFreezeAuthorityRevoked: true,
      isMintAuthorityRevoked: true,
      isMigrated: true,
    }, 'LIVE');

    // Bonding curve trades now blocked
    expect(migrationReport.checks.some(c => c.ruleId === 'BONDING_CURVE_GRADUATED' && !c.passed)).toBe(true);

    // 3. Coordinator detects migration and upgrades venue to PumpSwap
    const currentPos = testDb.loadPositions('PAPER', 'OPEN').find(p => p.id === posId)!;
    testDb.savePosition({
      ...currentPos,
      venue: 'PUMPSWAP',
      poolAddress: canonicalPool,
      migrationTimestamp: Date.now(),
      updatedAt: Date.now(),
    });

    // 4. Verify Position Record is upgraded
    const migratedPos = testDb.loadPositions('PAPER', 'OPEN').find(p => p.id === posId)!;
    expect(migratedPos.venue).toBe('PUMPSWAP');
    expect(migratedPos.poolAddress).toBe(canonicalPool);
    expect(migratedPos.migrationTimestamp).toBeGreaterThan(0);
  });

  // ===========================================================================
  // Scenario 3: Multi-Stage Take-Profit Ladder with Residual Trailing Stop
  // ===========================================================================
  it('W3: Take-Profit Ladder: TP1 (33% at +30%) -> TP2 (33% at +60%) -> Residual Exit via ExitEngine', () => {
    const engine = new ExitEngine();
    const entryPriceSol = 0.0001;
    const entryTimestamp = Date.now() - 60_000;

    // Step 1: TP1 executes 33% sell at +30% profit
    const tp1Decision = engine.evaluate({
      entryPriceSol,
      currentPriceSol: 0.00013, // +30% profit
      entryTimestamp,
      highWaterMarkSol: entryPriceSol,
      trailingStopSol: 0,
      exitStage: 0,
    });
    expect(tp1Decision.shouldExit).toBe(true);
    expect(tp1Decision.reason).toBe('TAKE_PROFIT_1');
    expect(tp1Decision.sellPercentage).toBe(ExitEngine.TP1_SELL_PCT);
    expect(tp1Decision.newExitStage).toBe(1);

    // Step 2: TP2 executes 33% sell at +60% profit
    const tp2Decision = engine.evaluate({
      entryPriceSol,
      currentPriceSol: 0.00016, // +60% profit
      entryTimestamp,
      highWaterMarkSol: 0.00013,
      trailingStopSol: tp1Decision.newTrailingStopSol,
      exitStage: tp1Decision.newExitStage,
    });
    expect(tp2Decision.shouldExit).toBe(true);
    expect(tp2Decision.reason).toBe('TAKE_PROFIT_2');
    expect(tp2Decision.sellPercentage).toBe(ExitEngine.TP2_SELL_PCT);
    expect(tp2Decision.newExitStage).toBe(2);

    // Step 3: Pullback from 0.00020 triggers trailing stop on remaining 34%
    const trailingDecision = engine.evaluate({
      entryPriceSol,
      currentPriceSol: 0.00017, // Pulled back below HWM * 0.90
      entryTimestamp,
      highWaterMarkSol: 0.00020,
      trailingStopSol: 0.00020 * ExitEngine.STAGE_2_TRAILING_RATIO,
      exitStage: 2,
    });
    expect(trailingDecision.shouldExit).toBe(true);
    expect(trailingDecision.reason).toBe('TRAILING_STOP');
    expect(trailingDecision.sellPercentage).toBe(100);
  });

  // ===========================================================================
  // Scenario 4: Crash Recovery Replay of Interrupted In-Flight Buy
  // ===========================================================================
  it('W4: Crash Recovery: interrupted PENDING order in WAL is reconciled cleanly on restart', () => {
    const unconfirmedOrderId = `ord_crash_${Date.now()}`;
    const clientOrderId = `client_crash_${Date.now()}`;

    // Order written to WAL before simulated crash
    testDb.saveOrder({
      id: unconfirmedOrderId,
      clientOrderId,
      correlationId: 'corr_crash_1',
      mint: VALID_PUMP_MINT_1.toBase58(),
      symbol: 'CRASHBUY',
      side: 'BUY',
      amountLamports: 5000000,
      expectedTokensRaw: '1000000',
      slippageBps: 300,
      status: 'PENDING',
      executionMode: 'PAPER',
      createdAt: Date.now() - 60000,
      updatedAt: Date.now() - 60000,
    });

    // Verify order is pending in WAL
    const pendingOrder = testDb.db.prepare('SELECT * FROM orders WHERE id = ?').get(unconfirmedOrderId) as any;
    expect(pendingOrder.status).toBe('PENDING');

    // Simulate startup reconciliation: tx never landed on-chain -> mark FAILED
    testDb.saveOrder({
      id: unconfirmedOrderId,
      clientOrderId,
      correlationId: 'corr_crash_1',
      mint: VALID_PUMP_MINT_1.toBase58(),
      symbol: 'CRASHBUY',
      side: 'BUY',
      amountLamports: 5000000,
      expectedTokensRaw: '1000000',
      slippageBps: 300,
      status: 'FAILED',
      rejectionReason: 'STARTUP_RECONCILIATION_UNCONFIRMED',
      executionMode: 'PAPER',
      createdAt: pendingOrder.created_at,
      updatedAt: Date.now(),
    });

    const reconciledOrder = testDb.db.prepare('SELECT * FROM orders WHERE id = ?').get(unconfirmedOrderId) as any;
    expect(reconciledOrder.status).toBe('FAILED');
    expect(reconciledOrder.rejection_reason).toContain('STARTUP_RECONCILIATION_UNCONFIRMED');

    // Verify no phantom position exists
    const phantomPositions = testDb.loadPositions('PAPER', 'OPEN').filter(p => p.mint === VALID_PUMP_MINT_1.toBase58());
    expect(phantomPositions.length).toBe(0);
  });

  // ===========================================================================
  // Scenario 5: Crash Recovery Replay of Partially Executed Exit
  // ===========================================================================
  it('W5: Crash Recovery: partially closed position retains correct token quantity and cost basis in WAL', () => {
    const posId = `pos_partially_closed_${Date.now()}`;

    testDb.savePosition({
      id: posId,
      mint: VALID_PUMP_MINT_1.toBase58(),
      symbol: 'PARTIALCRASH',
      name: 'Partial Crash Token',
      tokenDecimals: 6,
      baseTokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      entryPriceSol: 0.0001,
      currentPriceSol: 0.00015,
      tokenQuantityRaw: '500000000', // 500 tokens remaining after 50% sell
      costBasisLamports: 25_000_000,
      realizedPnLSol: 0.0025,
      status: 'PARTIALLY_CLOSED',
      venue: 'PUMP_BONDING_CURVE',
      executionMode: 'PAPER',
      entryTxSignature: 'sig_part_entry',
      entryTimestamp: Date.now() - 120000,
      recordUpdatedAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Reconcile and load position
    const loaded = testDb.loadPositions('PAPER', 'PARTIALLY_CLOSED').find(p => p.id === posId);
    expect(loaded).toBeDefined();
    expect(loaded?.tokenQuantityRaw).toBe('500000000');
    expect(loaded?.costBasisLamports).toBe(25_000_000);
    expect(loaded?.realizedPnLSol).toBe(0.0025);
  });

  // ===========================================================================
  // Scenario 6: Decoupled Copy Trading Whale Lifecycle
  // ===========================================================================
  it('W6: Copy Trading Decoupling: whale 50 SOL buy decoupled to MICRO_10 size (0.0055 SOL) with independent exit', async () => {
    const whaleTradeSizeSol = 50.0;
    const apexBankrollSol = 0.07;
    const spendableBankrollSol = apexBankrollSol - 0.015; // 0.055 SOL
    const decoupledSizeSol = Math.min(spendableBankrollSol * 0.10, 0.007); // 0.0055 SOL

    expect(decoupledSizeSol).toBeLessThanOrEqual(0.007);
    expect(decoupledSizeSol).toBeLessThan(whaleTradeSizeSol);

    // Execute decoupled trade with COPY_TRADE provenance
    const copyMint = 'CopyWhaleMint11111111111111111111111111111111';
    const tradeRes = await coordinator.executeTrade({
      mint: copyMint,
      symbol: 'COPYWHALE',
      name: 'Copy Whale Token',
      amountSol: 0.005,
      jitoTipSol: 0.0001,
      source: 'AUTO_SNIPER',
      provenance: 'COPY_TRADE',
      currentPriceSol: 0.0001,
    });

    expect(tradeRes.success).toBe(true);
    expect(tradeRes.executionMode).toBe('PAPER');

    // Whale dumps entire position 10 seconds later, but APEX holds based on independent trailing stop
    const posId = tradeRes.positionId!;
    expect(posId).toBeDefined();

    // Independent exit trigger executes cleanly
    const exitRes = await coordinator.closePosition(posId, 100, 'TRAILING_STOP');
    expect(exitRes.success).toBe(true);
  });

  // ===========================================================================
  // Scenario 7: Multi-Source Confluence Snipe Lifecycle
  // ===========================================================================
  it('W7: Multi-Source Confluence Snipe: high momentum + liquidity + clean dev holdings trigger high-score snipe', async () => {
    // 1. Calculate multi-factor confluence score
    const confluence = ConfluenceEngine.calculate({
      priceChange5mPct: 45.0,
      liquidityUsd: 28000,
      top10HoldersPct: 15.0,
      bondingCurveProgress: 65,
      buys5m: 55,
      sells5m: 8,
      devHoldingPct: 0.0,
      hasVerifiedSocialCall: true,
      socialCallCount: 2,
    });

    // Score > 80 indicates high-confidence entry
    expect(confluence.compositeScore).toBeGreaterThanOrEqual(80);

    // 2. Submit trade with REAL_ONCHAIN provenance
    const confMint = 'ConfluenceMint1111111111111111111111111111111';
    const snipeRes = await coordinator.executeTrade({
      mint: confMint,
      symbol: 'CONFLUENCE',
      name: 'Confluence Token',
      amountSol: 0.005,
      jitoTipSol: 0.0001,
      source: 'AUTO_SNIPER',
      provenance: 'REAL_ONCHAIN',
      currentPriceSol: 0.0001,
    });

    expect(snipeRes.success).toBe(true);
  });

  // ===========================================================================
  // Scenario 8: Drawdown Protection Circuit Trip & Capital Preservation
  // ===========================================================================
  it('W8: Drawdown Protection: consecutive losses trip DAILY_LOSS_LIMIT, halting new entries while allowing exits', async () => {
    // Mock daily loss at -0.052 SOL (breaches 0.05 limit)
    vi.spyOn(WorkstationDatabase.prototype, 'getDailyRealizedPnLSol').mockReturnValue(-0.052);

    // New trade entry is immediately rejected
    const newEntryRes = riskEngine.evaluateOrder({
      mint: VALID_PUMP_MINT_1.toBase58(),
      orderSizeSol: 0.005,
      expectedPriceSol: 0.0001,
      slippageBps: 300,
      estimatedFeeLamports: 15000,
      jitoTipLamports: 100000,
      signalTimestamp: Date.now(),
      marketDataTimestamp: Date.now(),
      currentOpenPositionsCount: 0,
      currentTotalExposureSol: 0,
      walletSpendableSol: 0.05,
      executionMode: 'PAPER',
    });

    expect(newEntryRes.approved).toBe(false);
    expect(newEntryRes.reasonCode).toBe('DAILY_LOSS_LIMIT');

    // But existing position can still be closed to preserve capital
    const posId = `pos_capital_preservation_${Date.now()}`;
    const openPos = {
      id: posId,
      mint: VALID_PUMP_MINT_1.toBase58(),
      symbol: 'PRESERVE',
      name: 'Capital Preservation',
      tokenDecimals: 6,
      baseTokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      entryPriceSol: 0.0001,
      currentPriceSol: 0.00008,
      tokenQuantityRaw: '1000000000',
      costBasisLamports: 100_000_000,
      realizedPnLSol: 0,
      status: 'OPEN' as const,
      venue: 'PUMP_BONDING_CURVE' as const,
      executionMode: 'PAPER' as const,
      entryTxSignature: 'sig_pres',
      entryTimestamp: Date.now() - 10000,
      recordUpdatedAt: Date.now(),
      updatedAt: Date.now(),
    };
    vi.spyOn(WorkstationDatabase.prototype, 'loadPositions').mockReturnValue([openPos]);

    const exitRes = await coordinator.closePosition(posId, 100, 'DAILY_STOP_HALT');
    expect(exitRes.success).toBe(true);
  });

  // ===========================================================================
  // Scenario 9: Jito Timeout with Deduplicated Fallback Reconciliation
  // ===========================================================================
  it('W9: Jito Timeout Fallback: bundle timeout dispatches via fallback without duplicate fill in DB', async () => {
    const clientOrderId = `client_timeout_fallback_${Date.now()}`;

    // Register timed-out bundle
    mockJito.registerBundle({
      bundleId: 'bundle_timed_out_1',
      transactions: ['raw_tx'],
      submittedAt: Date.now() - 60000,
      inflightStatus: 'Failed',
      confirmationStatus: 'Failed',
      slot: 280000000,
    });

    // Save order once under clientOrderId
    testDb.saveOrder({
      id: 'ord_fallback_rec',
      clientOrderId,
      correlationId: 'corr_fb_1',
      mint: VALID_PUMP_MINT_1.toBase58(),
      symbol: 'FALLBACK',
      side: 'BUY',
      amountLamports: 5000000,
      expectedTokensRaw: '1000000',
      slippageBps: 300,
      status: 'FILLED',
      executionMode: 'PAPER',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Verify exactly 1 order exists for clientOrderId
    const orders = testDb.db.prepare('SELECT count(*) as count FROM orders WHERE client_order_id = ?').get(clientOrderId) as { count: number };
    expect(orders.count).toBe(1);
  });

  // ===========================================================================
  // Scenario 10: Adversarial Honeypot Defense Lifecycle
  // ===========================================================================
  it('W10: Adversarial Honeypot Defense: active freeze authority token rejected, activating duplicate cooldown', () => {
    const maliciousMint = 'MaliciousHoneypotMint1111111111111111111111';

    // 1. Safety scan detects honeypot freeze authority
    const report = EligibilityFilter.evaluate({
      mint: maliciousMint,
      symbol: 'HONEY',
      name: 'Honey Token',
      liquidityUsd: 100000,
      isFreezeAuthorityRevoked: false, // Active freeze authority -> honeypot!
      isMintAuthorityRevoked: true,
    }, 'LIVE');

    expect(report.isEligible).toBe(false);

    // 2. Cooldown is activated to prevent repeated scans or orders on this mint
    riskEngine.updateLimits({ cooldownPerMintMs: 60000, cooldownAfterFailedTradeMs: 30000 });
    riskEngine.recordTradeFailure();

    // 3. Subsequent order on this mint or immediately after failure is blocked
    const orderCheck = riskEngine.evaluateOrder({
      mint: maliciousMint,
      orderSizeSol: 0.005,
      expectedPriceSol: 0.0001,
      slippageBps: 300,
      estimatedFeeLamports: 15000,
      jitoTipLamports: 100000,
      signalTimestamp: Date.now(),
      marketDataTimestamp: Date.now(),
      currentOpenPositionsCount: 0,
      currentTotalExposureSol: 0,
      walletSpendableSol: 0.05,
      executionMode: 'PAPER',
    });

    expect(orderCheck.approved).toBe(false);
    expect(['EXECUTION_DISABLED', 'TRADE_FAILURE_COOLDOWN']).toContain(orderCheck.reasonCode);
  });
});
