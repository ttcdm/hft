import { describe, it, expect, vi, afterEach } from 'vitest';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import {
  startTracing, stopTracing, tracingActive, tracingRequested, traced, scrubText, scrubAttributes, isLocalOtlpEndpoint,
} from '../server/observability/tracing';
import { executionCoordinator } from '../server/execution/coordinator';
import { solPriceService } from '../server/market/solPriceService';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { EligibilityFilter } from '../server/signals/eligibilityFilter';
import { workstationDb } from '../server/db/database';
import { riskEngine } from '../server/risk/riskEngine';
import { Keypair } from '@solana/web3.js';
import { DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';

const paperRequest = (mint = Keypair.generate().publicKey.toBase58()) => ({
  mint, symbol: 'P', name: 'P', amountSol: 0.005, jitoTipSol: 0.0001, source: 'AUTO_SNIPER' as const, provenance: 'REAL_ONCHAIN' as const,
  currentPriceSol: 0.0001, signalTimestamp: Date.now(),
  eligibilityReport: EligibilityFilter.evaluate({
    mint, symbol: 'P', name: 'P', liquidityUsd: 15_000, devHoldingPct: 2, top10HoldersPct: 12, isMintAuthorityRevoked: true, isFreezeAuthorityRevoked: true,
  } as any, 'PAPER'),
});
const paperSetup = () => {
  PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() } as any;
  PumpCurveService.cachedFeeConfig = { feeBps: 100 } as any;
  vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
};

afterEach(async () => {
  await stopTracing();
  for (const p of workstationDb.loadPositions('PAPER', 'ACTIVE')) await executionCoordinator.closePosition(p.id, 100, 'MANUAL');
  PumpCurveService.cachedGlobal = null;
  PumpCurveService.cachedFeeConfig = null;
  riskEngine.setKillSwitch(false);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('S209: tracing is off unless asked for', () => {
  it('without APEX_TRACING=true no SDK starts and traced() makes no span', async () => {
    expect(tracingRequested({})).toBe(false);
    expect(tracingRequested({ APEX_TRACING: 'yes' })).toBe(false);
    expect(await startTracing({ env: {} })).toBe(false);
    expect(tracingActive()).toBe(false);
    const tracerSpy = vi.spyOn(trace, 'getTracer');
    expect(traced('x', () => 41 + 1)).toBe(42);
    await expect(traced('y', async () => 'ok')).resolves.toBe('ok');
    expect(tracerSpy).not.toHaveBeenCalled(); // no tracer was even asked for
  });

  it('a PAPER trade through the coordinator makes no span while off', async () => {
    const tracerSpy = vi.spyOn(trace, 'getTracer');
    solPriceService.setPrice(150, 'TEST');
    paperSetup();
    const r = await executionCoordinator.executeTrade(paperRequest());
    expect(r.success, r.error).toBe(true);
    expect(tracerSpy).not.toHaveBeenCalled();
    expect(tracingActive()).toBe(false);
  });
});

describe('S209: tracing on', () => {
  it('a PAPER trade emits its pipeline spans in order, all in one trace', async () => {
    const exporter = new InMemorySpanExporter();
    expect(await startTracing({ force: true, exporter, instrumentNetwork: false })).toBe(true);
    solPriceService.setPrice(150, 'TEST');
    paperSetup();
    const r = await executionCoordinator.executeTrade(paperRequest());
    expect(r.success, r.error).toBe(true);
    const spans = [...exporter.getFinishedSpans()].sort((a, b) => (a.startTime[0] - b.startTime[0]) || (a.startTime[1] - b.startTime[1]));
    const names = spans.map((s) => s.name);
    const opened = workstationDb.loadPositions('PAPER', 'ACTIVE');
    expect(opened.length).toBeGreaterThan(0);
    expect(names[0]).toBe('trade.execute');
    expect(names).toContain('gate.eligibility');
    expect(names).toContain('risk.evaluateOrder');
    expect(names.indexOf('gate.eligibility')).toBeLessThan(names.indexOf('risk.evaluateOrder'));
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
    const root = spans[0];
    for (const s of spans.slice(1)) expect(s.parentSpanContext?.spanId ?? s.spanContext().traceId).toBeTruthy();
    expect(spans.filter((s) => !s.parentSpanContext).map((s) => s.name)).toEqual([root.name]);
    exporter.reset();
    await executionCoordinator.closePosition(opened[0].id, 100, 'MANUAL'); // the exit pass is its own trace
    expect(exporter.getFinishedSpans().map((s) => s.name)).toContain('exit.close');
  });

  it('nested traced() calls nest, errors mark the span, and a boolean success is recorded', async () => {
    const exporter = new InMemorySpanExporter();
    await startTracing({ force: true, exporter, instrumentNetwork: false });
    await traced('outer', async () => {
      traced('inner', () => ({ success: false }));
      await expect(traced('boom', async () => { throw new Error('nope'); })).rejects.toThrow('nope');
    });
    const by = Object.fromEntries(exporter.getFinishedSpans().map((s) => [s.name, s]));
    expect(by.inner.parentSpanContext?.spanId).toBe(by.outer.spanContext().spanId);
    expect(by.inner.attributes['apex.success']).toBe(false);
    expect(by.boom.status.code).toBe(2); // ERROR
  });

  it('URLs in attributes, events and status are cut down to scheme and host', async () => {
    const exporter = new InMemorySpanExporter();
    await startTracing({ force: true, exporter, instrumentNetwork: false });
    const secret = 'https://user:pw@rpc.example.com/v2/SECRETKEY123?api-key=SECRETKEY456';
    await traced('call', async () => {
      await traced('http-like', async () => { throw new Error(`failed to fetch ${secret}`); }, {
        'url.full': secret, 'http.url': secret, 'url.path': '/v2/SECRETKEY123', 'url.query': 'api-key=SECRETKEY456', 'apex.note': `via ${secret}`,
      }).catch(() => undefined);
    });
    const dump = JSON.stringify(exporter.getFinishedSpans().map((s) => ({ a: s.attributes, e: s.events, st: s.status })));
    expect(dump).not.toMatch(/SECRETKEY/);
    expect(dump).not.toMatch(/user:pw/);
    expect(dump).toContain('https://rpc.example.com');
  });

  it('scrub helpers', () => {
    expect(scrubText('GET https://a.b/c/KEY?x=1 done')).toBe('GET https://a.b done');
    expect(scrubAttributes({ 'url.path': '/KEY', n: 3, ok: true, s: 'plain' })).toEqual({ 'url.path': '[REDACTED]', n: 3, ok: true, s: 'plain' });
  });

  it('only a local OTLP endpoint is accepted', async () => {
    expect(isLocalOtlpEndpoint('http://127.0.0.1:4318/v1/traces')).toBe(true);
    expect(isLocalOtlpEndpoint('http://localhost:4318/v1/traces')).toBe(true);
    expect(isLocalOtlpEndpoint('http://[::1]:4318/v1/traces')).toBe(true);
    expect(isLocalOtlpEndpoint('http://jaeger:4318/v1/traces')).toBe(true);
    expect(isLocalOtlpEndpoint('https://otel.vendor.com/v1/traces')).toBe(false);
    expect(isLocalOtlpEndpoint('http://127.0.0.1.evil.com/v1/traces')).toBe(false);
    expect(isLocalOtlpEndpoint('not a url')).toBe(false);
    expect(await startTracing({ env: { APEX_TRACING: 'true', APEX_TRACING_OTLP_ENDPOINT: 'https://otel.vendor.com/v1/traces' } })).toBe(false);
    expect(tracingActive()).toBe(false);
  });
});
