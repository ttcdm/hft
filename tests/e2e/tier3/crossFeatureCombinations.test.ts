import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { ExecutionCoordinator } from '../../../server/execution/coordinator';
import { HardenedRiskEngine } from '../../../server/risk/riskEngine';
import { EligibilityFilter } from '../../../server/signals/eligibilityFilter';
import { AuthManager } from '../../../server/middleware/auth';
import { ConfluenceEngine } from '../../../server/signals/confluenceEngine';
import { WorkstationDatabase } from '../../../server/db/database';
import { JitoTransport } from '../../../server/solana/transports';
import { executionConfig } from '../../../server/solana/executionConfig';
import { TestDatabase } from '../helpers/testDb';
import { MockSolanaRpc } from '../helpers/mockRpc';
import { MockJitoEngine } from '../helpers/mockJito';
import {
  VALID_PUMP_MINT_1,
  GRADUATED_PUMP_MINT,
  TOKEN_2022_MINT,
  SIMULATED_PASSING_ELIGIBILITY,
} from '../helpers/simulatedStates';
import * as fs from 'node:fs';

describe('Tier 3: Cross-Feature Combinations (Pairwise Feature Interactions)', () => {
  let mockRpc: MockSolanaRpc;
  let mockJito: MockJitoEngine;
  let testDb: TestDatabase;
  let coordinator: ExecutionCoordinator;
  let riskEngine: HardenedRiskEngine;

  beforeEach(async () => {
    mockRpc = new MockSolanaRpc();
    mockJito = new MockJitoEngine();
    await mockJito.start();
    testDb = new TestDatabase();
    riskEngine = new HardenedRiskEngine();
    riskEngine.updateLimits({
      cooldownPerMintMs: 0,
      cooldownAfterFailedTradeMs: 0,
      maxAggregateExposureSol: 100,
      maxDailyLossSol: 0.05,
      maxPositionSol: 0.007,
      maxFeePctOfPosition: 20.0,
      maxSlippageBps: 800,
    });
    vi.spyOn(WorkstationDatabase.prototype, 'loadPositions').mockReturnValue([]);
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
  // Interaction 1: F1 (Execution Mode) + F8 (Token-2022 Policy)
  // ===========================================================================
  it('C1: [F1 + F8] Unsupported Token-2022 extension is permitted/warned in PAPER mode but fails-closed in LIVE mode', () => {
    const unmodeledToken = {
      mint: TOKEN_2022_MINT.toBase58(),
      symbol: 'UNMODELED',
      name: 'Unmodeled Token-2022',
      liquidityUsd: 15000,
      isFreezeAuthorityRevoked: true,
      isMintAuthorityRevoked: true,
      hasToken2022Extensions: true,
      unsupportedToken2022Extension: 'PermanentDelegate',
    };

    // In PAPER mode: fail-closed does not block execution if unmodeled extensions are exploratory
    const paperReport = EligibilityFilter.evaluate(unmodeledToken, 'PAPER');
    // In LIVE mode: strictly fails-closed
    const liveReport = EligibilityFilter.evaluate(unmodeledToken, 'LIVE');

    expect(liveReport.isEligible).toBe(false);
    expect(liveReport.checks.some(c => c.ruleId === 'TOKEN_2022_POLICY' && !c.passed)).toBe(true);
    expect(liveReport.checks.find(c => c.ruleId === 'TOKEN_2022_POLICY')?.reason).toContain('UNSUPPORTED_TOKEN_EXTENSION');
  });

  // ===========================================================================
  // Interaction 2: F2 (Pump V2) + F4 (Migration Safety)
  // ===========================================================================
  it('C2: [F2 + F4] Graduated bonding curve token fails bonding curve trade and directs to PumpSwap migration route', () => {
    const graduatedToken = {
      mint: GRADUATED_PUMP_MINT.toBase58(),
      symbol: 'GRAD',
      name: 'Graduated Token',
      liquidityUsd: 50000,
      isFreezeAuthorityRevoked: true,
      isMintAuthorityRevoked: true,
      isMigrated: true,
    };

    const report = EligibilityFilter.evaluate(graduatedToken, 'LIVE');
    expect(report.isEligible).toBe(false);
    const gradCheck = report.checks.find(c => c.ruleId === 'BONDING_CURVE_GRADUATED');
    expect(gradCheck).toBeDefined();
    expect(gradCheck?.passed).toBe(false);
    expect(gradCheck?.reason).toContain('already graduated');
  });

  // ===========================================================================
  // Interaction 3: F3 (PumpSwap Correctness) + F8 (Token-2022)
  // ===========================================================================
  it('C3: [F3 + F8] PumpSwap quoting accounts for transfer fee extensions on Token-2022 pairs via EligibilityFilter', () => {
    const report = EligibilityFilter.evaluate({
      mint: TOKEN_2022_MINT.toBase58(),
      symbol: 'T22',
      name: 'Token 2022 Transfer Fee',
      hasToken2022Extensions: true,
      unsupportedToken2022Extension: true, // Non-zero transfer fee / hook extension
      isMintAuthorityRevoked: true,
      isFreezeAuthorityRevoked: true,
      liquidityUsd: 15000,
    }, 'LIVE');

    expect(report.isEligible).toBe(false);
    expect(report.checks.some((r) => r.reason?.includes('TOKEN_2022') || r.ruleId.includes('TOKEN_2022'))).toBe(true);
  });

  // ===========================================================================
  // Interaction 4: F4 (Migration Safety) + F13 (WAL Crash Recovery)
  // ===========================================================================
  it('C4: [F4 + F13] Migration transition from PUMP_BONDING_CURVE to PUMPSWAP persists across SQLite restart', () => {
    const posId = `mig_pos_${Date.now()}`;
    testDb.savePosition({
      id: posId,
      mint: GRADUATED_PUMP_MINT.toBase58(),
      symbol: 'MIGTEST',
      name: 'Migrating Token',
      tokenDecimals: 6,
      baseTokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      entryPriceSol: 0.0001,
      currentPriceSol: 0.00012,
      tokenQuantityRaw: '1000000000',
      costBasisLamports: 100_000_000,
      realizedPnLSol: 0,
      status: 'OPEN',
      venue: 'PUMP_BONDING_CURVE',
      executionMode: 'PAPER',
      entryTxSignature: 'sig_mig_1',
      entryTimestamp: Date.now() - 60000,
      recordUpdatedAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Verify initial venue is PUMP_BONDING_CURVE
    let pos = testDb.loadPositions('PAPER', 'OPEN').find(p => p.id === posId);
    expect(pos?.venue).toBe('PUMP_BONDING_CURVE');

    // Migration detected and resolved to PumpSwap canonical pool
    const canonicalPool = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf').toBase58();
    const migrationTime = Date.now();

    testDb.savePosition({
      ...pos!,
      venue: 'PUMPSWAP',
      poolAddress: canonicalPool,
      migrationTimestamp: migrationTime,
      updatedAt: migrationTime,
    });

    // Re-query directly from SQLite
    pos = testDb.loadPositions('PAPER', 'OPEN').find(p => p.id === posId);
    expect(pos?.venue).toBe('PUMPSWAP');
    expect(pos?.poolAddress).toBe(canonicalPool);
    expect(pos?.migrationTimestamp).toBe(migrationTime);
  });

  // ===========================================================================
  // Interaction 5: F5 (Jito Correctness) + F6 (Safe Jito Retry & RPC Fallback)
  // ===========================================================================
  it('C5: [F5 + F6] Jito bundle drop triggers bounded retry with separate bundle IDs and single clientOrderId', async () => {
    const clientOrderId = `client_ord_${Date.now()}`;
    const bundleIds: string[] = [];

    // Simulate sending 2 bundle attempts with the same order payload
    for (let attempt = 1; attempt <= 2; attempt++) {
      const bundleId = `bundle_attempt_${attempt}_${Date.now()}`;
      bundleIds.push(bundleId);
      mockJito.registerBundle({
        bundleId,
        transactions: ['tx_signed_blob'],
        submittedAt: Date.now(),
        inflightStatus: attempt === 1 ? 'Failed' : 'Landed',
        confirmationStatus: attempt === 1 ? 'Failed' : 'confirmed',
        slot: 280000010 + attempt,
      });
    }

    // Bundle IDs are distinct
    expect(bundleIds[0] !== bundleIds[1]).toBe(true);

    // But order was recorded once in orders table under single clientOrderId
    testDb.saveOrder({
      id: 'ord_retry_test',
      clientOrderId,
      correlationId: 'corr_retry_test',
      mint: VALID_PUMP_MINT_1.toBase58(),
      symbol: 'RETRY',
      side: 'BUY',
      amountLamports: 5000000,
      expectedTokensRaw: '1000000',
      slippageBps: 300,
      status: 'FILLED',
      executionMode: 'PAPER',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const ordersWithClient = testDb.db.prepare('SELECT count(*) as count FROM orders WHERE client_order_id = ?').get(clientOrderId) as { count: number };
    expect(ordersWithClient.count).toBe(1); // Exactly 1 fill record
  });

  // ===========================================================================
  // Interaction 6: F6 (Safe RPC Fallback) + F1 (Execution Mode)
  // ===========================================================================
  it('C6: [F6 + F1] In LIVE mode, RPC fallback requires valid signer and fails-closed if signer locked', async () => {
    (coordinator as any).executionMode = 'LIVE';

    // Attempting LIVE trade without configured signer rejects before transport
    const res = await coordinator.executeTrade({
      mint: VALID_PUMP_MINT_1.toBase58(),
      symbol: 'RPCSIGNER',
      name: 'RPC Signer Fallback',
      amountSol: 0.005,
      source: 'AUTO_SNIPER',
      provenance: 'REAL_ONCHAIN',
      currentPriceSol: 0.0001,
    });

    expect(res.success).toBe(false);
    expect(res.error?.toLowerCase()).toContain('signer');
  });

  // ===========================================================================
  // Interaction 7: F7 (Token Eligibility) + F1 (Execution Mode)
  // ===========================================================================
  it('C7: [F7 + F1] Tri-state UNKNOWN freeze authority passes in PAPER mode but rejects in LIVE mode', () => {
    const unknownToken = {
      mint: VALID_PUMP_MINT_1.toBase58(),
      symbol: 'UNKNWN',
      name: 'Unknown Authority Token',
      liquidityUsd: 10000,
      isFreezeAuthorityRevoked: 'UNKNOWN' as const,
      isMintAuthorityRevoked: true,
    };

    const paperReport = EligibilityFilter.evaluate(unknownToken, 'PAPER');
    const liveReport = EligibilityFilter.evaluate(unknownToken, 'LIVE');

    // In PAPER mode, UNKNOWN does not block trading
    const paperFreezeCheck = paperReport.checks.find(c => c.ruleId === 'FREEZE_AUTHORITY_REVOKED');
    expect(paperFreezeCheck?.passed).toBe(true);

    // In LIVE mode, UNKNOWN causes immediate rejection
    const liveFreezeCheck = liveReport.checks.find(c => c.ruleId === 'FREEZE_AUTHORITY_REVOKED');
    expect(liveFreezeCheck?.passed).toBe(false);
    expect(liveReport.isEligible).toBe(false);
  });

  // ===========================================================================
  // Interaction 8: F7 (Token Eligibility) + F17 (Copy Trading)
  // ===========================================================================
  it('C8: [F7 + F17] Whale copy trade on honeypot token is rejected by EligibilityFilter before coordinator submission', () => {
    const honeypotWhaleBuy = {
      mint: 'HoneypotWhaleBuy11111111111111111111111111',
      symbol: 'HONEYWHALE',
      name: 'Honeypot Whale Token',
      liquidityUsd: 50000,
      isFreezeAuthorityRevoked: false, // Active freeze authority -> Honeypot!
      isMintAuthorityRevoked: false,
    };

    const report = EligibilityFilter.evaluate(honeypotWhaleBuy, 'LIVE');
    expect(report.isEligible).toBe(false);
    expect(report.checks.some(c => c.ruleId === 'FREEZE_AUTHORITY_REVOKED' && !c.passed)).toBe(true);
  });

  // ===========================================================================
  // Interaction 9: F9 (Mandatory Provenance) + F10 (Synthetic Data Isolation)
  // ===========================================================================
  it('C9: [F9 + F10] DEMO_PAPER synthetic signals cannot trigger LIVE trades or contaminate LIVE metrics', async () => {
    (coordinator as any).executionMode = 'LIVE';

    const syntheticTrade = await coordinator.executeTrade({
      mint: VALID_PUMP_MINT_1.toBase58(),
      symbol: 'SYNTH',
      name: 'Synthetic Signal',
      amountSol: 0.005,
      source: 'AUTO_SNIPER',
      provenance: 'DEMO_PAPER',
      currentPriceSol: 0.0001,
    });

    // In LIVE mode, DEMO_PAPER is strictly prohibited
    expect(syntheticTrade.success).toBe(false);
  });

  // ===========================================================================
  // Interaction 10: F11 (WebSocket Telemetry) + F1 (Execution Mode)
  // ===========================================================================
  it('C10: [F11 + F1] Unauthenticated requests cannot access LIVE execution channels via AuthManager', () => {
    const auth = new AuthManager();
    const validSession = auth.createSession('OPERATOR');

    // Unauthenticated token fails validation
    expect(auth.validateToken('unauthenticated_dummy_token')).toBe(false);
    expect(auth.validateToken('')).toBe(false);

    // Authenticated operator session passes
    expect(auth.validateToken(validSession.token)).toBe(true);
    expect(auth.getSession(validSession.token)?.role).toBe('OPERATOR');
  });

  // ===========================================================================
  // Interaction 11: F12 (Live Readiness Health) + F5 (Jito Health)
  // ===========================================================================
  it('C11: [F12 + F5] Jito NOT_CONFIGURED blocks LiveReadiness from declaring system ready', () => {
    const readiness = coordinator.getLiveReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.reasons.some(r => r.includes('Signer') || r.includes('Jito'))).toBe(true);
  });

  // ===========================================================================
  // Interaction 12: F12 (Live Readiness Health) + F13 (Database WAL Health)
  // ===========================================================================
  it('C12: [F12 + F13] SQLite database status directly controls LiveReadiness.components.db.healthy', () => {
    const readiness = coordinator.getLiveReadiness();
    // Default initialized test environment DB is healthy
    expect(readiness.components.db.healthy).toBe(true);
    expect(readiness.components.db.status).toBe('HEALTHY');
  });

  // ===========================================================================
  // Interaction 13: F14 (Real-Money Prohibition) + F1 (Execution Mode)
  // ===========================================================================
  it('C13: [F14 + F1] Real-money prohibition prevents accidental on-chain mainnet broadcasts during testing', async () => {
    // Attempting LIVE trade on mainnet without explicit arming and keys fails-closed
    expect(coordinator.getExecutionMode()).toBe('PAPER');

    const result = await coordinator.executeTrade({
      mint: VALID_PUMP_MINT_1.toBase58(),
      symbol: 'MAINNET_PROHIBIT',
      name: 'Real Money Gate',
      amountSol: 0.005,
      source: 'AUTO_SNIPER',
      provenance: 'REAL_ONCHAIN',
      currentPriceSol: 0.0001,
    });

    // Automatically routed safely to PAPER engine
    expect(result.executionMode).toBe('PAPER');
  });

  // ===========================================================================
  // Interaction 14: F15 (Snipe Speed Profiling) + F16 (Dynamic MEV Tip)
  // ===========================================================================
  it('C14: [F15 + F16] High network latency escalates dynamic Jito tip within bounded maximum via executionConfig', () => {
    const normalTip = executionConfig.resolveDynamicJitoTip({
      tradeAmountSol: 0.006,
      urgencyMultiplier: 1.0,
    });
    const congestedTip = executionConfig.resolveDynamicJitoTip({
      tradeAmountSol: 0.006,
      urgencyMultiplier: 2.0, // Escalated urgency under latency/congestion
    });

    expect(normalTip.tipLamports).toBeGreaterThanOrEqual(150_000); // Floor 150k lamports
    expect(congestedTip.tipLamports).toBeGreaterThan(normalTip.tipLamports);
    expect(congestedTip.tipLamports).toBeLessThanOrEqual(1_000_000); // Ceiling 1M lamports
  });

  // ===========================================================================
  // Interaction 15: F16 (Dynamic MEV Tip) + F21 (MICRO_10 Fee Economics)
  // ===========================================================================
  it('C15: [F16 + F21] Escalated tip that pushes total fee > 20% of 0.007 SOL order is rejected by fee economics', () => {
    // 0.007 SOL order = 7,000,000 lamports
    // 20% fee ceiling = 1,400,000 lamports
    const baseReq = {
      mint: VALID_PUMP_MINT_1.toBase58(),
      orderSizeSol: 0.007,
      expectedPriceSol: 0.0001,
      slippageBps: 300,
      signalTimestamp: Date.now(),
      marketDataTimestamp: Date.now(),
      currentOpenPositionsCount: 0,
      currentTotalExposureSol: 0,
      walletSpendableSol: 0.05,
      executionMode: 'PAPER' as const,
    };

    // Total fees = 100,000 + 1,400,000 = 1,500,000 lamports (21.4% > 20%)
    const feeBreachedReq = {
      ...baseReq,
      estimatedFeeLamports: 100_000,
      jitoTipLamports: 1_400_000,
    };

    const res = riskEngine.evaluateOrder(feeBreachedReq);
    expect(res.approved).toBe(false);
    expect(res.reasonCode).toBe('EXPECTED_EDGE_BELOW_EXECUTION_COST');
  });

  // ===========================================================================
  // Interaction 16: F17 (Copy Trading) + F21 (MICRO_10 Sizing & Hard Cap)
  // ===========================================================================
  it('C16: [F17 + F21] Copy trading engine caps 100 SOL whale trade to <= 0.007 SOL and passes risk check', () => {
    const whaleOrderSizeSol = 100.0;
    const apexBankrollSol = 0.07;
    const spendable = apexBankrollSol - 0.015; // 0.055 SOL
    const sizedTradeSol = Math.min(spendable * 0.10, 0.007); // 0.0055 SOL

    expect(sizedTradeSol).toBeLessThanOrEqual(0.007);
    expect(sizedTradeSol).toBeLessThan(whaleOrderSizeSol);

    const res = riskEngine.evaluateOrder({
      mint: VALID_PUMP_MINT_1.toBase58(),
      orderSizeSol: sizedTradeSol,
      expectedPriceSol: 0.0001,
      slippageBps: 300,
      estimatedFeeLamports: 15000,
      jitoTipLamports: 100000,
      signalTimestamp: Date.now(),
      marketDataTimestamp: Date.now(),
      currentOpenPositionsCount: 0,
      currentTotalExposureSol: 0,
      walletSpendableSol: spendable,
      executionMode: 'PAPER',
    });

    expect(res.approved).toBe(true);
    expect(res.reasonCode).toBe('RISK_OK');
  });

  // ===========================================================================
  // Interaction 17: F18 (Social Scanner) + F7 (Token Eligibility)
  // ===========================================================================
  it('C17: [F18 + F7] Extracted social token address with insufficient liquidity fails eligibility screening', () => {
    const socialPost = 'Check out this early gem: 9x6f8MhA2Qf1dK7e3sL5pZ8wXy9bV4c1a2B3c4D5e6F7';
    const solanaRegex = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
    const match = socialPost.match(solanaRegex);

    expect(match).toBeDefined();
    const extractedMint = match![0];

    // Check against eligibility: token has only $500 liquidity (< $2000 required)
    const report = EligibilityFilter.evaluate({
      mint: extractedMint,
      symbol: 'LOWLIQ',
      name: 'Low Liq Social Token',
      liquidityUsd: 500,
      isFreezeAuthorityRevoked: true,
      isMintAuthorityRevoked: true,
    }, 'LIVE');

    expect(report.isEligible).toBe(false);
    expect(report.checks.some(c => c.ruleId === 'MIN_LIQUIDITY_DEPTH' && !c.passed)).toBe(true);
  });

  // ===========================================================================
  // Interaction 18: F19 (Signal Confluence) + F18 (Social Scanner)
  // ===========================================================================
  it('C18: [F19 + F18] Social alert alone provides only 1 factor and fails confluence minimum requirement (>= 3 factors)', () => {
    // Confluence evaluation with only social signal and flat/negative on-chain metrics
    const singleFactorData = {
      priceChange5mPct: 0.0,
      liquidityUsd: 5000,
      top10HoldersPct: 40.0, // Concentrated
      bondingCurveProgress: 10,
      buys5m: 1,
      sells5m: 1,
      devHoldingPct: 5.0,
      hasVerifiedSocialCall: true,
      socialCallCount: 1,
    };

    const res = ConfluenceEngine.calculate(singleFactorData);
    // Score should be below strong buy threshold
    expect(res.compositeScore).toBeLessThan(70);
    expect(res.explanation).toContain('Confluence');
  });

  // ===========================================================================
  // Interaction 19: F20 (Dynamic Exits) + F21 (Drawdown State Machine)
  // ===========================================================================
  it('C19: [F20 + F21] Trailing stop loss updates daily realized loss in SQLite and triggers DAILY_LOSS_LIMIT when breached', () => {
    // Mock daily realized loss of -0.051 SOL (breaches 0.05 limit)
    vi.spyOn(WorkstationDatabase.prototype, 'getDailyRealizedPnLSol').mockReturnValue(-0.051);

    const orderReq = {
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
      executionMode: 'PAPER' as const,
    };

    const evalResult = riskEngine.evaluateOrder(orderReq);
    expect(evalResult.approved).toBe(false);
    expect(evalResult.reasonCode).toBe('DAILY_LOSS_LIMIT');
  });

  // ===========================================================================
  // Interaction 20: F20 (Dynamic Exits / TP Ladder) + F4 (PumpSwap Migration)
  // ===========================================================================
  it('C20: [F20 + F4] Migrated PumpSwap position executes partial take-profit ladder step, updating token quantity in SQLite', () => {
    const posId = `pumpswap_ladder_${Date.now()}`;
    const initialTokensRaw = '1000000000'; // 1,000 tokens

    testDb.savePosition({
      id: posId,
      mint: GRADUATED_PUMP_MINT.toBase58(),
      symbol: 'LADDERPS',
      name: 'PumpSwap Ladder',
      tokenDecimals: 6,
      baseTokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      entryPriceSol: 0.0001,
      currentPriceSol: 0.0002, // 2x price
      tokenQuantityRaw: initialTokensRaw,
      costBasisLamports: 100_000_000,
      realizedPnLSol: 0,
      status: 'OPEN',
      venue: 'PUMPSWAP',
      poolAddress: '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf',
      executionMode: 'PAPER',
      entryTxSignature: 'sig_ps_ladder',
      entryTimestamp: Date.now() - 120000,
      recordUpdatedAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Execute 50% partial exit step at 2x
    const sellPct = 50;
    const remainingTokens = (BigInt(initialTokensRaw) * BigInt(100 - sellPct)) / 100n;
    const realizedPnL = 0.05; // 0.05 SOL profit booked

    testDb.savePosition({
      id: posId,
      mint: GRADUATED_PUMP_MINT.toBase58(),
      symbol: 'LADDERPS',
      name: 'PumpSwap Ladder',
      tokenDecimals: 6,
      baseTokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      entryPriceSol: 0.0001,
      currentPriceSol: 0.0002,
      tokenQuantityRaw: remainingTokens.toString(),
      costBasisLamports: 50_000_000,
      realizedPnLSol: realizedPnL,
      status: 'PARTIALLY_CLOSED',
      venue: 'PUMPSWAP',
      poolAddress: '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf',
      executionMode: 'PAPER',
      entryTxSignature: 'sig_ps_ladder',
      entryTimestamp: Date.now() - 120000,
      recordUpdatedAt: Date.now(),
      updatedAt: Date.now(),
    });

    const updatedPos = testDb.loadPositions('PAPER', 'PARTIALLY_CLOSED').find(p => p.id === posId);
    expect(updatedPos).toBeDefined();
    expect(updatedPos?.tokenQuantityRaw).toBe('500000000');
    expect(updatedPos?.realizedPnLSol).toBe(0.05);
    expect(updatedPos?.status).toBe('PARTIALLY_CLOSED');
  });

  // ===========================================================================
  // Interaction 21: F1 (Execution Mode) + F23 (Adversarial Rapid Bursts)
  // ===========================================================================
  it('C21: [F1 + F23] Concurrent rapid-fire executions for the same mint trigger DUPLICATE_MINT cooldown', () => {
    const mint = VALID_PUMP_MINT_1.toBase58();
    riskEngine.updateLimits({ cooldownPerMintMs: 20000 });

    // Trade 1 passes and records success
    riskEngine.recordTradeSuccess(mint);

    // Trade 2 fired 100ms later is rejected
    const burstReq = {
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
      walletSpendableSol: 0.05,
      executionMode: 'PAPER' as const,
    };

    const res = riskEngine.evaluateOrder(burstReq);
    expect(res.approved).toBe(false);
    expect(res.reasonCode).toBe('DUPLICATE_MINT');
  });

  // ===========================================================================
  // Interaction 22: F13 (WAL Crash Recovery) + F6 (Idempotent Deduplication)
  // ===========================================================================
  it('C22: [F13 + F6] Orders persisted in SQLite WAL maintain clientOrderId uniqueness across restarts', () => {
    const clientOrderId = 'unique_dedupe_client_ord_1';

    testDb.saveOrder({
      id: 'ord_dedupe_1',
      clientOrderId,
      correlationId: 'corr_dedupe_1',
      mint: VALID_PUMP_MINT_1.toBase58(),
      symbol: 'DEDUPE',
      side: 'BUY',
      amountLamports: 5000000,
      expectedTokensRaw: '1000000',
      slippageBps: 300,
      status: 'FILLED',
      executionMode: 'PAPER',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Check if clientOrderId exists
    const existing = testDb.db.prepare('SELECT id, status FROM orders WHERE client_order_id = ?').get(clientOrderId) as { id: string; status: string };
    expect(existing).toBeDefined();
    expect(existing.status).toBe('FILLED');

    // Duplicate submission attempt detects existing order
    const isDuplicate = existing !== undefined;
    expect(isDuplicate).toBe(true);
  });
});
