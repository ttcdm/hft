import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { Keypair } from '@solana/web3.js';
import { installDom, removeDom, installFakeServer, click, typeInto, flush, type FakeServer } from './helpers/domApp';
import { mount, buttonByText } from './helpers/mountDom';
import { describeTradingMode, snipeBlockedReason, MODE_STALE_MS } from '../src/utils/tradingMode';
import { MemecoinSocialSniperModal } from '../src/components/MemecoinSocialSniperModal';
import { PlugAndPlayTradingModal } from '../src/components/PlugAndPlayTradingModal';
import { pumpFunService } from '../server/pumpfunService';
import { autoSnipeController } from '../server/auto/controller';

/** UI status report 2026-10-26, fix 7: with the kill switch ON the snipe buttons stayed enabled (the server refused the order anyway). */
describe('UI fix 7: snipe buttons are greyed out while the kill switch is on', () => {
  const now = 1_000_000;
  it('the shared mode answer carries the kill switch; on means blocked, off or unknown means not', () => {
    expect(snipeBlockedReason(describeTradingMode({ mode: 'PAPER', killSwitchActive: true }, now - 1000, now))).toMatch(/KILL SWITCH ON/);
    expect(snipeBlockedReason(describeTradingMode({ mode: 'PAPER', killSwitchActive: false }, now - 1000, now))).toBeNull();
    // a stale answer does not claim the switch is on (the button stays usable; the server still decides)
    expect(describeTradingMode({ mode: 'PAPER', killSwitchActive: true }, now - MODE_STALE_MS - 1, now).killSwitch).toBeNull();
  });
});

describe('UI fix 7: on the real screens', () => {
  let server: FakeServer;
  const svc = pumpFunService as any;
  beforeEach(() => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: true };
    installFakeServer(server);
    // a mainnet server (so the callout button is not blocked for its cluster) with the kill switch on
    server.routes['/api/diagnostics/system'] = () => ({ json: { systemAudit: { mode: 'PAPER', isLiveArmed: false, allowedCluster: 'mainnet-beta', killSwitchActive: server.killSwitchActive } } });
    // the callouts the real route lists (server.ts GET /api/pumpfun/callouts), from the real pump.fun service
    server.routes['/api/pumpfun/callouts'] = () => ({ json: { status: 'OK', feedStatus: 'ONLINE', callouts: pumpFunService.getHotCallouts(), leaderboard: [], autoSnipeRules: pumpFunService.getAutoSnipeRules() } });
  });
  afterEach(async () => { await removeDom(); svc.hotCallouts = []; svc.rawTokensCache = []; });

  it('every snipe button on the Sniper, callout and Plug & Play screens is disabled by it', async () => {
    vi.spyOn(autoSnipeController, 'getMode').mockReturnValue('OFF');
    const t = Date.now();
    pumpFunService.handleOnChainCreateEvent({
      signature: 'sig', slot: 1, mint: Keypair.generate().publicKey.toBase58(), creator: Keypair.generate().publicKey.toBase58(), bondingCurve: Keypair.generate().publicKey.toBase58(),
      name: 'UF7', symbol: 'UF7', uri: '', virtualTokenReserves: 1_073_000_000_000_000n, virtualSolReserves: 30_000_000_000n, realTokenReserves: 793_100_000_000_000n,
      realSolReserves: 0n, tokenTotalSupply: 1_000_000_000_000_000n, initialPriceSol: 2.8e-8, initialMarketCapSol: 28, receivedAt: t, parsedAt: t, parseLatencyMs: 1, source: 'TEST_FEED',
    } as any);
    const mint = 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS';

    const sniper = await mount(<MemecoinSocialSniperModal isOpen onClose={() => {}} />);
    await flush(10);
    const callout = buttonByText(sniper.container, /^SNIPE \(/); // the callout card's 1-click button (calloutSnipeLabel)
    expect(sniper.container.textContent).toContain('UF7');
    expect(callout?.disabled).toBe(true);
    expect(callout?.title).toMatch(/KILL SWITCH ON/);
    await click(buttonByText(sniper.container, /Autonomous Sniper & Positions/)!);
    await typeInto(sniper.container.querySelector('input[placeholder^="e.g. CzLSuj"]'), mint);
    const instant = buttonByText(sniper.container, /Instant Snipe/)!;
    expect(instant.disabled).toBe(true);
    expect(instant.title).toMatch(/KILL SWITCH ON/);
    await sniper.unmount();

    const pnp = await mount(<PlugAndPlayTradingModal isOpen onClose={() => {}} />);
    await typeInto(pnp.container.querySelector('input[placeholder^="Enter Pump.fun"]'), mint);
    const manual = [...pnp.container.querySelectorAll('button')].find((b) => b.getAttribute('title')?.match(/KILL SWITCH ON/) && /SNIPE/.test(b.textContent || '')) as HTMLButtonElement | undefined;
    expect(manual?.disabled).toBe(true);
    await pnp.unmount();
    expect(server.calls.filter((c) => c.method === 'POST' && /trade|snipe/.test(c.url))).toEqual([]);
  });
});
