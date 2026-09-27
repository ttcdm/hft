import { describe, it, expect, beforeEach } from 'vitest';
import { HardenedRiskEngine, RiskEvaluationRequest } from '../server/risk/riskEngine';

describe('HardenedRiskEngine — Pre-Trade Risk Verification', () => {
  let risk: HardenedRiskEngine;

  const validRequest: RiskEvaluationRequest = {
    mint: 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS',
    orderSizeSol: 0.02,
    expectedPriceSol: 0.0001,
    slippageBps: 500,
    estimatedFeeLamports: 50_000,
    jitoTipLamports: 1_000_000,
    expectedEdgeSol: 0.005,
    signalTimestamp: Date.now(),
    marketDataTimestamp: Date.now(),
    currentOpenPositionsCount: 1,
    currentTotalExposureSol: 0.02,
    walletSpendableSol: 0.1,
    executionMode: 'PAPER',
  };

  beforeEach(() => {
    risk = new HardenedRiskEngine();
    validRequest.signalTimestamp = Date.now();
    validRequest.marketDataTimestamp = Date.now();
  });

  it('approves orders that conform strictly to risk parameters', () => {
    const res = risk.evaluateOrder(validRequest);
    expect(res.approved).toBe(true);
    expect(res.reasonCode).toBe('RISK_OK');
  });

  it('rejects trades when kill switch is active', () => {
    risk.setKillSwitch(true);
    const res = risk.evaluateOrder(validRequest);
    expect(res.approved).toBe(false);
    expect(res.reasonCode).toBe('KILL_SWITCH_ACTIVE');
  });

  it('rejects trades when circuit breaker is tripped open', () => {
    risk.setCircuitBreaker('OPEN');
    const res = risk.evaluateOrder(validRequest);
    expect(res.approved).toBe(false);
    expect(res.reasonCode).toBe('CIRCUIT_BREAKER_OPEN');
  });

  it('rejects trades that breach the single position SOL ceiling', () => {
    const req = { ...validRequest, orderSizeSol: 0.08 }; // max is 0.05
    const res = risk.evaluateOrder(req);
    expect(res.approved).toBe(false);
    expect(res.reasonCode).toBe('MAX_POSITION_SIZE');
  });

  it('rejects trades that breach aggregate exposure limits', () => {
    const req = { ...validRequest, currentTotalExposureSol: 0.05, orderSizeSol: 0.02 }; // 0.05 + 0.02 > 0.06
    const res = risk.evaluateOrder(req);
    expect(res.approved).toBe(false);
    expect(res.reasonCode).toBe('MAX_EXPOSURE');
  });

  it('rejects trades when simultaneous open position count is reached', () => {
    const req = { ...validRequest, currentOpenPositionsCount: 3 }; // limit is 3
    const res = risk.evaluateOrder(req);
    expect(res.approved).toBe(false);
    expect(res.reasonCode).toBe('MAX_EXPOSURE');
  });

  it('rejects trades that violate the minimum SOL gas reserve', () => {
    const req = { ...validRequest, walletSpendableSol: 0.02, orderSizeSol: 0.01 }; // 0.02 - 0.01 = 0.01 < 0.015 reserve
    const res = risk.evaluateOrder(req);
    expect(res.approved).toBe(false);
    expect(res.reasonCode).toBe('INSUFFICIENT_BALANCE');
  });

  it('rejects trades with stale market data', () => {
    const req = { ...validRequest, marketDataTimestamp: Date.now() - 10000 }; // 10s old > 5s max
    const res = risk.evaluateOrder(req);
    expect(res.approved).toBe(false);
    expect(res.reasonCode).toBe('STALE_MARKET_DATA');
  });

  it('rejects trades with stale strategy signals', () => {
    const req = { ...validRequest, signalTimestamp: Date.now() - 12000 }; // 12s old > 8s max
    const res = risk.evaluateOrder(req);
    expect(res.approved).toBe(false);
    expect(res.reasonCode).toBe('STALE_SIGNAL');
  });

  it('rejects trades with excessive slippage tolerance', () => {
    const req = { ...validRequest, slippageBps: 1500 }; // 15% > 8% max
    const res = risk.evaluateOrder(req);
    expect(res.approved).toBe(false);
    expect(res.reasonCode).toBe('SLIPPAGE_TOO_HIGH');
  });

  it('rejects trades where execution fees overwhelm trade economics', () => {
    // 0.005 SOL trade with 0.002 SOL fees = 40% of trade value (> 20% limit)
    const req = {
      ...validRequest,
      orderSizeSol: 0.005,
      estimatedFeeLamports: 1_000_000,
      jitoTipLamports: 1_000_000,
    };
    const res = risk.evaluateOrder(req);
    expect(res.approved).toBe(false);
    expect(res.reasonCode).toBe('EXPECTED_EDGE_BELOW_EXECUTION_COST');
  });

  it('rejects trades with excessive total execution cost exceeding policy limit', () => {
    const req = {
      ...validRequest,
      jitoTipLamports: 60_000_000, // > 50_000_000 lamports max fee
    };
    const res = risk.evaluateOrder(req);
    expect(res.approved).toBe(false);
    expect(res.reasonCode).toBe('FEE_TOO_HIGH');
  });

  it('enforces per-mint trading cooldown to prevent rapid churn', () => {
    risk.recordTradeSuccess(validRequest.mint);
    const res = risk.evaluateOrder(validRequest);
    expect(res.approved).toBe(false);
    expect(res.reasonCode).toBe('DUPLICATE_MINT');
  });

  it('enforces post-failure system cooldown', () => {
    risk.recordTradeFailure();
    const res = risk.evaluateOrder(validRequest);
    expect(res.approved).toBe(false);
    expect(res.reasonCode).toBe('EXECUTION_DISABLED');
  });

  it('trips circuit breaker and kill switch after 3 consecutive RPC failures', () => {
    expect(risk.recordRpcFailure()).toBe(false);
    expect(risk.recordRpcFailure()).toBe(false);
    expect(risk.recordRpcFailure()).toBe(true); // 3rd failure trips breaker
    expect(risk.getCircuitBreakerState()).toBe('OPEN');
    expect(risk.isKillSwitchActive()).toBe(true);
  });

  it('rejects live arming when ALLOW_LIVE_REAL_MONEY_TRADING is not true', async () => {
    const { ExecutionCoordinator } = await import('../server/execution/coordinator');
    const coord = new ExecutionCoordinator();
    const origEnv = process.env.ALLOW_LIVE_REAL_MONEY_TRADING;
    try {
      delete process.env.ALLOW_LIVE_REAL_MONEY_TRADING;
      const res = coord.armLiveTrading(true, 'CONFIRM_LIVE_TRADING_RISK');
      expect(res.success).toBe(false);
      expect(res.message).toContain('REAL_MONEY_PROHIBITED');
    } finally {
      if (origEnv !== undefined) {
        process.env.ALLOW_LIVE_REAL_MONEY_TRADING = origEnv;
      }
      coord.cleanup();
    }
  });

  it('fails live readiness when Jito transport is unconfigured or offline', async () => {
    const { ExecutionCoordinator } = await import('../server/execution/coordinator');
    const coord = new ExecutionCoordinator();
    try {
      const readiness = coord.getLiveReadiness();
      expect(readiness.ready).toBe(false);
      expect(readiness.reasons.some((r) => r.includes('Jito'))).toBe(true);
    } finally {
      coord.cleanup();
    }
  });
});

