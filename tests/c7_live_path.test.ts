import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { HardenedRiskEngine, RiskEvaluationRequest, estimateRoundTripCostLamports, MAX_ROUND_TRIP_COST_FRACTION } from '../server/risk/riskEngine';
import { PaperExecutionEngine } from '../server/execution/paperEngine';
import { EligibilityFilter } from '../server/signals/eligibilityFilter';
import { CapitalSizer } from '../server/capital/capitalSizer';

const baseReq = (): RiskEvaluationRequest => ({
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
  executionMode: 'LIVE',
});

describe('C7: live-path correctness', () => {
  describe('price impact is enforced by the risk engine', () => {
    let risk: HardenedRiskEngine;
    beforeEach(() => {
      risk = new HardenedRiskEngine();
    });

    it('rejects an order whose quoted price impact exceeds maxPriceImpactBps', () => {
      const res = risk.evaluateOrder({ ...baseReq(), estimatedPriceImpactBps: 99_999 });
      expect(res.approved).toBe(false);
      expect(res.reasonCode).toBe('PRICE_IMPACT_TOO_HIGH');
    });

    it('accepts an order with a small price impact', () => {
      const res = risk.evaluateOrder({ ...baseReq(), estimatedPriceImpactBps: 10 });
      expect(res.approved).toBe(true);
    });

    it('does not reject when no price impact is supplied (legacy callers)', () => {
      const res = risk.evaluateOrder(baseReq());
      expect(res.reasonCode).not.toBe('PRICE_IMPACT_TOO_HIGH');
    });
  });

  describe('Token-2022 report reaches the eligibility filter', () => {
    const t22Rule = (r: ReturnType<typeof EligibilityFilter.evaluate>) =>
      r.checks.find((c) => c.ruleId === 'TOKEN_2022_POLICY');

    it('marks an explicitly safe Token-2022 mint as PASS in LIVE', () => {
      const r = EligibilityFilter.evaluate({ mint: 'm', token2022Safe: true } as any, 'LIVE');
      expect(t22Rule(r)?.status).toBe('PASS');
    });

    it('fails an unsafe Token-2022 mint in LIVE', () => {
      const r = EligibilityFilter.evaluate({ mint: 'm', token2022Safe: false } as any, 'LIVE');
      expect(t22Rule(r)?.status).toBe('FAIL');
      expect(t22Rule(r)?.passed).toBe(false);
    });

    it('fails closed in LIVE when the extensions are present but unverified', () => {
      const r = EligibilityFilter.evaluate({ mint: 'm', hasToken2022Extensions: true } as any, 'LIVE');
      expect(t22Rule(r)?.passed).toBe(false);
    });
  });

  describe('coordinator wiring (static)', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'server/execution/coordinator.ts'), 'utf8');

    it('passes the Token-2022 report and the quoted price impact into the checks', () => {
      expect(src).toContain('token2022Safe: marketState.token2022Report');
      expect(src).toContain('estimatedPriceImpactBps: quote.estimatedPriceImpactBps');
    });

    it('never zeroes the tip on the RPC fallback, because the tip is inside the signed tx', () => {
      expect(src).not.toMatch(/transport === 'JITO' \?/);
    });

    it('tracks in-flight buys per mint and releases them in finally', () => {
      expect(src).toContain('inFlightBuyMints');
      expect(src).toContain('DUPLICATE_MINT');
      expect(src).toMatch(/inFlightBuyMints\.delete\(/);
    });
  });

  describe('cold start sizing', () => {
    it('uses a prior weight of 25 trades, which the aggregator gate relies on', () => {
      expect(CapitalSizer.SHRINKAGE_PRIOR_WEIGHT).toBe(25);
      const agg = fs.readFileSync(path.resolve(process.cwd(), 'server/memecoinAggregator.ts'), 'utf8');
      expect(agg).toContain('historicalStats.tradeCount < CapitalSizer.SHRINKAGE_PRIOR_WEIGHT');
      expect(agg).toContain("rejectionReason === 'NEGATIVE_OR_ZERO_EXPECTANCY'");
    });
  });

  describe('C7b: round-trip cost floor and paper price impact', () => {
    const base = { buyTipLamports: 150_000, sellTipLamports: 150_000, priorityFeeLamports: 25_000, buyProtocolFeeLamports: 95_000, buyCreatorFeeLamports: 0 };

    it('sums buy tip + sell tip + 2 x (5,000 + priority) + pump fees on both sides', () => {
      expect(estimateRoundTripCostLamports(base)).toBe(150_000 + 150_000 + 2 * (5_000 + 25_000) + 2 * 95_000);
    });

    it('a 0.01 SOL order is above the 20% floor at these costs and a 0.1 SOL order is below it', () => {
      const cost = estimateRoundTripCostLamports(base);
      expect(cost > MAX_ROUND_TRIP_COST_FRACTION * 0.01 * 1e9).toBe(false);
      expect(cost > MAX_ROUND_TRIP_COST_FRACTION * 0.001 * 1e9).toBe(true);
      expect(MAX_ROUND_TRIP_COST_FRACTION).toBe(0.2);
    });

    it('the coordinator rejects with EXPECTED_EDGE_BELOW_EXECUTION_COST and never rounds the size up (static)', () => {
      const src = fs.readFileSync(path.resolve(process.cwd(), 'server/execution/coordinator.ts'), 'utf8');
      expect(src).toContain("EXPECTED_EDGE_BELOW_EXECUTION_COST");
      expect(src).toMatch(/roundTripCostLamports > MAX_ROUND_TRIP_COST_FRACTION \* req\.amountSol/);
    });

    it('paper price impact: the modeled impact grows with order size and the paper risk check receives it', () => {
      const small = PaperExecutionEngine.estimateImpactBps(0.01, 15_000, 150);
      const huge = PaperExecutionEngine.estimateImpactBps(50, 15_000, 150);
      expect(huge).toBeGreaterThan(small);
      expect(huge).toBeGreaterThan(600); // over the default maxPriceImpactBps
      const src = fs.readFileSync(path.resolve(process.cwd(), 'server/execution/coordinator.ts'), 'utf8');
      expect(src).toContain('estimatedPriceImpactBps: PaperExecutionEngine.estimateImpactBps(');
      const res = new HardenedRiskEngine().evaluateOrder({ ...baseReq(), executionMode: 'PAPER', estimatedPriceImpactBps: huge });
      expect(res.reasonCode).toBe('PRICE_IMPACT_TOO_HIGH');
    });
  });
});
