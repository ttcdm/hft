import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

let mode: any;
vi.mock('../src/utils/tradingMode', async (orig) => {
  const real: any = await orig();
  return { ...real, useTradingMode: () => mode };
});
import { TradingModeBanner, ReadOnlyPill } from '../src/components/TradingModeBanner';

const base = { label: 'PAPER', live: false, known: true, cluster: 'mainnet-beta', rpcHost: 'rpc.example', ageMs: 1000, stale: false };
beforeEach(() => { mode = { ...base, readOnly: true }; });

describe('S185 the read-only banner', () => {
  it('shows MAINNET · READ-ONLY · PAPER on a mainnet cluster, in the banner row and the header pill', () => {
    const b = renderToStaticMarkup(<TradingModeBanner />);
    expect(b).toContain('data-testid="read-only-banner"');
    expect(b).toContain('MAINNET · READ-ONLY · PAPER');
    expect(renderToStaticMarkup(<ReadOnlyPill />)).toContain('MAINNET · READ-ONLY · PAPER');
  });
  it('names the real cluster elsewhere and renders nothing when the server is not read-only', () => {
    mode = { ...base, cluster: 'devnet', readOnly: true };
    expect(renderToStaticMarkup(<ReadOnlyPill />)).toContain('DEVNET · READ-ONLY · PAPER');
    mode = { ...base, readOnly: false };
    expect(renderToStaticMarkup(<ReadOnlyPill />)).toBe('');
    expect(renderToStaticMarkup(<TradingModeBanner />)).not.toContain('read-only-banner');
  });
});
