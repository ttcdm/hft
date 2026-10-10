import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Header } from '../src/components/Header';
import { fmtMicros } from '../src/components/EngineConsoleModal';
import { engineClient } from '../src/services/engineClient';

describe('R32: the kill-switch tooltip says what the kill switch does', () => {
  it('no longer promises to freeze all loops and open orders', () => {
    const html = renderToStaticMarkup(
      <Header kpis={{} as any} isHalted={false} onToggleKillSwitch={() => undefined} onOpenDeployModal={() => undefined} onOpenAiDiagnostics={() => undefined}
        onOpenUnitTests={() => undefined} onOpenGatewayModal={() => undefined} onOpenEngineConsole={() => undefined} activeFeed="CME_AURORA" onSelectFeed={() => undefined}
        capitalTier="MICRO_10" onToggleCapitalTier={() => undefined} />
    );
    expect(html).not.toMatch(/freeze all trading loops/i);
    expect(html).toMatch(/Open positions are not sold/);
  });
});

describe('R35: latency figures are a number with a unit or "n/a", never "n/aµs" or an invented value', () => {
  it('formats present, missing and non-finite values', () => {
    expect(fmtMicros(12.345)).toBe('12.3µs');
    expect(fmtMicros(0)).toBe('0.0µs');
    for (const v of [undefined, null, NaN, Infinity]) expect(fmtMicros(v as any)).toBe('n/a');
    const src = fs.readFileSync('src/components/EngineConsoleModal.tsx', 'utf8');
    expect(src).not.toContain("'58.4'"); // the invented median fallback
    expect(src).not.toMatch(/tickToTradeStats\.\w+Micros/); // every access is optional-chained, so missing stats cannot throw
  });
});

describe('R34: the WAL download is not revoked before the browser has it, and a failure is reported', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  const stubDom = () => {
    const click = vi.fn();
    const revoke = vi.fn();
    vi.stubGlobal('document', { createElement: () => ({ click, href: '', download: '' }) });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: revoke }));
    return { click, revoke };
  };

  it('revokes the object URL only after a delay', async () => {
    vi.useFakeTimers();
    const { click, revoke } = stubDom();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('wal-bytes', { status: 200 })));
    const r = await engineClient.downloadWalJournal();
    expect(r.ok).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled(); // not synchronously after click()
    vi.advanceTimersByTime(30_001);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('returns the failure instead of only logging it', async () => {
    stubDom();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 500 })));
    const r = await engineClient.downloadWalJournal();
    expect(r).toEqual({ ok: false, error: 'HTTP 500' });
  });
});

describe('R37: the client unit-test status is not "passed" before a summary exists', () => {
  it('shows RUNNING while tests have started but no summary has arrived', () => {
    // no DOM test environment: source check of the status expression (labelled)
    const src = fs.readFileSync('src/components/UnitTestModal.tsx', 'utf8');
    expect(src).not.toMatch(/progress\.current > 0 \? 'ALL_TESTS_PASSED'/);
    expect(src).toMatch(/progress\.current > 0 \? 'RUNNING'/);
  });
});
