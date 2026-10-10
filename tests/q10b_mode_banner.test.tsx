import { describe, it, expect } from 'vitest';
import React from 'react';
import fs from 'fs';
import { renderToStaticMarkup } from 'react-dom/server';
import App from '../src/App';
import { TradingModeBanner } from '../src/components/TradingModeBanner';
import { describeTradingMode, liveClickWarning, MODE_STALE_MS } from '../src/utils/tradingMode';
import { authorityBadge, holderPct } from '../src/utils/authorityBadge';
import { liveConfirmationRefusal } from '../server/execution/liveConfirmation';
import { SignalSnipeSchema, CalloutSnipeSchema } from '../server/execution/tradeInputs';
import { buildBoard } from '../server/board';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { solPriceService } from '../server/market/solPriceService';
import { Keypair } from '@solana/web3.js';
import { vi, afterEach } from 'vitest';

/** Q10b-d: the screens say what mode a click runs in, ask before a live click, and show unknown as unknown. */
describe('Q10b: mode, cluster and confirmation', () => {
  afterEach(() => vi.restoreAllMocks());
  const t0 = 1_000_000;

  it('describeTradingMode: unknown until the server answers, LIVE ARMED and the cluster when armed, unknown again when the answer is stale', () => {
    expect(describeTradingMode(null, null, t0)).toMatchObject({ label: 'MODE UNKNOWN', live: false, known: false });
    const paper = describeTradingMode({ mode: 'PAPER', isLiveArmed: false, allowedCluster: 'devnet', rpcEndpoint: 'https://api.devnet.solana.com/' }, t0 - 2000, t0);
    expect(paper).toMatchObject({ label: 'PAPER', live: false, known: true, cluster: 'devnet', rpcHost: 'api.devnet.solana.com', ageMs: 2000 });
    const live = describeTradingMode({ mode: 'LIVE', isLiveArmed: true, allowedCluster: 'devnet' }, t0 - 1000, t0);
    expect(live).toMatchObject({ label: 'LIVE ARMED', live: true });
    expect(describeTradingMode({ mode: 'LIVE', isLiveArmed: false }, t0, t0).label).toBe('LIVE (NOT ARMED)');
    const stale = describeTradingMode({ mode: 'PAPER', isLiveArmed: false }, t0 - MODE_STALE_MS - 1, t0);
    expect(stale).toMatchObject({ label: 'MODE UNKNOWN', known: false, stale: true, live: false });
  });

  it('a live click gets a warning naming the cluster; a paper click gets none', () => {
    const live = describeTradingMode({ mode: 'LIVE', isLiveArmed: true, allowedCluster: 'devnet' }, t0, t0);
    expect(liveClickWarning(live, 'Sniping $X for $5.00')).toMatch(/LIVE is armed on devnet\. Sniping \$X for \$5\.00 will send a REAL transaction/);
    expect(liveClickWarning(describeTradingMode({ mode: 'PAPER', isLiveArmed: false }, t0, t0), 'x')).toBeNull();
  });

  it('the server refuses a one-click LIVE trade without confirmLive, and the schemas let the flag through', () => {
    expect(liveConfirmationRefusal(false, 'devnet', {})).toBeNull();
    expect(liveConfirmationRefusal(true, 'devnet', {})).toMatch(/^LIVE_CONFIRMATION_REQUIRED: LIVE is armed on devnet/);
    expect(liveConfirmationRefusal(true, 'devnet', { confirmLive: 'true' })).not.toBeNull(); // only boolean true counts
    expect(liveConfirmationRefusal(true, 'devnet', { confirmLive: true })).toBeNull();
    const sig = SignalSnipeSchema.safeParse({ signalId: 'sig-1', amountUsd: 5, confirmLive: true });
    expect(sig.success && (sig.data as any).confirmLive).toBe(true);
    const call = CalloutSnipeSchema.safeParse({ calloutId: 'c-1', amountUsd: 5, confirmLive: true });
    expect(call.success && (call.data as any).confirmLive).toBe(true);
    const src = fs.readFileSync('server.ts', 'utf8');
    const snipeBlock = src.slice(src.indexOf("'/api/social/signals/snipe'"), src.indexOf("'/api/telegram/config'"));
    const calloutBlock = src.slice(src.indexOf("'/api/pumpfun/callouts/snipe'"), src.indexOf("'/api/pumpfun/callouts/toggle-autosnipe'"));
    for (const block of [snipeBlock, calloutBlock]) expect(block).toMatch(/liveConfirmationRefusal\(executionCoordinator\.isLiveArmed\(\)/);
    expect(snipeBlock.indexOf('liveConfirmationRefusal')).toBeLessThan(snipeBlock.indexOf('markSniped'));
  });

  it('the banner is on the page and says MODE UNKNOWN before the server has answered', () => {
    expect(renderToStaticMarkup(<TradingModeBanner />)).toMatch(/MODE UNKNOWN[\s\S]*cluster: unknown[\s\S]*no answer from the server yet/);
    const page = renderToStaticMarkup(<App />);
    expect(page).toContain('data-testid="trading-mode-banner"');
  });

  it('the screens no longer claim PAPER (SAFE) by default or describe live snipes as a simulation', () => {
    const pnp = fs.readFileSync('src/components/PlugAndPlayTradingModal.tsx', 'utf8');
    expect(pnp).not.toContain('PAPER TRADING (SAFE)');
    expect(pnp).toContain("'MODE UNKNOWN'");
    const callouts = fs.readFileSync('src/components/PumpFunHotCalloutsView.tsx', 'utf8');
    expect(callouts).not.toContain('use paper trading simulation');
  });
});

describe('Q10c/d: unknown authority is shown as unknown', () => {
  it('authorityBadge and holderPct', () => {
    expect(authorityBadge('Mint', true)).toEqual({ text: 'Mint Revoked', tone: 'ok' });
    expect(authorityBadge('Freeze', false)).toEqual({ text: 'Freeze NOT revoked', tone: 'bad' });
    expect(authorityBadge('Mint', null)).toEqual({ text: 'Mint: unknown', tone: 'unknown' });
    expect(authorityBadge('Mint', undefined).tone).toBe('unknown');
    expect(holderPct(-1)).toBe('—');
    expect(holderPct(null)).toBe('—');
    expect(holderPct(12.345)).toBe('12.3%');
    expect(holderPct(0)).toBe('0%');
  });

  it('a pool made from a create event is flagged unverified and the board reports its authorities as null', () => {
    vi.spyOn(solPriceService, 'lastKnownPrice').mockReturnValue(150);
    const mint = Keypair.generate().publicKey.toBase58();
    const pool = memecoinAggregator.ingestOnChainCreateEvent({
      signature: 's', slot: 1, mint, creator: Keypair.generate().publicKey.toBase58(), bondingCurve: Keypair.generate().publicKey.toBase58(), name: 'Q', symbol: 'Q', uri: '',
      virtualTokenReserves: 1_073_000_000_000_000n, virtualSolReserves: 30_000_000_000n, realTokenReserves: 793_100_000_000_000n, realSolReserves: 0n,
      tokenTotalSupply: 1_000_000_000_000_000n, initialPriceSol: 3e-8, initialMarketCapSol: 28, receivedAt: 1, parsedAt: 1, parseLatencyMs: 0, source: 'TEST_FEED',
    });
    expect(pool.authoritiesVerified).toBe(false);
    const row = buildBoard().launches.find((l) => l.mint === mint)!;
    expect(row.mintRevoked).toBeNull();
    expect(row.freezeRevoked).toBeNull();
  });

  it('the pool table has no unconditional Mint Revoked / Freeze Revoked badge', () => {
    const src = fs.readFileSync('src/components/MemecoinSocialSniperModal.tsx', 'utf8');
    expect(src).not.toMatch(/<span>Mint Revoked<\/span>/);
    expect(src).not.toMatch(/<span>Freeze Revoked<\/span>/);
    const callouts = fs.readFileSync('src/components/PumpFunHotCalloutsView.tsx', 'utf8');
    expect(callouts).not.toMatch(/<ShieldCheck className="w-3 h-3 mr-0\.5" \/> Mint Revoked/);
  });
});
